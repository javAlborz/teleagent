import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createSipStateStorageGuard,
  inspectSipStateInitialization,
  inspectSipStateStorage,
  requireExactSipStatePath,
  SIP_STATE_DATABASE,
  SIP_STATE_MARKER_CREDENTIAL,
  SIP_STATE_PARENT,
  SIP_STATE_ROOT,
  SIP_STATE_SINGLETON,
} from '../src/state-storage-boundary.js';

const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;

function directory({ dev, ino, uid, gid, mode }) {
  return {
    dev: BigInt(dev),
    ino: BigInt(ino),
    uid: BigInt(uid),
    gid: BigInt(gid),
    mode: BigInt(mode),
    nlink: 2n,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function regularFile({ dev, ino, uid, gid, mode = 0o100600, birthtimeNs, size = 0 }) {
  return {
    dev: BigInt(dev),
    ino: BigInt(ino),
    uid: BigInt(uid),
    gid: BigInt(gid),
    mode: BigInt(mode),
    nlink: 1n,
    birthtimeNs: BigInt(birthtimeNs),
    size: BigInt(size),
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function initializationFixture(overrides = {}) {
  const root = directory({ dev: 2, ino: 20, uid: 991, gid: 992, mode: 0o40700 });
  const database = regularFile({
    dev: 2,
    ino: overrides.databaseIno ?? 30,
    uid: 991,
    gid: 992,
    birthtimeNs: 3_000,
  });
  const singleton = regularFile({
    dev: 2, ino: 31, uid: 991, gid: 992, birthtimeNs: 3_100,
  });
  const markerSource = [
    'version=1',
    `state_root=${SIP_STATE_ROOT}`,
    `database_path=${SIP_STATE_DATABASE}`,
    `singleton_path=${SIP_STATE_SINGLETON}`,
    'state_dev=2',
    'database_ino=30',
    'database_birthtime_ns=3000',
    'singleton_ino=31',
    'singleton_birthtime_ns=3100',
    'state_uid=991',
    'state_gid=992',
    '',
  ].join('\n');
  const marker = regularFile({
    dev: 8,
    ino: 40,
    uid: 0,
    gid: 0,
    mode: 0o100400,
    birthtimeNs: 4_000,
    size: Buffer.byteLength(markerSource),
  });
  return {
    markerSource,
    options: {
      markerPath: SIP_STATE_MARKER_CREDENTIAL,
      expectedUid: 991,
      expectedGid: 992,
      lstat: (filename) => new Map([
        [SIP_STATE_MARKER_CREDENTIAL, marker],
        [SIP_STATE_ROOT, root],
        [SIP_STATE_DATABASE, database],
        [SIP_STATE_SINGLETON, singleton],
      ]).get(filename),
      realpath: (filename) => filename,
      open: () => 19,
      fstat: () => marker,
      read: () => markerSource,
      close() {},
    },
  };
}

function inspectSip(overrides = {}) {
  const parent = directory({ dev: 1, ino: 10, uid: 0, gid: 0, mode: 0o40755 });
  const root = directory({
    dev: overrides.sameDevice ? 1 : 2,
    ino: 20,
    uid: overrides.uid ?? 991,
    gid: overrides.gid ?? 992,
    mode: overrides.mode ?? 0o40700,
  });
  let rootReads = 0;
  let descriptorReads = 0;
  let closed = false;
  const health = inspectSipStateStorage({
    expectedUid: 991,
    expectedGid: 992,
    lstat: (filename) => {
      if (filename === SIP_STATE_PARENT) return parent;
      assert.equal(filename, SIP_STATE_ROOT);
      rootReads += 1;
      return rootReads > 1 && overrides.pathReplaced ? { ...root, ino: 21n } : root;
    },
    realpath: (filename) => overrides.realpathDrift && filename === SIP_STATE_ROOT
      ? `${filename}-replacement`
      : filename,
    open: (filename, flags) => {
      assert.equal(filename, SIP_STATE_ROOT);
      assert.notEqual(flags & fs.constants.O_DIRECTORY, 0);
      if (fs.constants.O_NOFOLLOW) assert.notEqual(flags & fs.constants.O_NOFOLLOW, 0);
      return 19;
    },
    fstat: () => {
      descriptorReads += 1;
      return descriptorReads > 1 && overrides.descriptorReplaced
        ? { ...root, ino: 22n }
        : root;
    },
    fstatfs: () => ({
      type: overrides.filesystemType ?? 0xef53n,
      bsize: 4096n,
      blocks: (overrides.capacity ?? (2n * GIB)) / 4096n,
      bavail: (overrides.free ?? (768n * MIB)) / 4096n,
    }),
    close: (descriptor) => {
      assert.equal(descriptor, 19);
      closed = true;
    },
  });
  assert.equal(closed, true);
  return health;
}

test('SIP state requires the exact canonical service-owned 1-4 GiB submount', () => {
  const health = inspectSip();
  assert.equal(health.root, SIP_STATE_ROOT);
  assert.equal(health.capacityBytes, 2n * GIB);
  assert.equal(health.requiredFreeBytes, 512n * MIB);
  assert.equal(health.admitted, true);

  for (const options of [
    { sameDevice: true },
    { uid: 0 },
    { gid: 0 },
    { mode: 0o40750 },
    { realpathDrift: true },
    { pathReplaced: true },
    { descriptorReplaced: true },
    { filesystemType: 0x01021994n },
    { capacity: 512n * MIB },
    { capacity: 5n * GIB },
  ]) {
    assert.throws(() => inspectSip(options), { code: 'SIP_STATE_BOUNDARY_INVALID' });
  }
});

test('startup and new-record gates enforce max(20 percent, 512 MiB)', () => {
  const largeLow = inspectSip({ capacity: 4n * GIB, free: 800n * MIB });
  assert.equal(largeLow.requiredFreeBytes, (4n * GIB + 4n) / 5n);
  assert.equal(largeLow.admitted, false);
  const guard = createSipStateStorageGuard({
    expectedUid: 991,
    expectedGid: 992,
    inspect: () => largeLow,
    inspectInitialization: () => ({ database: {}, singleton: {} }),
    markerPath: SIP_STATE_MARKER_CREDENTIAL,
  });
  assert.throws(() => guard.assertOpen(), {
    code: 'SIP_STATE_CAPACITY_EXHAUSTED',
    details: { phase: 'sqlite_open' },
  });
  assert.throws(() => guard.assertNewRecord(), {
    code: 'SIP_STATE_CAPACITY_EXHAUSTED',
    details: { phase: 'new_record' },
  });

  const smallThreshold = inspectSip({ capacity: 1n * GIB, free: 512n * MIB });
  assert.equal(smallThreshold.requiredFreeBytes, 512n * MIB);
  assert.equal(smallThreshold.admitted, true);
});

test('runtime binds both SQLite files to the root-authored initialization marker', () => {
  const valid = initializationFixture();
  const initialized = inspectSipStateInitialization(valid.options);
  assert.equal(initialized.database.ino, 30n);
  assert.equal(initialized.singleton.ino, 31n);

  const replaced = initializationFixture({ databaseIno: 33 });
  assert.throws(() => inspectSipStateInitialization(replaced.options), {
    code: 'SIP_STATE_INITIALIZATION_INVALID',
  });
  assert.throws(() => inspectSipStateInitialization({
    ...valid.options,
    markerPath: '/tmp/caller-selected-marker',
  }), { code: 'SIP_STATE_INITIALIZATION_INVALID' });
});

test('the guard rejects path drift before any inspection or open', () => {
  let inspected = false;
  assert.throws(() => createSipStateStorageGuard({
    expectedUid: 991,
    expectedGid: 992,
    databasePath: '/tmp/gateway-state.sqlite3',
    inspect: () => {
      inspected = true;
    },
  }), { code: 'SIP_STATE_PATH_INVALID' });
  assert.equal(inspected, false);
  assert.equal(requireExactSipStatePath(SIP_STATE_DATABASE).root, SIP_STATE_ROOT);
});
