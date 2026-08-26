'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;
const FIXED_WORKER_STATE_ROOT = '/var/lib/teleagent-worker-state';
const FIXED_WORKER_STATE_PARENT = path.dirname(FIXED_WORKER_STATE_ROOT);
const MIN_STATE_CAPACITY_BYTES = 1n * GIB;
const MAX_STATE_CAPACITY_BYTES = 8n * GIB;
const MIN_STATE_FREE_BYTES = 512n * MIB;
const STATE_DIRECTORIES = Object.freeze({
  'session-broker': `${FIXED_WORKER_STATE_ROOT}/session-broker`,
  'claude-egress': `${FIXED_WORKER_STATE_ROOT}/claude-egress`,
  'codex-egress': `${FIXED_WORKER_STATE_ROOT}/codex-egress`,
});

class WorkerStateStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerStateStorageError';
    this.code = code;
  }
}

function storageError(code, message) {
  throw new WorkerStateStorageError(code, message);
}

function exactRoleDirectory(role) {
  const directory = STATE_DIRECTORIES[String(role || '')];
  if (!directory) {
    storageError('WORKER_STATE_BOUNDARY_INVALID', 'Worker state storage role is invalid.');
  }
  return directory;
}

function inspectWorkerStateStorage({
  role,
  expectedUid,
  expectedGid,
  lstat = fs.lstatSync,
  stat = (filename) => fs.statSync(filename, { bigint: true }),
  statfs = (filename) => fs.statfsSync(filename, { bigint: true }),
  realpath = fs.realpathSync,
} = {}) {
  const directory = exactRoleDirectory(role);
  if (!Number.isSafeInteger(expectedUid) || expectedUid <= 0 ||
      !Number.isSafeInteger(expectedGid) || expectedGid <= 0) {
    storageError('WORKER_STATE_BOUNDARY_INVALID', 'Worker state owner identity is invalid.');
  }
  let parent;
  let root;
  let stateDirectory;
  let parentDevice;
  let rootDevice;
  let directoryDevice;
  let storage;
  try {
    parent = lstat(FIXED_WORKER_STATE_PARENT);
    root = lstat(FIXED_WORKER_STATE_ROOT);
    stateDirectory = lstat(directory);
    parentDevice = stat(FIXED_WORKER_STATE_PARENT);
    rootDevice = stat(FIXED_WORKER_STATE_ROOT);
    directoryDevice = stat(directory);
    storage = statfs(FIXED_WORKER_STATE_ROOT);
  } catch {
    storageError('WORKER_STATE_BOUNDARY_INVALID', 'Worker state storage cannot be inspected.');
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0 || realpath(FIXED_WORKER_STATE_PARENT) !== FIXED_WORKER_STATE_PARENT ||
      !root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || root.gid !== 0 ||
      (root.mode & 0o7777) !== 0o751 || realpath(FIXED_WORKER_STATE_ROOT) !== FIXED_WORKER_STATE_ROOT ||
      !stateDirectory.isDirectory() || stateDirectory.isSymbolicLink() ||
      stateDirectory.uid !== expectedUid || stateDirectory.gid !== expectedGid ||
      (stateDirectory.mode & 0o7777) !== 0o700 || realpath(directory) !== directory ||
      rootDevice.dev === parentDevice.dev || directoryDevice.dev !== rootDevice.dev) {
    storageError(
      'WORKER_STATE_BOUNDARY_INVALID',
      'Worker state requires one exact bounded dedicated mount and private role directory.'
    );
  }
  const blockSize = BigInt(storage.bsize);
  const blocks = BigInt(storage.blocks);
  const availableBlocks = BigInt(storage.bavail);
  if (blockSize <= 0n || blocks <= 0n || availableBlocks < 0n || availableBlocks > blocks) {
    storageError('WORKER_STATE_BOUNDARY_INVALID', 'Worker state filesystem accounting is invalid.');
  }
  const capacityBytes = blockSize * blocks;
  const freeBytes = blockSize * availableBlocks;
  if (capacityBytes < MIN_STATE_CAPACITY_BYTES || capacityBytes > MAX_STATE_CAPACITY_BYTES) {
    storageError(
      'WORKER_STATE_BOUNDARY_INVALID',
      'Worker state filesystem capacity is outside the fixed 1-8 GiB boundary.'
    );
  }
  const percentageReserve = capacityBytes / 10n;
  const requiredFreeBytes = percentageReserve > MIN_STATE_FREE_BYTES
    ? percentageReserve
    : MIN_STATE_FREE_BYTES;
  return Object.freeze({
    role,
    root: FIXED_WORKER_STATE_ROOT,
    directory,
    capacityBytes,
    freeBytes,
    requiredFreeBytes,
    admitted: freeBytes >= requiredFreeBytes,
  });
}

function createWorkerStateStorageGuard({
  role,
  expectedUid,
  expectedGid,
  inspect = inspectWorkerStateStorage,
} = {}) {
  const inspectCurrent = () => inspect({ role, expectedUid, expectedGid });
  inspectCurrent();
  return Object.freeze({
    inspect: inspectCurrent,
    assertNewWork() {
      const health = inspectCurrent();
      if (health?.admitted !== true) {
        storageError(
          'WORKER_STATE_CAPACITY_EXHAUSTED',
          'Worker state reserve is exhausted; new durable work is refused.'
        );
      }
      return health;
    },
  });
}

module.exports = {
  FIXED_WORKER_STATE_PARENT,
  FIXED_WORKER_STATE_ROOT,
  MAX_STATE_CAPACITY_BYTES,
  MIN_STATE_CAPACITY_BYTES,
  MIN_STATE_FREE_BYTES,
  STATE_DIRECTORIES,
  WorkerStateStorageError,
  createWorkerStateStorageGuard,
  exactRoleDirectory,
  inspectWorkerStateStorage,
};
