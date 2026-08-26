'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { authorizePrivilegedAction } = require('../verifier');
const { actionPlan, capabilityFixture } = require('./helpers');

function submit(fixture, {
  idempotencyKey = 'job_test123',
  jobId = 'job_test123',
  callId = 'call-test',
  plan = actionPlan(),
  capability = fixture.issue({ jobId, callId, plan }),
} = {}) {
  return fixture.broker.submit({
    idempotencyKey,
    jobId,
    callId,
    plan,
    authorization: { capability },
  });
}

test('signed capability binds full plan and detects tampering without consuming valid scope', () => {
  const fixture = capabilityFixture();
  const approvedPlan = actionPlan(['/usr/bin/true']);
  const token = fixture.issue({ plan: approvedPlan });
  assert.throws(
    () => submit(fixture, { plan: actionPlan(['/usr/bin/false']), capability: token }),
    { code: 'CAPABILITY_BINDING_MISMATCH' }
  );
  const accepted = submit(fixture, { plan: approvedPlan, capability: token });
  assert.equal(accepted.created, true);
  assert.equal(accepted.action.approval.method, 'root-broker-exact-argv-v1');
  fixture.store.close();
});

test('replay is rejected while exact idempotent retry returns existing action without reconsume', () => {
  const fixture = capabilityFixture();
  const plan = actionPlan();
  const token = fixture.issue({ plan });
  const first = submit(fixture, { plan, capability: token });
  const retry = submit(fixture, { plan, capability: 'not-used-on-exact-retry' });
  assert.equal(retry.created, false);
  assert.equal(retry.action.id, first.action.id);
  assert.throws(
    () => authorizePrivilegedAction({
      verifier: fixture.verifier,
      jobId: 'job_test123',
      callId: 'call-test',
      actionPlan: plan,
      authorization: { capability: token },
    }),
    { code: 'CAPABILITY_REPLAYED' }
  );
  fixture.store.close();
});

test('idempotency mismatch is rejected before a new capability can be consumed', () => {
  const fixture = capabilityFixture();
  submit(fixture);
  const before = fixture.store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count;
  const different = actionPlan(['/usr/bin/false']);
  const fresh = fixture.issue({ plan: different });
  assert.throws(
    () => submit(fixture, { plan: different, capability: fresh }),
    { code: 'IDEMPOTENCY_CONFLICT' }
  );
  assert.equal(fixture.store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count, before);
  fixture.store.close();
});

test('submission idempotency key must exactly equal the signed voice job ID', () => {
  const fixture = capabilityFixture();
  const token = fixture.issue();
  assert.throws(() => submit(fixture, {
    idempotencyKey: 'job_different123',
    jobId: 'job_test123',
    capability: token,
  }), { code: 'PRIVILEGED_IDEMPOTENCY_KEY_INVALID' });
  assert.equal(fixture.store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count, 0);
  assert.throws(() => fixture.broker.cancelByIdempotency({
    idempotencyKey: 'job_different123',
    jobId: 'job_test123',
    reason: 'mismatched cancellation',
  }), { code: 'PRIVILEGED_IDEMPOTENCY_KEY_INVALID' });
  assert.equal(fixture.store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_cancellations'
  ).get().count, 0);
  assert.equal(submit(fixture, { capability: token }).created, true);
  fixture.store.close();
});

test('nonce consumption and action insertion roll back together after submit failure', () => {
  const fixture = capabilityFixture();
  const token = fixture.issue();
  const originalSubmit = fixture.store.submitAction.bind(fixture.store);
  fixture.store.submitAction = () => {
    throw Object.assign(new Error('injected insert failure'), { code: 'INJECTED_FAILURE' });
  };
  assert.throws(() => submit(fixture, { capability: token }), /injected insert failure/);
  assert.equal(fixture.store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count, 0);
  fixture.store.submitAction = originalSubmit;
  assert.equal(submit(fixture, { capability: token }).created, true);
  fixture.store.close();
});

test('audit/outbox and action insertion are atomic and never persist bearer or nonce', () => {
  const fixture = capabilityFixture();
  const token = fixture.issue();
  const originalAppend = fixture.store._append.bind(fixture.store);
  fixture.store._append = () => { throw new Error('injected audit failure'); };
  assert.throws(() => submit(fixture, { capability: token }), /injected audit failure/);
  assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM privileged_actions').get().count, 0);
  assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM privileged_action_audit').get().count, 0);
  fixture.store._append = originalAppend;
  const accepted = submit(fixture, { capability: token });
  const persisted = fixture.store.db.prepare(`
    SELECT plan_json || approval_json AS body FROM privileged_actions WHERE id = ?
  `).get(accepted.action.id).body;
  assert.equal(persisted.includes(token), false);
  const replayColumns = fixture.store.db.prepare(
    'PRAGMA table_info(privileged_action_capability_replay)'
  ).all().map((column) => column.name);
  assert.equal(replayColumns.includes('nonce'), false);
  assert.equal(replayColumns.includes('token_sha256'), false);
  assert.ok(fixture.store.listAudit({ actionId: accepted.action.id }).length > 0);
  assert.ok(fixture.store.listOutbox().length > 0);
  fixture.store.close();
});

test('cancel-before-submit tombstone and panic both preserve an unconsumed capability', () => {
  const fixture = capabilityFixture();
  const token = fixture.issue();
  const canceled = fixture.broker.cancelByIdempotency({
    idempotencyKey: 'job_test123', jobId: 'job_test123', reason: 'caller pressed star',
  });
  assert.equal(canceled.tombstoned, true);
  assert.throws(() => submit(fixture, { capability: token }), {
    code: 'PRIVILEGED_ACTION_CANCELED_BEFORE_SUBMIT',
  });
  assert.equal(fixture.store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count, 0);

  const second = capabilityFixture();
  second.broker.panic({ reason: 'dial panic' });
  const panicToken = second.issue();
  assert.throws(() => submit(second, { capability: panicToken }), {
    code: 'PRIVILEGED_PANIC_LOCKED',
  });
  assert.equal(second.store.db.prepare(
    'SELECT COUNT(*) AS count FROM privileged_action_capability_replay'
  ).get().count, 0);
  fixture.store.close();
  second.store.close();
});

test('CAS cancellation and interrupted execution are truthfully terminalized', () => {
  const fixture = capabilityFixture();
  const action = submit(fixture).action;
  assert.throws(() => fixture.store.requestCancellation({
    actionId: action.id, expectedRevision: action.revision + 1,
  }), { code: 'CAS_MISMATCH' });
  const claim = fixture.store.claimNext({ workerId: 'test-worker' });
  assert.ok(claim);
  const recovered = fixture.store.recoverInterrupted();
  assert.deepEqual(recovered, [action.id]);
  assert.equal(fixture.store.getAction(action.id).state, 'outcome_unknown');
  fixture.store.close();
});

test('outbox consumer cursor is durable and CAS protected', () => {
  const fixture = capabilityFixture();
  submit(fixture);
  const batch = fixture.store.listOutboxForConsumer({ consumerId: 'test-projection' });
  const last = batch.events.at(-1).sequence;
  fixture.store.acknowledgeOutbox({
    consumerId: 'test-projection', sequence: last, expectedPrevious: 0,
  });
  assert.equal(
    fixture.store.listOutboxForConsumer({ consumerId: 'test-projection' }).lastSequence,
    last
  );
  assert.throws(() => fixture.store.acknowledgeOutbox({
    consumerId: 'test-projection', sequence: last, expectedPrevious: 0,
  }), { code: 'CAS_MISMATCH' });
  fixture.store.close();
});

test('panic unlock is root-local only and refuses unverifiable or active execution', () => {
  const fixture = capabilityFixture();
  fixture.store.panic({ reason: 'operator stop' });
  assert.throws(() => fixture.store.unlockPanic({ source: 'test' }), {
    code: 'PRIVILEGED_QUIESCENCE_UNVERIFIED',
  });
  assert.equal(fixture.store.unlockPanic({
    source: 'root_local_control_cli', activeChildCount: 0,
  }).panic.locked, false);

  const active = capabilityFixture();
  submit(active);
  active.store.claimNext({ workerId: 'still-active' });
  active.store.panic({ reason: 'operator stop' });
  assert.throws(() => active.store.unlockPanic({
    source: 'root_local_control_cli', activeChildCount: 0,
  }), { code: 'PRIVILEGED_ACTIONS_ACTIVE' });
  fixture.store.close();
  active.store.close();
});

test('panic reasserts cancellation for already cancel-requested work until quiesced', () => {
  const fixture = capabilityFixture();
  const action = submit(fixture).action;
  const claim = fixture.store.claimNext({ workerId: 'active-worker' });
  assert.equal(claim.action.id, action.id);

  const first = fixture.broker.panic({ reason: 'dial nine', source: 'voice' });
  assert.equal(first.accepted, true);
  assert.equal(first.persisted, true);
  assert.equal(first.quiesced, false);
  assert.deepEqual(first.activeActionIds, [action.id]);

  const second = fixture.broker.panic({ reason: 'dial nine retry', source: 'voice_retry' });
  assert.equal(second.alreadyLocked, true);
  assert.equal(second.quiesced, false);
  assert.deepEqual(second.activeActionIds, [action.id]);
  assert.equal(fixture.store.listAudit({ actionId: action.id })
    .some((event) => event.eventType === 'cancel_reasserted'), true);

  fixture.store.markOutcomeUnknown({
    actionId: action.id,
    leaseToken: claim.leaseToken,
    workerId: 'active-worker',
    errorCode: 'TEST_OUTCOME_UNKNOWN',
    errorMessage: 'The test execution may have completed.',
  });
  const quiesced = fixture.broker.panic({ reason: 'verify quiescence', source: 'voice_retry' });
  assert.equal(quiesced.quiesced, true);
  assert.equal(quiesced.activeActionCount, 0);
  fixture.store.close();
});

test('durable process recovery barrier prevents false quiescence and local unlock', () => {
  const fixture = capabilityFixture();
  const action = submit(fixture).action;
  const claim = fixture.store.claimNext({ workerId: 'recovery-worker' });
  const markerHash = 'a'.repeat(64);
  fixture.store.prepareProcessExecution({
    actionId: action.id,
    leaseToken: claim.leaseToken,
    workerId: 'recovery-worker',
    processId: 'pproc_recovery_test',
    purpose: 'main',
    markerHash,
    argvHash: 'b'.repeat(64),
  });
  fixture.store.setRecoveryBarrier({
    reason: 'restart_child_scan',
    details: { durableProcessCount: 1 },
  });
  fixture.store.recoverInterrupted();
  const panic = fixture.store.panic({ reason: 'reassert while recovering' });
  assert.equal(panic.quiesced, false);
  assert.equal(panic.unquiescedProcessCount, 1);
  assert.equal(panic.recoveryBlocked, true);
  assert.throws(() => fixture.store.unlockPanic({
    source: 'root_local_control_cli', activeChildCount: 0,
  }), { code: 'PRIVILEGED_RECOVERY_BLOCKED' });

  fixture.store.recordProcessQuiesced({
    processId: 'pproc_recovery_test',
    markerHash,
    actor: 'root_broker_recovery',
    evidence: { verified_zero: true },
  });
  fixture.store.clearRecoveryBarrier({
    source: 'root_broker_recovery',
    activeChildCount: 0,
  });
  assert.equal(fixture.store.getPanicStatus().locked, true);
  assert.equal(fixture.store.getPanicStatus().recoveryBlocked, false);
  assert.equal(fixture.store.unlockPanic({
    source: 'root_local_control_cli', activeChildCount: 0,
  }).panic.locked, false);
  fixture.store.close();
});
