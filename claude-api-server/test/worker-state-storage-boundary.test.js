'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FIXED_WORKER_STATE_PARENT,
  FIXED_WORKER_STATE_ROOT,
  MIN_STATE_FREE_PERCENT,
  STATE_DIRECTORIES,
  createWorkerStateStorageGuard,
  inspectWorkerStateStorage,
} = require('../worker-state-storage-boundary');

const GIB = 1024n * 1024n * 1024n;

function metadata({ uid, gid, mode }) {
  return {
    uid,
    gid,
    mode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function inspect(overrides = {}) {
  const role = 'session-broker';
  const directory = STATE_DIRECTORIES[role];
  return inspectWorkerStateStorage({
    role,
    expectedUid: 991,
    expectedGid: 992,
    lstat: (filename) => {
      if (filename === FIXED_WORKER_STATE_PARENT) {
        return metadata({ uid: 0, gid: 0, mode: 0o40755 });
      }
      if (filename === FIXED_WORKER_STATE_ROOT) {
        return metadata({ uid: 0, gid: 0, mode: overrides.rootMode ?? 0o40751 });
      }
      assert.equal(filename, directory);
      return metadata({
        uid: overrides.uid ?? 991,
        gid: overrides.gid ?? 992,
        mode: 0o40700,
      });
    },
    realpath: (filename) => filename,
    stat: (filename) => ({
      dev: filename === FIXED_WORKER_STATE_PARENT
        ? 1n
        : filename === FIXED_WORKER_STATE_ROOT
          ? (overrides.rootDev ?? 2n)
          : (overrides.directoryDev ?? 2n),
    }),
    statfs: () => ({
      bsize: 4096n,
      blocks: (overrides.capacity ?? (4n * GIB)) / 4096n,
      bavail: (overrides.free ?? (1n * GIB)) / 4096n,
    }),
  });
}

test('worker state requires the exact bounded submount and private role directory', () => {
  const health = inspect();
  assert.equal(health.root, FIXED_WORKER_STATE_ROOT);
  assert.equal(health.directory, STATE_DIRECTORIES['session-broker']);
  assert.equal(health.capacityBytes, 4n * GIB);
  assert.equal(health.requiredFreeBytes, 4n * GIB / 5n);
  assert.equal(MIN_STATE_FREE_PERCENT, 20n);
  assert.equal(health.admitted, true);
  assert.throws(() => inspect({ rootDev: 1n }), { code: 'WORKER_STATE_BOUNDARY_INVALID' });
  assert.throws(() => inspect({ directoryDev: 3n }), { code: 'WORKER_STATE_BOUNDARY_INVALID' });
  assert.throws(() => inspect({ gid: 993 }), { code: 'WORKER_STATE_BOUNDARY_INVALID' });
  assert.throws(() => inspect({ rootMode: 0o40771 }), { code: 'WORKER_STATE_BOUNDARY_INVALID' });
  assert.throws(() => inspect({ capacity: 9n * GIB }), { code: 'WORKER_STATE_BOUNDARY_INVALID' });
});

test('worker state refuses guard startup below the 20-percent reserve', () => {
  const low = inspect({ free: 700n * 1024n * 1024n });
  assert.equal(low.admitted, false);
  assert.throws(() => createWorkerStateStorageGuard({
    role: 'session-broker',
    expectedUid: 991,
    expectedGid: 992,
    inspect: () => low,
  }), { code: 'WORKER_STATE_CAPACITY_EXHAUSTED' });
});

test('worker state rechecks the reserve before every new durable write', () => {
  const healthy = inspect();
  const low = inspect({ free: 700n * 1024n * 1024n });
  let current = healthy;
  const guard = createWorkerStateStorageGuard({
    role: 'session-broker',
    expectedUid: 991,
    expectedGid: 992,
    inspect: () => current,
  });
  assert.equal(guard.inspect().admitted, true);
  current = low;
  assert.equal(guard.inspect().admitted, false);
  assert.throws(() => guard.assertNewWork(), { code: 'WORKER_STATE_CAPACITY_EXHAUSTED' });
});
