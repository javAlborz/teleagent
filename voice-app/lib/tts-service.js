/**
 * OpenAI-compatible Text-to-Speech Service
 * Generates speech audio files and returns URLs for FreeSWITCH playback.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_TTS_BASE_URL = 'http://127.0.0.1:18000/v1';
const DEFAULT_VOICE_ID = process.env.TTS_VOICE || 'af_bella';
const ALLOWED_VOICE_IDS = new Set(
  (process.env.TTS_ALLOWED_VOICES || '')
    .split(',')
    .map((voice) => voice.trim())
    .filter(Boolean)
);
const MODEL_ID = process.env.TTS_MODEL || 'kokoro';
const RESPONSE_FORMAT = process.env.TTS_RESPONSE_FORMAT || 'mp3';
const TTS_TIMEOUT_MS = parseInt(process.env.TTS_TIMEOUT_MS || '30000', 10);

// Audio output directory (set via setAudioDir)
let audioDir = process.env.AUDIO_DIR || path.join(__dirname, '../audio-temp');

function normalizeBaseUrl(rawUrl) {
  const trimmed = (rawUrl || DEFAULT_TTS_BASE_URL).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function getTtsBaseUrl() {
  return normalizeBaseUrl(process.env.TTS_BASE_URL || DEFAULT_TTS_BASE_URL);
}

function getTtsApiKey() {
  return process.env.TTS_API_KEY || 'not-needed';
}

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

function stringifyErrorData(data) {
  if (!data) return undefined;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
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
  // Hash text to create unique identifier
  const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
  const timestamp = Date.now();
  return `tts-${timestamp}-${hash}.${getAudioExtension()}`;
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
    const baseUrl = getTtsBaseUrl();
    const apiKey = getTtsApiKey();
    const selectedVoiceId = resolveVoiceId(voiceId);

    logger.info('Generating speech with OpenAI-compatible TTS', {
      textLength: text.length,
      voiceId: selectedVoiceId,
      model: MODEL_ID,
      baseUrl
    });

    // Call OpenAI-compatible TTS endpoint (for example Kokoro-FastAPI)
    const response = await axios({
      method: 'POST',
      url: `${baseUrl}/audio/speech`,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      data: {
        input: text,
        model: MODEL_ID,
        voice: selectedVoiceId,
        response_format: RESPONSE_FORMAT,
        speed: parseFloat(process.env.TTS_SPEED || '1.0')
      },
      responseType: 'arraybuffer',
      timeout: TTS_TIMEOUT_MS
    });

    // Generate filename and save audio
    const filename = generateFilename(text);
    const filepath = path.join(audioDir, filename);

    fs.writeFileSync(filepath, response.data);

    const latency = Date.now() - startTime;
    const fileSize = response.data.length;

    logger.info('Speech generation successful', {
      filename,
      fileSize,
      latency,
      textLength: text.length
    });

    // Return HTTP URL (assumes audio-temp is served via HTTP)
    // Format: http://localhost:PORT/audio/filename.mp3
    // The HTTP server setup is handled elsewhere
    const audioUrl = `http://127.0.0.1:3000/audio-files/${filename}`;

    return audioUrl;

  } catch (error) {
    const latency = Date.now() - startTime;

    logger.error('Speech generation failed', {
      error: error.message,
      latency,
      textLength: text?.length,
      responseStatus: error.response?.status,
      responseData: stringifyErrorData(error.response?.data)
    });

    // Handle specific errors
    if (error.response?.status === 401) {
      throw new Error('TTS endpoint authentication failed');
    } else if (error.response?.status === 429) {
      throw new Error('TTS endpoint rate limit exceeded');
    } else if (error.response?.status === 400) {
      throw new Error('Invalid request to TTS endpoint');
    }

    throw new Error(`TTS generation failed: ${error.message}`);
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
    const response = await axios({
      method: 'GET',
      url: `${getTtsBaseUrl()}/audio/voices`,
      headers: {
        'Authorization': `Bearer ${getTtsApiKey()}`
      }
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
    logger.error('Failed to fetch available voices', { error: error.message });
    throw error;
  }
}

// Initialize audio directory
setAudioDir(audioDir);

// Setup periodic cleanup (every 30 minutes)
setInterval(() => {
  cleanupOldFiles();
}, 30 * 60 * 1000);

module.exports = {
  generateSpeech,
  setAudioDir,
  cleanupOldFiles,
  getAvailableVoices
};
