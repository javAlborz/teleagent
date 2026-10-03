'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { OwnerApprovalStore } = require('../owner-approval-coordinator');
const { OwnerNativeCoordinator, NATIVE_DELIVERY_POLICY } = require('../owner-native-coordinator');
const { requestPlan, hash } = require('../owner-session-delivery');

function fixture(t) {
  const db = new Database(':memory:'); db.pragma('synchronous=FULL'); t.after(() => db.close());
  const store = new OwnerApprovalStore(db);
  const state = { sends: 0, calls: 0, receipt: null, lost: false, admission: true, pause: null };
  const broker = {
    async prepare(input) {
      const request = { operationId: input.operationId, provider: 'codex', sessionId: 'native_fixture',
        sessionFingerprint: 'a'.repeat(64), expectedTurnId: null, message: input.message };
      return { id: input.id, request, planHash: hash(requestPlan(request)), requestHash: hash(input.message) };
    },
    async forward(input) {
      assert.deepEqual(Object.keys(input).sort(), ['id', 'request']);
      assert.equal(store.get(input.request.operationId).state, 'dispatching');
      state.sends++;
      if (state.pause) await state.pause;
      state.receipt = { operationId: input.request.operationId, state: 'accepted', completed: false };
      if (state.lost) throw new Error('lost response');
      return state.receipt;
    },
    async result() { return state.receipt; },
    async panic() { return { locked: true, deliveryQuiesced: true }; },
  };
  const attester = {
    async resolveCall(call) { assert.equal(call, 'handset@pbx'); state.calls++; return 'opaque'; },
    async attest() { assert.fail('native policy never plays or attests a prompt'); },
    async panic() { return { locked: true, quiesced: true }; },
  };
  const options = { store, broker, attester, assertAdmission() {
    if (!state.admission) throw new Error('no headroom');
  } };
  const coordinator = new OwnerNativeCoordinator(options);
  return { db, store, state, broker, attester, coordinator, options,
    input: { id: 'os_fixture', operationId: 'job_fixture', message: 'Edit the enrolled workspace.' },
    context: { sipCallId: 'handset@pbx' },
    drain: () => Promise.allSettled([...coordinator.active.values()]) };
}

test('native policy forwards once from the real call with no approval evidence or capability', async (t) => {
  const f = fixture(t);
  const pending = await f.coordinator.request(f.input, f.context);
  assert.equal(pending.deliveryPolicy, NATIVE_DELIVERY_POLICY);
  await f.drain();
  assert.equal(f.store.result('job_fixture').state, 'accepted');
  assert.equal(f.store.result('job_fixture').completed, false);
  await f.coordinator.request(f.input, f.context);
  assert.equal(f.state.sends, 1); assert.equal(f.state.calls, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_approval_evidence_replay').get().n, 0);
  await assert.rejects(f.coordinator.request({ ...f.input, message: 'Different' }, f.context),
    { code: 'OWNER_APPROVAL_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.coordinator.request({ ...f.input, approved: true }, f.context));
});

test('invalid or absent handset, changed plan, and missing resources never forward', async (t) => {
  for (const failure of ['call', 'plan', 'resources']) {
    const f = fixture(t);
    if (failure === 'call') f.attester.resolveCall = async () => { throw new Error('absent call'); };
    if (failure === 'plan') { const prepare = f.broker.prepare;
      f.broker.prepare = async (input) => ({ ...await prepare(input), planHash: 'b'.repeat(64) }); }
    if (failure === 'resources') f.state.admission = false;
    await assert.rejects(f.coordinator.request(f.input, f.context));
    assert.equal(f.state.sends, 0); assert.equal(f.store.get('job_fixture'), null);
  }
});

test('unknown delivery reconciles its receipt without sending again, including after restart', async (t) => {
  const f = fixture(t); f.state.lost = true;
  await f.coordinator.request(f.input, f.context); await f.drain();
  assert.equal(f.store.result('job_fixture').state, 'outcome_unknown');
  const restarted = new OwnerNativeCoordinator(f.options);
  await restarted.recover();
  await restarted.request(f.input, f.context);
  assert.equal(f.state.sends, 1);
  assert.equal((await restarted.reconcile('job_fixture')).state, 'accepted');
  assert.equal(f.state.sends, 1);
});

test('panic fences new delivery without claiming to stop the native agent', async (t) => {
  const f = fixture(t); let resume;
  f.state.pause = new Promise((resolve) => { resume = resolve; });
  await f.coordinator.request(f.input, f.context);
  await assert.rejects(f.coordinator.request({ ...f.input, operationId: 'job_second' }, f.context),
    { code: 'OWNER_APPROVAL_BUSY' });
  const panic = await f.coordinator.panic();
  assert.equal(panic.locked, true); assert.equal(panic.quiesced, false); assert.equal(panic.deliveryQuiesced, false);
  resume(); await f.drain();
  await assert.rejects(f.coordinator.request({ ...f.input, operationId: 'job_second' }, f.context),
    { code: 'OWNER_APPROVAL_LOCKED' });
  assert.equal(f.state.sends, 1);
});

test('dispatch crash recovery never resends and old pending approvals stay refused', async (t) => {
  for (const initialState of ['pending_approval', 'dispatching']) {
    const f = fixture(t); const prepared = await f.broker.prepare(f.input);
    f.store.insert({ inputHash: hash({ input: f.input, sipCallId: f.context.sipCallId }), id: f.input.id,
      sipCallHash: hash(f.context.sipCallId), request: prepared.request, planHash: prepared.planHash, initialState });
    await f.coordinator.recover();
    assert.equal(f.store.result('job_fixture').state, initialState === 'dispatching' ? 'outcome_unknown' : 'refused');
    assert.equal(f.state.sends, 0); assert.equal(f.state.calls, 0);
  }
});
