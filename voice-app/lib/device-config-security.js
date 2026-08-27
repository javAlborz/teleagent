'use strict';

const fs = require('node:fs');

const PROHIBITED_DEVICE_AUTH_FIELD = /^(?:authId|authPassword|password)$/iu;
const MAX_DEVICE_CONFIG_BYTES = 1024 * 1024;
const ALLOWED_FIELDS = new Set([
  'agentTimeoutSeconds',
  'claudeTimeoutSeconds',
  'defaultAgentProfile',
  'extension',
  'holdMusicEnabled',
  'maxTurns',
  'name',
  'prompt',
  'resumeTargetExtension',
  'resumeTtlSeconds',
  'sessionType',
  'voiceId',
  'voiceMode',
  'voiceThreadTtlSeconds',
]);
const SESSION_TYPES = new Set([
  'phone-haiku', 'phone-sonnet', 'phone-opus',
  'phone-codex-luna', 'phone-codex-terra', 'phone-codex-sol', 'phone-codex-deploy',
]);
const AGENT_PROFILES = new Set([
  'haiku', 'sonnet', 'opus', 'codex-luna', 'codex-terra', 'codex-sol', 'codex-deploy',
]);

class DeviceConfigSecurityError extends Error {
  constructor(message = 'Device configuration is invalid persona/routing metadata.') {
    super(message);
    this.name = 'DeviceConfigSecurityError';
    this.code = 'DEVICE_CONFIG_CONTAINS_AUTHENTICATION';
  }
}

function invalid(message) {
  throw new DeviceConfigSecurityError(message);
}

function assertDeviceConfigHasNoAuthentication(value) {
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (PROHIBITED_DEVICE_AUTH_FIELD.test(key)) throw new DeviceConfigSecurityError();
      pending.push(child);
    }
  }
  return value;
}

function cleanString(value, label, { min = 1, max = 256, pattern = null } = {}) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < min ||
      value.length > max || /[\u0000-\u001F\u007F]/u.test(value) ||
      (pattern && !pattern.test(value))) {
    invalid(`Device ${label} is invalid.`);
  }
  return value;
}

function optionalInteger(device, name, minimum, maximum) {
  if (!Object.hasOwn(device, name)) return undefined;
  const value = device[name];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`Device ${name} is invalid.`);
  }
  return value;
}

function validateAndProjectDeviceConfig(value) {
  assertDeviceConfigHasNoAuthentication(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Device configuration must be an object.');
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 32) {
    invalid('Device configuration must contain from 1 to 32 entries.');
  }
  const projected = {};
  const names = new Set();
  for (const [key, rawDevice] of entries) {
    const extension = cleanString(key, 'extension key', {
      max: 8,
      pattern: /^[0-9]{1,8}$/u,
    });
    if (!rawDevice || typeof rawDevice !== 'object' || Array.isArray(rawDevice)) {
      invalid(`Device ${extension} must be an object.`);
    }
    for (const field of Object.keys(rawDevice)) {
      if (!ALLOWED_FIELDS.has(field)) invalid(`Device ${extension} has an unsupported field.`);
    }
    if (rawDevice.extension !== extension) {
      invalid(`Device ${extension} must bind its exact extension key.`);
    }
    const name = cleanString(rawDevice.name, 'name', { max: 64 });
    const normalizedName = name.toLocaleLowerCase('en-US');
    if (names.has(normalizedName)) invalid('Device names must be unique.');
    names.add(normalizedName);

    const sessionType = cleanString(rawDevice.sessionType, 'sessionType', { max: 40 });
    if (!SESSION_TYPES.has(sessionType)) invalid(`Device ${extension} sessionType is not reviewed.`);
    const prompt = cleanString(rawDevice.prompt, 'prompt', { max: 4000 });
    const device = { name, extension, sessionType, prompt };

    if (Object.hasOwn(rawDevice, 'voiceId')) {
      device.voiceId = cleanString(rawDevice.voiceId, 'voiceId', {
        max: 64,
        pattern: /^[A-Za-z0-9._-]+$/u,
      });
    }
    if (Object.hasOwn(rawDevice, 'voiceMode')) {
      if (rawDevice.voiceMode !== 'openai-realtime') {
        invalid(`Device ${extension} voiceMode is not reviewed.`);
      }
      device.voiceMode = rawDevice.voiceMode;
    }
    if (Object.hasOwn(rawDevice, 'defaultAgentProfile')) {
      const profile = cleanString(rawDevice.defaultAgentProfile, 'defaultAgentProfile', { max: 40 });
      if (!AGENT_PROFILES.has(profile)) invalid(`Device ${extension} profile is not reviewed.`);
      device.defaultAgentProfile = profile;
    }
    if (Object.hasOwn(rawDevice, 'resumeTargetExtension')) {
      device.resumeTargetExtension = cleanString(
        rawDevice.resumeTargetExtension,
        'resumeTargetExtension',
        { max: 8, pattern: /^[0-9]{1,8}$/u }
      );
    }
    for (const [name, minimum, maximum] of [
      ['agentTimeoutSeconds', 30, 3600],
      ['claudeTimeoutSeconds', 30, 3600],
      ['maxTurns', 1, 100],
      ['resumeTtlSeconds', 60, 604800],
      ['voiceThreadTtlSeconds', 60, 604800],
    ]) {
      const number = optionalInteger(rawDevice, name, minimum, maximum);
      if (number !== undefined) device[name] = number;
    }
    if (Object.hasOwn(rawDevice, 'holdMusicEnabled')) {
      if (typeof rawDevice.holdMusicEnabled !== 'boolean') {
        invalid(`Device ${extension} holdMusicEnabled is invalid.`);
      }
      device.holdMusicEnabled = rawDevice.holdMusicEnabled;
    }
    projected[extension] = Object.freeze(device);
  }
  for (const device of Object.values(projected)) {
    if (device.resumeTargetExtension && !Object.hasOwn(projected, device.resumeTargetExtension)) {
      invalid(`Device ${device.extension} resumeTargetExtension is not configured.`);
    }
  }
  return Object.freeze(projected);
}

function loadSecureDeviceConfig({
  filename,
  fsModule = fs,
  expectedUid = 0,
  expectedGid = typeof process.getegid === 'function' ? process.getegid() : -1,
  expectedMode = 0o440,
  verifyMetadata = true,
} = {}) {
  let descriptor = null;
  let contents = null;
  try {
    descriptor = fsModule.openSync(
      filename,
      fsModule.constants.O_RDONLY | (fsModule.constants.O_NOFOLLOW || 0)
    );
    const metadata = fsModule.fstatSync(descriptor);
    if (!metadata.isFile?.() || metadata.isSymbolicLink?.() || metadata.nlink !== 1 ||
        metadata.size < 2 || metadata.size > MAX_DEVICE_CONFIG_BYTES ||
        (verifyMetadata && (
          metadata.uid !== expectedUid || metadata.gid !== expectedGid ||
          (metadata.mode & 0o777) !== expectedMode
        ))) {
      invalid('Device configuration metadata is unsafe.');
    }
    contents = fsModule.readFileSync(descriptor);
    const parsed = JSON.parse(contents.toString('utf8'));
    return validateAndProjectDeviceConfig(parsed);
  } catch (error) {
    if (error instanceof DeviceConfigSecurityError) throw error;
    invalid('Device configuration is missing, unreadable, or malformed.');
  } finally {
    contents?.fill?.(0);
    if (descriptor !== null) {
      try { fsModule.closeSync(descriptor); } catch { /* startup stays rejected on failure */ }
    }
  }
}

module.exports = {
  DeviceConfigSecurityError,
  PROHIBITED_DEVICE_AUTH_FIELD,
  assertDeviceConfigHasNoAuthentication,
  loadSecureDeviceConfig,
  validateAndProjectDeviceConfig,
};
