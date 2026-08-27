'use strict';

const { randomUUID } = require('node:crypto');

function rejectInvite(res, status = 503) {
  try {
    res.send(status);
  } catch {
    // The admission decision is still fail-closed if the SIP transport ended.
  }
}

async function destroyResource(resource) {
  if (!resource || resource.destroyed || typeof resource.destroy !== 'function') return true;
  await resource.destroy();
  return true;
}

class InboundCallRegistry {
  constructor() {
    this.accepting = false;
    this.operations = new Map();
    this.cleanupFailures = new Set();
  }

  startAccepting() {
    this.accepting = this.cleanupFailures.size === 0;
    return this.getStatus();
  }

  stopAccepting() {
    this.accepting = false;
    return this.getStatus();
  }

  dispatch(req, res, handler) {
    if (!this.accepting) {
      rejectInvite(res, 503);
      return Promise.resolve({ rejected: true, reason: 'voice_runtime_draining' });
    }
    if (typeof handler !== 'function') throw new Error('Inbound call handler is required');
    const id = `inbound_${randomUUID().replaceAll('-', '')}`;
    const operation = {
      id,
      controller: new AbortController(),
      dialog: null,
      endpoint: null,
      cleanup: null,
      cleanupPromise: null,
      cleanupSucceeded: null,
      promise: null,
    };
    this.operations.set(id, operation);
    const handlerPromise = Promise.resolve().then(() => handler({
      id,
      signal: operation.controller.signal,
      onResources: (resources = {}) => {
        const acquired = Boolean(resources.dialog || resources.endpoint || resources.cleanup);
        operation.dialog = resources.dialog || operation.dialog;
        operation.endpoint = resources.endpoint || operation.endpoint;
        operation.cleanup = typeof resources.cleanup === 'function'
          ? resources.cleanup
          : operation.cleanup;
        if (acquired && !operation.cleanupPromise) operation.cleanupSucceeded = null;
        if (operation.controller.signal.aborted) void this._cleanupOperation(operation);
      },
    }));
    operation.promise = handlerPromise.then(
      async (value) => {
        const cleanup = await this._cleanupOperation(operation);
        if (!cleanup.success) this._recordCleanupFailure(operation);
        return value;
      },
      async (error) => {
        const cleanup = await this._cleanupOperation(operation);
        if (!cleanup.success) this._recordCleanupFailure(operation);
        throw error;
      }
    ).finally(() => {
      this.operations.delete(id);
    });
    return operation.promise;
  }

  async _cleanupOperation(operation) {
    if (operation.cleanupPromise) return operation.cleanupPromise;
    if (!operation.cleanup && !operation.dialog && !operation.endpoint) {
      operation.cleanupSucceeded = true;
      return { success: true, resourcesAcquired: false };
    }
    operation.cleanupPromise = Promise.resolve().then(async () => {
      const failures = [];
      try {
        if (operation.cleanup) {
          await operation.cleanup();
        } else {
          await destroyResource(operation.dialog);
          await destroyResource(operation.endpoint);
        }
      } catch (error) {
        failures.push(error);
        // A custom cleanup may have failed before attempting one resource.
        try { await destroyResource(operation.dialog); } catch (fallbackError) { failures.push(fallbackError); }
        try { await destroyResource(operation.endpoint); } catch (fallbackError) { failures.push(fallbackError); }
      }
      operation.cleanupSucceeded = failures.length === 0;
      return { success: operation.cleanupSucceeded, resourcesAcquired: true, failures };
    });
    return operation.cleanupPromise;
  }

  _recordCleanupFailure(operation) {
    this.cleanupFailures.add(operation.id);
    // A SIP/media resource whose teardown was not confirmed may still exist.
    // Do not admit more calls, clear this uncertainty online, or release the
    // app-lifetime owner fence before process/cgroup death.
    this.accepting = false;
  }

  async shutdown({ reason = 'Voice application shutdown', timeoutMs = 10000 } = {}) {
    this.stopAccepting();
    const operations = [...this.operations.values()];
    for (const operation of operations) {
      if (!operation.controller.signal.aborted) operation.controller.abort(reason);
    }
    const boundedMs = Math.max(10, Math.min(Number(timeoutMs) || 10000, 60000));
    let timer = null;
    let cleanupResults = null;
    const drain = Promise.allSettled(operations.map(async (operation) => {
      await this._cleanupOperation(operation);
      await Promise.allSettled([operation.promise]);
      return this._cleanupOperation(operation);
    })).then((results) => {
      cleanupResults = results;
      return true;
    });
    const settled = await Promise.race([
      drain,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), boundedMs);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const cleanupSucceeded = settled && cleanupResults?.every(
      (result) => result.status === 'fulfilled' && result.value?.success === true
    ) === true;
    const activeIds = [...new Set([
      ...this.operations.keys(),
      ...this.cleanupFailures,
    ])];
    const quiesced = settled && cleanupSucceeded && activeIds.length === 0;
    return {
      success: quiesced,
      drained: quiesced,
      safeToClose: quiesced,
      accepting: false,
      activeCount: activeIds.length,
      activeIds,
      cleanupSucceeded,
      error: quiesced ? null : 'inbound_call_quiescence_unconfirmed',
    };
  }

  getStatus() {
    return {
      accepting: this.accepting,
      activeCount: new Set([...this.operations.keys(), ...this.cleanupFailures]).size,
      activeIds: [...new Set([...this.operations.keys(), ...this.cleanupFailures])],
      cleanupUncertain: this.cleanupFailures.size > 0,
    };
  }
}

module.exports = {
  InboundCallRegistry,
  rejectInvite,
};
