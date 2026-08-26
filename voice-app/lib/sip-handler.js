/**
 * SIP Call Handler with Conversation Loop
 * v12: Device registry integration with proper method names
 */

const { runConversationLoop } = require('./conversation-loop');
const { runRealtimeConversation } = require('./realtime-conversation');
const { getRealtimeApiKey } = require('./openai-realtime-client');
const {
  getRecentSession,
  getResumeTtlSeconds,
  rememberRecentSession,
} = require('./recent-session-cache');

function extractCallerId(req) {
  var from = req.get("From") || "";
  var match = from.match(/sip:([+\d]+)@/);
  if (match) return match[1];
  var numMatch = from.match(/<sip:(\d+)@/);
  if (numMatch) return numMatch[1];
  return "unknown";
}

/**
 * Extract dialed extension from SIP To header
 */
function extractDialedExtension(req) {
  var to = req.get("To") || "";
  var match = to.match(/sip:(\d+)@/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Strip video tracks from SDP (FreeSWITCH doesn't support H.261 and rejects with 488)
 * Keeps only audio tracks to ensure codec negotiation succeeds
 */
function stripVideoFromSdp(sdp) {
  if (!sdp) return sdp;

  const lines = sdp.split('\r\n');
  const result = [];
  let inVideoSection = false;

  for (const line of lines) {
    // Check if we're entering a video media section
    if (line.startsWith('m=video')) {
      inVideoSection = true;
      continue; // Skip the m=video line
    }

    // Check if we're entering a new media section (audio, etc.)
    if (line.startsWith('m=') && !line.startsWith('m=video')) {
      inVideoSection = false;
    }

    // Skip all lines in the video section
    if (inVideoSection) {
      continue;
    }

    result.push(line);
  }

  return result.join('\r\n');
}

/**
 * Handle incoming SIP INVITE
 */
async function handleInvite(req, res, options) {
  const { mediaServer, deviceRegistry } = options;
  const signal = options.signal || null;

  // The outer SIP listener authenticates the exact Asterisk trunk before it
  // enters the active-call registry. Consume that one-use in-process admission
  // here before reading caller identity or touching device, media, thread, or
  // approval state. Direct/internal calls to this handler therefore fail closed.
  if (!options.inboundTrunkAuthenticator?.consumeAdmission?.(options.inboundAdmission)) {
    try { res.send(403); } catch {}
    return { callerId: null, callUuid: null, unauthorized: true };
  }
  let capacityHealth = null;
  try { capacityHealth = options.stateCapacityGuard?.check?.(); } catch {}
  if (capacityHealth?.ok !== true) {
    try { res.send(503); } catch {}
    return {
      callerId: null,
      callUuid: null,
      unavailable: capacityHealth?.code || 'VOICE_STATE_BOUNDARY_INVALID',
    };
  }

  const callerId = extractCallerId(req);
  const dialedExt = extractDialedExtension(req);
  let sessionKey = null;
  let startupAnnouncement = null;
  let sessionEndPreserveSeconds = 0;
  let resumeCacheExtension = dialedExt;
  let skipGreeting = false;
  let realtimeResume = false;
  let isRealtimeVoice = false;
  let endpoint = null;
  let dialog = null;
  let cleanupPromise = null;

  const cleanupCallResources = async () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures = [];
      if (dialog && !dialog.destroyed && typeof dialog.destroy === 'function') {
        try { await dialog.destroy(); } catch (error) { failures.push(error); }
      }
      if (endpoint && !endpoint.destroyed && typeof endpoint.destroy === 'function') {
        try { await endpoint.destroy(); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Inbound SIP/media cleanup failed');
      }
      return { success: true };
    })();
    return cleanupPromise;
  };

  if (signal?.aborted) {
    try { res.send(503); } catch (error) {}
    return { callerId, callUuid: null, aborted: true };
  }

  // Look up device config using deviceRegistry.get() (works with name OR extension)
  let deviceConfig = null;
  if (deviceRegistry && dialedExt) {
    deviceConfig = deviceRegistry.get(dialedExt);
    if (deviceConfig) {
      console.log('[' + new Date().toISOString() + '] CALL Device matched: ' + deviceConfig.name + ' (ext ' + dialedExt + ')');
    } else {
      console.log('[' + new Date().toISOString() + '] CALL Unknown extension ' + dialedExt + ', using default');
      deviceConfig = deviceRegistry.getDefault();
    }
  }

  const resumeTargetExtension = deviceConfig?.resumeTargetExtension;
  const baseDeviceConfig = resumeTargetExtension
    ? (deviceRegistry?.get(resumeTargetExtension) || deviceConfig)
    : deviceConfig;
  isRealtimeVoice = baseDeviceConfig?.voiceMode === 'openai-realtime';

  if (isRealtimeVoice) {
    deviceConfig = baseDeviceConfig;
    realtimeResume = Boolean(resumeTargetExtension);
    resumeCacheExtension = resumeTargetExtension || dialedExt;
    startupAnnouncement = realtimeResume ? 'Resume requested.' : 'Fresh voice thread requested.';
  } else if (resumeTargetExtension) {
    resumeCacheExtension = resumeTargetExtension;

    if (baseDeviceConfig) {
      deviceConfig = baseDeviceConfig;
    }

    const recentSession = getRecentSession(callerId, resumeTargetExtension);
    sessionEndPreserveSeconds = getResumeTtlSeconds(deviceConfig);

    if (recentSession.hit && recentSession.entry?.sessionKey) {
      sessionKey = recentSession.entry.sessionKey;
      startupAnnouncement = `Resuming your recent ${deviceConfig.name} session.`;
      skipGreeting = true;
      console.log(
        '[' + new Date().toISOString() + '] CALL Resume hit for caller ' + callerId +
        ' ext ' + resumeTargetExtension + ' using session ' + sessionKey
      );
    } else {
      startupAnnouncement = `I couldn't find a recent ${deviceConfig.name} session, so I'm starting a fresh one.`;
      console.log(
        '[' + new Date().toISOString() + '] CALL Resume miss for caller ' + callerId +
        ' ext ' + resumeTargetExtension + ' reason ' + recentSession.reason
      );
    }
  } else {
    sessionEndPreserveSeconds = getResumeTtlSeconds(deviceConfig);
  }

  if (isRealtimeVoice && !getRealtimeApiKey()) {
    console.error('[' + new Date().toISOString() + '] CALL OpenAI Realtime extension unavailable: OPENAI_REALTIME_API_KEY is missing');
    try { res.send(503); } catch (e) {}
    return { callerId, callUuid: null, unavailable: 'openai_realtime_not_configured' };
  }

  console.log('[' + new Date().toISOString() + '] CALL Incoming from: ' + callerId + ' to ext: ' + (dialedExt || 'unknown'));

  try {
    if (signal?.aborted) throw new Error('inbound_call_aborted');
    // Strip video from SDP to avoid FreeSWITCH 488 error with unsupported video codecs
    const originalSdp = req.body;
    const audioOnlySdp = stripVideoFromSdp(originalSdp);
    if (originalSdp !== audioOnlySdp) {
      console.log('[' + new Date().toISOString() + '] CALL Stripped video track from SDP');
    }

    const result = await mediaServer.connectCaller(req, res, { remoteSdp: audioOnlySdp });
    endpoint = result.endpoint;
    dialog = result.dialog;
    options.onResources?.({ endpoint, dialog, cleanup: cleanupCallResources });
    if (signal?.aborted) {
      await cleanupCallResources();
      return { callerId, callUuid: endpoint?.uuid || null, aborted: true };
    }
    const callUuid = endpoint.uuid;
    sessionKey = sessionKey || callUuid;

    console.log(
      '[' + new Date().toISOString() + '] CALL Connected: ' + callUuid +
      ' sessionKey: ' + sessionKey +
      ' resumeExt: ' + (resumeCacheExtension || 'none') +
      ' preserveSeconds: ' + sessionEndPreserveSeconds
    );

    dialog.on('destroy', function() {
      console.log('[' + new Date().toISOString() + '] CALL Ended');
      void cleanupCallResources().catch(function() {});
    });

    if (isRealtimeVoice) {
      await runRealtimeConversation(endpoint, dialog, callUuid, {
        audioForkServer: options.audioForkServer,
        wsPort: options.wsPort,
        stateStore: options.voiceStateStore,
        jobBroker: options.agentJobBroker,
        callerId,
        callbackTarget: callerId,
        resume: realtimeResume,
        startupAnnouncement,
        defaultProfile: deviceConfig?.defaultAgentProfile || 'codex-terra',
        resumeTtlSeconds: deviceConfig?.voiceThreadTtlSeconds || 86400,
      });
    } else {
      await runConversationLoop(endpoint, dialog, callUuid, {
        audioForkServer: options.audioForkServer,
        whisperClient: options.whisperClient,
        claudeBridge: options.claudeBridge,
        ttsService: options.ttsService,
        wsPort: options.wsPort,
        deviceConfig: deviceConfig,
        maxTurns: deviceConfig?.maxTurns,
        sessionKey,
        sessionEndPreserveSeconds,
        startupAnnouncement,
        callbackTarget: callerId,
        skipGreeting,
        onSessionEnded: async (endSessionResult) => {
          if (!endSessionResult?.hadSession || !endSessionResult?.preserved || !resumeCacheExtension) {
            console.log(
              '[' + new Date().toISOString() + '] CALL Session not cached for resume: ' +
              'callUuid=' + callUuid +
              ' sessionKey=' + sessionKey +
              ' hadSession=' + !!endSessionResult?.hadSession +
              ' preserved=' + !!endSessionResult?.preserved
            );
            return;
          }

          rememberRecentSession({
            callerId,
            extension: resumeCacheExtension,
            sessionKey,
            sessionType: deviceConfig?.sessionType || 'phone',
            deviceName: deviceConfig?.name || 'Morpheus',
            ttlSeconds: sessionEndPreserveSeconds,
          });
        }
      });
    }
    await cleanupCallResources();
    return { endpoint: endpoint, dialog: dialog, callerId: callerId, callUuid: callUuid };

  } catch (error) {
    console.error('[' + new Date().toISOString() + '] CALL Error:', error.message);
    try { await cleanupCallResources(); } catch (cleanupError) {}
    if (signal?.aborted) {
      return { endpoint, dialog, callerId, callUuid: endpoint?.uuid || null, aborted: true };
    }
    try { res.send(500); } catch (e) {}
    throw error;
  }
}

module.exports = {
  handleInvite: handleInvite,
  extractCallerId: extractCallerId,
  extractDialedExtension: extractDialedExtension,
};
