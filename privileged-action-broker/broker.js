'use strict';

const { isDeepStrictEqual } = require('node:util');
const {
  privilegedActionRequestHash,
  validateCanonicalPrivilegedActionPlan,
} = require('../lib/privileged-action-plan');
const { validatePlanAgainstPolicy } = require('./policy');
const { authorizePrivilegedAction } = require('./verifier');

class PrivilegedActionBrokerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrivilegedActionBrokerError';
    this.code = code;
    this.details = details;
  }
}

function brokerError(code, message, details = {}) {
  throw new PrivilegedActionBrokerError(code, message, details);
}

function assertExistingMatches(existing, { jobId, callId, plan, planHash }) {
  if (existing.jobId !== jobId || existing.callId !== callId ||
      existing.target !== plan.target || existing.planHash !== planHash ||
      !isDeepStrictEqual(existing.plan, plan)) {
    brokerError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to another privileged action.',
      { actionId: existing.id }
    );
  }
  return existing;
}

class PrivilegedActionBroker {
  constructor({ store, policy, verifier, dispatcher = null } = {}) {
    if (!store?.db || !policy || !verifier?.consumeSync) {
      brokerError(
        'PRIVILEGED_BROKER_CONFIG_INVALID',
        'The privileged broker requires a durable store, root policy, and approval verifier.'
      );
    }
    this.store = store;
    this.policy = policy;
    this.verifier = verifier;
    this.dispatcher = dispatcher;
  }

  submit({ idempotencyKey, jobId, callId, plan: inputPlan, authorization } = {}) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey !== jobId) {
      brokerError(
        'PRIVILEGED_IDEMPOTENCY_KEY_INVALID',
        'The privileged idempotency key must exactly equal its signed controller job ID.'
      );
    }
    const plan = validatePlanAgainstPolicy(
      validateCanonicalPrivilegedActionPlan(inputPlan),
      this.policy
    );
    const planHash = privilegedActionRequestHash(plan);
    const canceledBeforeSubmit = this.store.getCancellationByIdempotencyKey(idempotencyKey);
    if (canceledBeforeSubmit) {
      if (canceledBeforeSubmit.jobId !== jobId) {
        brokerError('IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to another job.');
      }
      brokerError(
        'PRIVILEGED_ACTION_CANCELED_BEFORE_SUBMIT',
        'The privileged action was canceled before its capability could be consumed.'
      );
    }
    const existing = this.store.getByIdempotencyKeyIfPresent?.(idempotencyKey) || null;
    if (existing) {
      return { created: false, action: assertExistingMatches(existing, {
        jobId, callId, plan, planHash,
      }) };
    }

    const transaction = this.store.db.transaction(() => {
      const racedCancellation = this.store.getCancellationByIdempotencyKey(idempotencyKey);
      if (racedCancellation) {
        if (racedCancellation.jobId !== jobId) {
          brokerError('IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to another job.');
        }
        brokerError(
          'PRIVILEGED_ACTION_CANCELED_BEFORE_SUBMIT',
          'The privileged action was canceled before its capability could be consumed.'
        );
      }
      const raced = this.store.getByIdempotencyKeyIfPresent?.(idempotencyKey) || null;
      if (raced) {
        return { created: false, action: assertExistingMatches(raced, {
          jobId, callId, plan, planHash,
        }) };
      }
      const sanitizedApproval = authorizePrivilegedAction({
        verifier: this.verifier,
        jobId,
        callId,
        actionPlan: plan,
        authorization,
      });
      return this.store.submitAction({
        idempotencyKey,
        jobId,
        callId,
        target: plan.target,
        plan,
        planHash,
        approval: sanitizedApproval,
      });
    });
    const result = transaction.immediate();
    if (result.created) this.dispatcher?.wake?.();
    return result;
  }

  getAction(id) {
    return this.store.getAction(id);
  }

  getByIdempotencyKey(key) {
    return this.store.getByIdempotencyKeyIfPresent(key);
  }

  cancel({ actionId, reason, source = 'voice_controller', expectedRevision = null } = {}) {
    const result = this.store.requestCancellation({
      actionId, reason, source, expectedRevision,
    });
    if (result.changed) this.dispatcher?.cancel?.(actionId);
    return result;
  }

  cancelByIdempotency({ idempotencyKey, jobId, reason, source = 'voice_controller' } = {}) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey !== jobId) {
      brokerError(
        'PRIVILEGED_IDEMPOTENCY_KEY_INVALID',
        'The privileged cancellation key must exactly equal its controller job ID.'
      );
    }
    const result = this.store.requestCancellationByIdempotency({
      idempotencyKey, jobId, reason, source,
    });
    if (result.changed && result.action?.id) {
      this.dispatcher?.cancel?.(result.action.id);
    }
    return result;
  }

  panic({ reason, source = 'voice_controller' } = {}) {
    const result = this.store.panic({ reason, source });
    this.dispatcher?.cancelAll?.(result.activeActionIds);
    return result;
  }
}

module.exports = {
  PrivilegedActionBroker,
  PrivilegedActionBrokerError,
};
