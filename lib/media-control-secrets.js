'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

const MEDIA_CONTROL_SECRET_NAMES = Object.freeze([
  'DRACHTIO_SECRET',
  'FREESWITCH_SECRET',
]);

const OTHER_SENSITIVE_ENV_NAMES = Object.freeze([
  'AGENT_API_TOKEN',
  'CLAUDE_API_TOKEN',
  'EXECUTOR_API_TOKEN',
  'OPENAI_REALTIME_API_KEY',
  'OUTBOUND_API_TOKEN',
  'PRIVILEGED_ACTION_API_TOKEN',
  'VOICE_CONTROL_TOKEN',
]);

const PLACEHOLDER_PATTERN = /(?:replace[-_]?with|change[-_]?me|changeme|placeholder|example|dummy|not[-_]?a[-_]?real|your[-_]?(?:password|secret|token))/iu;

class MediaControlSecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaControlSecretError';
    this.code = code;
  }
}

function secretDigest(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function timingSafeSecretEqual(left, right) {
  return timingSafeEqual(secretDigest(left), secretDigest(right));
}

function normalizeMediaControlSecret(value, name) {
  const secret = typeof value === 'string' ? value : '';
  const byteLength = Buffer.byteLength(secret, 'utf8');
  if (
    byteLength < 32 ||
    byteLength > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(secret) ||
    PLACEHOLDER_PATTERN.test(secret) ||
    new Set(secret).size < 8
  ) {
    throw new MediaControlSecretError(
      'MEDIA_CONTROL_SECRET_INVALID',
      `${name} must be a non-placeholder 32-128 byte base64url-safe random secret.`,
    );
  }
  return secret;
}

function loadMediaControlSecrets(env = process.env) {
  const values = Object.fromEntries(MEDIA_CONTROL_SECRET_NAMES.map((name) => (
    [name, normalizeMediaControlSecret(env[name], name)]
  )));

  if (timingSafeSecretEqual(values.DRACHTIO_SECRET, values.FREESWITCH_SECRET)) {
    throw new MediaControlSecretError(
      'MEDIA_CONTROL_SECRET_REUSED',
      'DRACHTIO_SECRET and FREESWITCH_SECRET must be distinct.',
    );
  }

  for (const mediaName of MEDIA_CONTROL_SECRET_NAMES) {
    for (const otherName of OTHER_SENSITIVE_ENV_NAMES) {
      const other = typeof env[otherName] === 'string' ? env[otherName] : '';
      if (other && timingSafeSecretEqual(values[mediaName], other)) {
        throw new MediaControlSecretError(
          'MEDIA_CONTROL_SECRET_REUSED',
          `${mediaName} must be distinct from ${otherName}.`,
        );
      }
    }
  }

  return Object.freeze({
    drachtioSecret: values.DRACHTIO_SECRET,
    freeswitchSecret: values.FREESWITCH_SECRET,
  });
}

module.exports = {
  MEDIA_CONTROL_SECRET_NAMES,
  MediaControlSecretError,
  loadMediaControlSecrets,
  normalizeMediaControlSecret,
  timingSafeSecretEqual,
};
