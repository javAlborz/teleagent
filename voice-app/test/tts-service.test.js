const assert = require('node:assert/strict');
require('./helpers/voice-egress-fixture').installEgressFixture();
const { installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();
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

  const testEnvironment = {
    LEGACY_SPEECH_SERVICES_ENABLED: 'true',
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(testEnvironment)) {
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
  let requestConfig = null;
  const { service, restore } = loadTtsServiceWithAxiosStub(
    async (config) => {
      requestConfig = config;
      return ({
      data: audio,
      headers: { 'x-zeus-tts-backend': 'kokoro' }
      });
    },
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
  assert.match(
    url,
    /^http:\/\/127\.0\.0\.1:3000\/audio-files\/tts-\d+-[a-f0-9]{32}\.mp3$/
  );
  const audioPath = path.join(tempDir, files[0]);
  assert.equal(fs.statSync(audioPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(audioPath), audio);
  assert.equal(requestConfig.maxRedirects, 0);
  assert.equal(Object.hasOwn(requestConfig.headers, 'Authorization'), false);
});

test('disabled or redirected legacy speech cannot send text or reflected secrets to logs', async (t) => {
  const reflected = 'SENTINEL-reflected-private-token';
  const logs = [];
  let requests = 0;
  const { service, restore } = loadTtsServiceWithAxiosStub(
    async () => {
      requests += 1;
      const error = new Error('local backend rejected request');
      error.response = { status: 500, data: reflected };
      throw error;
    },
    { LEGACY_SPEECH_SERVICES_ENABLED: 'false' }
  );
  const logger = require('../lib/logger');
  t.mock.method(logger, 'error', (...args) => logs.push(JSON.stringify(args)));
  t.after(restore);

  await assert.rejects(service.generateSpeech('SENTINEL-private-transcript'), {
    code: 'LEGACY_SPEECH_DISABLED',
  });
  restore();
  const redirected = loadTtsServiceWithAxiosStub(
    async () => {
      requests += 1;
      throw new Error(reflected);
    },
    {
      LEGACY_SPEECH_SERVICES_ENABLED: 'true',
      TTS_BASE_URL: 'http://attacker.invalid/v1',
    }
  );
  t.after(redirected.restore);
  await assert.rejects(redirected.service.generateSpeech('SENTINEL-private-transcript'), {
    code: 'LEGACY_SPEECH_CONFIG_INVALID',
  });
  assert.equal(requests, 0);
  assert.equal(logs.join('\n').includes('SENTINEL-private-transcript'), false);
  assert.equal(logs.join('\n').includes(reflected), false);
});
