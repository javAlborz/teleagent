'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { OwnerApprovalCoordinator, OwnerApprovalStore } = require('../owner-approval-coordinator');
const { requestPlan, hash } = require('../owner-session-delivery');
const { createPbxArmVerifier, createPbxEvidenceIssuer, DTMF_SOURCE } = require('../../lib/pbx-approval-protocol');
const { createTelecap2Verifier, PBX_EVIDENCE_METHOD } = require('../../lib/telecap2-execution-capability');

const NOW = 1800000000000;
const SESSION = '01000000-0000-7000-8000-000000000001';
function fixture(t) {
  const keys = Object.fromEntries(['arm', 'pbx', 'execution'].map((role) => [role, crypto.generateKeyPairSync('ed25519')]));
  const db = new Database(':memory:'); db.pragma('synchronous=FULL'); t.after(() => db.close());
  const store = new OwnerApprovalStore(db, { now: () => NOW });
  const state = { sends: 0, arms: 0, pause: null, admission: true, lost: false, receipt: null };
  let now = NOW;
  const armVerifier = createPbxArmVerifier({ publicKeys: { arm: keys.arm.publicKey }, now: () => now });
  const evidenceIssuer = createPbxEvidenceIssuer({ privateKey: keys.pbx.privateKey, keyId: 'pbx',
    controllerArmPublicKeys: { arm: keys.arm.publicKey }, now: () => now });
  const broker = {
    async prepare(input) {
      const request = { operationId: input.operationId, provider: 'codex', sessionId: SESSION,
        sessionFingerprint: 'f'.repeat(64), expectedTurnId: null, message: input.message };
      return { id: input.id, label: 'Fixture', request, planHash: hash(requestPlan(request)), requestHash: hash(input.message) };
    },
    async deliver(input) {
      const plan = requestPlan(input.request);
      const fingerprint = (key) => crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
      const verifier = createTelecap2Verifier({ publicKeys: { execution: keys.execution.publicKey }, now: () => now,
        consumeReplay: () => true });
      verifier.authorize(input.capability, { controllerKeyId: 'execution', ...input.approval,
        controllerArmKeyId: 'arm', controllerArmKeyFingerprint: fingerprint(keys.arm.publicKey),
        pbxAttesterKeyId: 'pbx', pbxAttesterKeyFingerprint: fingerprint(keys.pbx.publicKey),
        evidenceMethod: PBX_EVIDENCE_METHOD, jobId: plan.operationId, operation: 'owner-session-message',
        requestHash: hash(plan.message), planHash: hash(plan), target: `owner-codex:${SESSION}`,
        provider: 'codex', profile: 'owner-codex-session' });
      state.sends++;
      state.receipt = { operationId: input.request.operationId, state: 'accepted', completed: false };
      if (state.lost) throw new Error('socket lost');
      return state.receipt;
    },
    async result() { return state.receipt; }, async panic() { return { locked: true, quiesced: false, deliveryQuiesced: true }; },
  };
  const attester = {
    async resolveCall(sipCallId) { assert.equal(sipCallId, 'call@pbx'); return Buffer.alloc(32, 1).toString('base64url'); },
    async attest(armToken) {
      state.arms++;
      if (state.pause) await state.pause;
      const arm = armVerifier.verify(armToken);
      now += 4000;
      const observation = { pbx_call_handle: arm.claims.pbx_call_handle, prompt_sha256: arm.claims.prompt_sha256,
        prompt_audio_sha256: 'a'.repeat(64), playback_id: `playback-${state.arms}`,
        playback_started_at_ms: now - 3000, playback_completed_at_ms: now - 2000,
        digit: '#', dtmf_source: DTMF_SOURCE, dtmf_event_id: `dtmf-${state.arms}`, dtmf_received_at_ms: now - 1000,
        call_leg: { pbx_instance_id: 'pbx', linkedid: 'linked', handset_uniqueid: 'handset', handset_endpoint: 'PJSIP/1001',
          channel_birth_ms: NOW, trunk_uniqueid: 'trunk', bridge_id: 'bridge', dialed_route: '7' } };
      const evidenceToken = evidenceIssuer.issue({ armToken, observation });
      return { evidenceToken };
    },
    async panic() { return { locked: true, quiesced: true }; },
  };
  const options = { store, broker, attester, armPrivateKey: keys.arm.privateKey, armKeyId: 'arm',
    executionPrivateKey: keys.execution.privateKey, executionKeyId: 'execution',
    controllerArmPublicKeys: { arm: keys.arm.publicKey }, pbxAttesterPublicKeys: { pbx: keys.pbx.publicKey }, now: () => now,
    assertAdmission: async () => { if (!state.admission) throw new Error('headroom lost'); } };
  const coordinator = new OwnerApprovalCoordinator(options);
  const input = { id: 'os_fixture', operationId: 'job_fixture', message: 'Review the fixture' };
  const context = { sipCallId: 'call@pbx' };
  return { coordinator, input, context, state, db, store, options, broker, attester,
    async drain() { await Promise.allSettled([...coordinator.active.values()]); } };
}

test('controller persists pending request and sends only a fully attested exact capability', async (t) => {
  const f = fixture(t);
  await f.coordinator.request(f.input, f.context); await f.drain();
  const result = f.store.result('job_fixture');
  assert.equal(result.state, 'accepted'); assert.equal(result.completed, false);
  assert.equal(f.state.sends, 1); assert.equal(f.state.arms, 1);
  await f.coordinator.request(f.input, f.context); await f.drain();
  assert.equal(f.state.sends, 1); assert.equal(f.state.arms, 1);
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM owner_approval_jobs').all()), /telecap2\.|teleattest1\.|telereq1\./);
  await assert.rejects(f.coordinator.request({ ...f.input, message: 'Changed instruction' }, f.context),
    { code: 'OWNER_APPROVAL_IDEMPOTENCY_CONFLICT' });
});

test('cancellation during approval prevents delivery even if pound evidence arrives later', async (t) => {
  const f = fixture(t); let resume;
  f.state.pause = new Promise((resolve) => { resume = resolve; });
  await f.coordinator.request(f.input, f.context);
  const cancelled = f.coordinator.cancel('job_fixture');
  assert.equal(cancelled.deliveryPrevented, true); assert.equal(cancelled.promptStopped, false);
  resume(); await f.drain();
  assert.equal(f.state.sends, 0); assert.equal(f.store.result('job_fixture').state, 'refused');
});

test('resource refusal and forged PBX evidence never produce a submission', async (t) => {
  const f = fixture(t);
  f.state.admission = false;
  await assert.rejects(f.coordinator.request(f.input, f.context));
  assert.equal(f.state.arms, 0);
  f.state.admission = true;
  f.attester.attest = async () => ({ evidenceToken: 'forged' });
  await f.coordinator.request(f.input, f.context); await f.drain();
  assert.equal(f.state.sends, 0); assert.equal(f.store.result('job_fixture').state, 'refused');
});

test('lost delivery response stays unknown without automatic retry', async (t) => {
  const f = fixture(t); f.state.lost = true;
  await f.coordinator.request(f.input, f.context); await f.drain();
  assert.equal(f.store.result('job_fixture').state, 'outcome_unknown');
  await f.coordinator.request(f.input, f.context);
  assert.equal(f.state.sends, 1);
  assert.equal((await f.coordinator.reconcile('job_fixture')).state, 'accepted');
  assert.equal(f.state.sends, 1);
});

test('restart recovery queries the exact dispatch and never repeats its approval or send', async (t) => {
  const f = fixture(t);
  const prepared = await f.broker.prepare(f.input);
  f.store.insert({ inputHash: hash({ input: f.input, sipCallId: 'call@pbx' }), id: f.input.id,
    sipCallHash: hash('call@pbx'), request: prepared.request, planHash: prepared.planHash });
  f.store.transition('job_fixture', 'pending_approval', 'dispatching');
  f.state.receipt = { operationId: 'job_fixture', state: 'accepted', completed: false };
  let queries = 0;
  f.broker.result = async (id, planHash) => {
    queries++; assert.equal(id, 'job_fixture'); assert.equal(planHash, prepared.planHash); return f.state.receipt;
  };
  await new OwnerApprovalCoordinator(f.options).recover();
  assert.equal(f.store.result('job_fixture').state, 'accepted');
  assert.equal(queries, 1); assert.equal(f.state.sends, 0); assert.equal(f.state.arms, 0);
});

test('restart invalidates pending approval and refuses ambiguous missing dispatch evidence', async (t) => {
  const f = fixture(t);
  const prepared = await f.broker.prepare(f.input);
  f.store.insert({ inputHash: 'a'.repeat(64), id: f.input.id, sipCallHash: hash('call@pbx'),
    request: prepared.request, planHash: prepared.planHash });
  await f.coordinator.recover();
  assert.equal(f.store.result('job_fixture').state, 'refused');
  f.db.prepare("UPDATE owner_approval_jobs SET state='dispatching'").run();
  await f.coordinator.recover();
  assert.equal(f.store.result('job_fixture').state, 'outcome_unknown');
  assert.equal(f.state.sends, 0); assert.equal(f.state.arms, 0);
});

test('panic is durable and truthfully reports personal agents are not quiesced', async (t) => {
  const f = fixture(t); let resume;
  f.state.pause = new Promise((resolve) => { resume = resolve; });
  await f.coordinator.request(f.input, f.context);
  assert.deepEqual(await f.coordinator.panic(), { locked: true, quiesced: false, deliveryQuiesced: false });
  resume(); await f.drain();
  assert.deepEqual(await f.coordinator.panic(), { locked: true, quiesced: false, deliveryQuiesced: true });
  assert.equal(f.state.sends, 0);
  await assert.rejects(f.coordinator.request({ ...f.input, operationId: 'job_next' }, f.context), { code: 'OWNER_APPROVAL_LOCKED' });
});

test('another job is refused while awaiting approval; an outer transaction cannot admit work', async (t) => {
  const f = fixture(t); let resume;
  f.state.pause = new Promise((resolve) => { resume = resolve; });
  await f.coordinator.request(f.input, f.context);
  await assert.rejects(f.coordinator.request({ ...f.input, operationId: 'job_next' }, f.context), { code: 'OWNER_APPROVAL_BUSY' });
  resume(); await f.drain();
  f.db.exec('BEGIN');
  await assert.rejects(f.coordinator.request({ ...f.input, operationId: 'job_next' }, f.context), { code: 'OWNER_APPROVAL_TRANSACTION_ACTIVE' });
  f.db.exec('ROLLBACK');
  assert.equal(f.state.sends, 1);
});
