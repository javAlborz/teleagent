/**
 * Outbound Call Handler
 * Core logic for initiating outbound SIP calls via drachtio
 * v2: Added voiceId support for device-specific TTS
 *
 * Uses Early Offer pattern:
 * 1. Create FreeSWITCH endpoint first to get local SDP
 * 2. Send INVITE with our SDP
 * 3. On answer, connect the endpoint with remote SDP
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const ttsService = require('./tts-service');
const { verifyOutboundRoutingConfig } = require('./outbound-routing-config');

function createOutboundAbortError(reason = 'Outbound call canceled') {
  const error = new Error(String(reason || 'Outbound call canceled'));
  error.name = 'AbortError';
  error.code = 'OUTBOUND_CALL_CANCELED';
  return error;
}

async function cleanupOutboundResources(dialog, endpoint, callId) {
  const failures = [];
  if (dialog && !dialog.destroyed) {
    try {
      await dialog.destroy();
      logger.info('Dialog destroyed', { callId });
    } catch (error) {
      failures.push(error);
      logger.warn('Failed to destroy dialog', { callId, error: error.message });
    }
  }
  if (endpoint) {
    try {
      await endpoint.destroy();
      logger.info('Endpoint destroyed', { callId });
    } catch (error) {
      failures.push(error);
      logger.warn('Failed to destroy endpoint', { callId, error: error.message });
    }
  }
  return { success: failures.length === 0, failures };
}

function verifiedRoutingConfig(value) {
  // Re-normalize at the side-effect boundary. A caller cannot smuggle an
  // alternate buildSipUri implementation, add URI parameters, or substitute a
  // different authentication target after startup.
  try {
    return verifyOutboundRoutingConfig(value);
  } catch {
    throw new Error('A validated outbound SIP routing configuration is required');
  }
}

function buildSipUri({ to, routingConfig }) {
  return verifiedRoutingConfig(routingConfig).buildSipUri(to);
}

/**
 * Initiate an outbound call
 *
 * @param {Object} srf - drachtio SRF instance
 * @param {Object} mediaServer - FreeSWITCH media server
 * @param {Object} options - Call options
 * @param {string} options.to - Phone number in E.164 format (+15551234567)
 * @param {string} options.message - Message to play when answered
 * @param {string} [options.callerId] - Caller ID (defaults to DEFAULT_CALLER_ID env var)
 * @param {number} [options.timeoutSeconds=30] - Ring timeout in seconds
 * @returns {Promise<Object>} { callId, dialog, endpoint }
 */
async function initiateOutboundCall(srf, mediaServer, options) {
  const {
    to,
    callerId,
    timeoutSeconds = 30,
    deviceConfig = null,
    routingConfig,
    callId: reservedCallId = null,
    signal = null
  } = options;

  const callId = reservedCallId || uuidv4();
  const startTime = Date.now();
  let endpoint = null;
  let dialog = null;
  let sipAttemptStarted = false;
  let dialogAcquired = false;
  let cleanupPromise = Promise.resolve({ success: true, failures: [] });
  const cleanupFailures = [];
  const cleanup = () => {
    const dialogToClean = dialog;
    const endpointToClean = endpoint;
    dialog = null;
    endpoint = null;
    cleanupPromise = cleanupPromise.then(async () => {
      const result = await cleanupOutboundResources(dialogToClean, endpointToClean, callId);
      cleanupFailures.push(...result.failures);
      return { success: cleanupFailures.length === 0, failures: cleanupFailures };
    });
    return cleanupPromise;
  };
  const throwIfAborted = async () => {
    if (!signal?.aborted) return;
    await cleanup();
    throw createOutboundAbortError(signal.reason);
  };
  const abortListener = () => { void cleanup(); };
  signal?.addEventListener?.('abort', abortListener, { once: true });

  try {
    await throwIfAborted();
    logger.info('Initiating outbound call', {
      callId,
      to,
      callerId,
      timeout: timeoutSeconds
    });

    // STEP 1: Create FreeSWITCH endpoint first (Early Offer pattern)
    logger.info('Creating FreeSWITCH endpoint', { callId });
    endpoint = await mediaServer.createEndpoint();
    await throwIfAborted();

    // Get local SDP from FreeSWITCH
    const localSdp = endpoint.local.sdp;

    // The destination authority is startup-validated and server-owned. API
    // callers and inbound Contact headers never influence this route.
    const route = verifiedRoutingConfig(routingConfig);
    const defaultCallerId = callerId || process.env.DEFAULT_CALLER_ID || '+15551234567';

    const sipUri = buildSipUri({
      to,
      routingConfig: route,
    });

    logger.info('Dialing SIP URI', {
      callId,
      sipTarget: sipUri.replace(/^sip:[^@]+@/i, 'sip:<redacted>@'),
      from: defaultCallerId,
      hasAuth: true
    });

    // STEP 2: Create UAC (outbound call) with Early Offer
    // Use device extension and display name if available, otherwise fall back to callerId
    const fromExtension = deviceConfig ? deviceConfig.extension : defaultCallerId.replace('+', '');
    const displayName = deviceConfig ? deviceConfig.name : null;
    const fromUri = route.buildFromUri(fromExtension);
    const fromHeader = displayName
      ? '"' + displayName.replaceAll(/["\\\r\n]/g, '') + '" <' + fromUri + '>'
      : '<' + fromUri + '>';

    const uacOptions = {
      localSdp: localSdp,
      headers: {
        'From': fromHeader,
        'User-Agent': 'NetworkChuck-VoiceServer/1.0',
        'X-Call-ID': callId
      }
    };

    // The callback credential is a dedicated, app-owned trunk capability. It
    // is never selected from caller/device data and is attached only after the
    // exact PBX authority and transport have been revalidated above.
    uacOptions.auth = route.getCallbackAuth();
    logger.info('SIP trunk authentication enabled', { callId });

    let isRinging = false;
    // Create the outbound call (returns dialog directly, not { uas, uac })
    sipAttemptStarted = true;
    dialog = await srf.createUAC(sipUri, uacOptions, {
      cbRequest: function(err, _req) {
        // Called when INVITE is sent
        if (err) {
          logger.error('INVITE send failed', { callId, error: err.message });
        } else {
          logger.info('INVITE sent successfully', { callId });
        }
      },
      cbProvisional: function(res) {
        // Called on provisional responses (180 Ringing, 183 Progress, etc.)
        logger.info('Provisional response received', {
          callId,
          status: res.status,
          reason: res.reason
        });

        if (res.status === 180) {
          isRinging = true;
          logger.info('Phone is ringing', { callId, to });
        }
      }
    });
    dialogAcquired = true;
    await throwIfAborted();

    // STEP 3: Call was answered! Connect endpoint with remote SDP
    const latency = Date.now() - startTime;

    logger.info('Call answered', {
      callId,
      to,
      latency,
      isRinging
    });

    // Modify endpoint with remote SDP to complete media connection
    await endpoint.modify(dialog.remote.sdp);
    await throwIfAborted();

    logger.info('Media connection established', { callId });

    return {
      callId,
      dialog,
      endpoint,
      isRinging,
      latency
    };

  } catch (error) {
    const latency = Date.now() - startTime;

    logger.error('Outbound call failed', {
      callId,
      to,
      error: error.message,
      latency
    });

    const cleanupResult = await cleanup();

    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'OUTBOUND_CALL_CANCELED') {
      const abortError = createOutboundAbortError(signal?.reason || error.message);
      const knownRejectedInvite = [401, 404, 407, 408, 480, 486, 503].includes(error?.status);
      abortError.cleanupSucceeded = cleanupResult.success &&
        (!sipAttemptStarted || dialogAcquired || knownRejectedInvite);
      throw abortError;
    }

    // Handle specific SIP error codes
    if (error.status) {
      const status = error.status;
      if (status === 486) {
        error = new Error('busy');
      } else if (status === 480 || status === 408) {
        error = new Error('no_answer');
      } else if (status === 404) {
        error = new Error('not_found');
      } else if (status === 503) {
        error = new Error('service_unavailable');
      } else if (status === 401 || status === 407) {
        error = new Error('auth_failed');
      }
    }

    error.cleanupSucceeded = cleanupResult.success;
    throw error;
  } finally {
    signal?.removeEventListener?.('abort', abortListener);
  }
}

/**
 * Play a TTS message to an active call
 *
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {string} message - Text to convert to speech and play
 * @param {Object} [options] - Playback options
 * @param {string} [options.voiceId] - TTS provider voice ID/name for device-specific voice
 * @returns {Promise<void>}
 */
async function playMessage(endpoint, message, options) {
  options = options || {};
  var voiceId = options.voiceId || null;
  var startTime = Date.now();

  try {
    logger.info('Generating TTS for outbound call', {
      textLength: message.length,
      voiceId: voiceId || 'default'
    });

    // Generate TTS audio file with optional device voice
    var audioUrl = await ttsService.generateSpeech(message, voiceId);

    logger.info('Playing TTS to caller', { audioUrl: audioUrl });

    // Play the audio file via FreeSWITCH
    await endpoint.play(audioUrl);

    var duration = Date.now() - startTime;

    logger.info('TTS playback completed', {
      duration: duration,
      audioUrl: audioUrl
    });

  } catch (error) {
    logger.error('Failed to play message', {
      error: error.message
    });
    throw error;
  }
}

/**
 * Hangup an active outbound call
 *
 * @param {Object} dialog - drachtio dialog (UAC)
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {string} callId - Call UUID for logging
 */
async function hangupCall(dialog, endpoint, callId) {
  logger.info('Hanging up outbound call', { callId: callId });
  return cleanupOutboundResources(dialog, endpoint, callId);
}

module.exports = {
  buildSipUri,
  cleanupOutboundResources,
  createOutboundAbortError,
  initiateOutboundCall: initiateOutboundCall,
  playMessage: playMessage,
  hangupCall: hangupCall
};
