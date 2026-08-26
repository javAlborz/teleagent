'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  normalizeCredential,
} = require('./sip-trunk-auth');
const { assertDeviceConfigHasNoAuthentication } = require('./device-config-security');
const { loadRuntimeSecrets } = require('./runtime-secrets');

const VOICE_RUNTIME_PATHS = Object.freeze({
  configDirectory: '/app/config',
  deviceConfigFile: '/app/config/devices.json',
  stateDirectory: '/app/state',
  // These retired paths are checked for absence. The untrusted voice process
  // must never receive approval-signing or privileged proxy authority.
  approvalPrivateKey: '/run/secrets/teleagent-approval-private.pem',
  privilegedActionBearer: '/run/secrets/teleagent-privileged-action-api-token',
  sipIngressCredential: '/run/secrets/teleagent-sip-ingress-password',
  sipCallbackCredential: '/run/secrets/teleagent-sip-callback-password',
});

const MAX_DEVICE_CONFIG_BYTES = 1024 * 1024;
const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;
const MIN_STATE_CAPACITY_BYTES = 4n * GIB;
const MAX_STATE_CAPACITY_BYTES = 8n * GIB;
const MIN_STATE_FREE_BYTES = 512n * MIB;

class VoiceRuntimePreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VoiceRuntimePreflightError';
    this.code = 'VOICE_RUNTIME_PREFLIGHT_FAILED';
  }
}

function reject(reason) {
  throw new VoiceRuntimePreflightError(`Dedicated voice runtime is not ready: ${reason}.`);
}

function verifyDirectory(fsModule, filename, label, {
  uid,
  gid,
  mode,
}) {
  let metadata;
  try {
    metadata = fsModule.lstatSync(filename);
  } catch {
    reject(`${label} is missing or unreadable`);
  }
  if (!metadata.isDirectory?.() || metadata.isSymbolicLink?.() || metadata.uid !== uid ||
      metadata.gid !== gid || (metadata.mode & 0o777) !== mode) {
    reject(`${label} metadata is unsafe`);
  }
  return metadata;
}

function exactNonnegativeBigInt(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  reject(`${label} is invalid`);
}

function verifyBoundedStateFilesystem(fsModule, filename, {
  configDevice,
  stateDevice,
}) {
  const normalizedConfigDevice = exactNonnegativeBigInt(
    configDevice, 'device configuration filesystem identity');
  const normalizedStateDevice = exactNonnegativeBigInt(
    stateDevice, 'durable state filesystem identity');
  if (normalizedConfigDevice === normalizedStateDevice) {
    reject('durable state is not on a dedicated bounded filesystem');
  }
  let statistics;
  try {
    statistics = fsModule.statfsSync(filename, { bigint: true });
  } catch {
    reject('durable state filesystem capacity is unverifiable');
  }
  const blockSize = exactNonnegativeBigInt(statistics?.bsize,
    'durable state filesystem block size');
  const blocks = exactNonnegativeBigInt(statistics?.blocks,
    'durable state filesystem block count');
  const availableBlocks = exactNonnegativeBigInt(statistics?.bavail,
    'durable state filesystem available block count');
  if (blockSize === 0n || availableBlocks > blocks) {
    reject('durable state filesystem capacity is invalid');
  }
  const capacity = blockSize * blocks;
  const available = blockSize * availableBlocks;
  if (capacity < MIN_STATE_CAPACITY_BYTES || capacity > MAX_STATE_CAPACITY_BYTES) {
    reject('durable state filesystem must have a 4-8 GiB hard capacity');
  }
  const percentageReserve = (capacity + 4n) / 5n;
  const requiredFree = percentageReserve > MIN_STATE_FREE_BYTES
    ? percentageReserve
    : MIN_STATE_FREE_BYTES;
  if (available < requiredFree) {
    reject('durable state filesystem free-space reserve is exhausted');
  }
  return Object.freeze({ capacity, available, requiredFree });
}

class VoiceStateCapacityGuard {
  constructor({
    fsModule = fs,
    paths = VOICE_RUNTIME_PATHS,
    effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : -1,
    effectiveGid = typeof process.getegid === 'function' ? process.getegid() : -1,
  } = {}) {
    this.fsModule = fsModule;
    this.paths = paths;
    this.effectiveUid = effectiveUid;
    this.effectiveGid = effectiveGid;
  }

  check() {
    try {
      const configDirectory = verifyDirectory(
        this.fsModule,
        this.paths.configDirectory,
        'device configuration directory',
        { uid: 0, gid: this.effectiveGid, mode: 0o750 },
      );
      const stateDirectory = verifyDirectory(
        this.fsModule,
        this.paths.stateDirectory,
        'durable state directory',
        { uid: this.effectiveUid, gid: this.effectiveGid, mode: 0o700 },
      );
      const result = verifyBoundedStateFilesystem(
        this.fsModule,
        this.paths.stateDirectory,
        { configDevice: configDirectory.dev, stateDevice: stateDirectory.dev },
      );
      return Object.freeze({
        ok: true,
        code: null,
        capacityBytes: Number(result.capacity),
        availableBytes: Number(result.available),
        requiredFreeBytes: Number(result.requiredFree),
      });
    } catch (error) {
      const exhausted = error instanceof VoiceRuntimePreflightError &&
        /free-space reserve is exhausted/u.test(error.message);
      return Object.freeze({
        ok: false,
        code: exhausted
          ? 'VOICE_STATE_CAPACITY_EXHAUSTED'
          : 'VOICE_STATE_BOUNDARY_INVALID',
      });
    }
  }
}

function readSecureFile(fsModule, filename, label, {
  gid,
  minBytes = 1,
  maxBytes,
}) {
  let descriptor = null;
  try {
    descriptor = fsModule.openSync(
      filename,
      fsModule.constants.O_RDONLY | (fsModule.constants.O_NOFOLLOW || 0),
    );
    const metadata = fsModule.fstatSync(descriptor);
    if (!metadata.isFile?.() || metadata.uid !== 0 || metadata.gid !== gid ||
        metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o440 ||
        metadata.size < minBytes || metadata.size > maxBytes) {
      reject(`${label} metadata is unsafe`);
    }
    const value = fsModule.readFileSync(descriptor);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  } catch (error) {
    if (error instanceof VoiceRuntimePreflightError) throw error;
    reject(`${label} is missing or unreadable`);
  } finally {
    if (descriptor !== null) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // A failed close cannot make an invalid credential usable.
      }
    }
  }
}

function sameSecret(left, right) {
  const leftDigest = crypto.createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(right, 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function requireAbsent(fsModule, filename, label) {
  try {
    fsModule.lstatSync(filename);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.message === 'missing') return;
    reject(`${label} absence is unverifiable`);
  }
  reject(`${label} must not be projected into the voice runtime`);
}

function enabledFlag(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') return true;
  reject(`${label} must be true or false`);
}

function validateVoiceRuntimePreflight({
  fsModule = fs,
  effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : -1,
  effectiveGid = typeof process.getegid === 'function' ? process.getegid() : -1,
  paths = VOICE_RUNTIME_PATHS,
  runtimeSecretLoader = loadRuntimeSecrets,
  privilegedActionsEnabled = process.env.VOICE_PRIVILEGED_ACTIONS_ENABLED,
} = {}) {
  if (!Number.isSafeInteger(effectiveUid) || !Number.isSafeInteger(effectiveGid) ||
      effectiveUid <= 0 || effectiveGid <= 0 || effectiveUid === 1000 || effectiveGid === 1000) {
    reject('the process is not the dedicated non-root teleagent-voice identity');
  }

  const configDirectory = verifyDirectory(
    fsModule, paths.configDirectory, 'device configuration directory', {
    uid: 0,
    gid: effectiveGid,
    mode: 0o750,
  });
  const stateDirectory = verifyDirectory(fsModule, paths.stateDirectory, 'durable state directory', {
    uid: effectiveUid,
    gid: effectiveGid,
    mode: 0o700,
  });
  verifyBoundedStateFilesystem(fsModule, paths.stateDirectory, {
    configDevice: configDirectory.dev,
    stateDevice: stateDirectory.dev,
  });

  requireAbsent(fsModule, paths.approvalPrivateKey, 'approval signing key');
  requireAbsent(fsModule, paths.privilegedActionBearer, 'privileged-action bearer');

  const deviceConfig = readSecureFile(
    fsModule,
    paths.deviceConfigFile,
    'device configuration',
    { gid: effectiveGid, maxBytes: MAX_DEVICE_CONFIG_BYTES },
  );
  let parsedDevices;
  try {
    parsedDevices = JSON.parse(deviceConfig.toString('utf8'));
    if (!parsedDevices || typeof parsedDevices !== 'object' || Array.isArray(parsedDevices)) {
      reject('device configuration is invalid');
    }
    assertDeviceConfigHasNoAuthentication(parsedDevices);
  } catch (error) {
    if (error instanceof VoiceRuntimePreflightError) throw error;
    reject('device configuration is invalid');
  } finally {
    deviceConfig.fill(0);
  }

  const ingressBuffer = readSecureFile(
    fsModule,
    paths.sipIngressCredential,
    'SIP ingress credential',
    { gid: effectiveGid, minBytes: 32, maxBytes: 4097 },
  );
  const callbackBuffer = readSecureFile(
    fsModule,
    paths.sipCallbackCredential,
    'SIP callback credential',
    { gid: effectiveGid, minBytes: 32, maxBytes: 4097 },
  );
  let ingressCredential;
  let callbackCredential;
  try {
    ingressCredential = normalizeCredential(ingressBuffer, 'SIP ingress credential');
    callbackCredential = normalizeCredential(callbackBuffer, 'SIP callback credential');
    if (sameSecret(ingressCredential, callbackCredential)) {
      reject('SIP trunk credentials are not distinct');
    }
  } catch (error) {
    if (error instanceof VoiceRuntimePreflightError) throw error;
    reject('SIP trunk credentials are invalid');
  } finally {
    ingressBuffer.fill(0);
    callbackBuffer.fill(0);
  }

  // Load and validate the complete file-backed snapshot as the final preflight
  // step. The production filesystem also verifies every ancestor; injected
  // fixture filesystems exercise file metadata without pretending to model /.
  if (enabledFlag(privilegedActionsEnabled, 'VOICE_PRIVILEGED_ACTIONS_ENABLED')) {
    reject('privileged voice actions require an independent approval attester');
  }
  const runtimeSecrets = runtimeSecretLoader({
    fsModule,
    expectedUid: 0,
    expectedGid: effectiveGid,
    verifyAncestors: fsModule === fs,
    required: [],
  });

  const runtimeValues = Object.entries(runtimeSecrets).filter(([, value]) => value);
  const sipCredentials = [
    ['SIP ingress credential', ingressCredential],
    ['SIP callback credential', callbackCredential],
  ];
  for (const [sourceName, source] of sipCredentials) {
    for (const [runtimeName, runtimeValue] of runtimeValues) {
      if (sameSecret(source, runtimeValue)) {
        reject(`${sourceName} must be distinct from runtime secret ${runtimeName}`);
      }
    }
  }

  return Object.freeze({ ok: true, uid: effectiveUid, gid: effectiveGid });
}

module.exports = {
  VOICE_RUNTIME_PATHS,
  VoiceStateCapacityGuard,
  VoiceRuntimePreflightError,
  verifyBoundedStateFilesystem,
  validateVoiceRuntimePreflight,
  MAX_STATE_CAPACITY_BYTES,
  MIN_STATE_CAPACITY_BYTES,
  MIN_STATE_FREE_BYTES,
};
