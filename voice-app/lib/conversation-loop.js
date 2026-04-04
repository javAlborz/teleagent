/**
 * Shared Conversation Loop
 * Extracted from sip-handler.js for use by both inbound and outbound calls
 *
 * Features:
 * - VAD-based speech detection
 * - DTMF # key to end speech early
 * - DTMF * key to cancel in-flight Claude work
 * - Spoken cancel phrases during the thinking phase
 * - Whisper transcription
 * - Claude API integration
 * - TTS response generation
 * - Turn-taking audio cues (beeps)
 * - Hold music during processing
 */

const logger = require('./logger');
const fs = require('fs');
const path = require('path');
const {
  getClaudeTimeoutSeconds,
  getHoldMusicEnabled,
  getMaxTurns,
} = require('./phone-agent-config');

// Audio cue URLs
const READY_BEEP_URL = 'http://127.0.0.1:3000/static/ready-beep.wav';
const GOTIT_BEEP_URL = 'http://127.0.0.1:3000/static/gotit-beep.wav';
const STATIC_AUDIO_DIR = path.join(__dirname, '..', 'static');
const HOLD_MUSIC_DIR = path.join(STATIC_AUDIO_DIR, 'hold-music');
const HOLD_MUSIC_URL_PREFIX = 'http://127.0.0.1:3000/static/hold-music';
const HOLD_MUSIC_FALLBACK_FILE = path.join(STATIC_AUDIO_DIR, 'hold-music.mp3');
const HOLD_MUSIC_FALLBACK_URL = 'http://127.0.0.1:3000/static/hold-music.mp3';
let nextHoldMusicFileIndex = 0;
const CANCEL_ACKNOWLEDGEMENT = 'Stopped.';
const SPOKEN_CANCEL_ENABLED = true;
const SPOKEN_CANCEL_LISTEN_TIMEOUT_MS = 1000;
const SPOKEN_CANCEL_PHRASES = new Set([
  'cancel request',
  'cancel requests',
  'cancel the request',
  'cancel the requests',
  'please cancel request',
  'please cancel requests',
  'cancel request please',
  'cancel requests please',
]);

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

function getNextHoldMusicUrl() {
  try {
    const files = fs.readdirSync(HOLD_MUSIC_DIR)
      .filter((filename) => /\.mp3$/i.test(filename))
      .sort();

    if (files.length > 0) {
      const selectedIndex = nextHoldMusicFileIndex % files.length;
      nextHoldMusicFileIndex = (selectedIndex + 1) % files.length;
      const selected = files[selectedIndex];
      return `${HOLD_MUSIC_URL_PREFIX}/${encodeURIComponent(selected)}`;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to read hold music directory', {
        directory: HOLD_MUSIC_DIR,
        error: error.message,
      });
    }
  }

  if (fs.existsSync(HOLD_MUSIC_FALLBACK_FILE)) {
    return HOLD_MUSIC_FALLBACK_URL;
  }

  return null;
}

function isGoodbye(transcript) {
  const lower = transcript.toLowerCase().trim();
  const goodbyePhrases = ['goodbye', 'good bye', 'bye', 'hang up', 'end call', "that's all", 'thats all'];
  return goodbyePhrases.some(phrase => {
    return lower === phrase || lower.includes(` ${phrase}`) ||
           lower.startsWith(`${phrase} `) || lower.endsWith(` ${phrase}`);
  });
}

function normalizeControlTranscript(transcript) {
  return String(transcript || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpokenCancelPhrase(transcript) {
  const normalized = normalizeControlTranscript(transcript);
  if (!normalized) return false;

  const wordCount = normalized.split(' ').filter(Boolean).length;
  if (wordCount > 4) return false;

  return SPOKEN_CANCEL_PHRASES.has(normalized);
}

function isUtteranceTimeoutError(error) {
  return Boolean(
    error?.message &&
    error.message.startsWith('Timed out waiting for utterance')
  );
}

async function watchForSpokenCancel({
  session,
  callUuid,
  whisperClient,
  isActive,
  onCancel,
}) {
  logger.info('Spoken cancel watcher started', { callUuid });
  session.setCaptureEnabled(true);

  try {
    while (isActive()) {
      let utterance = null;
      try {
        utterance = await session.waitForUtterance({
          timeoutMs: SPOKEN_CANCEL_LISTEN_TIMEOUT_MS,
          logTimeout: false,
        });
      } catch (error) {
        if (!isActive()) break;

        if (isUtteranceTimeoutError(error)) {
          continue;
        }

        logger.warn('Spoken cancel utterance wait failed', {
          callUuid,
          error: error.message,
        });
        continue;
      }

      if (!utterance || !isActive()) {
        continue;
      }

      let transcript = '';
      try {
        transcript = await whisperClient.transcribe(utterance.audio, {
          format: 'pcm',
          sampleRate: 16000,
        });
      } catch (error) {
        if (!isActive()) break;

        logger.warn('Spoken cancel transcription failed', {
          callUuid,
          error: error.message,
        });
        continue;
      }

      const normalized = normalizeControlTranscript(transcript);
      if (!normalized) {
        continue;
      }

      logger.info('Spoken cancel candidate', {
        callUuid,
        transcript: normalized,
        reason: utterance.reason,
      });

      if (!isSpokenCancelPhrase(normalized)) {
        continue;
      }

      logger.info('Spoken cancel phrase detected', {
        callUuid,
        transcript: normalized,
      });

      const canceled = await onCancel(normalized);
      if (canceled) {
        return true;
      }
    }
  } finally {
    session.setCaptureEnabled(false);
    logger.info('Spoken cancel watcher stopped', { callUuid });
  }

  return false;
}

/**
 * Extract voice-friendly line from Claude's response
 * Priority: VOICE_RESPONSE > CUSTOM COMPLETED > COMPLETED > first sentence
 */
function extractVoiceLine(response) {
  /**
   * Clean markdown and formatting from text for speech
   */
  function cleanForSpeech(text) {
    return text
      .replace(/\*+/g, '')              // Remove bold/italic markers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Convert [text](url) to just text
      .replace(/\[([^\]]+)\]/g, '$1')   // Remove remaining brackets
      .trim();
  }

  // Priority 1: Check for new VOICE_RESPONSE line (voice-optimized content)
  const voiceMatch = response.match(/🗣️\s*VOICE_RESPONSE:\s*([^\n]+)/im);
  if (voiceMatch) {
    const text = cleanForSpeech(voiceMatch[1]);
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

    // Accept if under 60 words
    if (text && wordCount <= 60) {
      return text;
    }

    // If too long, log warning but continue to next fallback
    logger.warn('VOICE_RESPONSE too long, falling back', { wordCount, maxWords: 60 });
  }

  // Priority 2: Check for legacy CUSTOM COMPLETED line
  const customMatch = response.match(/🗣️\s*CUSTOM\s+COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (customMatch) {
    const text = cleanForSpeech(customMatch[1]);
    if (text && text.split(/\s+/).length <= 50) {
      return text;
    }
  }

  // Priority 3: Check for standard COMPLETED line
  const completedMatch = response.match(/🎯\s*COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (completedMatch) {
    return cleanForSpeech(completedMatch[1]);
  }

  // Priority 4: Fallback to first sentence
  const firstSentence = response.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length < 500) {
    return firstSentence.trim();
  }

  // Last resort: truncate
  return response.substring(0, 500).trim();
}

/**
 * Run the conversation loop
 *
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {Object} dialog - SIP dialog
 * @param {string} callUuid - Unique call identifier
 * @param {Object} options - Configuration options
 * @param {Object} options.audioForkServer - WebSocket audio fork server
 * @param {Object} options.whisperClient - Whisper transcription client
 * @param {Object} options.claudeBridge - Claude API bridge
 * @param {Object} options.ttsService - TTS service
 * @param {number} options.wsPort - WebSocket port
 * @param {string} [options.initialContext] - Context for outbound calls (why we're calling)
 * @param {boolean} [options.skipGreeting=false] - Skip greeting (for outbound, greeting already played)
 * @param {number} [options.maxTurns=20] - Maximum conversation turns
 * @param {string} [options.sessionKey=callUuid] - Stable Claude session key for resumable context
 * @param {number} [options.sessionEndPreserveSeconds=0] - Preserve Claude session after hangup for this many seconds
 * @param {string} [options.startupAnnouncement] - Optional message to play before the normal greeting
 * @param {Function} [options.onSessionEnded] - Callback invoked with end-session result
 * @returns {Promise<void>}
 */
async function runConversationLoop(endpoint, dialog, callUuid, options) {
  const {
    audioForkServer,
    whisperClient,
    claudeBridge,
    ttsService,
    wsPort,
    initialContext = null,
    skipGreeting = false,
    deviceConfig = null,
    maxTurns = 20,
    sessionKey = callUuid,
    sessionEndPreserveSeconds = 0,
    startupAnnouncement = null,
    onSessionEnded = null,
  } = options;

  // Extract devicePrompt and voiceId from deviceConfig (for Cephanie etc)
  const devicePrompt = deviceConfig?.prompt || null;
  const sessionType = deviceConfig?.sessionType || 'phone';
  const voiceId = deviceConfig?.voiceId || null;  // null = use default Morpheus voice
  const claudeTimeoutSeconds = getClaudeTimeoutSeconds(deviceConfig);
  const holdMusicEnabled = getHoldMusicEnabled(deviceConfig);
  const resolvedMaxTurns = getMaxTurns(deviceConfig, maxTurns);
  const holdMusicUrl = holdMusicEnabled ? getNextHoldMusicUrl() : null;
  let holdMusicSeekOffset = 0;
  let holdMusicStopRequested = false;
  let session = null;
  let forkRunning = false;
  let callActive = true;
  let dtmfHandler = null;
  let claudeInFlight = false;
  let cancelRequested = false;

  // Track when call ends to prevent operations on dead endpoints
  const onDialogDestroy = () => {
    callActive = false;
    logger.info('Call ended (dialog destroyed)', { callUuid });
  };

  try {
    logger.info('Conversation loop starting', {
      callUuid,
      sessionKey,
      sessionEndPreserveSeconds,
      skipGreeting,
      hasInitialContext: !!initialContext,
      holdMusicEnabled,
      holdMusicUrl,
      startupAnnouncement: !!startupAnnouncement,
    });

    // Listen for call end
    dialog.on('destroy', onDialogDestroy);

    if (startupAnnouncement && callActive) {
      const startupAnnouncementUrl = await ttsService.generateSpeech(
        startupAnnouncement,
        voiceId
      );
      await endpoint.play(startupAnnouncementUrl);
    }

    // Play greeting (skip for outbound where initial message already played)
    if (!skipGreeting && callActive) {
      const greetingUrl = await ttsService.generateSpeech(
        "Hello! I'm your server. How can I help you today?",
        voiceId
      );
      await endpoint.play(greetingUrl);
    }

    // Prime Claude with context if this is an outbound call (NON-BLOCKING)
    // Fire-and-forget: we don't use the response, just establishing session context
    if (initialContext && callActive) {
      logger.info('Priming Claude with outbound context (non-blocking)', { callUuid });
      claudeBridge.query(
        `[SYSTEM CONTEXT - DO NOT REPEAT]: You just called the user to tell them: "${initialContext}". They have answered. Now listen to their response and help them.`,
        {
          callId: callUuid,
          sessionKey,
          devicePrompt: devicePrompt,
          isSystemPrime: true,
          sessionType,
          timeout: claudeTimeoutSeconds
        }
      ).catch(err => logger.warn('Prime query failed', { callUuid, error: err.message }));
    }

    // Check if call is still active before starting audio fork
    if (!callActive) {
      logger.info('Call ended before audio fork could start', { callUuid });
      return;
    }

    // Start audio fork for entire call
    const wsUrl = `ws://127.0.0.1:${wsPort}/${encodeURIComponent(callUuid)}`;

    // Use try-catch for expectSession to handle race conditions
    let sessionPromise;
    try {
      sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });
    } catch (err) {
      logger.warn('Failed to set up session expectation', { callUuid, error: err.message });
      return;
    }

    await endpoint.forkAudioStart({
      wsUrl,
      mixType: 'mono',
      sampling: '16k'
    });
    forkRunning = true;

    try {
      session = await sessionPromise;
      logger.info('Audio fork connected', { callUuid });
    } catch (err) {
      logger.warn('Audio fork session failed', { callUuid, error: err.message });
      // Cancel the pending expectation if still there
      audioForkServer.cancelExpectation && audioForkServer.cancelExpectation(callUuid);
      return;
    }

    const requestCancel = async (reason, source, extra = {}) => {
      if (!claudeInFlight || cancelRequested) {
        return false;
      }

      cancelRequested = true;
      logger.info('Cancel requested', {
        callUuid,
        sessionKey,
        reason,
        source,
        ...extra,
      });

      try {
        const result = await claudeBridge.cancelSession(callUuid, {
          sessionKey,
          resetSession: false,
          reason,
        });

        logger.info('Cancel request completed', {
          callUuid,
          sessionKey,
          source,
          success: !!result.success,
          canceledCount: result.canceledCount || 0,
        });
      } catch (error) {
        logger.warn('Cancel request failed', {
          callUuid,
          sessionKey,
          source,
          error: error.message,
        });
      }

      try {
        await endpoint.api('uuid_break', endpoint.uuid);
      } catch (error) {
        logger.warn('Cancel audio break failed', {
          callUuid,
          source,
          error: error.message,
        });
      }

      return true;
    };

    const startHoldMusic = () => {
      if (!callActive || !holdMusicUrl) {
        if (callActive && holdMusicEnabled) {
          logger.info('No hold music file available', { callUuid });
        }
        return null;
      }

      const playbackOptions = {
        file: holdMusicUrl,
        seekOffset: holdMusicSeekOffset,
      };
      holdMusicStopRequested = false;

      logger.info('Starting hold music playback', {
        callUuid,
        holdMusicUrl,
        seekOffset: holdMusicSeekOffset,
      });

      return endpoint.play(playbackOptions)
        .then((result) => {
          const nextOffset = Number.parseInt(result?.playbackLastOffsetPos, 10);
          if (holdMusicStopRequested && Number.isFinite(nextOffset) && nextOffset >= 0) {
            holdMusicSeekOffset = nextOffset;
          } else if (!holdMusicStopRequested) {
            holdMusicSeekOffset = 0;
          }

          logger.info('Hold music playback finished', {
            callUuid,
            holdMusicUrl,
            playbackMilliseconds: result?.playbackMilliseconds,
            playbackLastOffsetPos: result?.playbackLastOffsetPos,
            nextSeekOffset: holdMusicSeekOffset,
          });

          return result;
        })
        .catch((error) => {
          logger.warn('Hold music failed', {
            callUuid,
            holdMusicUrl,
            seekOffset: holdMusicSeekOffset,
            error: error.message,
          });
          return null;
        });
    };

    const stopHoldMusic = async (playbackPromise) => {
      if (!playbackPromise || !callActive) {
        return;
      }

      holdMusicStopRequested = true;

      try {
        await endpoint.api('uuid_break', endpoint.uuid);
      } catch (error) {
        logger.debug('Hold music break ignored', {
          callUuid,
          error: error.message,
        });
      }

      await playbackPromise;
    };

    // Set up DTMF handler for # (finalize speech) and * (cancel active work)
    dtmfHandler = (evt) => {
      const digit = evt.dtmf || evt.digit;
      logger.info('DTMF received', { callUuid, digit });

      if (digit === '#' && session) {
        logger.info('DTMF # pressed - forcing utterance finalization', { callUuid });
        session.forceFinalize();
        return;
      }

      if (digit === '*' && claudeInFlight && !cancelRequested) {
        logger.info('DTMF * pressed - canceling active Claude work', { callUuid });
        requestCancel('dtmf_cancel', 'dtmf').catch((error) => {
          logger.warn('DTMF cancel request failed', { callUuid, error: error.message });
        });
        return;
      }

      if (digit === '*') {
        logger.info('DTMF * pressed with no active Claude work', { callUuid });
      }
    };

    // Enable DTMF detection on endpoint
    try {
      // Tell FreeSWITCH to detect DTMF
      await endpoint.api('uuid_recv_dtmf', `${endpoint.uuid} true`);
      endpoint.on('dtmf', dtmfHandler);
      logger.info('DTMF detection enabled', { callUuid });
    } catch (err) {
      logger.warn('Failed to enable DTMF detection', { callUuid, error: err.message });
      // Continue without DTMF - not critical
    }

    // Emit session event for external monitoring
    if (audioForkServer.emit) {
      audioForkServer.emit('session', session);
    }
    console.log('[AUDIO] New session for call ' + callUuid);

    // Main conversation loop
    let turnCount = 0;

    while (turnCount < resolvedMaxTurns && callActive) {
      turnCount++;
      logger.info('Conversation turn', {
        callUuid,
        turn: turnCount,
        maxTurns: resolvedMaxTurns,
        claudeTimeoutSeconds
      });

      // Check if call is still active
      if (!callActive) {
        logger.info('Call ended during turn', { callUuid, turn: turnCount });
        break;
      }

      // ============================================
      // READY BEEP: Signal "your turn to speak"
      // ============================================
      try {
        if (callActive) await endpoint.play(READY_BEEP_URL);
      } catch (e) {
        if (!callActive) break;
        logger.warn('Ready beep failed', { callUuid, error: e.message });
      }

      // Enable capture and wait for speech
      session.setCaptureEnabled(true);
      logger.info('Waiting for speech (press # to send immediately)', { callUuid });

      let utterance = null;
      try {
        utterance = await session.waitForUtterance({ timeoutMs: 30000 });
        logger.info('Got utterance', { callUuid, bytes: utterance.audio.length, reason: utterance.reason });
      } catch (err) {
        if (!callActive) break;
        logger.info('Utterance timeout', { callUuid, error: err.message });
      }

      session.setCaptureEnabled(false);

      // Check if call ended during speech detection
      if (!callActive) {
        logger.info('Call ended during speech detection', { callUuid });
        break;
      }

      // Handle no speech
      if (!utterance) {
        const promptUrl = await ttsService.generateSpeech(
          "I didn't hear anything. Are you still there?",
          voiceId
        );
        if (callActive) await endpoint.play(promptUrl);
        continue;
      }

      // ============================================
      // GOT-IT BEEP: Signal "I heard you, processing"
      // ============================================
      try {
        if (callActive) await endpoint.play(GOTIT_BEEP_URL);
      } catch (e) {
        if (!callActive) break;
        logger.warn('Got-it beep failed', { callUuid, error: e.message });
      }

      // Transcribe
      const transcript = await whisperClient.transcribe(utterance.audio, {
        format: 'pcm',
        sampleRate: 16000
      });

      logger.info('Transcribed', { callUuid, transcript });

      // Handle empty transcription
      if (!transcript || transcript.trim().length < 2) {
        const clarifyUrl = await ttsService.generateSpeech(
          "Sorry, I didn't catch that. Could you repeat?",
          voiceId
        );
        if (callActive) await endpoint.play(clarifyUrl);
        continue;
      }

      // Handle goodbye
      if (isGoodbye(transcript)) {
        const byeUrl = await ttsService.generateSpeech("Goodbye! Call again anytime.", voiceId);
        if (callActive) await endpoint.play(byeUrl);
        break;
      }

      // ============================================
      // THINKING FEEDBACK
      // ============================================

      // Check if call still active before thinking feedback
      if (!callActive) break;

      // 1. Play random thinking phrase
      const thinkingPhrase = getRandomThinkingPhrase();
      logger.info('Playing thinking phrase', { callUuid, phrase: thinkingPhrase });
      const thinkingUrl = await ttsService.generateSpeech(thinkingPhrase, voiceId);
      if (callActive) await endpoint.play(thinkingUrl);

      // 2. Start hold music in background
      const holdMusicPlayback = startHoldMusic();

      // 3. Query Claude
      logger.info('Querying Claude', { callUuid, sessionKey });
      let claudeResult;
      let spokenCancelWatcher = null;
      const spokenCancelState = { stopped: false };
      claudeInFlight = true;
      cancelRequested = false;
      try {
        if (SPOKEN_CANCEL_ENABLED) {
          spokenCancelWatcher = watchForSpokenCancel({
            session,
            callUuid,
            whisperClient,
            isActive: () => (
              callActive &&
              claudeInFlight &&
              !cancelRequested &&
              !spokenCancelState.stopped
            ),
            onCancel: (spokenTranscript) => requestCancel('spoken_cancel', 'spoken', {
              transcript: spokenTranscript,
            }),
          }).catch((error) => {
            logger.warn('Spoken cancel watcher failed', {
              callUuid,
              error: error.message,
            });
            return false;
          });
        }

        claudeResult = await claudeBridge.queryDetailed(
          transcript,
          {
            callId: callUuid,
            sessionKey,
            devicePrompt: devicePrompt,
            sessionType,
            timeout: claudeTimeoutSeconds
          }
        );
      } finally {
        claudeInFlight = false;
        spokenCancelState.stopped = true;

        if (spokenCancelWatcher) {
          await spokenCancelWatcher;
        }
      }

      // 4. Stop hold music
      await stopHoldMusic(holdMusicPlayback);

      // Check if call ended during Claude processing
      if (!callActive) {
        logger.info('Call ended during Claude processing', { callUuid });
        break;
      }

      if (cancelRequested) {
        logger.info('Claude work canceled', { callUuid, turn: turnCount });
        const canceledUrl = await ttsService.generateSpeech(CANCEL_ACKNOWLEDGEMENT, voiceId);
        if (callActive) await endpoint.play(canceledUrl);
        continue;
      }

      if (!claudeResult.success) {
        logger.warn('Claude query failed', {
          callUuid,
          code: claudeResult.code || 'CLAUDE_ERROR',
          error: claudeResult.error
        });

        const errorUrl = await ttsService.generateSpeech(
          claudeResult.userMessage || 'Sorry, something went wrong.',
          voiceId
        );
        if (callActive) await endpoint.play(errorUrl);
        continue;
      }

      logger.info('Claude responded', { callUuid });

      // 5. Extract and play voice line
      const voiceLine = extractVoiceLine(claudeResult.response);
      logger.info('Voice line', { callUuid, voiceLine });

      const responseUrl = await ttsService.generateSpeech(voiceLine, voiceId);
      if (callActive) await endpoint.play(responseUrl);

      logger.info('Turn complete', { callUuid, turn: turnCount });
    }

    // Max turns reached
    if (turnCount >= resolvedMaxTurns && callActive) {
      const maxUrl = await ttsService.generateSpeech(
        "We've been talking for a while. Goodbye!",
        voiceId
      );
      await endpoint.play(maxUrl);
    }

    logger.info('Conversation loop ended normally', {
      callUuid,
      sessionKey,
      turns: turnCount,
    });

  } catch (error) {
    logger.error('Conversation loop error', {
      callUuid,
      error: error.message,
      stack: error.stack
    });

    try {
      if (session) session.setCaptureEnabled(false);
      if (callActive) {
        const errUrl = await ttsService.generateSpeech("Sorry, something went wrong.", voiceId);
        await endpoint.play(errUrl);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  } finally {
    logger.info('Conversation loop cleanup', { callUuid, sessionKey });

    // Remove dialog listener
    dialog.off('destroy', onDialogDestroy);

    // Remove DTMF handler
    if (dtmfHandler) {
      endpoint.off('dtmf', dtmfHandler);
    }

    // Cancel any pending session expectations
    if (audioForkServer.cancelExpectation) {
      audioForkServer.cancelExpectation(callUuid);
    }

    // End Claude session
    try {
      const endSessionResult = await claudeBridge.endSession(callUuid, {
        sessionKey,
        preserveForSeconds: sessionEndPreserveSeconds,
      });

      if (typeof onSessionEnded === 'function') {
        await onSessionEnded(endSessionResult);
      }
    } catch (e) {
      // Ignore
    }

    // Stop audio fork
    if (forkRunning) {
      try {
        await endpoint.forkAudioStop();
      } catch (e) {
        // Ignore
      }
    }
  }
}

module.exports = {
  runConversationLoop,
  extractVoiceLine,
  isGoodbye,
  getRandomThinkingPhrase,
  getNextHoldMusicUrl,
  READY_BEEP_URL,
  GOTIT_BEEP_URL
};
