'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  panicPrivilegedPlane,
  panicWorkerPlane,
  performCoordinatedVoicePanic,
  privilegedSubmissionBoundary,
} = require('../voice-panic-coordinator');

function localPlanes({ executorQuiesced = true } = {}) {
  let locked = false;
  return {
    get locked() { return locked; },
    voiceExecutionControl: {
      lock({ reason, source }) {
        locked = true;
        return { locked: true, persistent: true, reason, source };
      },
      getStatus() { return { locked, persistent: true }; },
    },
    cancelAllVoiceRequests() {
      assert.equal(locked, true, 'the durable voice lock must be first');
      return { canceledCount: 2, clearedSessionCount: 1 };
    },
    executorTaskDispatcher: {
      panic() {
        assert.equal(locked, true, 'executor panic must follow the voice lock');
        return {
          accepted: true,
          persisted: true,
          quiesced: executorQuiesced,
          activeTaskIds: executorQuiesced ? [] : ['etask-active'],
        };
      },
    },
  };
}

test('controller panic locks first and requires both executor and root planes to quiesce', async () => {
  const planes = localPlanes();
  let rootPanicCalls = 0;
  const result = await performCoordinatedVoicePanic({
    reason: 'dial_nine',
    source: 'asterisk_1001',
    ...planes,
    privilegedActionProxyEnabled: true,
    privilegedActionProxy: {
      async panic(body) {
        rootPanicCalls += 1;
        assert.equal(planes.locked, true, 'root fencing must happen after the controller lock');
        assert.deepEqual(body, { reason: 'dial_nine', source: 'asterisk_1001' });
        return {
          status: 200,
          payload: {
            success: true,
            accepted: true,
            persisted: true,
            quiesced: true,
            activeActionIds: [],
          },
        };
      },
    },
    workerSessionProxyEnabled: true,
    workerSessionProxy: {
      async panic(body) {
        assert.deepEqual(body, { reason: 'dial_nine', source: 'asterisk_1001' });
        return {
          status: 200,
          payload: { success: true, accepted: true, persisted: true, quiesced: true },
        };
      },
    },
  });

  assert.equal(rootPanicCalls, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.persisted, true);
  assert.equal(result.quiesced, true);
  assert.equal(result.success, true);
  assert.equal(result.privilegedCancellation.configured, true);
});

test('accepted root panic remains PARTIAL until the root broker is actually quiescent', async () => {
  const planes = localPlanes();
  const result = await performCoordinatedVoicePanic({
    reason: 'dial_nine',
    source: 'voice_controller',
    ...planes,
    privilegedActionProxyEnabled: true,
    privilegedActionProxy: {
      async panic() {
        return {
          status: 200,
          payload: {
            success: true,
            accepted: true,
            persisted: true,
            quiesced: false,
            activeActionCount: 1,
            activeActionIds: ['pact-running'],
          },
        };
      },
    },
    workerSessionProxyEnabled: true,
    workerSessionProxy: {
      async panic() {
        return {
          status: 200,
          payload: { success: true, accepted: true, persisted: true, quiesced: true },
        };
      },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.persisted, true);
  assert.equal(result.quiesced, false);
  assert.equal(result.success, false);
  assert.deepEqual(result.privilegedCancellation.activeActionIds, ['pact-running']);
});

test('root fencing still runs when another controller cancellation plane throws', async () => {
  let rootPanicked = false;
  const result = await performCoordinatedVoicePanic({
    reason: 'dial_nine',
    source: 'voice_controller',
    voiceExecutionControl: {
      lock: () => ({ locked: true, persistent: true }),
    },
    cancelAllVoiceRequests() {
      throw new Error('in-memory cancellation failed');
    },
    executorTaskDispatcher: {
      panic() { throw new Error('executor DB failed'); },
    },
    privilegedActionProxyEnabled: true,
    privilegedActionProxy: {
      async panic() {
        rootPanicked = true;
        return {
          status: 200,
          payload: { success: true, accepted: true, persisted: true, quiesced: true },
        };
      },
    },
    workerSessionProxyEnabled: true,
    workerSessionProxy: {
      async panic() {
        return {
          status: 200,
          payload: { success: true, accepted: true, persisted: true, quiesced: true },
        };
      },
    },
  });

  assert.equal(rootPanicked, true);
  assert.equal(result.accepted, false);
  assert.equal(result.success, false);
  assert.equal(result.privilegedCancellation.quiesced, true);
});

test('a missing enabled root plane fails closed while a disabled plane is explicitly not applicable', async () => {
  const unavailable = await panicPrivilegedPlane({
    enabled: true,
    proxy: { async panic() { throw Object.assign(new Error('socket lost'), { code: 'ECONNREFUSED' }); } },
  });
  assert.equal(unavailable.success, false);
  assert.equal(unavailable.accepted, false);
  assert.equal(unavailable.quiesced, false);
  assert.doesNotMatch(unavailable.error, /socket lost/);

  const disabled = await panicPrivilegedPlane({ enabled: false, proxy: null });
  assert.equal(disabled.success, true);
  assert.equal(disabled.configured, false);
  assert.equal(disabled.notApplicable, true);
  assert.equal(disabled.quiesced, true);
});

test('worker panic treats accepted 503 as persisted but not quiescent', async () => {
  const result = await panicWorkerPlane({
    enabled: true,
    proxy: {
      async panic() {
        return {
          status: 503,
          payload: {
            success: false,
            accepted: true,
            persisted: true,
            quiesced: false,
            activeOperationIds: ['job_worker_active'],
          },
        };
      },
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.persisted, true);
  assert.equal(result.quiesced, false);
  assert.equal(result.success, false);
  assert.deepEqual(result.activeOperationIds, ['job_worker_active']);
});

test('coordinated panic cannot claim STOPPED until the worker and provider cgroups quiesce', async () => {
  const result = await performCoordinatedVoicePanic({
    reason: 'dial_nine',
    source: 'phone',
    ...localPlanes(),
    privilegedActionProxyEnabled: false,
    privilegedActionProxy: null,
    workerSessionProxyEnabled: true,
    workerSessionProxy: {
      async panic() {
        return {
          status: 503,
          payload: {
            accepted: true, persisted: true, quiesced: false,
            activeOperationIds: ['job_worker_active'],
          },
        };
      },
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.persisted, true);
  assert.equal(result.quiesced, false);
  assert.equal(result.success, false);
  assert.deepEqual(result.workerCancellation.activeOperationIds, ['job_worker_active']);
});

test('privileged submission boundary rejects either controller or executor panic lock', () => {
  const allowed = privilegedSubmissionBoundary({
    voiceExecutionControl: { getStatus: () => ({ locked: false }) },
    executorTaskStore: { getPanicStatus: () => ({ locked: false }) },
  });
  assert.equal(allowed.allowed, true);

  const controllerLocked = privilegedSubmissionBoundary({
    voiceExecutionControl: { getStatus: () => ({ locked: true, reason: 'dial_nine' }) },
    executorTaskStore: { getPanicStatus: () => ({ locked: false }) },
  });
  assert.equal(controllerLocked.allowed, false);

  const executorLocked = privilegedSubmissionBoundary({
    voiceExecutionControl: { getStatus: () => ({ locked: false }) },
    executorTaskStore: { getPanicStatus: () => ({ locked: true, reason: 'dial_nine' }) },
  });
  assert.equal(executorLocked.allowed, false);

  const unreadable = privilegedSubmissionBoundary({
    voiceExecutionControl: { getStatus: () => { throw new Error('disk unavailable'); } },
    executorTaskStore: { getPanicStatus: () => ({ locked: false }) },
  });
  assert.equal(unreadable.allowed, false);
});
