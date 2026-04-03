/**
 * SIP Call Handler with Conversation Loop
 * v12: Device registry integration with proper method names
 */

const { setTimeout: sleep } = require('node:timers/promises');
const { runConversationLoop } = require('./conversation-loop');
const {
  getClaudeTimeoutSeconds,
  getMaxTurns,
} = require('./phone-agent-config');
const {
  getRecentSession,
  getResumeTtlSeconds,
  rememberRecentSession,
} = require('./recent-session-cache');

// Audio cue URLs
const READY_BEEP_URL = 'http://127.0.0.1:3000/static/ready-beep.wav';
const GOTIT_BEEP_URL = 'http://127.0.0.1:3000/static/gotit-beep.wav';
const HOLD_MUSIC_URL = 'http://127.0.0.1:3000/static/hold-music.mp3';

// Default TTS voice for the primary assistant
const DEFAULT_VOICE_ID = process.env.TTS_VOICE || 'af_bella';

// Claude Code-style thinking phrases
const THINKING_PHRASES = [
  "Pondering...",
  "Elucidating...",
  "Cogitating...",
  "Ruminating...",
  "Contemplating...",
  "Consulting the oracle...",
  "Summoning knowledge...",
  "Engaging neural pathways...",
  "Accessing the mainframe...",
  "Querying the void...",
  "Let me think about that...",
  "Processing...",
  "Hmm, interesting question...",
  "One moment...",
  "Searching my brain...",
];

function getRandomThinkingPhrase() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

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

function isGoodbye(transcript) {
  const lower = transcript.toLowerCase().trim();
  const goodbyePhrases = ['goodbye', 'good bye', 'bye', 'hang up', 'end call', "that's all", 'thats all'];
  return goodbyePhrases.some(function(phrase) {
    return lower === phrase || lower.includes(' ' + phrase) ||
           lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase);
  });
}

/**
 * Extract voice-friendly line from Claude's response
 * Priority: VOICE_RESPONSE > CUSTOM COMPLETED > COMPLETED > first sentence
 */
function extractVoiceLine(response) {
  // Priority 1: VOICE_RESPONSE (new format)
  var voiceMatch = response.match(/🗣️\s*VOICE_RESPONSE:\s*([^\n]+)/im);
  if (voiceMatch) {
    var text = voiceMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 60) {
      return text;
    }
  }

  // Priority 2: CUSTOM COMPLETED
  var customMatch = response.match(/🗣️\s*CUSTOM\s+COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (customMatch) {
    text = customMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 50) {
      return text;
    }
  }

  // Priority 3: COMPLETED
  var completedMatch = response.match(/🎯\s*COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (completedMatch) {
    return completedMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
  }

  // Priority 4: First sentence
  var firstSentence = response.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length < 500) {
    return firstSentence.trim();
  }

  return response.substring(0, 500).trim();
}

/**
 * Main conversation loop
 * @param {Object} deviceConfig - Device configuration (name, prompt, voiceId, etc.) or null for default
 */
async function conversationLoop(endpoint, dialog, callUuid, options, deviceConfig) {
  const { ttsService, whisperClient, claudeBridge, wsPort, audioForkServer } = options;

  let session = null;
  let forkRunning = false;

  // Get device-specific settings
  const deviceName = deviceConfig ? deviceConfig.name : 'Morpheus';
  const devicePrompt = deviceConfig ? deviceConfig.prompt : null;
  const sessionType = (deviceConfig && deviceConfig.sessionType) ? deviceConfig.sessionType : 'phone';
  const voiceId = (deviceConfig && deviceConfig.voiceId) ? deviceConfig.voiceId : DEFAULT_VOICE_ID;
  const claudeTimeoutSeconds = getClaudeTimeoutSeconds(deviceConfig);
  const maxTurns = getMaxTurns(deviceConfig);
  const greeting = deviceConfig && deviceConfig.name !== 'Morpheus'
    ? "Hello! I'm " + deviceConfig.name + ". How can I help you today?"
    : "Hello! I'm your server. How can I help you today?";

  try {
    console.log('[' + new Date().toISOString() + '] CONVERSATION Starting (session: ' + callUuid + ', device: ' + deviceName + ', voice: ' + voiceId + ')...');

    // Play device-specific greeting with device voice
    const greetingUrl = await ttsService.generateSpeech(greeting, voiceId);
    await endpoint.play(greetingUrl);

    // Start fork for entire call
    const wsUrl = 'ws://127.0.0.1:' + wsPort + '/' + encodeURIComponent(callUuid);
    const sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });

    await endpoint.forkAudioStart({
      wsUrl: wsUrl,
      mixType: 'mono',
      sampling: '16k'
    });
    forkRunning = true;

    session = await sessionPromise;
    console.log('[' + new Date().toISOString() + '] AUDIO Fork connected');

    // Main conversation loop
    let turnCount = 0;

    while (turnCount < maxTurns) {
      turnCount++;
      console.log('[' + new Date().toISOString() + '] CONVERSATION Turn ' + turnCount + '/' + maxTurns + ' (Claude timeout: ' + claudeTimeoutSeconds + 's)');

      // READY BEEP
      try {
        await endpoint.play(READY_BEEP_URL);
      } catch (e) {
        console.log('[' + new Date().toISOString() + '] BEEP: Ready beep failed, continuing');
      }

      session.setCaptureEnabled(true);
      console.log('[' + new Date().toISOString() + '] LISTEN Waiting for speech...');

      let utterance = null;
      try {
        utterance = await session.waitForUtterance({ timeoutMs: 30000 });
        console.log('[' + new Date().toISOString() + '] LISTEN Got: ' + utterance.audio.length + ' bytes');
      } catch (err) {
        console.log('[' + new Date().toISOString() + '] LISTEN Timeout: ' + err.message);
      }

      session.setCaptureEnabled(false);

      if (!utterance) {
        const promptUrl = await ttsService.generateSpeech("I didn't hear anything. Are you still there?", voiceId);
        await endpoint.play(promptUrl);
        continue;
      }

      // GOT-IT BEEP
      try {
        await endpoint.play(GOTIT_BEEP_URL);
      } catch (e) {
        console.log('[' + new Date().toISOString() + '] BEEP: Got-it beep failed, continuing');
      }

      // Transcribe
      const transcript = await whisperClient.transcribe(utterance.audio, {
        format: 'pcm',
        sampleRate: 16000
      });

      console.log('[' + new Date().toISOString() + '] WHISPER: "' + transcript + '"');

      if (!transcript || transcript.trim().length < 2) {
        const clarifyUrl = await ttsService.generateSpeech("Sorry, I didn't catch that. Could you repeat?", voiceId);
        await endpoint.play(clarifyUrl);
        continue;
      }

      if (isGoodbye(transcript)) {
        const byeUrl = await ttsService.generateSpeech("Goodbye! Call again anytime.", voiceId);
        await endpoint.play(byeUrl);
        break;
      }

      // THINKING FEEDBACK
      const thinkingPhrase = getRandomThinkingPhrase();
      console.log('[' + new Date().toISOString() + '] THINKING: "' + thinkingPhrase + '"');
      const thinkingUrl = await ttsService.generateSpeech(thinkingPhrase, voiceId);
      await endpoint.play(thinkingUrl);

      // Hold music in background
      let musicPlaying = false;
      endpoint.play(HOLD_MUSIC_URL).catch(function(e) {
        console.log('[' + new Date().toISOString() + '] MUSIC: Hold music failed, continuing');
      });
      musicPlaying = true;

      // Query Claude with device-specific prompt
      console.log('[' + new Date().toISOString() + '] CLAUDE Querying (device: ' + deviceName + ')...');
      const claudeResponse = await claudeBridge.query(
        transcript,
        {
          callId: callUuid,
          devicePrompt: devicePrompt,
          sessionType: sessionType,
          timeout: claudeTimeoutSeconds
        }
      );

      // Stop hold music
      if (musicPlaying) {
        try {
          await endpoint.api('uuid_break', endpoint.uuid);
        } catch (e) {}
      }

      console.log('[' + new Date().toISOString() + '] CLAUDE Response received');

      // Extract and play voice line with device voice
      const voiceLine = extractVoiceLine(claudeResponse);
      console.log('[' + new Date().toISOString() + '] VOICE: "' + voiceLine + '"');

      const responseUrl = await ttsService.generateSpeech(voiceLine, voiceId);
      await endpoint.play(responseUrl);

      console.log('[' + new Date().toISOString() + '] CONVERSATION Turn ' + turnCount + ' complete');
    }

    if (turnCount >= maxTurns) {
      const maxUrl = await ttsService.generateSpeech("We've been talking for a while. Goodbye!", voiceId);
      await endpoint.play(maxUrl);
    }

  } catch (error) {
    console.error('[' + new Date().toISOString() + '] CONVERSATION Error:', error.message);
    try {
      if (session) session.setCaptureEnabled(false);
      const errUrl = await ttsService.generateSpeech("Sorry, something went wrong.", voiceId);
      await endpoint.play(errUrl);
    } catch (e) {}
  } finally {
    console.log('[' + new Date().toISOString() + '] CONVERSATION Cleanup...');

    try {
      await claudeBridge.endSession(callUuid);
    } catch (e) {}

    if (forkRunning) {
      try {
        await endpoint.forkAudioStop();
      } catch (e) {}
    }

    try { dialog.destroy(); } catch (e) {}
  }
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
  let sessionKey = null;
  let startupAnnouncement = null;
  let sessionEndPreserveSeconds = 0;
  let resumeCacheExtension = dialedExt;

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
  extractDialedExtension: extractDialedExtension
};
