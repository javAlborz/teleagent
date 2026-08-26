'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalizeTargetSessionMessage } = require('../../lib/target-session-message');

test('target-session canonical text rejects keystroke, paste, bidi, and invisible injection', () => {
  assert.equal(canonicalizeTargetSessionMessage('  Review the exact diff.  '), 'Review the exact diff.');
  for (const malicious of [
    'visible\u001b[201~\n/slash-command',
    'visible\nsecond submission',
    'visible\rhidden',
    'visible\tambiguous',
    'safe-looking\u202Egnorw',
    'safe\u200Bhidden',
    'safe\u0085next',
  ]) {
    assert.throws(
      () => canonicalizeTargetSessionMessage(malicious),
      (error) => error.code === 'INVALID_TARGET_MESSAGE',
    );
  }
});
