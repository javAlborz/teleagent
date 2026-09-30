'use strict';

const { spawn } = require('node:child_process');
const { sessionError } = require('./owner-session-endpoint');
const MAX_WAVE = 44 + 22050 * 2 * 90;
const HEADER = Buffer.from('5249464624f0ff7f57415645666d742010000000010001002256000044ac0000020010006461746100f0ff7f', 'hex');

// eSpeak's stdout has a fixed streaming WAV header with unknown-length size
// sentinels. Accept only its reviewed mono PCM16/22050 shape, never a generic
// media decoder. Resampling to Asterisk sln24 is bounded deterministic arithmetic.
function toPcm24(wave) {
  if (!Buffer.isBuffer(wave) || wave.length < 444 || wave.length > MAX_WAVE ||
      wave.length % 2 || !wave.subarray(0, 44).equals(HEADER)) throw sessionError('PBX_SPEECH_AUDIO_INVALID');
  const samples = (wave.length - 44) / 2;
  const count = Math.floor(samples * 24000 / 22050);
  const result = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const offset = i * 22050 / 24000; const left = Math.floor(offset);
    const a = wave.readInt16LE(44 + left * 2);
    const b = wave.readInt16LE(44 + Math.min(samples - 1, left + 1) * 2);
    result.writeInt16LE(Math.round(a + (b - a) * (offset - left)), i * 2);
  }
  return result;
}

function createPbxLocalSpeechSynthesizer({ assertBoundary, spawnImpl = spawn }) {
  if (typeof assertBoundary !== 'function') throw sessionError('PBX_SPEECH_CONFIGURATION_INVALID');
  return async (prompt) => {
    if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > 4096 || /[\x00-\x1f]/u.test(prompt)) {
      throw sessionError('PBX_SPEECH_PROMPT_INVALID');
    }
    const guard = () => {
      const value = assertBoundary();
      if (value && typeof value.then === 'function') throw sessionError('PBX_SPEECH_CONFIGURATION_INVALID');
    };
    guard();
    return new Promise((resolve, reject) => {
      const child = spawnImpl('/usr/bin/espeak-ng', ['--stdout', '--stdin', '-v', 'en-us', '-s', '155'], {
        cwd: '/', env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: '/nonexistent', PATH: '/usr/bin:/bin' },
        shell: false, stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks = []; let bytes = 0; let failed = false;
      const abort = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(abort, 10000);
      child.stdin.on('error', abort);
      child.stdout.on('error', abort);
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_WAVE) abort(); else chunks.push(chunk);
      });
      child.once('error', () => { clearTimeout(timer); reject(sessionError('PBX_SPEECH_UNAVAILABLE')); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (failed || code !== 0 || signal) { reject(sessionError('PBX_SPEECH_UNAVAILABLE')); return; }
        try { guard(); resolve(toPcm24(Buffer.concat(chunks))); } catch (error) { reject(error); }
      });
      // Text never enters argv, a shell, SSML mode, provider prompts, or disk.
      child.stdin.end(prompt);
    });
  };
}
module.exports = { createPbxLocalSpeechSynthesizer, toPcm24, MAX_WAVE };
