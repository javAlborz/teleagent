'use strict';

const crypto = require('node:crypto');

const MIN_PROVIDER_CREDENTIAL_BYTES = 32;
const MAX_PROVIDER_CREDENTIAL_BYTES = 4096;
const PLACEHOLDER = /(?:placeholder|example|change[-_ ]?me|replace[-_ ]?with|insert[-_ ]?(?:key|token)|your[-_ ]?(?:api[-_ ]?)?(?:key|token))/i;

function isRepeatedPattern(value) {
  const limit = Math.min(16, Math.floor(value.length / 2));
  for (let width = 1; width <= limit; width += 1) {
    if (value.length % width !== 0) continue;
    const pattern = value.slice(0, width);
    if (pattern.repeat(value.length / width) === value) return true;
  }
  return false;
}

function validateProviderCredential(input) {
  const value = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < MIN_PROVIDER_CREDENTIAL_BYTES || bytes > MAX_PROVIDER_CREDENTIAL_BYTES ||
      value.length !== bytes || !/^[\x21-\x7e]+$/.test(value) || PLACEHOLDER.test(value) ||
      new Set(value).size < 8 || isRepeatedPattern(value)) {
    throw new Error('Provider credential is invalid.');
  }
  return value;
}

function providerCredentialsEqual(left, right) {
  const leftDigest = crypto.createHash('sha256')
    .update(validateProviderCredential(left), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256')
    .update(validateProviderCredential(right), 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

module.exports = {
  MAX_PROVIDER_CREDENTIAL_BYTES,
  MIN_PROVIDER_CREDENTIAL_BYTES,
  providerCredentialsEqual,
  validateProviderCredential,
};
