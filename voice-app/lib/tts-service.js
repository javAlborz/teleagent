/**
 * OpenAI-compatible Text-to-Speech Service
 * Generates speech audio files and returns URLs for FreeSWITCH playback.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { requireLegacySpeechConfig } = require('./legacy-speech-config');
const { speechRequestOptions } = require('./voice-egress-transport');

const DEFAULT_VOICE_ID = process.env.TTS_VOICE || 'af_bella';
const ALLOWED_VOICE_IDS = new Set(
  (process.env.TTS_ALLOWED_VOICES || '')
    .split(',')
    .map((voice) => voice.trim())
    .filter(Boolean)
);
const RESPONSE_FORMAT = process.env.TTS_RESPONSE_FORMAT || 'mp3';
const TTS_TIMEOUT_MS = Math.max(
  1000,
  Math.min(Number.parseInt(process.env.TTS_TIMEOUT_MS || '30000', 10) || 30000, 60000)
);
const MAX_TTS_TEXT_BYTES = 64 * 1024;
const MAX_TTS_AUDIO_BYTES = 32 * 1024 * 1024;

// Audio output directory (set via setAudioDir)
let audioDir = process.env.AUDIO_DIR || path.join(__dirname, '../audio-temp');

function getAudioExtension() {
  const format = RESPONSE_FORMAT.toLowerCase();
  return format === 'mpeg' ? 'mp3' : format;
}

function resolveVoiceId(voiceId) {
  const selectedVoiceId = (voiceId || DEFAULT_VOICE_ID).trim() || DEFAULT_VOICE_ID;

  if (ALLOWED_VOICE_IDS.size > 0 && !ALLOWED_VOICE_IDS.has(selectedVoiceId)) {
    throw new Error(
      `TTS voice "${selectedVoiceId}" is not allowed. Allowed voices: ${[...ALLOWED_VOICE_IDS].join(', ')}`
    );
  }

  return selectedVoiceId;
}

function normalizeVoiceList(responseData) {
  if (Array.isArray(responseData?.voices)) {
    return responseData.voices;
  }

  if (Array.isArray(responseData?.voices?.custom)) {
    return responseData.voices.custom;
  }

  return [];
}

function formatEmptyAudioError() {
  return 'TTS endpoint returned empty audio payload';
}

/**
 * Set the audio output directory
 * @param {string} dir - Absolute path to audio directory
 */
function setAudioDir(dir) {
  audioDir = dir;

  // Create directory if it doesn't exist
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    logger.info('Created audio directory', { path: audioDir });
  }
}

/**
 * Generate unique filename for audio file
 * @param {string} text - Text being converted
 * @returns {string} Filename (without path)
 */
function generateFilename(text) {
  // Keep call audio unguessable even to a sibling loopback process that knows
  // the text and approximate generation time.
  void text;
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  return `tts-${timestamp}-${nonce}.${getAudioExtension()}`;
}

/**
 * Convert text to speech using an OpenAI-compatible API
 * @param {string} text - Text to convert to speech
 * @param {string} voiceId - Provider voice ID or name (optional)
 * @returns {Promise<string>} HTTP URL to audio file
 */
async function generateSpeech(text, voiceId = DEFAULT_VOICE_ID) {
  const startTime = Date.now();

  try {
    const legacyConfig = requireLegacySpeechConfig();
    const baseUrl = legacyConfig.ttsBaseUrl;
    const textBytes = Buffer.byteLength(String(text || ''), 'utf8');
    if (textBytes === 0 || textBytes > MAX_TTS_TEXT_BYTES) {
      throw new Error('TTS input must be non-empty and within the local request limit');
    }
    const selectedVoiceId = resolveVoiceId(voiceId);

    logger.info('Generating speech with OpenAI-compatible TTS', {
      textLength: text.length,
      voiceId: selectedVoiceId,
      model: legacyConfig.ttsModel,
    });

    // Call OpenAI-compatible TTS endpoint (for example Kokoro-FastAPI)
    const response = await axios({
      method: 'POST',
      url: `${baseUrl}/audio/speech`,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json'
      },
      data: {
        input: text,
        model: legacyConfig.ttsModel,
        voice: selectedVoiceId,
        response_format: RESPONSE_FORMAT,
        speed: parseFloat(process.env.TTS_SPEED || '1.0')
      },
      responseType: 'arraybuffer',
      timeout: TTS_TIMEOUT_MS,
      maxRedirects: 0,
      maxBodyLength: MAX_TTS_TEXT_BYTES,
      maxContentLength: MAX_TTS_AUDIO_BYTES,
      ...speechRequestOptions('tts'),
    });

    const audioBuffer = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data || '');
    const fileSize = audioBuffer.length;

    if (fileSize === 0) {
      logger.error('TTS endpoint returned empty audio payload', {
        latency: Date.now() - startTime,
        textLength: text.length,
        voiceId: selectedVoiceId,
        model: legacyConfig.ttsModel
      });
      throw new Error(formatEmptyAudioError());
    }

    // Generate filename and save audio
    const filename = generateFilename(text);
    const filepath = path.join(audioDir, filename);

    fs.writeFileSync(filepath, audioBuffer, { flag: 'wx', mode: 0o600 });

    const latency = Date.now() - startTime;

    logger.info('Speech generation successful', {
      filename,
      fileSize,
      latency,
      textLength: text.length
    });

    // FreeSWITCH fetches generated media from the admitted private receiver.
    const audioUrl = require('./media-playback-urls').playbackUrl('audio-files', filename);

    return audioUrl;

  } catch (error) {
    const latency = Date.now() - startTime;

    logger.error('Speech generation failed', {
      latency,
      textLength: text?.length,
      responseStatus: error.response?.status,
      errorCode: error.code || 'TTS_REQUEST_FAILED'
    });

    // Handle specific errors
    if (error.response?.status === 401) {
      throw new Error('TTS endpoint authentication failed');
    } else if (error.response?.status === 429) {
      throw new Error('TTS endpoint rate limit exceeded');
    } else if (error.response?.status === 400) {
      throw new Error('Invalid request to TTS endpoint');
    }

    if (error.message === formatEmptyAudioError() ||
        error.message?.startsWith('TTS input must be')) {
      throw error;
    }
    if (['LEGACY_SPEECH_DISABLED', 'LEGACY_SPEECH_CONFIG_INVALID'].includes(error.code)) {
      throw error;
    }
    throw new Error('TTS generation failed');
  }
}

/**
 * Clean up old audio files (older than specified age)
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 */
function cleanupOldFiles(maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(audioDir);

    let deletedCount = 0;
    files.forEach(file => {
      if (!file.startsWith('tts-') || !file.endsWith('.mp3')) {
        return;
      }

      const filepath = path.join(audioDir, file);
      const stats = fs.statSync(filepath);
      const age = now - stats.mtimeMs;

      if (age > maxAgeMs) {
        fs.unlinkSync(filepath);
        deletedCount++;
      }
    });

    if (deletedCount > 0) {
      logger.info('Cleaned up old audio files', { deletedCount });
    }

  } catch (error) {
    logger.warn('Failed to cleanup old audio files', { error: error.message });
  }
}

/**
 * Get list of available TTS voices
 * @returns {Promise<Array>} Array of voice names
 */
async function getAvailableVoices() {
  try {
    const config = requireLegacySpeechConfig();
    const response = await axios({
      method: 'GET',
      url: `${config.ttsBaseUrl}/audio/voices`,
      timeout: TTS_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: 1024 * 1024,
      ...speechRequestOptions('tts'),
    });

    const voices = normalizeVoiceList(response.data);
    if (ALLOWED_VOICE_IDS.size === 0) {
      return voices;
    }

    const allowedVoices = voices.filter((voiceId) => ALLOWED_VOICE_IDS.has(voiceId));
    if (allowedVoices.length > 0) {
      return allowedVoices;
    }

    return [...ALLOWED_VOICE_IDS];

  } catch (error) {
    logger.error('Failed to fetch available voices', {
      responseStatus: error.response?.status,
      errorCode: error.code || 'TTS_VOICE_LIST_FAILED',
    });
    throw new Error('TTS voice list request failed');
  }
}

// Initialize audio directory
setAudioDir(audioDir);

// Setup periodic cleanup (every 30 minutes)
const cleanupTimer = setInterval(() => {
  cleanupOldFiles();
}, 30 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

module.exports = {
  generateSpeech,
  setAudioDir,
  cleanupOldFiles,
  getAvailableVoices
};
