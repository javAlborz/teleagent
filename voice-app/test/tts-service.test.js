const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const servicePath = require.resolve('../lib/tts-service');
const axiosPath = require.resolve('axios');

function loadTtsServiceWithAxiosStub(axiosStub, envOverrides = {}) {
  require('axios');
  const axiosModule = require.cache[axiosPath];
  const originalAxios = axiosModule.exports;
  const originalEnv = {};

  for (const [key, value] of Object.entries(envOverrides)) {
    originalEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  delete require.cache[servicePath];
  axiosModule.exports = axiosStub;
  const service = require(servicePath);

  return {
    service,
    restore() {
      delete require.cache[servicePath];
      axiosModule.exports = originalAxios;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

test('generateSpeech rejects empty audio payloads without writing files', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-service-empty-'));
  const { service, restore } = loadTtsServiceWithAxiosStub(
    async () => ({
      data: Buffer.alloc(0),
      headers: { 'x-zeus-tts-backend': 'kokoro' }
    }),
    {
      TTS_ALLOWED_VOICES: 'alb',
      TTS_BASE_URL: 'http://127.0.0.1:18000/v1'
    }
  );

  t.after(() => {
    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  service.setAudioDir(tempDir);

  await assert.rejects(
    service.generateSpeech('hello from test', 'alb'),
    /empty audio payload/
  );
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test('generateSpeech writes non-empty audio and returns a playback URL', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-service-ok-'));
  const audio = Buffer.from('fake-mp3-audio');
  const { service, restore } = loadTtsServiceWithAxiosStub(
    async () => ({
      data: audio,
      headers: { 'x-zeus-tts-backend': 'kokoro' }
    }),
    {
      TTS_ALLOWED_VOICES: 'alb',
      TTS_BASE_URL: 'http://127.0.0.1:18000/v1'
    }
  );

  t.after(() => {
    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  service.setAudioDir(tempDir);

  const url = await service.generateSpeech('hello from test', 'alb');
  const files = fs.readdirSync(tempDir);

  assert.equal(files.length, 1);
  assert.match(url, /^http:\/\/127\.0\.0\.1:3000\/audio-files\/tts-/);
  assert.deepEqual(fs.readFileSync(path.join(tempDir, files[0])), audio);
});
