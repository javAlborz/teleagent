'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ExecutorTaskStore,
  ExecutorTaskStoreError,
} = require('../executor-task-store');

function createFixture(t, { leaseMs = 5000, storeOptions = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-executor-store-'));
  const dbPath = path.join(directory, 'state', 'executor.sqlite');
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const now = () => new Date(clockMs);
  const stores = [];
  const open = () => {
    const store = new ExecutorTaskStore({
      dbPath,
      now,
      defaultLeaseMs: leaseMs,
      ...storeOptions,
    });
    stores.push(store);
    return store;
  };
  const advance = (milliseconds) => { clockMs += milliseconds; };
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, dbPath, now, open, advance };
}

test('storage admission precedes SQLite open and gates only new task records', (t) => {
  const refusedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-executor-refused-'));
  const refusedPath = path.join(refusedDirectory, 'state', 'executor.sqlite');
  t.after(() => fs.rmSync(refusedDirectory, { recursive: true, force: true }));
  assert.throws(() => new ExecutorTaskStore({
    dbPath: refusedPath,
    assertStorageOpen: () => {
      throw Object.assign(new Error('low reserve'), { code: 'DURABLE_STATE_CAPACITY_EXHAUSTED' });
    },
  }), { code: 'DURABLE_STATE_CAPACITY_EXHAUSTED' });
  assert.equal(fs.existsSync(refusedPath), false);
  assert.equal(fs.existsSync(path.dirname(refusedPath)), false);

  let admit = true;
  const fixture = createFixture(t, {
    storeOptions: {
      admitNewWork: () => {
        if (!admit) {
          throw Object.assign(new Error('low reserve'), {
            code: 'DURABLE_STATE_CAPACITY_EXHAUSTED',
          });
        }
      },
    },
  });
  const store = fixture.open();
  const request = {
    idempotencyKey: 'capacity-existing',
    taskType: 'managed_agent',
    callId: 'call-capacity-existing',
    request: { prompt: 'one durable task' },
  };
  const first = store.submitTask(request);
  admit = false;
  const retry = store.submitTask(request);
  assert.equal(retry.created, false);
  assert.equal(retry.task.id, first.task.id);
  expectStoreError('EXECUTOR_STATE_CAPACITY_EXHAUSTED', () => store.submitTask({
    ...request,
    idempotencyKey: 'capacity-new',
  }));

  const cancellation = store.reserveCancellation({
    idempotencyKey: 'capacity-cancel-before-submit',
    callId: 'call-capacity-cancel',
    reason: 'caller stopped',
    source: 'capacity-test',
  });
  assert.equal(cancellation.idempotencyKey, 'capacity-cancel-before-submit');
  const panic = store.panic({ reason: 'operator stop', source: 'capacity-test' });
  assert.equal(panic.persisted, true);
  assert.equal(store.getTask(first.task.id).state, 'canceled');
});

function expectStoreError(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ExecutorTaskStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

test('tasks and idempotency survive process restart without duplicate submissions', (t) => {
  const fixture = createFixture(t);
  const firstStore = fixture.open();
  const first = firstStore.submitTask({
    idempotencyKey: 'call-1:tool-7',
    taskType: 'managed_agent',
    callId: 'call-1',
    request: { profile: 'codex-sol', prompt: 'inspect hermes' },
    metadata: { caller: '1001' },
  });
  assert.equal(first.created, true);
  assert.match(first.task.id, /^xtask_[a-f0-9]{32}$/);
  assert.equal(first.task.state, 'queued');

  const same = firstStore.submitTask({
    idempotencyKey: 'call-1:tool-7',
    taskType: 'managed_agent',
    callId: 'call-1',
    request: { prompt: 'inspect hermes', profile: 'codex-sol' },
    metadata: { caller: 'different non-semantic metadata' },
  });
  assert.equal(same.created, false);
  assert.equal(same.task.id, first.task.id);

  expectStoreError('IDEMPOTENCY_CONFLICT', () => firstStore.submitTask({
    idempotencyKey: 'call-1:tool-7',
    taskType: 'managed_agent',
    callId: 'call-1',
    request: { profile: 'codex-sol', prompt: 'do something else' },
  }));

  firstStore.close();
  const reopened = fixture.open();
  assert.equal(reopened.getTask(first.task.id).state, 'queued');
  assert.equal(reopened.getTaskByIdempotencyKey('call-1:tool-7').id, first.task.id);
  assert.equal(reopened.listEvents({ taskId: first.task.id }).length, 1);
  assert.equal(fs.statSync(fixture.dbPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(fixture.dbPath)).mode & 0o777, 0o700);
});

test('atomic claims across store connections never lease one task twice', (t) => {
  const fixture = createFixture(t);
  const storeA = fixture.open();
  const storeB = fixture.open();
  const taskA = storeA.submitTask({
    idempotencyKey: 'claim-a',
    request: { prompt: 'a' },
  }).task;
  const taskB = storeA.submitTask({
    idempotencyKey: 'claim-b',
    request: { prompt: 'b' },
  }).task;

  const claimA = storeA.claimNext({ workerId: 'worker-a' });
  const claimB = storeB.claimNext({ workerId: 'worker-b' });
  assert.notEqual(claimA.task.id, claimB.task.id);
  assert.deepEqual(new Set([claimA.task.id, claimB.task.id]), new Set([taskA.id, taskB.id]));
  assert.equal(storeA.claimNext({ workerId: 'worker-c' }), null);

  fixture.advance(1000);
  const heartbeat = storeA.heartbeat({
    taskId: claimA.task.id,
    leaseToken: claimA.leaseToken,
    workerId: 'worker-a',
    execution: { pid: 4242, processStartTime: '12345' },
  });
  assert.deepEqual(heartbeat.execution, { pid: 4242, processStartTime: '12345' });
  assert.equal(heartbeat.leaseExpired, false);

  const completed = storeA.completeTask({
    taskId: claimA.task.id,
    leaseToken: claimA.leaseToken,
    workerId: 'worker-a',
    result: { summary: 'done' },
  });
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.result, { summary: 'done' });
  expectStoreError('TASK_NOT_RUNNING', () => storeA.completeTask({
    taskId: claimA.task.id,
    leaseToken: claimA.leaseToken,
    workerId: 'worker-a',
  }));
});

test('definitive pre-provider capacity deferral releases the lease until its durable deadline', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const task = store.submitTask({
    idempotencyKey: 'provider-capacity-deferral',
    taskType: 'managed_ask',
    callId: 'call-capacity',
    request: { ask: { prompt: 'approved request' }, voiceAuthorization: { allowed: true } },
  }).task;
  const claim = store.claimNext({ workerId: 'capacity-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'capacity-worker',
    execution: { pid: 1234, provider: 'claude' },
  });
  const deferred = store.deferLeasedTask({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'capacity-worker',
    delayMs: 500,
  });
  assert.equal(deferred.state, 'queued');
  assert.equal(deferred.hasLease, false);
  assert.equal(deferred.execution, null);
  assert.equal(deferred.attempt, 1);
  assert.equal(store.claimNext({ workerId: 'too-early' }), null);
  fixture.advance(499);
  assert.equal(store.claimNext({ workerId: 'still-too-early' }), null);
  fixture.advance(1);
  const retried = store.claimNext({ workerId: 'capacity-restored' });
  assert.equal(retried.task.id, task.id);
  assert.equal(retried.task.attempt, 2);
  assert.equal(retried.task.availableAt, null);
  assert.equal(
    store.listEvents({ taskId: task.id }).some((event) => (
      event.eventType === 'task_deferred_for_provider_capacity'
    )),
    true,
  );
});

test('restart preserves running work for explicit process reconciliation', (t) => {
  const fixture = createFixture(t);
  const original = fixture.open();
  const task = original.submitTask({
    idempotencyKey: 'restart-safe',
    request: { prompt: 'long homelab audit' },
  }).task;
  const originalClaim = original.claimNext({ workerId: 'executor-before-restart' });
  assert.equal(originalClaim.task.id, task.id);
  original.heartbeat({
    taskId: task.id,
    leaseToken: originalClaim.leaseToken,
    workerId: 'executor-before-restart',
    execution: { pid: 9001, processStartTime: '777' },
  });
  original.close();

  const restarted = fixture.open();
  assert.equal(restarted.getTask(task.id).state, 'running');
  assert.equal(restarted.listReconciliationCandidates().length, 0);
  assert.equal(restarted.listReconciliationCandidates({ includeLiveLeases: true }).length, 1);
  assert.equal(restarted.claimNext({ workerId: 'executor-after-restart' }), null);

  fixture.advance(6000);
  const [candidate] = restarted.listReconciliationCandidates();
  assert.equal(candidate.id, task.id);
  assert.equal(candidate.state, 'running');
  assert.equal(candidate.leaseExpired, true);
  assert.deepEqual(candidate.execution, { pid: 9001, processStartTime: '777' });

  const adopted = restarted.reconcileTask({
    taskId: task.id,
    disposition: 'adopt',
    workerId: 'executor-after-restart',
    expectedRevision: candidate.revision,
    expectedUpdatedAt: candidate.updatedAt,
    reason: 'verified pid 9001 and process start time 777',
  });
  assert.equal(adopted.task.state, 'running');
  assert.equal(adopted.task.workerId, 'executor-after-restart');
  assert.ok(adopted.leaseToken);

  expectStoreError('LEASE_MISMATCH', () => restarted.heartbeat({
    taskId: task.id,
    leaseToken: originalClaim.leaseToken,
    workerId: 'executor-before-restart',
  }));
  const finished = restarted.completeTask({
    taskId: task.id,
    leaseToken: adopted.leaseToken,
    workerId: 'executor-after-restart',
    result: { recovered: true },
  });
  assert.equal(finished.state, 'completed');
  assert.deepEqual(
    restarted.listEvents({ taskId: task.id }).map((event) => event.eventType),
    ['task_submitted', 'lease_acquired', 'lease_heartbeat', 'lease_adopted', 'task_completed']
  );
});

test('restart reconciliation persists verified completion and explicit unknown results', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const completedTask = store.submitTask({
    idempotencyKey: 'reconcile-completed-result',
    taskType: 'target_session_message',
    request: { operationId: 'job_ReconcileComplete1' },
  }).task;
  store.claimNext({ workerId: 'old-worker' });
  const completed = store.reconcileTask({
    taskId: completedTask.id,
    disposition: 'complete',
    force: true,
    result: { httpStatus: 200, payload: { success: true, result: { delivered: true } } },
  }).task;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.payload.result.delivered, true);
  assert.equal(store.listEvents({ taskId: completed.id }).at(-1).eventType,
    'task_completed_after_reconciliation');

  const unknownTask = store.submitTask({
    idempotencyKey: 'reconcile-unknown-result',
    taskType: 'target_session_message',
    request: { operationId: 'job_ReconcileUnknown1' },
  }).task;
  store.claimNext({ workerId: 'old-worker' });
  const failed = store.reconcileTask({
    taskId: unknownTask.id,
    disposition: 'fail',
    force: true,
    errorCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
    errorMessage: 'not resent after unknown tmux delivery',
    result: { httpStatus: 409, payload: { success: false, delivered: true } },
  }).task;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'TARGET_DELIVERY_OUTCOME_UNKNOWN');
  assert.equal(failed.result.payload.delivered, true);
});

test('expired leases remain non-duplicated until reconciliation explicitly requeues', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const task = store.submitTask({
    idempotencyKey: 'explicit-requeue',
    request: { prompt: 'restartable read' },
  }).task;
  const claim = store.claimNext({ workerId: 'worker-one' });
  assert.equal(claim.task.id, task.id);
  fixture.advance(6000);

  assert.equal(store.claimNext({ workerId: 'worker-two' }), null);
  const staleCandidate = store.listReconciliationCandidates()[0];
  store.heartbeat({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'worker-one',
  });
  expectStoreError('RECONCILIATION_STALE', () => store.reconcileTask({
    taskId: task.id,
    disposition: 'requeue',
    expectedRevision: staleCandidate.revision,
    force: true,
    reason: 'stale observation must not win a race with heartbeat',
  }));

  fixture.advance(6000);
  const candidate = store.listReconciliationCandidates()[0];
  const requeued = store.reconcileTask({
    taskId: task.id,
    disposition: 'requeue',
    expectedRevision: candidate.revision,
    expectedUpdatedAt: candidate.updatedAt,
    reason: 'verified original process no longer exists',
  });
  assert.equal(requeued.task.state, 'queued');

  const secondClaim = store.claimNext({ workerId: 'worker-two' });
  assert.equal(secondClaim.task.id, task.id);
  assert.equal(secondClaim.task.attempt, 2);
  const failed = store.failTask({
    taskId: task.id,
    leaseToken: secondClaim.leaseToken,
    workerId: 'worker-two',
    errorCode: 'CLI_EXIT_1',
    errorMessage: 'agent exited unsuccessfully',
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'CLI_EXIT_1');
});

test('cancellation is immediate for queued work and cooperative for leased work', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const first = store.submitTask({
    idempotencyKey: 'cancel-queued',
    callId: 'call-cancel',
    request: { prompt: 'queued' },
  }).task;
  const second = store.submitTask({
    idempotencyKey: 'cancel-running',
    callId: 'call-cancel',
    request: { prompt: 'running' },
  }).task;
  const firstClaim = store.claimNext({ workerId: 'cancel-worker' });
  const running = firstClaim.task;
  const queued = [first, second].find((task) => task.id !== running.id);
  const unrelated = store.submitTask({
    idempotencyKey: 'cancel-unrelated',
    callId: 'another-call',
    request: { prompt: 'unrelated' },
  }).task;
  const cancelResult = store.cancelCallTasks({
    callId: 'call-cancel',
    reason: 'caller_pressed_star',
    source: 'dtmf',
  });
  assert.deepEqual(new Set(cancelResult.taskIds), new Set([queued.id, running.id]));
  assert.equal(cancelResult.cancellationRequested, 1);
  assert.equal(cancelResult.immediatelyCanceled, 1);
  assert.equal(store.getTask(running.id).state, 'cancel_requested');
  assert.equal(store.getTask(queued.id).state, 'canceled');
  assert.equal(store.getTask(unrelated.id).state, 'queued');

  expectStoreError('TASK_CANCEL_REQUESTED', () => store.completeTask({
    taskId: running.id,
    leaseToken: firstClaim.leaseToken,
    workerId: 'cancel-worker',
  }));
  const acknowledged = store.acknowledgeCanceled({
    taskId: running.id,
    leaseToken: firstClaim.leaseToken,
    workerId: 'cancel-worker',
    result: { signal: 'SIGTERM' },
  });
  assert.equal(acknowledged.state, 'canceled');
  assert.deepEqual(acknowledged.result, { signal: 'SIGTERM' });
});

test('a worker may preserve a verified success that wins the cancellation race', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const task = store.submitTask({
    idempotencyKey: 'cancel-raced-verified-success',
    taskType: 'managed_ask',
    request: { prompt: 'finish during cancel' },
  }).task;
  const claim = store.claimNext({ workerId: 'success-worker' });
  store.requestCancellation({
    taskId: task.id,
    reason: 'caller_pressed_star',
    source: 'dtmf',
  });

  const result = {
    httpStatus: 200,
    payload: {
      success: true,
      response: 'The service was already restarted.',
      provider: 'codex',
      sessionId: 'session-after-cancel',
    },
  };
  const completed = store.completeTask({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'success-worker',
    result,
    allowAfterCancellation: true,
  });

  assert.equal(completed.state, 'completed');
  assert.equal(completed.cancelReason, 'caller_pressed_star');
  assert.deepEqual(completed.result, result);
  assert.equal(
    store.listEvents({ taskId: task.id }).at(-1).details.completedAfterCancellation,
    true
  );
});

test('a cancellation reservation wins before submission and materializes a terminal task', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const cancellation = store.cancelCallTasks({
    callId: 'job_cancel_before_submit',
    idempotencyKey: 'job_cancel_before_submit',
    reason: 'caller_pressed_star',
    source: 'voice_app',
  });

  assert.deepEqual(cancellation.taskIds, []);
  assert.deepEqual(cancellation.reservation, {
    idempotencyKey: 'job_cancel_before_submit',
    callId: 'job_cancel_before_submit',
    reason: 'caller_pressed_star',
    source: 'voice_app',
    createdAt: fixture.now().toISOString(),
    updatedAt: fixture.now().toISOString(),
  });

  const submitted = store.submitTask({
    idempotencyKey: 'job_cancel_before_submit',
    taskType: 'managed_ask',
    callId: 'job_cancel_before_submit',
    voiceOrigin: true,
    request: { ask: { prompt: 'must never run' }, canceledBeforeAuthorization: true },
  });
  assert.equal(submitted.created, true);
  assert.equal(submitted.task.state, 'canceled');
  assert.equal(submitted.task.terminal, true);
  assert.equal(submitted.task.attempt, 0);
  assert.equal(submitted.task.cancelReason, 'caller_pressed_star');
  assert.equal(store.claimNext({ workerId: 'must-not-claim' }), null);
  assert.equal(
    store.listEvents({ taskId: submitted.task.id })[0].eventType,
    'task_canceled_by_reservation'
  );

  const retry = store.submitTask({
    idempotencyKey: 'job_cancel_before_submit',
    taskType: 'managed_ask',
    callId: 'job_cancel_before_submit',
    voiceOrigin: true,
    request: { ask: { prompt: 'must never run' }, canceledBeforeAuthorization: true },
  });
  assert.equal(retry.created, false);
  assert.equal(retry.task.id, submitted.task.id);
});

test('phone cancellation reservations do not cancel non-voice executor work', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  store.reserveCancellation({
    idempotencyKey: 'shared-controller-key',
    callId: 'job_phone_only',
    reason: 'phone_cancel',
    source: 'voice_app',
  });

  const task = store.submitTask({
    idempotencyKey: 'shared-controller-key',
    taskType: 'managed_ask',
    callId: 'ordinary-controller',
    voiceOrigin: false,
    request: { ask: { prompt: 'ordinary authenticated API work' } },
  }).task;
  assert.equal(task.state, 'queued');
  assert.equal(store.claimNext({ workerId: 'ordinary-worker' }).task.id, task.id);
});

test('panic persists atomically, blocks new voice work, and leaves non-voice work alone', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const runningVoice = store.submitTask({
    idempotencyKey: 'panic-running',
    request: { prompt: 'running voice task' },
  }).task;
  const claim = store.claimNext({ workerId: 'panic-worker' });
  assert.equal(claim.task.id, runningVoice.id);
  const queuedVoice = store.submitTask({
    idempotencyKey: 'panic-queued',
    request: { prompt: 'queued voice task' },
  }).task;
  const ordinary = store.submitTask({
    idempotencyKey: 'ordinary-api-task',
    voiceOrigin: false,
    request: { prompt: 'ordinary API task' },
  }).task;

  const panic = store.panic({ reason: 'caller_pressed_9', source: 'asterisk' });
  assert.equal(panic.alreadyLocked, false);
  assert.equal(panic.accepted, true);
  assert.equal(panic.persisted, true);
  assert.equal(panic.quiesced, false);
  assert.equal(panic.activeCount, 1);
  assert.deepEqual(panic.activeTaskIds, [runningVoice.id]);
  assert.equal(panic.panic.locked, true);
  assert.equal(store.getTask(runningVoice.id).state, 'cancel_requested');
  assert.equal(store.getTask(queuedVoice.id).state, 'canceled');
  assert.equal(store.getTask(ordinary.id).state, 'queued');

  const reasserted = store.panic({ reason: 'caller_pressed_9_again', source: 'asterisk' });
  assert.equal(reasserted.alreadyLocked, true);
  assert.equal(reasserted.cancellationReasserted, 1);
  assert.deepEqual(reasserted.taskIds, [runningVoice.id]);
  assert.equal(store.getTask(runningVoice.id).cancelReason, 'caller_pressed_9_again');
  assert.ok(store.listEvents({ taskId: runningVoice.id })
    .some((event) => event.eventType === 'panic_cancellation_reasserted'));

  store.acknowledgeCanceled({
    taskId: runningVoice.id,
    leaseToken: claim.leaseToken,
    workerId: 'panic-worker',
    result: { signal: 'SIGTERM' },
  });
  assert.equal(store.getPanicStatus().quiesced, true);
  assert.equal(store.getPanicStatus().activeCount, 0);

  const existingRetry = store.submitTask({
    idempotencyKey: 'panic-queued',
    request: { prompt: 'queued voice task' },
  });
  assert.equal(existingRetry.created, false);
  expectStoreError('EXECUTION_PANIC_LOCKED', () => store.submitTask({
    idempotencyKey: 'panic-new',
    request: { prompt: 'must stay locked' },
  }));
  assert.equal(store.claimNext({ workerId: 'ordinary-worker' }).task.id, ordinary.id);

  store.close();
  const restarted = fixture.open();
  assert.equal(restarted.getPanicStatus().locked, true);
  expectStoreError('EXECUTION_PANIC_LOCKED', () => restarted.submitTask({
    idempotencyKey: 'panic-after-restart',
    request: { prompt: 'still blocked' },
  }));
  const unlock = restarted.unlockPanic({ source: 'authenticated_operator' });
  assert.equal(unlock.wasLocked, true);
  assert.equal(unlock.panic.locked, false);
  assert.equal(restarted.submitTask({
    idempotencyKey: 'panic-after-unlock',
    request: { prompt: 'allowed' },
  }).created, true);
});

test('executor audit events are append-only at the database boundary', (t) => {
  const fixture = createFixture(t);
  const store = fixture.open();
  const task = store.submitTask({
    idempotencyKey: 'append-only',
    request: { prompt: 'audit me' },
  }).task;
  const [event] = store.listEvents({ taskId: task.id });
  assert.equal(event.eventType, 'task_submitted');

  assert.throws(
    () => store.db.prepare('UPDATE executor_events SET actor = ? WHERE sequence = ?')
      .run('tampered', event.sequence),
    /executor_events is append-only/
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM executor_events WHERE sequence = ?').run(event.sequence),
    /executor_events is append-only/
  );
  assert.equal(store.listEvents({ taskId: task.id })[0].actor, 'controller');
});
