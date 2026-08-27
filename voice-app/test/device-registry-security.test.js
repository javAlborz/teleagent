'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { invalidDeviceSummary } = require('../lib/device-registry');

test('invalid device logging metadata never contains SIP credentials', () => {
  const summary = invalidDeviceSummary('7', {
    authId: 'private-auth-id',
    password: 'private-sip-password',
    voiceId: 'marin'
  });
  const encoded = JSON.stringify(summary);

  assert.deepEqual(summary, {
    extension: '7',
    missingFields: ['name', 'extension']
  });
  assert.doesNotMatch(encoded, /private-auth-id|private-sip-password|marin/);
  assert.deepEqual(Object.keys(summary).sort(), ['extension', 'missingFields']);
});
