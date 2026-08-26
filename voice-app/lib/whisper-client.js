/**
 * OpenAI-compatible Whisper client for speech-to-text.
 * Converts audio buffers (L16 PCM from FreeSWITCH) to text.
 */

const WaveFile = require("wavefile").WaveFile;
const { loadLegacySpeechConfig, requireLegacySpeechConfig } = require('./legacy-speech-config');

const MAX_STT_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_STT_RESPONSE_BYTES = 64 * 1024;
const STT_TIMEOUT_MS = 30000;

/**
 * Convert L16 PCM buffer to WAV format for Whisper API
 * @param {Buffer} pcmBuffer - Raw L16 PCM audio data
 * @param {number} sampleRate - Sample rate (default: 8000 Hz for telephony)
 * @returns {Buffer} WAV file buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 8000) {
  const wav = new WaveFile();

  // Convert Buffer to Int16Array for wavefile library
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

  // Create WAV from raw PCM data
  wav.fromScratch(1, sampleRate, "16", samples);

  return Buffer.from(wav.toBuffer());
}

/**
 * Transcribe audio using an OpenAI-compatible Whisper endpoint
 * @param {Buffer} audioBuffer - Audio data (either WAV or raw PCM)
 * @param {Object} options - Transcription options
 * @param {string} options.format - Input format: "wav" or "pcm" (default: "pcm")
 * @param {number} options.sampleRate - Sample rate for PCM (default: 8000)
 * @param {string} options.language - Language code (default: "en")
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(audioBuffer, options = {}) {
  const {
    format = "pcm",
    sampleRate = 8000,
    language = "en"
  } = options;

  const config = requireLegacySpeechConfig();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('The local STT fetch client is unavailable');
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0 ||
      audioBuffer.length > MAX_STT_AUDIO_BYTES) {
    throw new Error('STT audio must be a non-empty bounded Buffer');
  }

  // Convert PCM to WAV if needed
  let wavBuffer;
  if (format === "pcm") {
    wavBuffer = pcmToWav(audioBuffer, sampleRate);
  } else {
    wavBuffer = audioBuffer;
  }

  if (wavBuffer.length > MAX_STT_AUDIO_BYTES) {
    throw new Error('Encoded STT audio exceeds the local request limit');
  }

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', config.sttModel);
  form.append('language', language);
  form.append('response_format', 'text');

  const response = await fetchImpl(`${config.sttBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!response?.ok) {
    throw new Error(`Local STT endpoint failed with status ${Number(response?.status) || 0}`);
  }
  const advertisedLength = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_STT_RESPONSE_BYTES) {
    throw new Error('Local STT response exceeded the size limit');
  }
  const transcription = String(await response.text());
  if (Buffer.byteLength(transcription, 'utf8') > MAX_STT_RESPONSE_BYTES) {
    throw new Error('Local STT response exceeded the size limit');
  }

  console.log(
    `[${new Date().toISOString()}] WHISPER Transcribed chars=${transcription.length}`
  );
  return transcription;
}

/**
 * Check if Whisper API is configured and available
 * @returns {boolean} True if an endpoint URL is available
 */
function isAvailable() {
  return loadLegacySpeechConfig().enabled;
}

module.exports = {
  transcribe,
  pcmToWav,
  isAvailable,
  MAX_STT_AUDIO_BYTES,
  MAX_STT_RESPONSE_BYTES,
};
