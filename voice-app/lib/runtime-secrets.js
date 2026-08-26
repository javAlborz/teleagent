'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SECRET_DIRECTORY = '/run/secrets';

const SECRET_SPECS = Object.freeze({
  drachtioSecret: Object.freeze({
    filename: 'teleagent-drachtio-secret',
    label: 'Drachtio control credential',
    kind: 'base64url',
    required: true,
    maxBytes: 128,
  }),
  freeswitchSecret: Object.freeze({
    filename: 'teleagent-freeswitch-secret',
    label: 'FreeSWITCH control credential',
    kind: 'base64url',
    required: true,
    maxBytes: 128,
  }),
  executorApiToken: Object.freeze({
    filename: 'teleagent-executor-api-token',
    label: 'executor API credential',
    kind: 'token',
    required: true,
  }),
  voiceControlToken: Object.freeze({
    filename: 'teleagent-voice-control-token',
    label: 'voice-control credential',
    kind: 'token',
    required: true,
  }),
  openaiRealtimeApiKey: Object.freeze({
    filename: 'teleagent-openai-realtime-api-key',
    label: 'OpenAI Realtime API credential',
    kind: 'token',
    required: true,
  }),
  openaiSafetyIdentifierSalt: Object.freeze({
    filename: 'teleagent-openai-safety-salt',
    label: 'OpenAI safety-identifier salt',
    kind: 'base64url',
    required: true,
    maxBytes: 128,
  }),
  outboundApiToken: Object.freeze({
    filename: 'teleagent-outbound-api-token',
    label: 'outbound callback API credential',
    kind: 'token',
    required: true,
  }),
});

const SECRET_PATHS = Object.freeze(Object.fromEntries(
  Object.entries(SECRET_SPECS).map(([name, spec]) => [
    name,
    path.posix.join(SECRET_DIRECTORY, spec.filename),
  ])
));

const PLACEHOLDER_PATTERN = /(?:replace[-_ ]?with|change[-_ ]?me|changeme|placeholder|example|dummy|not[-_ ]?a[-_ ]?real|your[-_ ]?(?:password|secret|token|api[-_ ]?key))/iu;
const MAX_SECRET_BYTES = 4096;

class RuntimeSecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeSecretError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new RuntimeSecretError(code, message);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function sameSecret(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function normalizeFileValue(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.includes(0)) {
    reject('VOICE_RUNTIME_SECRET_INVALID', `${label} is not a valid text credential.`);
  }
  let value = buffer.toString('utf8');
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.endsWith('\r')) value = value.slice(0, -1);
  if (!value || value !== value.trim() || /[\u0000-\u001F\u007F]/u.test(value)) {
    reject('VOICE_RUNTIME_SECRET_INVALID', `${label} is not a clean text credential.`);
  }
  return value;
}

function validateValue(value, spec) {
  const byteLength = Buffer.byteLength(value, 'utf8');
  const maxBytes = spec.maxBytes || MAX_SECRET_BYTES;
  if (byteLength < 32 || byteLength > maxBytes || PLACEHOLDER_PATTERN.test(value)) {
    reject(
      'VOICE_RUNTIME_SECRET_INVALID',
      `${spec.label} must be a non-placeholder credential from 32 to ${maxBytes} bytes.`,
    );
  }
  if (spec.kind === 'base64url' && !/^[A-Za-z0-9_-]+$/u.test(value)) {
    reject('VOICE_RUNTIME_SECRET_INVALID', `${spec.label} must be base64url-safe.`);
  }
  if (spec.kind === 'token' && !/^[\x21-\x7e]+$/u.test(value)) {
    reject('VOICE_RUNTIME_SECRET_INVALID', `${spec.label} must contain only clean ASCII.`);
  }
  if (new Set(value).size < 8) {
    reject('VOICE_RUNTIME_SECRET_INVALID', `${spec.label} does not contain enough variation.`);
  }
  return value;
}

function verifySecureAncestors(fsModule, filename, expectedUid) {
  let current = path.dirname(filename);
  while (current && current !== path.dirname(current)) {
    let metadata;
    try {
      metadata = fsModule.lstatSync(current);
    } catch {
      reject('VOICE_RUNTIME_SECRET_UNREADABLE', 'The runtime secret directory is missing or unreadable.');
    }
    if (!metadata.isDirectory?.() || metadata.isSymbolicLink?.() ||
        metadata.uid !== expectedUid || (metadata.mode & 0o022) !== 0) {
      reject('VOICE_RUNTIME_SECRET_METADATA', 'The runtime secret directory metadata is unsafe.');
    }
    current = path.dirname(current);
  }
}

function readSecretFile(filename, spec, {
  fsModule = fs,
  expectedUid = 0,
  expectedGid = typeof process.getegid === 'function' ? process.getegid() : -1,
  verifyAncestors = true,
} = {}) {
  if (verifyAncestors) verifySecureAncestors(fsModule, filename, expectedUid);
  let descriptor = null;
  let contents = null;
  try {
    descriptor = fsModule.openSync(
      filename,
      fsModule.constants.O_RDONLY | (fsModule.constants.O_NOFOLLOW || 0),
    );
    const metadata = fsModule.fstatSync(descriptor);
    if (!metadata.isFile?.() || metadata.uid !== expectedUid || metadata.gid !== expectedGid ||
        metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o440 ||
        metadata.size < 1 || metadata.size > (spec.maxBytes || MAX_SECRET_BYTES) + 2) {
      reject('VOICE_RUNTIME_SECRET_METADATA', `${spec.label} metadata is unsafe.`);
    }
    contents = fsModule.readFileSync(descriptor);
    return validateValue(normalizeFileValue(contents, spec.label), spec);
  } catch (error) {
    if (error instanceof RuntimeSecretError) throw error;
    reject('VOICE_RUNTIME_SECRET_UNREADABLE', `${spec.label} is missing or unreadable.`);
  } finally {
    if (contents) contents.fill(0);
    if (descriptor !== null) {
      try { fsModule.closeSync(descriptor); } catch { /* fail closed above */ }
    }
  }
}

function loadRuntimeSecrets({
  fsModule = fs,
  directory = SECRET_DIRECTORY,
  expectedUid = 0,
  expectedGid = typeof process.getegid === 'function' ? process.getegid() : -1,
  verifyAncestors = true,
  required = [],
} = {}) {
  const additionallyRequired = new Set(required);
  const loaded = {};
  for (const [name, spec] of Object.entries(SECRET_SPECS)) {
    const filename = path.join(directory, spec.filename);
    const mustExist = spec.required || additionallyRequired.has(name);
    if (!mustExist) {
      try {
        fsModule.lstatSync(filename);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.message === 'missing') {
          loaded[name] = null;
          continue;
        }
        reject('VOICE_RUNTIME_SECRET_UNREADABLE', `${spec.label} is unreadable.`);
      }
    }
    // Optional means absent is permitted. Once a directory entry exists it is
    // held to the same O_NOFOLLOW, metadata, strength, and reuse contract as a
    // required credential; an unsafe entry is never treated as absent.
    loaded[name] = readSecretFile(filename, spec, {
      fsModule, expectedUid, expectedGid, verifyAncestors,
    });
  }

  const populated = Object.entries(loaded).filter(([, value]) => value);
  for (let leftIndex = 0; leftIndex < populated.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < populated.length; rightIndex += 1) {
      const [leftName, left] = populated[leftIndex];
      const [rightName, right] = populated[rightIndex];
      if (sameSecret(left, right)) {
        reject(
          'VOICE_RUNTIME_SECRET_REUSED',
          `${SECRET_SPECS[leftName].label} must be distinct from ${SECRET_SPECS[rightName].label}.`,
        );
      }
    }
  }
  return Object.freeze(loaded);
}

let activeRuntimeSecrets = null;

function configureRuntimeSecrets(secrets) {
  if (!secrets || typeof secrets !== 'object') {
    reject('VOICE_RUNTIME_SECRET_NOT_CONFIGURED', 'The voice runtime secret snapshot is invalid.');
  }
  activeRuntimeSecrets = Object.freeze({ ...secrets });
  return activeRuntimeSecrets;
}

function getRuntimeSecret(name, { required = true } = {}) {
  if (!Object.hasOwn(SECRET_SPECS, name)) {
    reject('VOICE_RUNTIME_SECRET_UNKNOWN', 'An unknown runtime secret was requested.');
  }
  const value = activeRuntimeSecrets?.[name] || null;
  if (!value && required) {
    reject(
      'VOICE_RUNTIME_SECRET_NOT_CONFIGURED',
      `${SECRET_SPECS[name].label} is not loaded.`,
    );
  }
  return value;
}

function clearRuntimeSecretsForTest() {
  activeRuntimeSecrets = null;
}

module.exports = {
  SECRET_DIRECTORY,
  SECRET_PATHS,
  SECRET_SPECS,
  RuntimeSecretError,
  clearRuntimeSecretsForTest,
  configureRuntimeSecrets,
  getRuntimeSecret,
  loadRuntimeSecrets,
  readSecretFile,
  sameSecret,
  validateValue,
};
