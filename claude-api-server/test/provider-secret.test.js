'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  providerCredentialsEqual,
  validateProviderCredential,
} = require('../../lib/provider-secret');

const VALID_CLAUDE = 'sk-ant-api03-SecureCredential_A1b2C3d4E5f6G7';
const VALID_CODEX = 'sk-proj-SecureCredential_Z9y8X7w6V5u4T3';

test('provider credentials require bounded visible nonplaceholder high-diversity bytes', () => {
  assert.equal(validateProviderCredential(VALID_CLAUDE), VALID_CLAUDE);
  for (const invalid of [
    'too-short',
    ` ${VALID_CLAUDE}`,
    `${VALID_CLAUDE} `,
    `${VALID_CLAUDE}\n`,
    `sk-ant-api03-Secure Credential_A1b2C3d4E5f6G7`,
    'replace-with-real-anthropic-api-key-now',
    'EXAMPLE_API_KEY_A1b2C3d4E5f6G7H8I9',
    'a'.repeat(64),
    'abcd'.repeat(16),
    `sk-proj-${'é'.repeat(32)}`,
    'x'.repeat(4097),
  ]) {
    assert.throws(
      () => validateProviderCredential(invalid),
      (error) => error.message === 'Provider credential is invalid.' &&
        !error.message.includes(invalid.slice(0, 12))
    );
  }
});

test('provider credential distinction uses validated timing-safe digests', () => {
  assert.equal(providerCredentialsEqual(VALID_CLAUDE, VALID_CLAUDE), true);
  assert.equal(providerCredentialsEqual(VALID_CLAUDE, VALID_CODEX), false);
  assert.throws(() => providerCredentialsEqual(VALID_CLAUDE, 'b'.repeat(64)),
    /Provider credential is invalid/);
});
