'use strict';

const LEGACY_TTS_BASE_URL = 'http://127.0.0.1:18000/v1';
const LEGACY_STT_BASE_URL = 'http://127.0.0.1:18001/v1';
const LEGACY_TTS_MODEL = 'kokoro';
const LEGACY_STT_MODEL = 'whisper-1';

class LegacySpeechConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacySpeechConfigError';
    this.code = 'LEGACY_SPEECH_CONFIG_INVALID';
  }
}

function parseEnabled(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new LegacySpeechConfigError('LEGACY_SPEECH_SERVICES_ENABLED must be true or false');
}

function exactOptional(settings, name, expected) {
  const value = settings?.[name];
  if (value === undefined || value === '') return expected;
  if (value !== expected) {
    throw new LegacySpeechConfigError(`${name} must be the reviewed local value ${expected}`);
  }
  return expected;
}

function loadLegacySpeechConfig(settings = process.env) {
  const enabled = parseEnabled(settings.LEGACY_SPEECH_SERVICES_ENABLED);
  const ttsBaseUrl = exactOptional(settings, 'TTS_BASE_URL', LEGACY_TTS_BASE_URL);
  const sttBaseUrl = exactOptional(settings, 'STT_BASE_URL', LEGACY_STT_BASE_URL);
  const ttsModel = exactOptional(settings, 'TTS_MODEL', LEGACY_TTS_MODEL);
  const sttModel = exactOptional(settings, 'STT_MODEL', LEGACY_STT_MODEL);
  return Object.freeze({ enabled, ttsBaseUrl, sttBaseUrl, ttsModel, sttModel });
}

function requireLegacySpeechConfig(settings = process.env) {
  const config = loadLegacySpeechConfig(settings);
  if (!config.enabled) {
    const error = new LegacySpeechConfigError(
      'Legacy local TTS/STT is disabled; OpenAI Realtime is the production voice path'
    );
    error.code = 'LEGACY_SPEECH_DISABLED';
    throw error;
  }
  return config;
}

module.exports = {
  LEGACY_STT_BASE_URL,
  LEGACY_STT_MODEL,
  LEGACY_TTS_BASE_URL,
  LEGACY_TTS_MODEL,
  LegacySpeechConfigError,
  loadLegacySpeechConfig,
  requireLegacySpeechConfig,
};
