import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

function sameIdentity(left, right) {
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'birthtimeNs']
    .every((field) => left[field] === right[field]);
}

function matchesInitializedIdentity(actual, expected) {
  if (!expected) return true;
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'birthtimeNs']
    .every((field) => BigInt(actual[field]) === BigInt(expected[field]));
}

function assertPrivateStateDirectory(directory, expectedUid, expectedGid) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const linkMetadata = lstatSync(directory);
  const metadata = statSync(directory);
  if (linkMetadata.isSymbolicLink() || !metadata.isDirectory()
      || realpathSync(directory) !== directory) {
    throw new Error('SIP gateway singleton directory must be a real directory');
  }
  if ((metadata.mode & 0o7777) !== 0o700
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid) {
    throw new Error('SIP gateway singleton directory must be private and service-owned');
  }
}

function openValidatedLockFile(lockPath, expectedUid, expectedGid, requireExisting) {
  let descriptor;
  try {
    const flags = requireExisting
      ? fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0)
      : fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR
        | (fsConstants.O_NOFOLLOW ?? 0);
    descriptor = openSync(lockPath, flags, 0o600);
  } catch (error) {
    if (requireExisting || error.code !== 'EEXIST') throw error;
    descriptor = openSync(
      lockPath,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
    );
  }
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n
        || metadata.uid !== BigInt(expectedUid) || metadata.gid !== BigInt(expectedGid)
        || (metadata.mode & 0o7777n) !== 0o600n) {
      throw new Error('SIP gateway singleton lock must be a regular single-link file');
    }
    const pathMetadata = lstatSync(lockPath, { bigint: true });
    if (pathMetadata.isSymbolicLink() || !sameIdentity(metadata, pathMetadata)
        || realpathSync(lockPath) !== lockPath) {
      throw new Error('SIP gateway singleton lock changed while inspected');
    }
    return { descriptor, metadata };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function gatewaySingletonPath(stateDatabasePath) {
  if (!path.isAbsolute(String(stateDatabasePath ?? ''))) {
    throw new TypeError('SIP state database path must be absolute');
  }
  return `${stateDatabasePath}.lifetime-lock.sqlite3`;
}

export function acquireGatewaySingleton({
  stateDatabasePath,
  expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : 0,
  expectedGid = typeof process.getegid === 'function' ? process.getegid() : 0,
  requireExisting = false,
  storageGuard = null,
  databaseFactory = (filename, options) => new Database(filename, options),
} = {}) {
  const lockPath = gatewaySingletonPath(stateDatabasePath);
  assertPrivateStateDirectory(path.dirname(lockPath), expectedUid, expectedGid);
  const opened = openValidatedLockFile(lockPath, expectedUid, expectedGid, requireExisting);
  let checkedDescriptorOpen = true;
  let database;
  try {
    const expectedIdentity = storageGuard?.assertFileIdentity?.(lockPath);
    if (!matchesInitializedIdentity(opened.metadata, expectedIdentity)) {
      throw new Error('SIP gateway singleton lock does not match initialization marker');
    }
    database = databaseFactory(lockPath, { timeout: 0 });
    const afterOpen = lstatSync(lockPath, { bigint: true });
    const reboundIdentity = storageGuard?.assertFileIdentity?.(lockPath);
    if (!sameIdentity(opened.metadata, fstatSync(opened.descriptor, { bigint: true }))
        || !sameIdentity(opened.metadata, afterOpen)
        || !matchesInitializedIdentity(afterOpen, reboundIdentity)) {
      throw new Error('SIP gateway singleton lock changed during SQLite open');
    }
    // POSIX closes release this process's fcntl locks for the inode, even when
    // SQLite owns a different descriptor. Close the inspection descriptor
    // before SQLite acquires BEGIN EXCLUSIVE, never after it.
    closeSync(opened.descriptor);
    checkedDescriptorOpen = false;
    database.pragma('busy_timeout = 0');
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.exec(`
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS gateway_lifetime_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
      INSERT INTO gateway_lifetime_lock (singleton) VALUES (1)
      ON CONFLICT(singleton) DO NOTHING;
    `);
  } catch (error) {
    database?.close();
    if (String(error.code ?? '').startsWith('SQLITE_BUSY')) {
      throw new Error(
        'Another Realtime SIP gateway holds the kernel-backed singleton lock',
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (checkedDescriptorOpen) closeSync(opened.descriptor);
  }

  let released = false;
  return Object.freeze({
    lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        database.exec('ROLLBACK');
      } finally {
        database.close();
      }
    },
  });
}
