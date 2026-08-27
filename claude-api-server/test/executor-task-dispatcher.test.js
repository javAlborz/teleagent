'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ExecutorTaskStore } = require('../executor-task-store');
const {
  ExecutorTaskDispatcher,
  processStartTimeFromStat,
} = require('../executor-task-dispatcher');

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for executor dispatcher condition');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function managedTask(store, key, request = {}) {
  return store.submitTask({
    idempotencyKey: key,
    taskType: 'managed_ask',
    callId: request.callId || null,
    voiceOrigin: request.voiceOrigin !== false,
    request: { ask: { prompt: key }, ...request },
  }).task;
}

function targetTask(store, key) {
  return store.submitTask({
    idempotencyKey: key,
    taskType: 'target_session_message',
    callId: key,
    request: { targetSession: { request: { operationId: key } } },
  }).task;
}

test('dispatcher claims, records process identity, heartbeats, and completes tasks', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = managedTask(store, 'dispatch-success');
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'test-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: async (claimed, context) => {
      assert.equal(claimed.id, task.id);
      context.recordExecution({ pid: 123, processStartTime: '456', detached: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { httpStatus: 200, payload: { success: true, response: 'done' } };
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const completed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'completed' ? current : null;
  });
  assert.equal(completed.attempt, 1);
  assert.deepEqual(completed.execution, {
    pid: 123,
    processStartTime: '456',
    detached: true,
  });
  assert.equal(completed.result.payload.response, 'done');
  const eventTypes = store.listEvents({ taskId: task.id }).map((event) => event.eventType);
  assert.equal(eventTypes[0], 'task_submitted');
  assert.ok(eventTypes.filter((type) => type === 'lease_heartbeat').length >= 2);
  assert.equal(eventTypes.at(-1), 'task_completed');
});

test('definitive pre-provider BUSY waits for capacity without consuming a new task or spawning twice', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = managedTask(store, 'provider-busy-then-ready', {
    voiceAuthorization: { allowed: true, authorization: { method: 'dtmf-pound' } },
  });
  let providerSpawns = 0;
  let executions = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'capacity-retry-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    providerBusyBackoffMs: 100,
    executeTask: async () => {
      executions += 1;
      if (executions === 1) {
        const error = new Error('provider capacity is occupied by an interactive session');
        error.code = 'PROVIDER_SUPERVISOR_BUSY';
        error.result = {
          httpStatus: 503,
          payload: {
            success: false,
            code: 'PROVIDER_SUPERVISOR_BUSY',
            agentCode: 'PROVIDER_SUPERVISOR_BUSY',
            provider_started: false,
            retry_safe: true,
          },
        };
        throw error;
      }
      providerSpawns += 1;
      return { httpStatus: 200, payload: { success: true, response: 'done once' } };
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const deferred = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'queued' && current.attempt === 1 ? current : null;
  });
  assert.equal(deferred.execution, null);
  assert.deepEqual(store.getTask(task.id).request, task.request);
  const completed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'completed' ? current : null;
  });
  assert.equal(completed.attempt, 2);
  assert.equal(executions, 2);
  assert.equal(providerSpawns, 1);
  assert.equal(
    store.listEvents({ taskId: task.id }).filter((event) => (
      event.eventType === 'task_deferred_for_provider_capacity'
    )).length,
    1,
  );
});

test('restart after durable pre-provider BUSY requeues without losing approval or inferring provider work', async (t) => {
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const store = new ExecutorTaskStore({
    defaultLeaseMs: 1000,
    now: () => new Date(clockMs),
  });
  t.after(() => store.close());
  const task = managedTask(store, 'provider-busy-crash-barrier', {
    voiceAuthorization: {
      allowed: true,
      authorization: { method: 'dtmf-pound', capabilityId: 'sanitized-decision-only' },
    },
  });
  const originalRequest = structuredClone(task.request);
  const oldClaim = store.claimNext({ workerId: 'crashed-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: oldClaim.leaseToken,
    workerId: 'crashed-worker',
    leaseMs: 1000,
    execution: {
      pid: 45678,
      processStartTime: '99123',
      detached: true,
      provider: 'claude',
      requestId: 'request-before-crash',
      kind: 'managed_ask',
      stage: 'provider_not_started_busy',
      providerStarted: false,
      retrySafe: true,
      denialCode: 'PROVIDER_SUPERVISOR_BUSY',
      deniedAt: '2026-08-25T12:00:00.100Z',
    },
  });

  // This is the crash barrier: the exact denial stage is durable, but the old
  // dispatcher never reached deferLeasedTask before its lease expired.
  clockMs += 2000;
  let reconciliations = 0;
  let executions = 0;
  let processInspections = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'replacement-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    reconcileInterruptedTask: async (candidate) => {
      reconciliations += 1;
      assert.equal(candidate.execution.stage, 'provider_not_started_busy');
      return {
        disposition: 'requeue',
        reason: 'provider rejected launch before acceptance',
      };
    },
    inspectExecution: async () => {
      processInspections += 1;
      return { known: true, alive: false, reason: 'process_not_found' };
    },
    executeTask: async (claimed) => {
      executions += 1;
      assert.deepEqual(claimed.request, originalRequest);
      return { httpStatus: 200, payload: { success: true, response: 'ran once' } };
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const completed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'completed' ? current : null;
  });
  assert.equal(reconciliations, 1);
  assert.equal(processInspections, 0);
  assert.equal(executions, 1);
  assert.equal(completed.attempt, 2);
  assert.deepEqual(completed.request, originalRequest);
  assert.equal(
    store.listEvents({ taskId: task.id }).filter((event) => (
      event.eventType === 'task_requeued_after_reconciliation'
    )).length,
    1,
  );
});

test('restart never requeues a malformed or post-acceptance provider BUSY stage', async (t) => {
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const store = new ExecutorTaskStore({
    defaultLeaseMs: 1000,
    now: () => new Date(clockMs),
  });
  t.after(() => store.close());
  const task = managedTask(store, 'provider-busy-malformed-stage');
  const oldClaim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: oldClaim.leaseToken,
    workerId: 'old-worker',
    execution: {
      pid: 56789,
      processStartTime: '1234',
      provider: 'codex',
      requestId: 'accepted-before-busy',
      kind: 'managed_ask',
      stage: 'provider_not_started_busy',
      providerStarted: true,
      retrySafe: true,
      denialCode: 'PROVIDER_SUPERVISOR_BUSY',
    },
  });
  clockMs += 2000;
  let reconciliationCallbacks = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    reconcileInterruptedTask: async () => {
      reconciliationCallbacks += 1;
      return { disposition: 'requeue' };
    },
    inspectExecution: async () => ({
      known: true,
      alive: false,
      reason: 'process_not_found',
    }),
    executeTask: async () => {
      throw new Error('post-acceptance work must not be resent');
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const failed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'failed' ? current : null;
  });
  assert.equal(reconciliationCallbacks, 0);
  assert.equal(failed.errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(failed.attempt, 1);
});

test('direct cancellation aborts a running execution and acknowledges terminal cancellation', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = managedTask(store, 'dispatch-cancel', { callId: 'call-cancel' });
  let observedAbort = false;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'cancel-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: (_claimed, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => {
        observedAbort = true;
        const error = new Error('execution aborted');
        error.code = 'AGENT_CANCELED';
        reject(error);
      }, { once: true });
    }),
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();
  await waitFor(() => store.getTask(task.id).state === 'running');

  const cancellation = dispatcher.requestCancellation({
    taskId: task.id,
    reason: 'caller_pressed_star',
    source: 'dtmf',
  });
  assert.equal(cancellation.task.state, 'cancel_requested');
  const canceled = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'canceled' ? current : null;
  });
  assert.equal(observedAbort, true);
  assert.equal(canceled.cancelReason, 'caller_pressed_star');
});

test('cancellation preserves target delivery uncertainty instead of declaring canceled', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = targetTask(store, 'job_TargetCancelUnknown1');
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'target-cancel-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: (_claimed, context) => new Promise((_resolve, reject) => {
      context.recordExecution({ stage: 'delivery_attempt_started' });
      context.signal.addEventListener('abort', () => {
        const payload = {
          success: false,
          code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          agentCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          delivery_attempted: true,
          reconciliation_required: true,
        };
        const error = new Error('delivery may have occurred');
        error.code = payload.code;
        error.result = { httpStatus: 409, payload };
        reject(error);
      }, { once: true });
    }),
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();
  await waitFor(() => store.getTask(task.id).state === 'running');

  dispatcher.requestCancellation({
    taskId: task.id,
    reason: 'caller_pressed_star',
    source: 'dtmf',
  });
  const failed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'failed' ? current : null;
  });
  assert.equal(failed.errorCode, 'TARGET_DELIVERY_OUTCOME_UNKNOWN');
  assert.equal(failed.result.payload.delivery_attempted, true);
  assert.equal(failed.cancelReason, 'caller_pressed_star');
});

test('restart reconciliation adopts a verified live process with revision CAS', async (t) => {
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const store = new ExecutorTaskStore({
    now: () => new Date(clockMs),
    defaultLeaseMs: 1000,
  });
  t.after(() => store.close());
  const task = managedTask(store, 'reconcile-live');
  const original = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: original.leaseToken,
    workerId: 'old-worker',
    leaseMs: 1000,
    execution: {
      pid: 9876,
      processStartTime: '111',
      detached: true,
      provider: 'codex',
    },
  });
  clockMs += 2000;
  let alive = true;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    recoveryPollMs: 50,
    inspectExecution: async () => ({
      known: true,
      alive,
      reason: alive ? 'identity_matches' : 'process_not_found',
    }),
    executeTask: async () => {
      throw new Error('recovered work must not be executed twice');
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const adopted = store.getTask(task.id);
  assert.equal(adopted.state, 'running');
  assert.equal(adopted.workerId, 'new-worker');
  assert.ok(store.listEvents({ taskId: task.id })
    .some((event) => event.eventType === 'lease_adopted'));

  alive = false;
  const terminal = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'failed' ? current : null;
  });
  assert.equal(terminal.errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(terminal.result.payload.code, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(terminal.result.payload.provider, 'codex');
  assert.equal(Object.hasOwn(terminal.result.payload, 'sessionId'), false);
  assert.equal(terminal.result.payload.provider_context_persistent, false);
  assert.equal(terminal.result.payload.processExit, 'process_not_found');
  assert.equal(terminal.attempt, 1);
});

test('unknown restart identities remain deferred instead of failing or duplicating', async (t) => {
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const store = new ExecutorTaskStore({
    defaultLeaseMs: 1000,
    now: () => new Date(clockMs),
  });
  t.after(() => store.close());
  const task = managedTask(store, 'reconcile-unknown');
  store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  clockMs += 2000;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    inspectExecution: async () => ({ known: false, alive: false, reason: 'identity_missing' }),
    executeTask: async () => {
      throw new Error('unknown work must not be executed twice');
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  const reconciliation = await dispatcher.reconcileOnStart();
  assert.deepEqual(reconciliation.deferred, [
    { taskId: task.id, reason: 'execution_identity_missing' },
  ]);
  assert.equal(store.getTask(task.id).state, 'running');
  assert.equal(store.getTask(task.id).workerId, 'old-worker');
});

test('startup reconciliation gates new claims and resets cleanly after a start failure', async (t) => {
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const store = new ExecutorTaskStore({
    defaultLeaseMs: 1000,
    now: () => new Date(clockMs),
  });
  t.after(() => store.close());
  const interrupted = managedTask(store, 'startup-gate-interrupted');
  const oldClaim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: interrupted.id,
    leaseToken: oldClaim.leaseToken,
    workerId: 'old-worker',
    leaseMs: 1000,
    execution: { pid: 12345, processStartTime: '999', provider: 'codex' },
  });
  managedTask(store, 'startup-gate-queued');
  clockMs += 2000;

  const inspection = deferred();
  let inspections = 0;
  let executions = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    reconciliationPollMs: 50,
    inspectExecution: async () => {
      inspections += 1;
      return inspection.promise;
    },
    executeTask: async () => {
      executions += 1;
      return { httpStatus: 200, payload: { success: true, response: 'queued done' } };
    },
  });
  t.after(() => dispatcher.shutdown({ releaseLeases: false, timeoutMs: 20 }));

  const starting = dispatcher.start();
  await waitFor(() => inspections === 1);
  assert.equal(dispatcher.status().starting, true);
  assert.equal(dispatcher.status().acceptingClaims, false);
  assert.equal(executions, 0);
  inspection.resolve({ known: true, alive: false, reason: 'process_not_found' });
  await starting;
  await waitFor(() => executions === 1);
  assert.equal(store.getTask(interrupted.id).errorCode, 'EXECUTION_OUTCOME_UNKNOWN');

  await dispatcher.shutdown({ releaseLeases: false, timeoutMs: 20 });
  const originalListCandidates = store.listReconciliationCandidates.bind(store);
  let failStartup = true;
  store.listReconciliationCandidates = (...args) => {
    if (failStartup) throw new Error('simulated reconciliation database failure');
    return originalListCandidates(...args);
  };
  await assert.rejects(
    dispatcher.start(),
    /simulated reconciliation database failure/
  );
  assert.equal(dispatcher.running, false);
  assert.equal(dispatcher.acceptingClaims, false);
  assert.equal(dispatcher.starting, false);
  assert.equal(dispatcher.pollTimer, null);
  assert.equal(dispatcher.reconciliationTimer, null);

  failStartup = false;
  await dispatcher.start();
  assert.equal(dispatcher.status().acceptingClaims, true);
});

test('periodic reconciliation never steals a live lease and retries expired CAS races', async (t) => {
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const store = new ExecutorTaskStore({
    defaultLeaseMs: 1000,
    now: () => new Date(clockMs),
  });
  t.after(() => store.close());
  const task = managedTask(store, 'periodic-reconciliation-cas');
  const oldClaim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: oldClaim.leaseToken,
    workerId: 'old-worker',
    leaseMs: 1000,
    execution: { pid: 23456, processStartTime: '1000', provider: 'claude' },
  });

  let inspections = 0;
  let alive = true;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    reconciliationPollMs: 50,
    recoveryPollMs: 50,
    inspectExecution: async () => {
      inspections += 1;
      if (inspections === 1) {
        // The original owner heartbeats after this candidate was read. Its
        // revision CAS must win and keep the replacement worker from adopting.
        store.heartbeat({
          taskId: task.id,
          leaseToken: oldClaim.leaseToken,
          workerId: 'old-worker',
          leaseMs: 1000,
        });
      }
      return { known: true, alive, reason: alive ? 'identity_matches' : 'process_not_found' };
    },
    terminateExecution: () => true,
    executeTask: async () => {
      throw new Error('interrupted managed work must never be executed twice');
    },
  });
  t.after(() => dispatcher.shutdown({ releaseLeases: false, timeoutMs: 20 }));
  await dispatcher.start();

  assert.equal(inspections, 0);
  assert.equal(store.getTask(task.id).workerId, 'old-worker');
  clockMs += 2000;
  await waitFor(() => inspections >= 1);
  assert.equal(store.getTask(task.id).workerId, 'old-worker');
  assert.equal(store.getTask(task.id).leaseExpired, false);

  clockMs += 2000;
  await waitFor(() => store.getTask(task.id).workerId === 'new-worker');
  assert.ok(inspections >= 2);
  alive = false;
  await waitFor(() => store.getTask(task.id).state === 'failed');
  assert.equal(store.getTask(task.id).errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
});

test('a verified managed success remains completed when cancellation races its response', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = managedTask(store, 'verified-success-after-cancel');
  const ready = deferred();
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'cancel-race-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: async (_task, context) => {
      ready.resolve();
      await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
      return {
        httpStatus: 200,
        payload: {
          success: true,
          response: 'The operation finished before cancellation took effect.',
          provider: 'codex',
          sessionId: 'session-won-cancel-race',
        },
      };
    },
  });
  t.after(() => dispatcher.shutdown({ releaseLeases: false, timeoutMs: 20 }));
  await dispatcher.start();
  await ready.promise;

  dispatcher.requestCancellation({
    taskId: task.id,
    reason: 'caller_pressed_star',
    source: 'dtmf',
  });
  const completed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'completed' ? current : null;
  });
  assert.equal(completed.cancelReason, 'caller_pressed_star');
  assert.equal(completed.result.payload.success, true);
  assert.equal(completed.result.payload.sessionId, 'session-won-cancel-race');
});

test('target restart before the persisted delivery boundary requeues safely and executes once', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = targetTask(store, 'job_TargetBeforePaste1');
  const originalClaim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.releaseLease({
    taskId: task.id,
    leaseToken: originalClaim.leaseToken,
    workerId: 'old-worker',
    reason: 'simulated_restart',
  });
  let executions = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: async () => {
      executions += 1;
      return { httpStatus: 200, payload: { success: true } };
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const completed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'completed' ? current : null;
  });
  assert.equal(executions, 1);
  assert.equal(completed.attempt, 2);
  assert.ok(store.listEvents({ taskId: task.id })
    .some((event) => event.eventType === 'task_requeued_after_reconciliation'));
});

test('known-delivered target work is monitored after restart and never resent', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = targetTask(store, 'job_TargetMonitor1');
  const claim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'old-worker',
    execution: {
      kind: 'target_session_message',
      stage: 'delivery_attempt_started',
      operationId: 'job_TargetMonitor1',
    },
  });
  store.releaseLease({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'old-worker',
    reason: 'simulated_restart',
  });
  let reconciliations = 0;
  let executions = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    recoveryPollMs: 50,
    reconcileInterruptedTask: async () => {
      reconciliations += 1;
      if (reconciliations < 3) {
        return { disposition: 'monitor', reason: 'marked provider work is still running' };
      }
      return {
        disposition: 'complete',
        reason: 'exact marked response verified',
        result: { httpStatus: 200, payload: { success: true, result: { delivered: true } } },
      };
    },
    executeTask: async () => {
      executions += 1;
      throw new Error('recovered target work must never be resent');
    },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const completed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'completed' ? current : null;
  });
  assert.ok(reconciliations >= 3);
  assert.equal(executions, 0);
  assert.equal(completed.result.payload.result.delivered, true);
  assert.equal(completed.attempt, 1);
  assert.ok(store.listEvents({ taskId: task.id })
    .some((event) => event.eventType === 'lease_adopted'));
});

test('an unverified target delivery attempt terminalizes unknown without resubmission', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = targetTask(store, 'job_TargetUnknown1');
  const claim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'old-worker',
    execution: { stage: 'delivery_attempt_started' },
  });
  store.releaseLease({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'old-worker',
    reason: 'simulated_restart',
  });
  let executions = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    reconcileInterruptedTask: async () => ({
      disposition: 'fail',
      errorCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
      errorMessage: 'delivery cannot be verified',
      result: { httpStatus: 409, payload: { success: false } },
    }),
    executeTask: async () => { executions += 1; },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const failed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'failed' ? current : null;
  });
  assert.equal(executions, 0);
  assert.equal(failed.errorCode, 'TARGET_DELIVERY_OUTCOME_UNKNOWN');
});

test('a verified persisted target result completes on restart without execution', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = targetTask(store, 'job_TargetVerified1');
  const claim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  const result = { httpStatus: 200, payload: { success: true, result: { delivered: true } } };
  store.heartbeat({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'old-worker',
    execution: { stage: 'delivery_verified', result },
  });
  store.releaseLease({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    workerId: 'old-worker',
    reason: 'simulated_restart',
  });
  let executions = 0;
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'new-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: async () => { executions += 1; },
  });
  t.after(() => dispatcher.stop({ releaseLeases: false }));
  await dispatcher.start();

  const completed = await waitFor(() => {
    const current = store.getTask(task.id);
    return current.state === 'completed' ? current : null;
  });
  assert.equal(executions, 0);
  assert.deepEqual(completed.result, result);
});

test('panic re-interrupts cancel-requested work and reports persisted versus quiesced truth', async (t) => {
  let clockMs = Date.parse('2026-08-25T12:00:00.000Z');
  const store = new ExecutorTaskStore({
    defaultLeaseMs: 1000,
    now: () => new Date(clockMs),
  });
  t.after(() => store.close());
  const task = managedTask(store, 'panic-reinterrupt');
  const oldClaim = store.claimNext({ workerId: 'old-worker', leaseMs: 1000 });
  store.heartbeat({
    taskId: task.id,
    leaseToken: oldClaim.leaseToken,
    workerId: 'old-worker',
    leaseMs: 1000,
    execution: { pid: 34567, processStartTime: '2000', provider: 'codex' },
  });
  store.requestCancellation({
    taskId: task.id,
    reason: 'first_cancel',
    source: 'voice_app',
  });
  clockMs += 2000;

  let alive = true;
  const signals = [];
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'panic-recovery-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    reconciliationPollMs: 50,
    recoveryPollMs: 50,
    recoveryKillGraceMs: 10000,
    inspectExecution: async () => ({
      known: true,
      alive,
      reason: alive ? 'identity_matches' : 'process_not_found',
    }),
    terminateExecution: (_execution, signal) => {
      signals.push(signal);
      return true;
    },
    executeTask: async () => {
      throw new Error('recovered execution must not be duplicated');
    },
  });
  t.after(() => dispatcher.shutdown({ releaseLeases: false, timeoutMs: 20 }));
  await dispatcher.start();
  await waitFor(() => store.getTask(task.id).workerId === 'panic-recovery-worker');
  const firstInterrupts = signals.filter((signal) => signal === 'SIGTERM').length;
  assert.ok(firstInterrupts >= 1);

  const panic = dispatcher.panic({ reason: 'panic_reassertion', source: 'voice_app' });
  assert.equal(panic.accepted, true);
  assert.equal(panic.persisted, true);
  assert.equal(panic.quiesced, false);
  assert.equal(panic.activeCount, 1);
  assert.deepEqual(panic.activeTaskIds, [task.id]);
  assert.equal(panic.cancellationReasserted, 1);
  assert.ok(signals.filter((signal) => signal === 'SIGTERM').length > firstInterrupts);

  alive = false;
  await waitFor(() => store.getTask(task.id).state === 'failed');
  assert.equal(store.getTask(task.id).errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(store.getPanicStatus().quiesced, true);
  assert.equal(store.getPanicStatus().activeCount, 0);
});

test('bounded shutdown marks identity-less work unknown and late completion cannot touch a closed store', async () => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  const task = managedTask(store, 'shutdown-outcome-unknown');
  const execution = deferred();
  const started = deferred();
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'shutdown-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: async () => {
      started.resolve();
      return execution.promise;
    },
  });
  await dispatcher.start();
  await started.promise;

  const shutdown = await dispatcher.shutdown({ releaseLeases: true, timeoutMs: 20 });
  assert.equal(shutdown.timedOut, true);
  assert.deepEqual(shutdown.unknownTaskIds, [task.id]);
  assert.deepEqual(shutdown.releasedTaskIds, []);
  const terminal = store.getTask(task.id);
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(dispatcher.active.size, 0);

  store.close();
  execution.resolve({
    httpStatus: 200,
    payload: { success: true, response: 'too late to persist' },
  });
  await new Promise((resolve) => globalThis.setImmediate(resolve));
});

test('bounded shutdown releases work with a durable execution identity for restart reconciliation', async (t) => {
  const store = new ExecutorTaskStore({ defaultLeaseMs: 1000 });
  t.after(() => store.close());
  const task = managedTask(store, 'shutdown-release-identity');
  const execution = deferred();
  const identityRecorded = deferred();
  const dispatcher = new ExecutorTaskDispatcher({
    store,
    workerId: 'shutdown-identity-worker',
    leaseMs: 1000,
    heartbeatMs: 250,
    pollMs: 25,
    executeTask: async (_task, context) => {
      context.recordExecution({
        pid: 45678,
        processStartTime: '3000',
        provider: 'claude',
        sessionId: 'durable-session-id',
      });
      identityRecorded.resolve();
      return execution.promise;
    },
  });
  await dispatcher.start();
  await identityRecorded.promise;

  const shutdown = await dispatcher.shutdown({ releaseLeases: true, timeoutMs: 20 });
  assert.equal(shutdown.timedOut, true);
  assert.deepEqual(shutdown.releasedTaskIds, [task.id]);
  assert.deepEqual(shutdown.unknownTaskIds, []);
  const released = store.getTask(task.id);
  assert.equal(released.state, 'running');
  assert.equal(released.hasLease, false);
  assert.equal(released.leaseExpired, true);
  assert.equal(released.execution.sessionId, 'durable-session-id');
  assert.equal(
    store.listEvents({ taskId: task.id }).at(-1).eventType,
    'lease_released'
  );

  execution.resolve({ httpStatus: 200, payload: { success: true, response: 'late' } });
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(store.getTask(task.id).state, 'running');
});

test('Linux process stat parser handles commands containing spaces and parentheses', () => {
  const fields = [
    'R', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13',
    '14', '15', '16', '17', '18', 'start-time-22', '20', '21',
  ];
  assert.equal(
    processStartTimeFromStat(`123 (agent command (worker)) ${fields.join(' ')}`),
    'start-time-22'
  );
});
