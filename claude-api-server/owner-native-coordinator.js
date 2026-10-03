'use strict';

const { OwnerApprovalCoordinator } = require('./owner-approval-coordinator');
const { hash, requestPlan } = require('./owner-session-delivery');
const { exact } = require('./owner-session-catalog');
const { sessionError } = require('./owner-session-endpoint');

const NATIVE_DELIVERY_POLICY = 'native-session-permissions-v1';

// Reuse durable reconciliation, cancellation and panic semantics, but never
// manufacture PBX evidence or an approval capability. The private controller
// socket and the signed release's broker policy authorize this forwarding path.
class OwnerNativeCoordinator extends OwnerApprovalCoordinator {
  constructor({ store, broker, attester, assertAdmission }) {
    // The parent constructor builds approval signers, which this policy does
    // not use. Supply our own state without loading any additional credentials.
    super({ store, broker, attester, assertAdmission, nativeOnly: true });
  }

  async request(input, { sipCallId }) {
    exact(input, ['id', 'operationId', 'message']);
    if (typeof sipCallId !== 'string' || !/^[A-Za-z0-9_.@:+-]{1,256}$/.test(sipCallId)) {
      throw sessionError('OWNER_APPROVAL_CALL_INVALID');
    }
    const inputHash = hash({ input, sipCallId });
    const previous = this.store.get(input.operationId);
    if (previous) {
      if (previous.input_hash !== inputHash) throw sessionError('OWNER_APPROVAL_IDEMPOTENCY_CONFLICT');
      return { ...this.store.result(input.operationId), deliveryPolicy: NATIVE_DELIVERY_POLICY };
    }
    if (this.preparing || this.active.size) throw sessionError('OWNER_APPROVAL_BUSY');
    this.preparing = true;
    try {
      this.store.assertUnlocked(); await this.assertAdmission();
      const prepared = await this.broker.prepare(input);
      const plan = requestPlan(prepared.request);
      if (prepared.id !== input.id || plan.operationId !== input.operationId ||
          plan.message !== input.message || prepared.planHash !== hash(plan) || prepared.requestHash !== hash(plan.message)) {
        throw sessionError('OWNER_APPROVAL_PLAN_CHANGED');
      }
      // Still require the authenticated handset's current encrypted PBX call.
      // No approval lease, private handle, playback, DTMF or attestation.
      if ((await this.attester.validateCall(sipCallId))?.current !== true) {
        throw sessionError('OWNER_APPROVAL_CALL_INVALID');
      }
      this.store.assertUnlocked(); await this.assertAdmission();
      const admitted = this.store.insert({ inputHash, id: input.id, sipCallHash: hash(sipCallId),
        request: prepared.request, planHash: hash(plan), initialState: 'dispatching' });
      if (admitted) {
        const work = this.runForward(input.id, prepared.request).catch(() => this.store.lock());
        this.active.set(input.operationId, work);
        void work.finally(() => this.active.delete(input.operationId)).catch(() => {});
      }
      return { ...this.store.result(input.operationId), deliveryPolicy: NATIVE_DELIVERY_POLICY };
    } finally { this.preparing = false; }
  }

  async runForward(id, request) {
    try {
      this.store.assertUnlocked(); await this.assertAdmission();
      this.store.assertUnlocked();
      const result = await this.broker.forward({ id, request });
      if (result?.operationId !== request.operationId || result?.completed !== false) {
        throw sessionError('OWNER_APPROVAL_RESULT_INVALID');
      }
      const state = ['accepted', 'submitted_unconfirmed'].includes(result.state) ? result.state : 'outcome_unknown';
      this.store.transition(request.operationId, 'dispatching', state, { state, completed: false,
        deliveryPolicy: NATIVE_DELIVERY_POLICY });
    } catch {
      this.store.transition(request.operationId, 'dispatching', 'outcome_unknown', {
        code: 'OWNER_SESSION_DELIVERY_OUTCOME_UNKNOWN', completed: false, deliveryPolicy: NATIVE_DELIVERY_POLICY });
    }
  }
}

module.exports = { OwnerNativeCoordinator, NATIVE_DELIVERY_POLICY };
