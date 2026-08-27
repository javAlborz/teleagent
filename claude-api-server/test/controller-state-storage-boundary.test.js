'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  ROLE_SPECS,
  STATE_PARENT,
  createDurableStateStorageGuard,
  inspectDurableStateStorage,
  requireExactStatePaths,
} = require('../../lib/durable-state-storage-boundary');
const {
  normalizeControllerStateConfiguration,
} = require('../controller-state-configuration');

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

function inspectController(overrides = {}) {
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
  const health = inspectDurableStateStorage({
    role: 'controller',
    expectedUid: 991,
    expectedGid: 992,
    lstat: (filename) => {
      if (filename === STATE_PARENT) return parent;
      assert.equal(filename, ROLE_SPECS.controller.root);
      rootReads += 1;
      return rootReads > 1 && overrides.replaced
        ? { ...root, ino: 21n }
        : root;
    },
    realpath: (filename) => overrides.realpathDrift && filename === ROLE_SPECS.controller.root
      ? `${filename}-replacement`
      : filename,
    open: (filename, flags) => {
      assert.equal(filename, ROLE_SPECS.controller.root);
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
      blocks: (overrides.capacity ?? (4n * GIB)) / 4096n,
      bavail: (overrides.free ?? (1n * GIB)) / 4096n,
    }),
    close: (descriptor) => {
      assert.equal(descriptor, 19);
      closed = true;
    },
  });
  assert.equal(closed, true);
  return health;
}

test('controller state requires one exact canonical durable 2-8 GiB submount', () => {
  const health = inspectController();
  assert.equal(health.root, ROLE_SPECS.controller.root);
  assert.equal(health.capacityBytes, 4n * GIB);
  assert.equal(health.requiredFreeBytes, (4n * GIB + 4n) / 5n);
  assert.equal(health.admitted, true);

  for (const options of [
    { sameDevice: true },
    { uid: 0 },
    { gid: 0 },
    { mode: 0o40750 },
    { realpathDrift: true },
    { replaced: true },
    { descriptorReplaced: true },
    { filesystemType: 0x01021994n },
    { capacity: 1n * GIB },
    { capacity: 9n * GIB },
  ]) {
    assert.throws(() => inspectController(options), { code: 'DURABLE_STATE_BOUNDARY_INVALID' });
  }
});

test('20 percent or 512 MiB reserve is enforced at open and new-work gates', () => {
  const low = inspectController({ free: 800n * MIB });
  assert.equal(low.requiredFreeBytes, (4n * GIB + 4n) / 5n);
  assert.equal(low.admitted, false);
  const guard = createDurableStateStorageGuard({
    role: 'controller',
    expectedUid: 991,
    expectedGid: 992,
    inspect: () => low,
  });
  assert.throws(() => guard.assertOpen(), {
    code: 'DURABLE_STATE_CAPACITY_EXHAUSTED',
    details: { phase: 'sqlite_open' },
  });
  assert.throws(() => guard.assertNewWork(), {
    code: 'DURABLE_STATE_CAPACITY_EXHAUSTED',
    details: { phase: 'new_work' },
  });

  const twoGibThreshold = 512n * MIB;
  const small = inspectController({ capacity: 2n * GIB, free: twoGibThreshold });
  assert.equal(small.requiredFreeBytes, twoGibThreshold);
  assert.equal(small.admitted, true);
});

test('hardened controller rejects non-exact boundary, home, DB, and lock values', () => {
  const exact = {
    TELEAGENT_CONTROLLER_STATE_BOUNDARY: 'required',
    HOME: ROLE_SPECS.controller.root,
    EXECUTOR_TASK_DB_PATH: ROLE_SPECS.controller.database,
    VOICE_EXECUTION_LOCK_FILE: ROLE_SPECS.controller.lock,
  };
  const events = [];
  const configuration = normalizeControllerStateConfiguration(exact, {
    uid: 991,
    gid: 992,
    createStorageGuard: () => ({
      assertOpen: () => events.push('admit-open'),
      assertNewWork: () => {},
      inspect: () => ({ admitted: true }),
    }),
    inspectStateFile: (filename, options) => {
      assert.equal(options.allowAbsent, false);
      events.push(filename === ROLE_SPECS.controller.lock
        ? 'inspect-lock'
        : 'inspect-database');
    },
  });
  assert.equal(configuration.enforced, true);
  assert.equal(configuration.databasePath, ROLE_SPECS.controller.database);
  assert.deepEqual(events, ['admit-open', 'inspect-lock', 'inspect-database']);

  for (const environment of [
    { ...exact, TELEAGENT_CONTROLLER_STATE_BOUNDARY: 'optional' },
    { ...exact, TELEAGENT_CONTROLLER_STATE_BOUNDARY: ' required ' },
    { ...exact, HOME: '/tmp/controller' },
    { ...exact, EXECUTOR_TASK_DB_PATH: '/tmp/executor.sqlite' },
    { ...exact, VOICE_EXECUTION_LOCK_FILE: '/tmp/voice.lock' },
  ]) {
    assert.throws(() => normalizeControllerStateConfiguration(environment, {
      uid: 991,
      gid: 992,
      createStorageGuard: () => assert.fail('unsafe configuration reached storage'),
    }));
  }
  assert.throws(() => requireExactStatePaths('controller', {
    databasePath: ROLE_SPECS.controller.database,
    lockPath: '/tmp/voice.lock',
  }), { code: 'DURABLE_STATE_PATH_INVALID' });
});
