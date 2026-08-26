'use strict';

const fs = require('node:fs');
const os = require('node:os');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processStartTimeFromStat(stat) {
  const closeParen = String(stat || '').lastIndexOf(') ');
  if (closeParen < 0) return null;
  const fieldsFromState = stat.slice(closeParen + 2).trim().split(/\s+/);
  // /proc/<pid>/stat field 3 is the first entry after the command. Start time
  // is field 22, so it is index 19 in this sliced array.
  return fieldsFromState[19] || null;
}

function captureProcessExecution(pid, { detached = process.platform !== 'win32' } = {}) {
  const parsedPid = Number.parseInt(pid, 10);
  if (!Number.isInteger(parsedPid) || parsedPid <= 0) return null;
  let processStartTime = null;
  if (process.platform === 'linux') {
    try {
      processStartTime = processStartTimeFromStat(
        fs.readFileSync(`/proc/${parsedPid}/stat`, 'utf8')
      );
    } catch {
      // The child may have completed before identity capture. Persisting the
      // pid is still useful, but restart adoption will fail closed without a
      // matching Linux start-time identity.
    }
  }
  return {
    pid: parsedPid,
    processStartTime,
    detached: Boolean(detached),
    platform: process.platform,
  };
}

function inspectProcessExecution(execution) {
  const pid = Number.parseInt(execution?.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { known: false, alive: false, reason: 'execution_pid_missing' };
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return { known: true, alive: false, reason: 'process_not_found' };
    if (error.code !== 'EPERM') {
      return { known: false, alive: false, reason: `process_probe_${error.code || 'failed'}` };
    }
  }

  if (process.platform === 'linux') {
    if (!execution.processStartTime) {
      return { known: false, alive: true, reason: 'process_start_time_missing' };
    }
    try {
      const actualStartTime = processStartTimeFromStat(
        fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      );
      if (!actualStartTime) {
        return { known: false, alive: true, reason: 'process_start_time_unreadable' };
      }
      if (String(actualStartTime) !== String(execution.processStartTime)) {
        return { known: true, alive: false, reason: 'process_identity_changed' };
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { known: true, alive: false, reason: 'process_not_found' };
      return { known: false, alive: true, reason: `process_identity_${error.code || 'failed'}` };
    }
  }

  return { known: true, alive: true, reason: 'process_identity_matches' };
}

function signalExecution(execution, signal) {
  const pid = Number.parseInt(execution?.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (execution.detached && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function isVerifiedSuccess(result) {
  return Boolean(result?.payload && result.payload.success === true);
}

function boundedString(value, maximum = 65536) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, maximum);
}

function executionOutcomeUnknownResult(task, inspection = null, message = null) {
  const persistedPayload = task?.execution?.result?.payload || task?.result?.payload || {};
  const payload = {
    success: false,
    code: 'EXECUTION_OUTCOME_UNKNOWN',
    agentCode: 'EXECUTION_OUTCOME_UNKNOWN',
    error: message ||
      'The executor lost its verified response channel after work began, so the exact outcome is unknown.',
    recovered: true,
    execution_outcome_unknown: true,
    reconciliation_required: true,
    provider_context_persistent: false,
  };

  const provider = boundedString(persistedPayload.provider || task?.execution?.provider, 100);
  const response = boundedString(persistedPayload.response, 65536);
  const requestId = boundedString(task?.execution?.requestId, 500);
  if (provider) payload.provider = provider;
  if (response) payload.response = response;
  if (requestId) payload.requestId = requestId;
  if (Number.isFinite(persistedPayload.duration_ms)) {
    payload.duration_ms = persistedPayload.duration_ms;
  }
  if (inspection?.reason) payload.processExit = boundedString(inspection.reason, 200);

  return { httpStatus: 409, payload };
}

class ExecutorTaskDispatcher {
  constructor({
    store,
    executeTask,
    workerId = `${os.hostname()}:${process.pid}`,
    concurrency = 1,
    leaseMs = 15000,
    heartbeatMs = 5000,
    pollMs = 250,
    reconciliationPollMs = 1000,
    recoveryPollMs = 500,
    recoveryKillGraceMs = 2000,
    providerBusyBackoffMs = 1000,
    inspectExecution = inspectProcessExecution,
    terminateExecution = signalExecution,
    reconcileInterruptedTask = null,
    logger = console,
  }) {
    if (!store) throw new TypeError('ExecutorTaskDispatcher requires a store');
    if (typeof executeTask !== 'function') {
      throw new TypeError('ExecutorTaskDispatcher requires executeTask');
    }
    this.store = store;
    this.executeTask = executeTask;
    this.workerId = String(workerId);
    this.concurrency = Math.max(1, Number.parseInt(concurrency, 10) || 1);
    this.leaseMs = Math.max(1000, Number.parseInt(leaseMs, 10) || 15000);
    this.heartbeatMs = Math.max(
      250,
      Math.min(Number.parseInt(heartbeatMs, 10) || 5000, Math.floor(this.leaseMs / 2))
    );
    this.pollMs = Math.max(25, Number.parseInt(pollMs, 10) || 250);
    this.reconciliationPollMs = Math.max(
      50,
      Number.parseInt(reconciliationPollMs, 10) || 1000
    );
    this.recoveryPollMs = Math.max(50, Number.parseInt(recoveryPollMs, 10) || 500);
    this.recoveryKillGraceMs = Math.max(
      0,
      Number.parseInt(recoveryKillGraceMs, 10) || 2000
    );
    this.providerBusyBackoffMs = Math.max(
      100,
      Math.min(Number.parseInt(providerBusyBackoffMs, 10) || 1000, 30000)
    );
    this.inspectExecution = inspectExecution;
    this.terminateExecution = terminateExecution;
    this.reconcileInterruptedTask = typeof reconcileInterruptedTask === 'function'
      ? reconcileInterruptedTask
      : null;
    this.logger = logger;
    this.active = new Map();
    this.running = false;
    this.starting = false;
    this.acceptingClaims = false;
    this.shuttingDown = false;
    this.pumping = false;
    this.pollTimer = null;
    this.reconciliationTimer = null;
    this.reconciliationRunning = false;
    this.wakeTimer = null;
    this.wakeScheduled = false;
    this.startPromise = null;
    this.shutdownPromise = null;
    this.lifecycleGeneration = 0;
  }

  async start() {
    if (this.running && this.acceptingClaims) return this.status();
    if (this.startPromise) return this.startPromise;
    if (this.shutdownPromise) await this.shutdownPromise;

    const generation = ++this.lifecycleGeneration;
    this.starting = true;
    this.acceptingClaims = false;
    this.shuttingDown = false;

    const operation = (async () => {
      try {
        const reconciliation = await this.reconcileOnStart({ generation });
        if (generation !== this.lifecycleGeneration) {
          const error = new Error('Executor dispatcher start was superseded');
          error.code = 'DISPATCHER_START_SUPERSEDED';
          throw error;
        }

        this.running = true;
        this.acceptingClaims = true;
        this.pollTimer = setInterval(() => this.wake(), this.pollMs);
        if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
        this.reconciliationTimer = setInterval(
          () => this._runReconciliationSweep(),
          this.reconciliationPollMs
        );
        if (typeof this.reconciliationTimer.unref === 'function') {
          this.reconciliationTimer.unref();
        }
        this._resumeRecoveryPolls();
        this.wake();
        return { ...this.status(), reconciliation };
      } catch (error) {
        this._resetAfterStartFailure(generation);
        throw error;
      } finally {
        if (generation === this.lifecycleGeneration) this.starting = false;
        if (this.startPromise === operation) this.startPromise = null;
      }
    })();
    this.startPromise = operation;
    return operation;
  }

  stop(options = {}) {
    return this.shutdown(options);
  }

  async shutdown({ releaseLeases = true, timeoutMs = 5000 } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    const boundedTimeoutMs = Math.max(
      0,
      Math.min(Number.parseInt(timeoutMs, 10) || 0, 60000)
    );
    const pendingStart = this.startPromise;
    ++this.lifecycleGeneration;
    this.running = false;
    this.acceptingClaims = false;
    this.shuttingDown = true;
    this._clearDispatcherTimers();

    const operation = (async () => {
      const records = [...this.active.values()];
      for (const record of records) {
        record.shutdownRequested = true;
        this._clearRecordTimers(record);
        this._interruptRecord(record, 'dispatcher_shutdown');
      }

      const drainPromises = records.map((record) => record.donePromise);
      if (pendingStart) drainPromises.push(Promise.resolve(pendingStart).catch(() => null));
      let drained = drainPromises.length === 0;
      if (!drained) {
        drained = await Promise.race([
          Promise.allSettled(drainPromises).then(() => true),
          sleep(boundedTimeoutMs).then(() => false),
        ]);
      }

      const releasedTaskIds = [];
      const unknownTaskIds = [];
      const unresolvedTaskIds = [];
      for (const record of records) {
        if (!this._isCurrentRecord(record)) continue;
        unresolvedTaskIds.push(record.task.id);
        record.orphaned = true;
        this._clearRecordTimers(record);
        this.active.delete(record.task.id);
        this._resolveRecord(record);

        if (!releaseLeases) continue;
        try {
          const current = this.store.getTask(record.task.id);
          if (!current || current.terminal) continue;
          const execution = record.execution || current.execution;
          const canReconcile = current.taskType === 'target_session_message' ||
            Boolean(execution?.pid);
          if (canReconcile) {
            this.store.releaseLease({
              taskId: current.id,
              leaseToken: record.leaseToken,
              workerId: this.workerId,
              reason: 'dispatcher_shutdown_reconciliation_required',
            });
            releasedTaskIds.push(current.id);
          } else {
            const result = executionOutcomeUnknownResult(
              { ...current, execution },
              null,
              'The executor shut down after work began without a durable execution identity; the exact outcome is unknown.'
            );
            this.store.failTask({
              taskId: current.id,
              leaseToken: record.leaseToken,
              workerId: this.workerId,
              errorCode: 'EXECUTION_OUTCOME_UNKNOWN',
              errorMessage: result.payload.error,
              result,
            });
            unknownTaskIds.push(current.id);
          }
        } catch (error) {
          this.logger.warn?.(`Could not reconcile executor task ${record.task.id} during shutdown: ${error.message}`);
        }
      }

      return {
        stopped: true,
        drained,
        timedOut: !drained,
        quiesced: drained && releasedTaskIds.length === 0 && unknownTaskIds.length === 0,
        unresolvedTaskIds,
        releasedTaskIds,
        unknownTaskIds,
      };
    })().finally(() => {
      this.shuttingDown = false;
      this.starting = false;
      if (this.shutdownPromise === operation) this.shutdownPromise = null;
    });
    this.shutdownPromise = operation;
    return operation;
  }

  status() {
    return {
      running: this.running,
      starting: this.starting,
      acceptingClaims: this.acceptingClaims,
      shuttingDown: this.shuttingDown,
      workerId: this.workerId,
      concurrency: this.concurrency,
      activeTaskIds: [...this.active.keys()],
      reconciliationCandidates: this.store.listReconciliationCandidates().length,
      panic: this.store.getPanicStatus(),
    };
  }

  wake() {
    if (!this.running || !this.acceptingClaims || this.shuttingDown || this.wakeScheduled) return;
    this.wakeScheduled = true;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeScheduled = false;
      this._pump().catch((error) => {
        this.logger.error?.(`Executor dispatcher pump failed: ${error.stack || error.message}`);
      });
    }, 0);
    if (typeof this.wakeTimer.unref === 'function') this.wakeTimer.unref();
  }

  async _pump() {
    if (!this.running || !this.acceptingClaims || this.shuttingDown || this.pumping) return;
    this.pumping = true;
    try {
      while (this.running && this.acceptingClaims && !this.shuttingDown &&
          this.active.size < this.concurrency) {
        const claim = this.store.claimNext({
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          taskTypes: ['managed_ask', 'target_session_message'],
        });
        if (!claim) break;
        this._startClaim(claim);
      }
    } finally {
      this.pumping = false;
    }
  }

  _startClaim(claim) {
    const abortController = new globalThis.AbortController();
    const record = this._createRecord({
      task: claim.task,
      leaseToken: claim.leaseToken,
      abortController,
      recovered: false,
      execution: claim.task.execution,
    });
    this.active.set(claim.task.id, record);
    this._startHeartbeat(record);

    const context = {
      signal: abortController.signal,
      recordExecution: (execution) => {
        if (!this._isCurrentRecord(record)) {
          const error = new Error(`Executor task ${record.task.id} is no longer owned by this worker`);
          error.code = 'EXECUTOR_RECORD_INACTIVE';
          throw error;
        }
        record.execution = execution;
        record.task = this.store.heartbeat({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          execution,
        });
        return record.task;
      },
    };

    record.promise = Promise.resolve()
      .then(() => this.executeTask(record.task, context))
      .then((result) => this._settleClaimSuccess(record, result))
      .catch((error) => this._settleClaimFailure(record, error));
    return record;
  }

  _createRecord(properties) {
    let resolveDone;
    const donePromise = new Promise((resolve) => { resolveDone = resolve; });
    return {
      heartbeatTimer: null,
      recoveryTimer: null,
      killTimer: null,
      recoveryPolling: false,
      promise: null,
      donePromise,
      resolveDone,
      doneResolved: false,
      orphaned: false,
      shutdownRequested: false,
      generation: this.lifecycleGeneration,
      ...properties,
    };
  }

  _resolveRecord(record) {
    if (record.doneResolved) return;
    record.doneResolved = true;
    record.resolveDone?.();
  }

  _isCurrentRecord(record) {
    return Boolean(record && !record.orphaned && this.active.get(record.task.id) === record);
  }

  _startHeartbeat(record) {
    record.heartbeatTimer = setInterval(() => {
      if (!this._isCurrentRecord(record)) return;
      try {
        record.task = this.store.heartbeat({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          leaseMs: this.leaseMs,
        });
        if (record.task.cancelRequested) this._interruptRecord(record, record.task.cancelReason);
      } catch (error) {
        this.logger.error?.(`Executor heartbeat failed for ${record.task.id}: ${error.message}`);
        record.orphaned = true;
        if (!record.recovered && !record.abortController.signal.aborted) {
          record.abortController.abort(new Error('executor_lease_lost'));
        }
        this._finishRecord(record);
      }
    }, this.heartbeatMs);
    if (typeof record.heartbeatTimer.unref === 'function') record.heartbeatTimer.unref();
  }

  _settleClaimSuccess(record, result) {
    if (!this._isCurrentRecord(record)) return;
    try {
      const current = this.store.getTask(record.task.id);
      if (!current || current.terminal) return;
      if (isVerifiedSuccess(result)) {
        this.store.completeTask({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          result,
          allowAfterCancellation: current.state === 'cancel_requested',
        });
      } else if (current.state === 'cancel_requested') {
        this.store.acknowledgeCanceled({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          result,
        });
      } else if (record.abortController.signal.aborted || record.shutdownRequested) {
        const unknownResult = executionOutcomeUnknownResult(
          { ...current, execution: record.execution || current.execution },
          null,
          'Execution returned an unverified result after its response channel was interrupted; the exact outcome is unknown.'
        );
        this.store.failTask({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          errorCode: 'EXECUTION_OUTCOME_UNKNOWN',
          errorMessage: unknownResult.payload.error,
          result: unknownResult,
        });
      } else {
        this.store.failTask({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          errorCode: 'EXECUTION_RESULT_UNVERIFIED',
          errorMessage: 'Executor task returned without a verified success payload.',
          result,
        });
      }
    } catch (error) {
      this.logger.error?.(`Could not settle executor task ${record.task.id}: ${error.message}`);
    } finally {
      this._finishRecord(record);
    }
  }

  _settleClaimFailure(record, error) {
    if (!this._isCurrentRecord(record)) return;
    try {
      const current = this.store.getTask(record.task.id);
      if (!current || current.terminal) return;
      const failureCode = error?.result?.payload?.agentCode ||
        error?.result?.payload?.code || error?.code || 'EXECUTION_FAILED';
      const outcomeUnknown = failureCode === 'TARGET_DELIVERY_OUTCOME_UNKNOWN' ||
        failureCode === 'EXECUTION_OUTCOME_UNKNOWN';
      const definitiveProviderBusy = failureCode === 'PROVIDER_SUPERVISOR_BUSY' &&
        error?.result?.payload?.provider_started === false &&
        error?.result?.payload?.retry_safe === true &&
        current.state === 'running' &&
        !record.abortController.signal.aborted &&
        !record.shutdownRequested;
      if (definitiveProviderBusy) {
        const exponential = this.providerBusyBackoffMs * (2 ** Math.min(current.attempt - 1, 5));
        this.store.deferLeasedTask({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          delayMs: Math.min(exponential, 30000),
          reason: 'provider_supervisor_busy_before_provider_accept',
        });
      } else if (current.state === 'cancel_requested' && !outcomeUnknown) {
        this.store.acknowledgeCanceled({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          result: error?.result || null,
        });
      } else if (record.shutdownRequested && !outcomeUnknown) {
        const unknownResult = executionOutcomeUnknownResult(
          { ...current, execution: record.execution || current.execution },
          null,
          'The executor shut down while this operation was in progress; the exact outcome is unknown.'
        );
        this.store.failTask({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          errorCode: 'EXECUTION_OUTCOME_UNKNOWN',
          errorMessage: unknownResult.payload.error,
          result: unknownResult,
        });
      } else {
        this.store.failTask({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          errorCode: failureCode,
          errorMessage: error?.message || 'Executor task failed',
          result: error?.result || null,
        });
      }
    } catch (settleError) {
      this.logger.error?.(`Could not fail executor task ${record.task.id}: ${settleError.message}`);
    } finally {
      this._finishRecord(record);
    }
  }

  _finishRecord(record) {
    this._clearRecordTimers(record);
    if (this.active.get(record.task.id) === record) this.active.delete(record.task.id);
    this._resolveRecord(record);
    this.wake();
  }

  _clearRecordTimers(record) {
    if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
    if (record.recoveryTimer) clearTimeout(record.recoveryTimer);
    if (record.killTimer) clearTimeout(record.killTimer);
    record.heartbeatTimer = null;
    record.recoveryTimer = null;
    record.killTimer = null;
  }

  _clearDispatcherTimers() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.pollTimer = null;
    this.reconciliationTimer = null;
    this.wakeTimer = null;
    this.wakeScheduled = false;
  }

  _resetAfterStartFailure(generation) {
    this._clearDispatcherTimers();
    this.running = false;
    this.acceptingClaims = false;
    for (const record of [...this.active.values()]) {
      if (record.generation !== generation) continue;
      record.orphaned = true;
      this._clearRecordTimers(record);
      this.active.delete(record.task.id);
      this._resolveRecord(record);
      try {
        this.store.releaseLease({
          taskId: record.task.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          reason: 'dispatcher_start_failed',
        });
      } catch (error) {
        this.logger.warn?.(`Could not release executor lease ${record.task.id} after start failure: ${error.message}`);
      }
    }
  }

  requestCancellation({ taskId, reason = 'cancel_requested', source = 'controller' }) {
    const result = this.store.requestCancellation({ taskId, reason, source });
    const record = this.active.get(taskId);
    if (record && result.task.state === 'cancel_requested') {
      this._interruptRecord(record, reason);
    }
    this.wake();
    return result;
  }

  cancelCallTasks({
    callId,
    idempotencyKey = null,
    reason = 'call_canceled',
    source = 'controller',
  }) {
    const result = this.store.cancelCallTasks({ callId, idempotencyKey, reason, source });
    for (const taskId of result.taskIds) {
      const record = this.active.get(taskId);
      if (record) this._interruptRecord(record, reason);
    }
    this.wake();
    return result;
  }

  panic({ reason = 'voice_panic_stop', source = 'panic_control' } = {}) {
    const result = this.store.panic({ reason, source });
    for (const taskId of result.taskIds) {
      const record = this.active.get(taskId);
      if (record) this._interruptRecord(record, reason);
    }
    return result;
  }

  _interruptRecord(record, reason) {
    if (!this._isCurrentRecord(record)) return;
    if (record.targetRecovery) {
      if (!record.abortController.signal.aborted) {
        record.abortController.abort(new Error(String(reason || 'cancel_requested')));
      }
      return;
    }
    if (record.recovered) {
      if (record.execution) {
        try {
          this.terminateExecution(record.execution, 'SIGTERM');
          if (!record.killTimer && this.recoveryKillGraceMs > 0) {
            record.killTimer = setTimeout(() => {
              try {
                this.terminateExecution(record.execution, 'SIGKILL');
              } catch (error) {
                this.logger.warn?.(`Recovered task kill failed for ${record.task.id}: ${error.message}`);
              }
            }, this.recoveryKillGraceMs);
            if (typeof record.killTimer.unref === 'function') record.killTimer.unref();
          }
        } catch (error) {
          this.logger.warn?.(`Recovered task cancellation failed for ${record.task.id}: ${error.message}`);
        }
      }
      return;
    }
    if (!record.abortController.signal.aborted) {
      record.abortController.abort(new Error(String(reason || 'cancel_requested')));
    }
  }

  async _runReconciliationSweep() {
    if (!this.running || this.shuttingDown || this.reconciliationRunning) return null;
    const generation = this.lifecycleGeneration;
    this.reconciliationRunning = true;
    try {
      const summary = await this.reconcileOnStart({ generation });
      if (generation === this.lifecycleGeneration && summary.requeued.length > 0) this.wake();
      return summary;
    } catch (error) {
      this.logger.error?.(`Executor reconciliation sweep failed: ${error.stack || error.message}`);
      return null;
    } finally {
      this.reconciliationRunning = false;
    }
  }

  _reconciliationIsCurrent(generation) {
    return generation === this.lifecycleGeneration && !this.shuttingDown;
  }

  _isReconciliationRace(error) {
    return error?.code === 'RECONCILIATION_STALE' || error?.code === 'LEASE_STILL_LIVE' ||
      error?.code === 'TASK_NOT_RECONCILABLE';
  }

  async reconcileOnStart({ generation = this.lifecycleGeneration } = {}) {
    const candidates = this.store.listReconciliationCandidates({ includeLiveLeases: false });
    const summary = { adopted: [], completed: [], requeued: [], failed: [], deferred: [] };
    for (const candidate of candidates) {
      if (!this._reconciliationIsCurrent(generation)) break;
      if (this.active.has(candidate.id)) {
        summary.deferred.push({ taskId: candidate.id, reason: 'already_active' });
        continue;
      }
      if (candidate.taskType === 'target_session_message') {
        const handled = await this._reconcileTargetSessionTask(candidate, summary, generation);
        if (handled) continue;
      }
      if (candidate.taskType === 'managed_ask') {
        const handled = await this._reconcilePreProviderBusyTask(candidate, summary, generation);
        if (handled) continue;
      }
      if (!candidate.execution?.pid) {
        summary.deferred.push({ taskId: candidate.id, reason: 'execution_identity_missing' });
        continue;
      }
      const inspection = await this.inspectExecution(candidate.execution);
      if (!this._reconciliationIsCurrent(generation)) break;
      if (!inspection.known) {
        summary.deferred.push({ taskId: candidate.id, reason: inspection.reason });
        continue;
      }
      if (!inspection.alive) {
        try {
          const persistedResult = candidate.execution?.result;
          const verified = isVerifiedSuccess(persistedResult);
          const unknownResult = verified
            ? persistedResult
            : executionOutcomeUnknownResult(
                candidate,
                inspection,
                'A recovered agent process exited after its verified response channel was lost; the operation may have completed.'
              );
          this.store.reconcileTask({
            taskId: candidate.id,
            disposition: verified ? 'complete' : 'fail',
            reason: `restart reconciliation: ${inspection.reason}`,
            result: unknownResult,
            errorCode: verified ? null : 'EXECUTION_OUTCOME_UNKNOWN',
            errorMessage: verified ? null : unknownResult.payload.error,
            expectedRevision: candidate.revision,
          });
          if (verified) summary.completed.push(candidate.id);
          else summary.failed.push({ taskId: candidate.id, reason: inspection.reason });
        } catch (error) {
          if (!this._isReconciliationRace(error)) throw error;
          summary.deferred.push({ taskId: candidate.id, reason: 'revision_changed' });
        }
        continue;
      }

      try {
        const adopted = this.store.reconcileTask({
          taskId: candidate.id,
          disposition: 'adopt',
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          reason: `verified process identity after executor restart: ${inspection.reason}`,
          expectedRevision: candidate.revision,
        });
        this._trackRecovered(adopted.task, adopted.leaseToken);
        summary.adopted.push(candidate.id);
      } catch (error) {
        if (!this._isReconciliationRace(error)) throw error;
        summary.deferred.push({ taskId: candidate.id, reason: 'revision_changed' });
      }
    }
    return summary;
  }

  async _reconcilePreProviderBusyTask(candidate, summary, generation) {
    const execution = candidate.execution || {};
    const exactStage = execution.kind === 'managed_ask' &&
      execution.stage === 'provider_not_started_busy' &&
      execution.providerStarted === false &&
      execution.retrySafe === true &&
      execution.denialCode === 'PROVIDER_SUPERVISOR_BUSY' &&
      ['claude', 'codex'].includes(execution.provider) &&
      Number.isInteger(execution.pid) && execution.pid > 0 &&
      /^\d+$/.test(String(execution.processStartTime || '')) &&
      typeof execution.requestId === 'string' && execution.requestId.length > 0;
    if (!exactStage || !this.reconcileInterruptedTask) return false;

    let directive = null;
    try {
      directive = await this.reconcileInterruptedTask(candidate);
    } catch (error) {
      this.logger.warn?.(
        `Pre-provider capacity reconciliation failed for ${candidate.id}: ${error.message}`
      );
      return false;
    }
    if (!this._reconciliationIsCurrent(generation)) {
      summary.deferred.push({ taskId: candidate.id, reason: 'reconciliation_superseded' });
      return true;
    }
    const expectedDisposition = candidate.state === 'cancel_requested' ? 'cancel' : 'requeue';
    if (directive?.disposition !== expectedDisposition) return false;

    try {
      this.store.reconcileTask({
        taskId: candidate.id,
        disposition: directive.disposition,
        reason: directive.reason || 'durable_pre_provider_capacity_denial',
        result: directive.result || null,
        expectedRevision: candidate.revision,
      });
      if (directive.disposition === 'requeue') summary.requeued.push(candidate.id);
      else summary.failed.push({ taskId: candidate.id, reason: directive.reason });
      return true;
    } catch (error) {
      if (!this._isReconciliationRace(error)) throw error;
      summary.deferred.push({ taskId: candidate.id, reason: 'revision_changed' });
      return true;
    }
  }

  async _reconcileTargetSessionTask(candidate, summary, generation) {
    let directive = null;
    if (this.reconcileInterruptedTask) {
      try {
        directive = await this.reconcileInterruptedTask(candidate);
      } catch (error) {
        directive = {
          disposition: 'fail',
          reason: 'Target-session delivery could not be reconciled after restart.',
          errorCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          errorMessage: 'The bridge restarted after delivery became possible, and the exact outcome could not be verified.',
          result: {
            httpStatus: 409,
            payload: {
              success: false,
              code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
              error: 'Target-session delivery outcome is unknown after executor restart.',
              reconciliationReason: error?.code || 'reconciliation_failed',
            },
          },
        };
      }
    }
    if (!this._reconciliationIsCurrent(generation)) {
      summary.deferred.push({ taskId: candidate.id, reason: 'reconciliation_superseded' });
      return true;
    }
    if (!directive) {
      const stage = candidate.execution?.stage || null;
      if (!stage) {
        directive = candidate.state === 'cancel_requested'
          ? { disposition: 'cancel', reason: 'Canceled before target-session delivery began.' }
          : { disposition: 'requeue', reason: 'No target-session delivery attempt was persisted before restart.' };
      } else if (stage === 'delivery_verified' && candidate.execution?.result) {
        directive = {
          disposition: 'complete',
          reason: 'Recovered the verified target-session delivery result after restart.',
          result: candidate.execution.result,
        };
      } else {
        directive = {
          disposition: 'fail',
          reason: 'Target-session delivery may have crossed into tmux before restart.',
          errorCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          errorMessage: 'The bridge restarted after delivery became possible, so the operation was not resent.',
          result: {
            httpStatus: 409,
            payload: {
              success: false,
              code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
              error: 'Target-session delivery may have occurred before executor restart; it was not resent.',
            },
          },
        };
      }
    }
    if (directive.disposition === 'defer') {
      summary.deferred.push({
        taskId: candidate.id,
        reason: directive.reason || 'target_session_reconciliation_deferred',
      });
      return true;
    }
    if (directive.disposition === 'monitor') {
      try {
        const adopted = this.store.reconcileTask({
          taskId: candidate.id,
          disposition: 'adopt',
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          reason: directive.reason || 'monitoring verified target-session delivery after restart',
          expectedRevision: candidate.revision,
        });
        this._trackTargetRecovery(adopted.task, adopted.leaseToken);
        summary.adopted.push(candidate.id);
      } catch (error) {
        if (!this._isReconciliationRace(error)) throw error;
        summary.deferred.push({ taskId: candidate.id, reason: 'revision_changed' });
      }
      return true;
    }
    try {
      const reconciled = this.store.reconcileTask({
        taskId: candidate.id,
        disposition: directive.disposition,
        reason: directive.reason || 'target_session_restart_reconciliation',
        result: directive.result || null,
        errorCode: directive.errorCode || null,
        errorMessage: directive.errorMessage || null,
        expectedRevision: candidate.revision,
      });
      if (directive.disposition === 'complete') summary.completed.push(candidate.id);
      else if (directive.disposition === 'requeue') summary.requeued.push(candidate.id);
      else if (directive.disposition === 'fail' || directive.disposition === 'cancel') {
        summary.failed.push({ taskId: candidate.id, reason: directive.reason });
      }
      return Boolean(reconciled.task);
    } catch (error) {
      if (!this._isReconciliationRace(error)) throw error;
      summary.deferred.push({ taskId: candidate.id, reason: 'revision_changed' });
      return true;
    }
  }

  _trackTargetRecovery(task, leaseToken) {
    const record = this._createRecord({
      task,
      leaseToken,
      abortController: new globalThis.AbortController(),
      recovered: true,
      targetRecovery: true,
      execution: task.execution,
    });
    this.active.set(task.id, record);
    this._startHeartbeat(record);
    if (this.running) this._scheduleTargetRecoveryPoll(record, 0);
    if (task.cancelRequested) this._interruptRecord(record, task.cancelReason);
  }

  _scheduleTargetRecoveryPoll(record, delayMs = this.recoveryPollMs) {
    if (!this._isCurrentRecord(record) || !this.running || this.shuttingDown ||
        record.recoveryTimer) return;
    record.recoveryTimer = setTimeout(() => {
      record.recoveryTimer = null;
      record.promise = this._pollTargetRecovery(record).catch((error) => {
        this.logger.error?.(
          `Recovered target-session poll failed for ${record.task.id}: ${error.message}`
        );
        if (this._isCurrentRecord(record)) {
          this._scheduleTargetRecoveryPoll(record);
        }
      });
    }, Math.max(0, delayMs));
    if (typeof record.recoveryTimer.unref === 'function') record.recoveryTimer.unref();
  }

  async _pollTargetRecovery(record) {
    if (record.recoveryPolling || !this._isCurrentRecord(record)) return;
    record.recoveryPolling = true;
    try {
      const current = this.store.getTask(record.task.id);
      if (!current || current.terminal) {
        this._finishRecord(record);
        return;
      }
      record.task = current;
      let directive;
      try {
        directive = this.reconcileInterruptedTask
          ? await this.reconcileInterruptedTask(current, {
            signal: record.abortController.signal,
            monitoring: true,
          })
          : null;
      } catch (error) {
        directive = {
          disposition: 'fail',
          errorCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          errorMessage: 'The interrupted target-session delivery could not be reconciled safely.',
          result: {
            httpStatus: 409,
            payload: {
              success: false,
              code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
              agentCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
              error: 'Target-session delivery outcome is unknown after executor restart.',
              reconciliationReason: error?.code || 'reconciliation_failed',
            },
          },
        };
      }
      if (!this._isCurrentRecord(record)) return;

      if (!directive || ['monitor', 'defer'].includes(directive.disposition)) {
        this._scheduleTargetRecoveryPoll(record);
        return;
      }
      if (directive.disposition === 'complete') {
        this.store.completeTask({
          taskId: current.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          result: directive.result || null,
          allowAfterCancellation: current.state === 'cancel_requested',
        });
      } else if (directive.disposition === 'cancel') {
        this.store.acknowledgeCanceled({
          taskId: current.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          result: directive.result || null,
        });
      } else if (directive.disposition === 'fail') {
        const failureCode = directive.errorCode ||
          directive.result?.payload?.agentCode || directive.result?.payload?.code ||
          'TARGET_DELIVERY_OUTCOME_UNKNOWN';
        const outcomeUnknown = failureCode === 'TARGET_DELIVERY_OUTCOME_UNKNOWN' ||
          failureCode === 'EXECUTION_OUTCOME_UNKNOWN';
        if (current.state === 'cancel_requested' && !outcomeUnknown) {
          this.store.acknowledgeCanceled({
            taskId: current.id,
            leaseToken: record.leaseToken,
            workerId: this.workerId,
            result: directive.result || null,
          });
        } else {
          this.store.failTask({
            taskId: current.id,
            leaseToken: record.leaseToken,
            workerId: this.workerId,
            errorCode: failureCode,
            errorMessage: directive.errorMessage || directive.reason ||
              'Target-session recovery failed.',
            result: directive.result || null,
          });
        }
      } else {
        throw new Error(`Unsupported target recovery disposition: ${directive.disposition}`);
      }
      this._finishRecord(record);
    } finally {
      record.recoveryPolling = false;
    }
  }

  _trackRecovered(task, leaseToken) {
    const record = this._createRecord({
      task,
      leaseToken,
      abortController: new globalThis.AbortController(),
      recovered: true,
      execution: task.execution,
    });
    this.active.set(task.id, record);
    this._startHeartbeat(record);
    if (this.running) this._scheduleRecoveredPoll(record, this.recoveryPollMs);
    if (task.cancelRequested) this._interruptRecord(record, task.cancelReason);
  }

  _resumeRecoveryPolls() {
    for (const record of this.active.values()) {
      if (!record.recovered || record.recoveryTimer || record.recoveryPolling) continue;
      if (record.targetRecovery) this._scheduleTargetRecoveryPoll(record, 0);
      else this._scheduleRecoveredPoll(record, this.recoveryPollMs);
    }
  }

  _scheduleRecoveredPoll(record, delayMs = this.recoveryPollMs) {
    if (!this._isCurrentRecord(record) || !this.running || this.shuttingDown ||
        record.recoveryTimer) return;
    record.recoveryTimer = setTimeout(() => {
      record.recoveryTimer = null;
      record.promise = this._pollRecovered(record).catch((error) => {
        this.logger.error?.(`Recovered executor task poll failed for ${record.task.id}: ${error.message}`);
        if (this._isCurrentRecord(record)) this._scheduleRecoveredPoll(record);
      });
    }, Math.max(0, delayMs));
    if (typeof record.recoveryTimer.unref === 'function') record.recoveryTimer.unref();
  }

  async _pollRecovered(record) {
    if (record.recoveryPolling || !this._isCurrentRecord(record)) return;
    record.recoveryPolling = true;
    try {
      const inspection = await this.inspectExecution(record.execution);
      if (!this._isCurrentRecord(record)) return;
      if (!inspection.known || inspection.alive) {
        this._scheduleRecoveredPoll(record);
        return;
      }
      const current = this.store.getTask(record.task.id);
      if (!current || current.terminal) return;
      const persistedResult = current.execution?.result;
      if (isVerifiedSuccess(persistedResult)) {
        this.store.completeTask({
          taskId: current.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          result: persistedResult,
          allowAfterCancellation: current.state === 'cancel_requested',
        });
      } else {
        const result = executionOutcomeUnknownResult(
          current,
          inspection,
          'A recovered agent process exited after its verified response channel was lost; the operation may have completed.'
        );
        this.store.failTask({
          taskId: current.id,
          leaseToken: record.leaseToken,
          workerId: this.workerId,
          errorCode: 'EXECUTION_OUTCOME_UNKNOWN',
          errorMessage: result.payload.error,
          result,
        });
      }
    } finally {
      record.recoveryPolling = false;
      const current = this._isCurrentRecord(record) ? this.store.getTask(record.task.id) : null;
      if (!current || current.terminal) this._finishRecord(record);
    }
  }
}

module.exports = {
  ExecutorTaskDispatcher,
  captureProcessExecution,
  inspectProcessExecution,
  processStartTimeFromStat,
  signalExecution,
  sleep,
};
