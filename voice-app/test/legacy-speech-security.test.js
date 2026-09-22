'use strict';
require('./helpers/voice-egress-fixture').installEgressFixture();

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LEGACY_STT_BASE_URL,
  LEGACY_TTS_BASE_URL,
  loadLegacySpeechConfig,
} = require('../lib/legacy-speech-config');
const whisper = require('../lib/whisper-client');

function withEnvironment(t, values) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('legacy speech is disabled by default and accepts only exact local endpoints', (t) => {
  withEnvironment(t, {
    LEGACY_SPEECH_SERVICES_ENABLED: undefined,
    STT_BASE_URL: undefined,
    TTS_BASE_URL: undefined,
  });
  assert.deepEqual(loadLegacySpeechConfig(), {
    enabled: false,
    sttBaseUrl: LEGACY_STT_BASE_URL,
    sttModel: 'whisper-1',
    ttsBaseUrl: LEGACY_TTS_BASE_URL,
    ttsModel: 'kokoro',
  });

  for (const value of [
    'http://attacker.invalid/v1',
    'https://127.0.0.1:18001/v1',
    'http://localhost:18001/v1',
    'http://127.0.0.1:18001/v1/',
    'http://127.0.0.1:18001/v1?next=attacker',
  ]) {
    assert.throws(
      () => loadLegacySpeechConfig({
        LEGACY_SPEECH_SERVICES_ENABLED: 'true',
        STT_BASE_URL: value,
      }),
      { code: 'LEGACY_SPEECH_CONFIG_INVALID' }
    );
  }
});

test('local STT disables redirects, sends no bearer, and logs only transcript length', async (t) => {
  withEnvironment(t, {
    LEGACY_SPEECH_SERVICES_ENABLED: 'true',
    STT_BASE_URL: LEGACY_STT_BASE_URL,
    STT_MODEL: 'whisper-1',
  });
  const transcript = 'SENTINEL private caller transcript';
  const logs = [];
  let request = null;
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));

  const result = await whisper.transcribe(Buffer.from([0, 0, 1, 0]), {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(Buffer.byteLength(transcript)) },
        text: async () => transcript,
      };
    },
  });

  assert.equal(result, transcript);
  assert.equal(request.url, `${LEGACY_STT_BASE_URL}/audio/transcriptions`);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers?.Authorization, undefined);
  assert.equal(logs.join('\n').includes(transcript), false);
  assert.match(logs.join('\n'), /chars=34/);
});

test('an attacker STT URL is rejected before fetch construction', async (t) => {
  withEnvironment(t, {
    LEGACY_SPEECH_SERVICES_ENABLED: 'true',
    STT_BASE_URL: 'http://127.0.0.1:9999/v1',
  });
  let requests = 0;
  await assert.rejects(
    whisper.transcribe(Buffer.from([0, 0]), {
      fetchImpl: async () => { requests += 1; },
    }),
    { code: 'LEGACY_SPEECH_CONFIG_INVALID' }
  );
  assert.equal(requests, 0);
});
