'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ROLE_SPECS,
  STATE_PARENT,
  inspectDurableStateStorage,
} = require('../../lib/durable-state-storage-boundary');
const { PrivilegedActionStore } = require('../store');
const {
  normalizePrivilegedStateConfiguration,
} = require('../state-configuration');
const { actionPlan, capabilityFixture } = require('./helpers');

const GIB = 1024n * 1024n * 1024n;

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

function inspectPrivileged({ capacity = 1n * GIB, free = 512n * 1024n * 1024n } = {}) {
  const parent = directory({ dev: 1, ino: 10, uid: 0, gid: 0, mode: 0o40755 });
  const root = directory({ dev: 2, ino: 20, uid: 0, gid: 0, mode: 0o40700 });
  return inspectDurableStateStorage({
    role: 'privileged',
    expectedUid: 0,
    expectedGid: 0,
    lstat: (filename) => filename === STATE_PARENT ? parent : root,
    realpath: (filename) => filename,
    open: (filename, flags) => {
      assert.equal(filename, ROLE_SPECS.privileged.root);
      assert.notEqual(flags & fs.constants.O_DIRECTORY, 0);
      return 29;
    },
    fstat: () => root,
    fstatfs: () => ({
      type: 0xef53n,
      bsize: 4096n,
      blocks: capacity / 4096n,
      bavail: free / 4096n,
    }),
    close: (descriptor) => assert.equal(descriptor, 29),
  });
}

test('privileged state uses the exact root-owned 1-8 GiB mount contract', () => {
  const health = inspectPrivileged();
  assert.equal(health.root, ROLE_SPECS.privileged.root);
  assert.equal(health.requiredFreeBytes, 512n * 1024n * 1024n);
  assert.equal(health.admitted, true);
  assert.throws(() => inspectPrivileged({ capacity: 9n * GIB }), {
    code: 'DURABLE_STATE_BOUNDARY_INVALID',
  });
  assert.throws(() => inspectDurableStateStorage({
    role: 'privileged', expectedUid: 0, expectedGid: 1,
  }), { code: 'DURABLE_STATE_BOUNDARY_INVALID' });
});

test('hardened privileged configuration admits and authenticates state before SQLite', () => {
  const exact = {
    TELEAGENT_PRIVILEGED_STATE_BOUNDARY: 'required',
    PRIVILEGED_ACTION_DB_PATH: ROLE_SPECS.privileged.database,
  };
  const events = [];
  const configuration = normalizePrivilegedStateConfiguration(exact, {
    uid: 0,
    gid: 0,
    createStorageGuard: () => ({
      assertOpen: () => events.push('admit-open'),
      assertNewWork: () => {},
      inspect: () => ({ admitted: true }),
    }),
    inspectStateFile: (filename, options) => {
      assert.equal(filename, ROLE_SPECS.privileged.database);
      assert.equal(options.allowAbsent, false);
      events.push('inspect-database');
    },
  });
  assert.equal(configuration.databasePath, ROLE_SPECS.privileged.database);
  assert.deepEqual(events, ['admit-open', 'inspect-database']);

  for (const [environment, uid, gid] of [
    [{ ...exact, TELEAGENT_PRIVILEGED_STATE_BOUNDARY: '' }, 0, 0],
    [{ ...exact, TELEAGENT_PRIVILEGED_STATE_BOUNDARY: ' required ' }, 0, 0],
    [{ ...exact, PRIVILEGED_ACTION_DB_PATH: '/tmp/actions.sqlite' }, 0, 0],
    [exact, 1, 0],
    [exact, 0, 1],
  ]) {
    assert.throws(() => normalizePrivilegedStateConfiguration(environment, {
      uid,
      gid,
      createStorageGuard: () => assert.fail('unsafe configuration reached storage'),
    }));
  }
});

test('capacity refusal rolls back capability use but preserves retries and safety writes', (t) => {
  const directoryName = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-privileged-capacity-'));
  const refusedPath = path.join(directoryName, 'missing', 'actions.sqlite');
  t.after(() => fs.rmSync(directoryName, { recursive: true, force: true }));
  assert.throws(() => new PrivilegedActionStore({
    dbPath: refusedPath,
    strictOwnership: false,
    assertStorageOpen: () => {
      throw Object.assign(new Error('low reserve'), { code: 'DURABLE_STATE_CAPACITY_EXHAUSTED' });
    },
  }), { code: 'DURABLE_STATE_CAPACITY_EXHAUSTED' });
  assert.equal(fs.existsSync(refusedPath), false);

  let admitted = true;
  const store = new PrivilegedActionStore({
    admitNewWork: () => {
      if (!admitted) {
        throw Object.assign(new Error('low reserve'), {
          code: 'DURABLE_STATE_CAPACITY_EXHAUSTED',
        });
      }
    },
  });
  const fixture = capabilityFixture({ store });
  t.after(() => store.close());
  const firstPlan = actionPlan(['/usr/bin/true']);
  const first = fixture.broker.submit({
    idempotencyKey: 'job_capexisting123',
    jobId: 'job_capexisting123',
    callId: 'call-capacity-existing',
    plan: firstPlan,
    authorization: {
      capability: fixture.issue({
        jobId: 'job_capexisting123',
        callId: 'call-capacity-existing',
        plan: firstPlan,
      }),
    },
  });
  admitted = false;
  const retry = fixture.broker.submit({
    idempotencyKey: 'job_capexisting123',
    jobId: 'job_capexisting123',
    callId: 'call-capacity-existing',
    plan: firstPlan,
    authorization: { capability: 'not-consumed-on-exact-retry' },
  });
  assert.equal(retry.created, false);
  assert.equal(retry.action.id, first.action.id);

  const secondPlan = actionPlan(['/usr/bin/false']);
  const secondCapability = fixture.issue({
    jobId: 'job_capnew123',
    callId: 'call-capacity-new',
    plan: secondPlan,
  });
  const replayCount = store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count;
  assert.throws(() => fixture.broker.submit({
    idempotencyKey: 'job_capnew123',
    jobId: 'job_capnew123',
    callId: 'call-capacity-new',
    plan: secondPlan,
    authorization: { capability: secondCapability },
  }), { code: 'PRIVILEGED_STATE_CAPACITY_EXHAUSTED' });
  assert.equal(store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count, replayCount);

  const cancellation = fixture.broker.cancelByIdempotency({
    idempotencyKey: 'job_capcanceled123',
    jobId: 'job_capcanceled123',
    reason: 'caller stopped',
  });
  assert.equal(cancellation.tombstoned, true);
  const panic = fixture.broker.panic({ reason: 'operator stop' });
  assert.equal(panic.persisted, true);
  assert.equal(store.getAction(first.action.id).state, 'canceled');
});
