import fs from 'node:fs';
import path from 'node:path';

const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;

export const SIP_STATE_PARENT = '/var/lib';
export const SIP_STATE_ROOT = '/var/lib/teleagent-sip-gateway';
export const SIP_STATE_DATABASE = `${SIP_STATE_ROOT}/gateway-state.sqlite3`;
export const SIP_STATE_SINGLETON = `${SIP_STATE_DATABASE}.lifetime-lock.sqlite3`;
export const SIP_STATE_MARKER_CREDENTIAL = '/run/credentials/teleagent-realtime-sip-gateway.service/SIP_STATE_INITIALIZED';
export const SIP_STATE_MIN_CAPACITY_BYTES = 1n * GIB;
export const SIP_STATE_MAX_CAPACITY_BYTES = 4n * GIB;
export const SIP_STATE_MIN_FREE_BYTES = 512n * MIB;
export const SIP_STATE_MIN_FREE_PERCENT = 20n;

// Only reviewed, durable local filesystems may back crash and replay truth.
// In particular, tmpfs, overlay, and network filesystems are not acceptable.
export const SIP_STATE_DURABLE_FILESYSTEM_TYPES = new Set([
  0xef53n, // ext2/3/4
  0x58465342n, // XFS
  0x9123683en, // Btrfs
  0xf2f52010n, // F2FS
  0x2fc12fc1n, // ZFS
]);

export class SipStateStorageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SipStateStorageError';
    this.code = code;
    this.details = details;
  }
}

function storageError(code, message, details = {}) {
  throw new SipStateStorageError(code, message, details);
}

function numeric(value) {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function sameIdentity(left, right) {
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink'].every((field) => {
    const leftValue = numeric(left?.[field]);
    const rightValue = numeric(right?.[field]);
    return leftValue !== null && rightValue !== null && leftValue === rightValue;
  });
}

function parseInitializationMarker(source) {
  const lines = String(source).split('\n');
  if (lines.at(-1) !== '') {
    storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker is malformed.');
  }
  lines.pop();
  const expectedKeys = [
    'version', 'state_root', 'database_path', 'singleton_path', 'state_dev',
    'database_ino', 'database_birthtime_ns', 'singleton_ino',
    'singleton_birthtime_ns', 'state_uid', 'state_gid',
  ];
  if (lines.length !== expectedKeys.length) {
    storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker is malformed.');
  }
  const result = {};
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const separator = lines[index].indexOf('=');
    const key = lines[index].slice(0, separator);
    const value = lines[index].slice(separator + 1);
    if (separator <= 0 || key !== expectedKeys[index] || value === '') {
      storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker is malformed.');
    }
    result[key] = value;
  }
  if (result.version !== '1') {
    storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker version is invalid.');
  }
  for (const key of [
    'state_dev', 'database_ino', 'database_birthtime_ns', 'singleton_ino',
    'singleton_birthtime_ns', 'state_uid', 'state_gid',
  ]) {
    if (!/^[0-9]+$/u.test(result[key])) {
      storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker is malformed.');
    }
  }
  return Object.freeze(result);
}

function safeInitializedStateFile(metadata, expectedUid, expectedGid) {
  const mode = numeric(metadata?.mode);
  const birthtime = numeric(metadata?.birthtimeNs);
  return metadata?.isFile?.() === true
    && metadata.isSymbolicLink?.() !== true
    && numeric(metadata.uid) === BigInt(expectedUid)
    && numeric(metadata.gid) === BigInt(expectedGid)
    && numeric(metadata.nlink) === 1n
    && mode !== null
    && (mode & 0o7777n) === 0o600n
    && birthtime !== null
    && birthtime > 0n;
}

export function inspectSipStateInitialization({
  markerPath = process.env.SIP_STATE_MARKER_FILE,
  expectedUid,
  expectedGid,
  lstat = (filename) => fs.lstatSync(filename, { bigint: true }),
  realpath = fs.realpathSync,
  open = fs.openSync,
  fstat = (descriptor) => fs.fstatSync(descriptor, { bigint: true }),
  read = fs.readFileSync,
  close = fs.closeSync,
} = {}) {
  if (markerPath !== SIP_STATE_MARKER_CREDENTIAL) {
    storageError(
      'SIP_STATE_INITIALIZATION_INVALID',
      'Realtime SIP state must use the fixed initialization-marker credential.',
    );
  }
  let markerDescriptor;
  let markerSource;
  try {
    const markerBefore = lstat(markerPath);
    const markerMode = numeric(markerBefore.mode);
    if (!markerBefore.isFile() || markerBefore.isSymbolicLink()
        || numeric(markerBefore.nlink) !== 1n
        || ![0n, BigInt(expectedUid)].includes(numeric(markerBefore.uid))
        || ![0n, BigInt(expectedGid)].includes(numeric(markerBefore.gid))
        || markerMode === null || (markerMode & 0o7777n) !== 0o400n
        || numeric(markerBefore.size) === null || numeric(markerBefore.size) > 4_096n
        || realpath(markerPath) !== markerPath) {
      storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker is unsafe.');
    }
    markerDescriptor = open(
      markerPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const markerOpened = fstat(markerDescriptor);
    if (!sameIdentity(markerBefore, markerOpened)
        || numeric(markerOpened.size) !== numeric(markerBefore.size)) {
      storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker changed.');
    }
    markerSource = read(markerDescriptor, 'utf8');
    const markerAfter = fstat(markerDescriptor);
    if (!sameIdentity(markerOpened, markerAfter)
        || numeric(markerAfter.size) !== numeric(markerOpened.size)
        || Buffer.byteLength(markerSource, 'utf8') !== Number(markerOpened.size)) {
      storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker changed.');
    }
  } catch (error) {
    if (error instanceof SipStateStorageError) throw error;
    storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP state marker cannot be read.');
  } finally {
    if (markerDescriptor !== undefined) close(markerDescriptor);
  }

  const marker = parseInitializationMarker(markerSource);
  let root;
  let database;
  let singleton;
  try {
    root = lstat(SIP_STATE_ROOT);
    database = lstat(SIP_STATE_DATABASE);
    singleton = lstat(SIP_STATE_SINGLETON);
  } catch {
    storageError('SIP_STATE_INITIALIZATION_INVALID', 'Realtime SIP initialized state is absent.');
  }
  if (!safeStateRoot(root, expectedUid, expectedGid)
      || !safeInitializedStateFile(database, expectedUid, expectedGid)
      || !safeInitializedStateFile(singleton, expectedUid, expectedGid)
      || realpath(SIP_STATE_ROOT) !== SIP_STATE_ROOT
      || realpath(SIP_STATE_DATABASE) !== SIP_STATE_DATABASE
      || realpath(SIP_STATE_SINGLETON) !== SIP_STATE_SINGLETON
      || marker.state_root !== SIP_STATE_ROOT
      || marker.database_path !== SIP_STATE_DATABASE
      || marker.singleton_path !== SIP_STATE_SINGLETON
      || BigInt(marker.state_dev) !== numeric(root.dev)
      || numeric(database.dev) !== numeric(root.dev)
      || numeric(singleton.dev) !== numeric(root.dev)
      || BigInt(marker.database_ino) !== numeric(database.ino)
      || BigInt(marker.database_birthtime_ns) !== numeric(database.birthtimeNs)
      || BigInt(marker.singleton_ino) !== numeric(singleton.ino)
      || BigInt(marker.singleton_birthtime_ns) !== numeric(singleton.birthtimeNs)
      || Number(marker.state_uid) !== expectedUid
      || Number(marker.state_gid) !== expectedGid) {
    storageError(
      'SIP_STATE_INITIALIZATION_INVALID',
      'Realtime SIP state does not match its root-authored initialization marker.',
    );
  }
  const fileIdentity = (metadata) => Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: metadata.nlink,
    birthtimeNs: metadata.birthtimeNs,
  });
  return Object.freeze({
    marker,
    database: fileIdentity(database),
    singleton: fileIdentity(singleton),
  });
}

function safeParent(metadata) {
  const mode = numeric(metadata?.mode);
  return metadata?.isDirectory?.() === true
    && metadata.isSymbolicLink?.() !== true
    && numeric(metadata.uid) === 0n
    && numeric(metadata.gid) === 0n
    && mode !== null
    && (mode & 0o022n) === 0n;
}

function safeStateRoot(metadata, expectedUid, expectedGid) {
  const mode = numeric(metadata?.mode);
  return metadata?.isDirectory?.() === true
    && metadata.isSymbolicLink?.() !== true
    && numeric(metadata.uid) === BigInt(expectedUid)
    && numeric(metadata.gid) === BigInt(expectedGid)
    && mode !== null
    && (mode & 0o7777n) === 0o700n;
}

export function requireExactSipStatePath(databasePath) {
  if (databasePath !== SIP_STATE_DATABASE || path.dirname(databasePath) !== SIP_STATE_ROOT) {
    storageError(
      'SIP_STATE_PATH_INVALID',
      'Realtime SIP durable state must use the fixed database path.',
    );
  }
  return Object.freeze({
    root: SIP_STATE_ROOT,
    databasePath: SIP_STATE_DATABASE,
    singletonPath: SIP_STATE_SINGLETON,
  });
}

export function inspectSipStateStorage({
  expectedUid,
  expectedGid,
  lstat = (filename) => fs.lstatSync(filename, { bigint: true }),
  realpath = fs.realpathSync,
  open = fs.openSync,
  fstat = (descriptor) => fs.fstatSync(descriptor, { bigint: true }),
  fstatfs = (descriptor) => fs.fstatfsSync(descriptor, { bigint: true }),
  close = fs.closeSync,
} = {}) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid <= 0
      || !Number.isSafeInteger(expectedGid) || expectedGid <= 0) {
    storageError('SIP_STATE_BOUNDARY_INVALID', 'Realtime SIP state owner identity is invalid.');
  }

  let parentBefore;
  let rootBefore;
  try {
    parentBefore = lstat(SIP_STATE_PARENT);
    rootBefore = lstat(SIP_STATE_ROOT);
  } catch {
    storageError('SIP_STATE_BOUNDARY_INVALID', 'Realtime SIP state storage cannot be inspected.');
  }
  if (!safeParent(parentBefore)
      || realpath(SIP_STATE_PARENT) !== SIP_STATE_PARENT
      || !safeStateRoot(rootBefore, expectedUid, expectedGid)
      || realpath(SIP_STATE_ROOT) !== SIP_STATE_ROOT
      || numeric(rootBefore.dev) === numeric(parentBefore.dev)) {
    storageError(
      'SIP_STATE_BOUNDARY_INVALID',
      'Realtime SIP state is not the exact private dedicated mount.',
    );
  }

  let descriptor;
  try {
    descriptor = open(
      SIP_STATE_ROOT,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0),
    );
    const descriptorBefore = fstat(descriptor);
    if (!safeStateRoot(descriptorBefore, expectedUid, expectedGid)
        || !sameIdentity(rootBefore, descriptorBefore)) {
      storageError(
        'SIP_STATE_BOUNDARY_INVALID',
        'Realtime SIP state mount changed while it was opened.',
      );
    }

    const storage = fstatfs(descriptor);
    const blockSize = numeric(storage?.bsize);
    const blocks = numeric(storage?.blocks);
    const availableBlocks = numeric(storage?.bavail);
    const filesystemType = BigInt.asUintN(32, numeric(storage?.type) ?? -1n);
    if (blockSize === null || blocks === null || availableBlocks === null
        || blockSize <= 0n || blocks <= 0n || availableBlocks < 0n
        || availableBlocks > blocks
        || !SIP_STATE_DURABLE_FILESYSTEM_TYPES.has(filesystemType)) {
      storageError(
        'SIP_STATE_BOUNDARY_INVALID',
        'Realtime SIP state is not on a reviewed durable local filesystem.',
      );
    }
    const capacityBytes = blockSize * blocks;
    const freeBytes = blockSize * availableBlocks;
    if (capacityBytes < SIP_STATE_MIN_CAPACITY_BYTES
        || capacityBytes > SIP_STATE_MAX_CAPACITY_BYTES) {
      storageError(
        'SIP_STATE_BOUNDARY_INVALID',
        'Realtime SIP state filesystem is outside the reviewed 1-4 GiB boundary.',
      );
    }
    const percentageReserve = (capacityBytes + 4n) / 5n;
    const requiredFreeBytes = percentageReserve > SIP_STATE_MIN_FREE_BYTES
      ? percentageReserve
      : SIP_STATE_MIN_FREE_BYTES;

    const descriptorAfter = fstat(descriptor);
    let parentAfter;
    let rootAfter;
    try {
      parentAfter = lstat(SIP_STATE_PARENT);
      rootAfter = lstat(SIP_STATE_ROOT);
    } catch {
      storageError(
        'SIP_STATE_BOUNDARY_INVALID',
        'Realtime SIP state mount changed during verification.',
      );
    }
    if (!sameIdentity(descriptorBefore, descriptorAfter)
        || !sameIdentity(descriptorAfter, rootAfter)
        || !sameIdentity(parentBefore, parentAfter)
        || realpath(SIP_STATE_PARENT) !== SIP_STATE_PARENT
        || realpath(SIP_STATE_ROOT) !== SIP_STATE_ROOT) {
      storageError(
        'SIP_STATE_BOUNDARY_INVALID',
        'Realtime SIP state mount changed during verification.',
      );
    }

    return Object.freeze({
      root: SIP_STATE_ROOT,
      databasePath: SIP_STATE_DATABASE,
      singletonPath: SIP_STATE_SINGLETON,
      filesystemType,
      capacityBytes,
      freeBytes,
      requiredFreeBytes,
      admitted: freeBytes >= requiredFreeBytes,
    });
  } catch (error) {
    if (error instanceof SipStateStorageError) throw error;
    storageError(
      'SIP_STATE_BOUNDARY_INVALID',
      'Realtime SIP state storage could not be verified.',
    );
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

export function createSipStateStorageGuard({
  expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  expectedGid = typeof process.getegid === 'function' ? process.getegid() : null,
  databasePath = SIP_STATE_DATABASE,
  inspect = inspectSipStateStorage,
  inspectInitialization = inspectSipStateInitialization,
  markerPath = process.env.SIP_STATE_MARKER_FILE,
} = {}) {
  requireExactSipStatePath(databasePath);
  const inspectIdentity = () => inspectInitialization({ markerPath, expectedUid, expectedGid });
  const inspectCurrent = () => Object.freeze({
    ...inspect({ expectedUid, expectedGid }),
    initializedState: inspectIdentity(),
  });
  const assertAdmission = (phase) => {
    const health = inspectCurrent();
    if (health?.admitted !== true) {
      storageError(
        'SIP_STATE_CAPACITY_EXHAUSTED',
        'Realtime SIP durable-state reserve is exhausted.',
        { phase },
      );
    }
    return health;
  };
  return Object.freeze({
    inspect: inspectCurrent,
    assertOpen: () => assertAdmission('sqlite_open'),
    assertNewRecord: () => assertAdmission('new_record'),
    assertFileIdentity: (filename) => {
      const initialized = inspectIdentity();
      if (filename === SIP_STATE_DATABASE) return initialized.database;
      if (filename === SIP_STATE_SINGLETON) return initialized.singleton;
      storageError('SIP_STATE_PATH_INVALID', 'Realtime SIP state open used an unreviewed path.');
    },
  });
}
