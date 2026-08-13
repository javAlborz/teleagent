'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { publicDevice } = require('../lib/device-routes');

test('Realtime devices expose conductor and resume metadata without credentials', () => {
  const device = publicDevice({
    name: 'OpenAI Realtime Resume',
    extension: '77',
    voiceMode: 'openai-realtime',
    defaultAgentProfile: 'codex-terra',
    resumeTargetExtension: '7',
    voiceThreadTtlSeconds: 86400,
    authId: 'secret-auth-id',
    password: 'secret-password',
  });

  assert.equal(device.voiceMode, 'openai-realtime');
  assert.equal(device.modelProfile, 'codex-terra');
  assert.equal(device.resumeTargetExtension, '7');
  assert.equal(device.voiceThreadTtlSeconds, 86400);
  assert.equal(device.holdMusicEnabled, false);
  assert.equal(device.hasVoice, true);
  assert.equal('authId' in device, false);
  assert.equal('password' in device, false);
});
