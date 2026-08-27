'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  createApprovalCapabilityIssuer,
} = require('../../lib/voice-approval-capability');

const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const MAX_CAPABILITY_TTL_SECONDS = 300;
const KEY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;

class ApprovalCapabilityConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalCapabilityConfigError';
    this.code = code;
  }
}

function configError(code, message) {
  return new ApprovalCapabilityConfigError(code, message);
}

function parseEnabled(value) {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw configError(
    'APPROVAL_CAPABILITY_INVALID_ENABLED',
    'VOICE_APPROVAL_CAPABILITY_ENABLED must be true or false.'
  );
}

function requiredSetting(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) {
    throw configError(
      'APPROVAL_CAPABILITY_CONFIG_MISSING',
      `Signed approval capabilities require ${name}.`
    );
  }
  return value;
}

function parseTtlSeconds(value) {
  const raw = value === undefined || value === null || String(value).trim() === ''
    ? '120'
    : String(value).trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw configError(
      'APPROVAL_CAPABILITY_INVALID_TTL',
      `VOICE_APPROVAL_CAPABILITY_TTL_SECONDS must be an integer from 1 to ${MAX_CAPABILITY_TTL_SECONDS}.`
    );
  }
  const ttlSeconds = Number.parseInt(raw, 10);
  if (ttlSeconds > MAX_CAPABILITY_TTL_SECONDS) {
    throw configError(
      'APPROVAL_CAPABILITY_INVALID_TTL',
      `VOICE_APPROVAL_CAPABILITY_TTL_SECONDS must be an integer from 1 to ${MAX_CAPABILITY_TTL_SECONDS}.`
    );
  }
  return ttlSeconds;
}

function parseKeyId(value) {
  const keyId = String(value || '').trim();
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw configError(
      'APPROVAL_CAPABILITY_KEY_ID_INVALID',
      'VOICE_APPROVAL_SIGNING_KEY_ID must contain only letters, numbers, dot, colon, underscore, or dash.'
    );
  }
  return keyId;
}

function readPrivateKey(privateKeyFile, fsModule) {
  if (!path.isAbsolute(privateKeyFile)) {
    throw configError(
      'APPROVAL_CAPABILITY_KEY_PATH_INVALID',
      'VOICE_APPROVAL_SIGNING_KEY_FILE must be an absolute path.'
    );
  }

  let descriptor = null;
  try {
    const noFollow = fsModule.constants.O_NOFOLLOW || 0;
    descriptor = fsModule.openSync(privateKeyFile, fsModule.constants.O_RDONLY | noFollow);
    const stat = fsModule.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw configError('APPROVAL_CAPABILITY_KEY_INVALID', 'The approval signing key must be a regular file.');
    }
    const permissions = stat.mode & 0o777;
    if (permissions !== 0o440) {
      throw configError(
        'APPROVAL_CAPABILITY_KEY_PERMISSIONS',
        'The approval signing key file must have mode 0440.'
      );
    }
    const effectiveGroupId = typeof process.getegid === 'function' ? process.getegid() : stat.gid;
    if (stat.uid !== 0 || stat.gid !== effectiveGroupId || stat.nlink !== 1) {
      throw configError(
        'APPROVAL_CAPABILITY_KEY_OWNER',
        'The approval signing key file must be owned by root and the exact voice runtime group.'
      );
    }
    if (stat.size < 64 || stat.size > MAX_PRIVATE_KEY_BYTES) {
      throw configError(
        'APPROVAL_CAPABILITY_KEY_INVALID',
        'The approval signing key file has an invalid size.'
      );
    }
    return fsModule.readFileSync(descriptor);
  } catch (error) {
    if (error instanceof ApprovalCapabilityConfigError) throw error;
    throw configError(
      'APPROVAL_CAPABILITY_KEY_UNREADABLE',
      'The configured approval signing key file could not be opened securely.'
    );
  } finally {
    if (descriptor !== null) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // A failed close cannot make an unread key usable or expose its value.
      }
    }
  }
}

function loadApprovalCapabilityConfig({
  env = process.env,
  fsModule = fs,
} = {}) {
  const enabled = parseEnabled(env.VOICE_APPROVAL_CAPABILITY_ENABLED);
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      issuer: null,
      keyId: null,
      ttlSeconds: null,
    });
  }

  const privateKeyFile = requiredSetting(env, 'VOICE_APPROVAL_SIGNING_KEY_FILE');
  const keyId = parseKeyId(requiredSetting(env, 'VOICE_APPROVAL_SIGNING_KEY_ID'));
  const ttlSeconds = parseTtlSeconds(env.VOICE_APPROVAL_CAPABILITY_TTL_SECONDS);
  const privateKeyBuffer = readPrivateKey(privateKeyFile, fsModule);
  try {
    const issuer = createApprovalCapabilityIssuer({
      privateKey: privateKeyBuffer,
      keyId,
      defaultTtlSeconds: ttlSeconds,
      maxTtlSeconds: MAX_CAPABILITY_TTL_SECONDS,
    });
    return Object.freeze({
      enabled: true,
      issuer,
      keyId,
      ttlSeconds,
    });
  } catch {
    throw configError(
      'APPROVAL_CAPABILITY_KEY_INVALID',
      'The configured approval signing key is not a valid Ed25519 private key.'
    );
  } finally {
    privateKeyBuffer.fill(0);
  }
}

module.exports = {
  ApprovalCapabilityConfigError,
  loadApprovalCapabilityConfig,
};
