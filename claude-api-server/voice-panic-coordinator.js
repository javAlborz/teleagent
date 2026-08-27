'use strict';

function boundedIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 160)
    .slice(0, 100);
}

function unavailablePrivilegedPanic(error) {
  return {
    success: false,
    configured: true,
    accepted: false,
    persisted: false,
    quiesced: false,
    code: String(error?.code || 'PRIVILEGED_PANIC_UNCONFIRMED').slice(0, 100),
    error: 'The controller could not confirm the root-broker panic boundary.',
  };
}

function unavailableWorkerPanic(error) {
  return {
    success: false,
    configured: true,
    accepted: false,
    persisted: false,
    quiesced: false,
    code: String(error?.code || 'WORKER_SESSION_PANIC_UNCONFIRMED').slice(0, 100),
    error: 'The controller could not confirm the isolated worker panic boundary.',
  };
}

async function panicPrivilegedPlane({
  enabled,
  proxy,
  reason,
  source,
} = {}) {
  if (!enabled || !proxy) {
    // With the proxy disabled, this controller cannot admit privileged work.
    // Treat that plane as not applicable rather than claiming a root broker
    // was contacted or quiesced.
    return {
      success: true,
      configured: false,
      notApplicable: true,
      accepted: true,
      persisted: true,
      quiesced: true,
      activeActionCount: 0,
      activeActionIds: [],
    };
  }

  try {
    const response = await proxy.panic({ reason, source });
    const payload = response?.payload && typeof response.payload === 'object'
      ? response.payload
      : {};
    const status = Number(response?.status);
    const accepted = status >= 200 && status < 300 &&
      payload.success === true && payload.accepted === true && payload.persisted === true;
    const quiesced = accepted && payload.quiesced === true;
    return {
      success: quiesced,
      configured: true,
      accepted,
      persisted: accepted,
      quiesced,
      alreadyLocked: Boolean(payload.alreadyLocked),
      activeActionCount: Number.isSafeInteger(payload.activeActionCount) &&
        payload.activeActionCount >= 0
        ? payload.activeActionCount
        : boundedIds(payload.activeActionIds).length,
      activeActionIds: boundedIds(payload.activeActionIds),
      code: accepted ? null : String(payload.code || 'PRIVILEGED_PANIC_REJECTED').slice(0, 100),
      error: accepted ? null : 'The root broker did not durably accept the panic boundary.',
    };
  } catch (error) {
    return unavailablePrivilegedPanic(error);
  }
}

async function panicWorkerPlane({
  enabled,
  proxy,
  reason,
  source,
} = {}) {
  if (!enabled || !proxy) {
    // Without the hardened worker proxy this controller is not ready and
    // cannot launch a provider. The disabled plane therefore has no admitted
    // child to stop, but it must never be described as contacted.
    return {
      success: true,
      configured: false,
      notApplicable: true,
      accepted: true,
      persisted: true,
      quiesced: true,
      activeOperationCount: 0,
      activeOperationIds: [],
    };
  }
  try {
    const response = await proxy.panic({ reason, source });
    const payload = response?.payload && typeof response.payload === 'object'
      ? response.payload
      : {};
    // Worker panic deliberately returns 503 while durably accepted but not
    // yet quiescent. Payload truth, not the HTTP convenience status, carries
    // the two-phase boundary. A generic 5xx without that exact truth remains
    // unconfirmed and will be retried idempotently by the caller.
    const accepted = payload.accepted === true && payload.persisted === true;
    const quiesced = accepted && payload.quiesced === true;
    return {
      success: quiesced,
      configured: true,
      accepted,
      persisted: accepted,
      quiesced,
      alreadyLocked: Boolean(payload.alreadyLocked),
      activeOperationCount: Number.isSafeInteger(payload.activeOperationCount) &&
        payload.activeOperationCount >= 0
        ? payload.activeOperationCount
        : boundedIds(payload.activeOperationIds).length,
      activeOperationIds: boundedIds(payload.activeOperationIds),
      providers: payload.providers && typeof payload.providers === 'object'
        ? payload.providers
        : null,
      code: accepted ? null : String(payload.code || 'WORKER_SESSION_PANIC_REJECTED').slice(0, 100),
      error: accepted ? null : 'The isolated worker did not durably accept the panic boundary.',
    };
  } catch (error) {
    return unavailableWorkerPanic(error);
  }
}

function privilegedSubmissionBoundary({ voiceExecutionControl, executorTaskStore } = {}) {
  let voiceExecution;
  let executor;
  try {
    voiceExecution = voiceExecutionControl.getStatus();
  } catch {
    voiceExecution = { locked: true, error: 'voice_lock_status_unavailable' };
  }
  try {
    executor = executorTaskStore.getPanicStatus();
  } catch {
    executor = { locked: true, error: 'executor_panic_status_unavailable' };
  }
  return {
    allowed: voiceExecution?.locked !== true && executor?.locked !== true,
    voiceExecution,
    executor,
  };
}

async function performCoordinatedVoicePanic({
  reason,
  source,
  voiceExecutionControl,
  cancelAllVoiceRequests,
  executorTaskDispatcher,
  privilegedActionProxy,
  privilegedActionProxyEnabled,
  workerSessionProxy,
  workerSessionProxyEnabled,
} = {}) {
  // Persist the controller lock before beginning either remote cancellation.
  // Any concurrent privileged POST that has not yet crossed this point is
  // refused; the root panic atomically fences one that already passed it.
  let lock;
  try {
    lock = voiceExecutionControl.lock({ reason, source });
  } catch {
    lock = {
      locked: true,
      persistent: false,
      error: 'controller_voice_lock_persistence_failed',
    };
  }
  // Start the independent root fence even if a later in-memory or executor
  // cancellation step fails. The planes must not fail in a cascade.
  const privilegedPanicPromise = panicPrivilegedPlane({
    enabled: privilegedActionProxyEnabled,
    proxy: privilegedActionProxy,
    reason,
    source,
  });
  const workerPanicPromise = panicWorkerPlane({
    enabled: workerSessionProxyEnabled,
    proxy: workerSessionProxy,
    reason,
    source,
  });
  let activeCancellation;
  try {
    activeCancellation = {
      ...cancelAllVoiceRequests({ reason }),
      accepted: true,
    };
  } catch {
    activeCancellation = {
      accepted: false,
      error: 'active_voice_request_cancellation_failed',
    };
  }
  let executorCancellation;
  try {
    executorCancellation = executorTaskDispatcher.panic({ reason, source });
  } catch {
    executorCancellation = {
      accepted: false,
      persisted: false,
      quiesced: false,
      error: 'executor_panic_persistence_failed',
    };
  }
  const privilegedCancellation = await privilegedPanicPromise;
  const workerCancellation = await workerPanicPromise;
  const accepted = Boolean(
    lock.locked &&
    lock.persistent &&
    activeCancellation.accepted !== false &&
    executorCancellation.accepted &&
    executorCancellation.persisted &&
    privilegedCancellation.accepted &&
    privilegedCancellation.persisted &&
    workerCancellation.accepted &&
    workerCancellation.persisted
  );
  const quiesced = Boolean(
    accepted &&
    executorCancellation.quiesced === true &&
    privilegedCancellation.quiesced === true &&
    workerCancellation.quiesced === true
  );
  return {
    // Acceptance and quiescence are intentionally distinct. No caller may
    // announce STOPPED until both durable execution planes are quiescent.
    success: quiesced,
    accepted,
    persisted: accepted,
    quiesced,
    lock,
    activeCancellation,
    executorCancellation,
    privilegedCancellation,
    workerCancellation,
  };
}

module.exports = {
  panicPrivilegedPlane,
  panicWorkerPlane,
  performCoordinatedVoicePanic,
  privilegedSubmissionBoundary,
};
