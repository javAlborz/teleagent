/**
 * SIP Call Handler with Conversation Loop
 * v12: Device registry integration with proper method names
 */

const { runConversationLoop } = require('./conversation-loop');
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

function extractContactUri(req) {
  const contact = req.get('Contact') || '';
  const bracketMatch = contact.match(/<\s*(sip:[^>]+)\s*>/i);
  if (bracketMatch && bracketMatch[1]) {
    return normalizeCallbackContactUri(bracketMatch[1]);
  }

  const inlineMatch = contact.match(/\b(sip:[^;>\s]+)/i);
  if (inlineMatch && inlineMatch[1]) {
    return normalizeCallbackContactUri(inlineMatch[1]);
  }

  return null;
}

function normalizeCallbackContactUri(contactUri) {
  const uri = String(contactUri || '').trim();
  if (!uri) return null;

  const uriMatch = uri.match(/^sip:([^@]+)@([^;>]+)(.*)$/i);
  if (!uriMatch) return null;

  const user = uriMatch[1].toLowerCase();
  const hostPort = uriMatch[2].toLowerCase();

  // Inbound requests from Asterisk expose its own contact header on loopback.
  // Using that as a callback target causes voice-app to call back into Asterisk
  // itself instead of the handset.
  if (
    user === 'asterisk' ||
    user === 'claude-phone' ||
    hostPort === '127.0.0.1' ||
    hostPort.startsWith('127.0.0.1:') ||
    hostPort === 'localhost' ||
    hostPort.startsWith('localhost:')
  ) {
    return null;
  }

  return uri;
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

  const callerId = extractCallerId(req);
  const dialedExt = extractDialedExtension(req);
  const callbackDialUri = extractContactUri(req);
  let sessionKey = null;
  let startupAnnouncement = null;
  let sessionEndPreserveSeconds = 0;
  let resumeCacheExtension = dialedExt;
  let skipGreeting = false;

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
  if (resumeTargetExtension) {
    resumeCacheExtension = resumeTargetExtension;

    const baseDeviceConfig = deviceRegistry?.get(resumeTargetExtension) || deviceConfig;
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

  console.log('[' + new Date().toISOString() + '] CALL Incoming from: ' + callerId + ' to ext: ' + (dialedExt || 'unknown'));
  if (callbackDialUri) {
    console.log('[' + new Date().toISOString() + '] CALL Callback contact: ' + callbackDialUri);
  }

  try {
    // Strip video from SDP to avoid FreeSWITCH 488 error with unsupported video codecs
    const originalSdp = req.body;
    const audioOnlySdp = stripVideoFromSdp(originalSdp);
    if (originalSdp !== audioOnlySdp) {
      console.log('[' + new Date().toISOString() + '] CALL Stripped video track from SDP');
    }

    const result = await mediaServer.connectCaller(req, res, { remoteSdp: audioOnlySdp });
    const { endpoint, dialog } = result;
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
      if (endpoint) endpoint.destroy().catch(function() {});
    });

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
      callbackDialUri,
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
    try {
      if (!dialog.destroyed) {
        await dialog.destroy();
      }
    } catch (e) {}
    return { endpoint: endpoint, dialog: dialog, callerId: callerId, callUuid: callUuid };

  } catch (error) {
    console.error('[' + new Date().toISOString() + '] CALL Error:', error.message);
    try { res.send(500); } catch (e) {}
    throw error;
  }
}

module.exports = {
  handleInvite: handleInvite,
  extractCallerId: extractCallerId,
  extractDialedExtension: extractDialedExtension,
  extractContactUri,
  normalizeCallbackContactUri,
};
