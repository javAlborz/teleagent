'use strict';

const fs = require('node:fs');

const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;
const STATE_PARENT = '/var/lib';
const MIN_FREE_BYTES = 512n * MIB;
const MAX_CAPACITY_BYTES = 8n * GIB;
const ROLE_SPECS = Object.freeze({
  controller: Object.freeze({
    root: '/var/lib/teleagent-control',
    database: '/var/lib/teleagent-control/executor-tasks.sqlite',
    lock: '/var/lib/teleagent-control/voice-execution.lock.json',
    minimumCapacityBytes: 2n * GIB,
  }),
  privileged: Object.freeze({
    root: '/var/lib/teleagent-privileged-action',
    database: '/var/lib/teleagent-privileged-action/actions.sqlite',
    lock: null,
    minimumCapacityBytes: 1n * GIB,
  }),
});

// These are reviewed durable local filesystems. Volatile tmpfs/ramfs,
// overlay filesystems, and network filesystems are deliberately excluded.
const DURABLE_FILESYSTEM_TYPES = new Set([
  0xef53n, // ext2/3/4
  0x58465342n, // XFS
  0x9123683en, // Btrfs
  0xf2f52010n, // F2FS
  0x2fc12fc1n, // ZFS
]);

class DurableStateStorageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DurableStateStorageError';
    this.code = code;
    this.details = details;
  }
}

function stateError(code, message, details = {}) {
  throw new DurableStateStorageError(code, message, details);
}

function roleSpec(role) {
  const normalized = String(role || '');
  const spec = ROLE_SPECS[normalized];
  if (!spec) {
    stateError('DURABLE_STATE_BOUNDARY_INVALID', 'Durable state role is invalid.');
  }
  return { role: normalized, ...spec };
}

function numeric(value) {
  try { return BigInt(value); } catch { return null; }
}

function sameIdentity(left, right) {
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink']
    .every((field) => {
      const leftValue = numeric(left?.[field]);
      const rightValue = numeric(right?.[field]);
      return leftValue !== null && rightValue !== null && leftValue === rightValue;
    });
}

function safeDirectory(metadata, { uid, gid, mode }) {
  const fileMode = numeric(metadata?.mode);
  return metadata?.isDirectory?.() === true && metadata.isSymbolicLink?.() !== true &&
    numeric(metadata.uid) === BigInt(uid) && numeric(metadata.gid) === BigInt(gid) &&
    fileMode !== null && (fileMode & 0o7777n) === BigInt(mode);
}

function safeStateFile(metadata, { uid, gid }) {
  const fileMode = numeric(metadata?.mode);
  return metadata?.isFile?.() === true && metadata.isSymbolicLink?.() !== true &&
    numeric(metadata.uid) === BigInt(uid) && numeric(metadata.gid) === BigInt(gid) &&
    numeric(metadata.nlink) === 1n && fileMode !== null &&
    (fileMode & 0o7777n) === 0o600n;
}

function requireExactStatePaths(role, { databasePath, lockPath = null } = {}) {
  const spec = roleSpec(role);
  if (databasePath !== spec.database || (spec.lock !== null && lockPath !== spec.lock) ||
      (spec.lock === null && lockPath !== null)) {
    stateError(
      'DURABLE_STATE_PATH_INVALID',
      `The ${spec.role} durable-state path contract drifted.`
    );
  }
  return Object.freeze({
    role: spec.role,
    root: spec.root,
    databasePath: spec.database,
    lockPath: spec.lock,
  });
}

function inspectExactStateFile(filename, {
  expectedUid,
  expectedGid,
  allowAbsent = false,
  lstat = (candidate) => fs.lstatSync(candidate, { bigint: true }),
  realpath = fs.realpathSync,
  open = fs.openSync,
  fstat = (descriptor) => fs.fstatSync(descriptor, { bigint: true }),
  close = fs.closeSync,
} = {}) {
  let pathMetadata;
  try {
    pathMetadata = lstat(filename);
  } catch (error) {
    if (allowAbsent && error?.code === 'ENOENT') return Object.freeze({ exists: false });
    stateError('DURABLE_STATE_FILE_INVALID', 'A durable state file is absent or unsafe.');
  }
  if (!safeStateFile(pathMetadata, { uid: expectedUid, gid: expectedGid }) ||
      realpath(filename) !== filename) {
    stateError('DURABLE_STATE_FILE_INVALID', 'A durable state file has unsafe metadata.');
  }
  let descriptor;
  try {
    descriptor = open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fstat(descriptor);
    const finalPath = lstat(filename);
    if (!safeStateFile(opened, { uid: expectedUid, gid: expectedGid }) ||
        !sameIdentity(pathMetadata, opened) || !sameIdentity(opened, finalPath) ||
        realpath(filename) !== filename) {
      stateError('DURABLE_STATE_FILE_INVALID', 'A durable state file changed while inspected.');
    }
    return Object.freeze({
      exists: true,
      dev: numeric(opened.dev),
      ino: numeric(opened.ino),
    });
  } catch (error) {
    if (error instanceof DurableStateStorageError) throw error;
    stateError('DURABLE_STATE_FILE_INVALID', 'A durable state file could not be inspected.');
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

function inspectDurableStateStorage({
  role,
  expectedUid,
  expectedGid,
  lstat = (filename) => fs.lstatSync(filename, { bigint: true }),
  realpath = fs.realpathSync,
  open = fs.openSync,
  fstat = (descriptor) => fs.fstatSync(descriptor, { bigint: true }),
  fstatfs = (descriptor) => fs.fstatfsSync(descriptor, { bigint: true }),
  close = fs.closeSync,
} = {}) {
  const spec = roleSpec(role);
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 ||
      !Number.isSafeInteger(expectedGid) || expectedGid < 0 ||
      (spec.role === 'controller' && (expectedUid === 0 || expectedGid === 0)) ||
      (spec.role === 'privileged' && (expectedUid !== 0 || expectedGid !== 0))) {
    stateError('DURABLE_STATE_BOUNDARY_INVALID', 'Durable state owner identity is invalid.');
  }

  let parentBefore;
  let rootBefore;
  try {
    parentBefore = lstat(STATE_PARENT);
    rootBefore = lstat(spec.root);
  } catch {
    stateError('DURABLE_STATE_BOUNDARY_INVALID', 'Durable state storage cannot be inspected.');
  }
  if (!safeDirectory(parentBefore, { uid: 0, gid: 0, mode: 0o755 }) ||
      realpath(STATE_PARENT) !== STATE_PARENT ||
      !safeDirectory(rootBefore, { uid: expectedUid, gid: expectedGid, mode: 0o700 }) ||
      realpath(spec.root) !== spec.root ||
      numeric(rootBefore.dev) === numeric(parentBefore.dev)) {
    stateError(
      'DURABLE_STATE_BOUNDARY_INVALID',
      `The ${spec.role} state root is not the exact private dedicated mount.`
    );
  }

  let descriptor;
  try {
    descriptor = open(
      spec.root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0)
    );
    const descriptorBefore = fstat(descriptor);
    if (!safeDirectory(descriptorBefore, {
      uid: expectedUid,
      gid: expectedGid,
      mode: 0o700,
    }) || !sameIdentity(rootBefore, descriptorBefore)) {
      stateError(
        'DURABLE_STATE_BOUNDARY_INVALID',
        `The ${spec.role} state mount changed while it was opened.`
      );
    }

    const storage = fstatfs(descriptor);
    const blockSize = numeric(storage?.bsize);
    const blocks = numeric(storage?.blocks);
    const availableBlocks = numeric(storage?.bavail);
    const filesystemType = BigInt.asUintN(32, numeric(storage?.type) ?? -1n);
    if (blockSize === null || blocks === null || availableBlocks === null ||
        blockSize <= 0n || blocks <= 0n || availableBlocks < 0n ||
        availableBlocks > blocks || !DURABLE_FILESYSTEM_TYPES.has(filesystemType)) {
      stateError(
        'DURABLE_STATE_BOUNDARY_INVALID',
        `The ${spec.role} state filesystem is not a reviewed durable local filesystem.`
      );
    }
    const capacityBytes = blockSize * blocks;
    const freeBytes = blockSize * availableBlocks;
    if (capacityBytes < spec.minimumCapacityBytes || capacityBytes > MAX_CAPACITY_BYTES) {
      stateError(
        'DURABLE_STATE_BOUNDARY_INVALID',
        `The ${spec.role} state filesystem capacity is outside its reviewed boundary.`
      );
    }
    const percentageReserve = (capacityBytes + 4n) / 5n;
    const requiredFreeBytes = percentageReserve > MIN_FREE_BYTES
      ? percentageReserve
      : MIN_FREE_BYTES;

    const descriptorAfter = fstat(descriptor);
    let parentAfter;
    let rootAfter;
    try {
      parentAfter = lstat(STATE_PARENT);
      rootAfter = lstat(spec.root);
    } catch {
      stateError(
        'DURABLE_STATE_BOUNDARY_INVALID',
        `The ${spec.role} state mount changed during verification.`
      );
    }
    if (!sameIdentity(descriptorBefore, descriptorAfter) ||
        !sameIdentity(descriptorAfter, rootAfter) ||
        !sameIdentity(parentBefore, parentAfter) ||
        realpath(STATE_PARENT) !== STATE_PARENT || realpath(spec.root) !== spec.root) {
      stateError(
        'DURABLE_STATE_BOUNDARY_INVALID',
        `The ${spec.role} state mount changed during verification.`
      );
    }

    return Object.freeze({
      role: spec.role,
      root: spec.root,
      databasePath: spec.database,
      lockPath: spec.lock,
      filesystemType,
      capacityBytes,
      freeBytes,
      requiredFreeBytes,
      admitted: freeBytes >= requiredFreeBytes,
    });
  } catch (error) {
    if (error instanceof DurableStateStorageError) throw error;
    stateError(
      'DURABLE_STATE_BOUNDARY_INVALID',
      `The ${spec.role} state storage could not be verified.`
    );
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

function createDurableStateStorageGuard({
  role,
  expectedUid,
  expectedGid,
  inspect = inspectDurableStateStorage,
} = {}) {
  const inspectCurrent = () => inspect({ role, expectedUid, expectedGid });
  const assertAdmission = (phase) => {
    const health = inspectCurrent();
    if (health?.admitted !== true) {
      stateError(
        'DURABLE_STATE_CAPACITY_EXHAUSTED',
        `The ${String(role || '')} durable-state reserve is exhausted.`,
        { phase }
      );
    }
    return health;
  };
  return Object.freeze({
    inspect: inspectCurrent,
    assertOpen: () => assertAdmission('sqlite_open'),
    assertNewWork: () => assertAdmission('new_work'),
  });
}

module.exports = {
  DURABLE_FILESYSTEM_TYPES,
  DurableStateStorageError,
  MAX_CAPACITY_BYTES,
  MIN_FREE_BYTES,
  ROLE_SPECS,
  STATE_PARENT,
  createDurableStateStorageGuard,
  inspectExactStateFile,
  inspectDurableStateStorage,
  requireExactStatePaths,
  roleSpec,
};
