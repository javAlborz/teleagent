import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

function assertPrivateStateDirectory(directory, expectedUid) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const linkMetadata = lstatSync(directory);
  const metadata = statSync(directory);
  if (linkMetadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('SIP gateway singleton directory must be a real directory');
  }
  if ((metadata.mode & 0o077) !== 0 || (metadata.uid !== 0 && metadata.uid !== expectedUid)) {
    throw new Error('SIP gateway singleton directory must be private and service-owned');
  }
}

function createOrValidateLockFile(lockPath, expectedUid) {
  let descriptor;
  try {
    descriptor = openSync(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      0o600,
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error('SIP gateway singleton lock must be a regular single-link file');
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const metadata = lstatSync(lockPath);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || (metadata.uid !== 0 && metadata.uid !== expectedUid)
  ) {
    throw new Error('SIP gateway singleton lock database is unsafe');
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
} = {}) {
  const lockPath = gatewaySingletonPath(stateDatabasePath);
  assertPrivateStateDirectory(path.dirname(lockPath), expectedUid);
  createOrValidateLockFile(lockPath, expectedUid);

  const database = new Database(lockPath, { timeout: 0 });
  try {
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
    database.close();
    if (String(error.code ?? '').startsWith('SQLITE_BUSY')) {
      throw new Error(
        'Another Realtime SIP gateway holds the kernel-backed singleton lock',
        { cause: error },
      );
    }
    throw error;
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
