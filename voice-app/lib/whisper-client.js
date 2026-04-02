/**
 * OpenAI-compatible Whisper client for speech-to-text.
 * Converts audio buffers (L16 PCM from FreeSWITCH) to text.
 */

const OpenAI = require("openai");
const WaveFile = require("wavefile").WaveFile;
const fs = require("fs");
const path = require("path");

// Lazy-initialized OpenAI client
let openai = null;

const DEFAULT_STT_BASE_URL = "http://127.0.0.1:18001/v1";
const DEFAULT_STT_MODEL = process.env.STT_MODEL || "whisper-1";

function normalizeBaseUrl(rawUrl) {
  const trimmed = (rawUrl || DEFAULT_STT_BASE_URL).trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function getOpenAIClient() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.STT_API_KEY || "not-needed",
      baseURL: normalizeBaseUrl(process.env.STT_BASE_URL || DEFAULT_STT_BASE_URL)
    });
  }
  return openai;
}

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

  const client = getOpenAIClient();
  if (!client) {
    throw new Error("STT client not configured");
  }

  // Convert PCM to WAV if needed
  let wavBuffer;
  if (format === "pcm") {
    wavBuffer = pcmToWav(audioBuffer, sampleRate);
  } else {
    wavBuffer = audioBuffer;
  }

  // Write to temp file (Whisper API requires a file)
  const tempFile = path.join("/tmp", "whisper-" + Date.now() + ".wav");
  fs.writeFileSync(tempFile, wavBuffer);

  try {
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: DEFAULT_STT_MODEL,
      language: language,
      response_format: "text"
    });

    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] WHISPER Transcribed: " + transcription.substring(0, 100) + (transcription.length > 100 ? "..." : ""));

    return transcription;
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check if Whisper API is configured and available
 * @returns {boolean} True if an endpoint URL is available
 */
function isAvailable() {
  return !!normalizeBaseUrl(process.env.STT_BASE_URL || DEFAULT_STT_BASE_URL);
}

module.exports = {
  transcribe,
  pcmToWav,
  isAvailable
};
