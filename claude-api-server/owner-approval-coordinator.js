'use strict';

const crypto = require('node:crypto');
const { canonicalJson, createTelecap2ControllerAuthority } = require('../lib/telecap2-execution-capability');
const { createPbxArmIssuer, createPbxArmVerifier, digestToken } = require('../lib/pbx-approval-protocol');
const { hash, requestPlan } = require('./owner-session-delivery');
const { exact } = require('./owner-session-catalog');
const { sessionError } = require('./owner-session-endpoint');

// Controller-owned storage. Its caller supplies the existing protected SQLite
// connection; signed artifacts are transient and never written to these tables.
class OwnerApprovalStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db; this.now = now;
    if (db.inTransaction) throw sessionError('OWNER_APPROVAL_TRANSACTION_ACTIVE');
    const journal = db.pragma('journal_mode', { simple: true });
    if (!['wal', 'memory'].includes(journal) || db.pragma('synchronous', { simple: true }) !== 2) {
      throw sessionError('OWNER_APPROVAL_STORAGE_UNSAFE');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_approval_jobs (
        operation_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, catalog_id TEXT NOT NULL,
        sip_call_hash TEXT NOT NULL, request_json TEXT NOT NULL, plan_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending_approval','dispatching','accepted','submitted_unconfirmed','outcome_unknown','refused')),
        result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS owner_approval_one_active ON owner_approval_jobs((1))
        WHERE state IN ('pending_approval','dispatching');
      CREATE TABLE IF NOT EXISTS owner_approval_evidence_replay (
        evidence_hash TEXT PRIMARY KEY, key_nonce_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS owner_approval_control (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), locked INTEGER NOT NULL CHECK(locked IN (0,1))
      ) STRICT;
      INSERT OR IGNORE INTO owner_approval_control VALUES(1,0);
    `);
  }
  assertWritable() {
    if (this.db.inTransaction) throw sessionError('OWNER_APPROVAL_TRANSACTION_ACTIVE');
  }
  assertUnlocked() {
    if (this.db.prepare('SELECT locked FROM owner_approval_control WHERE singleton=1').get()?.locked !== 0) {
      throw sessionError('OWNER_APPROVAL_LOCKED');
    }
  }
  get(id) { return this.db.prepare('SELECT * FROM owner_approval_jobs WHERE operation_id=?').get(id) || null; }
  result(id) {
    const row = this.get(id);
    if (!row) return null;
    return { operationId: row.operation_id, state: row.state, completed: false,
      result: row.result_json ? JSON.parse(row.result_json) : null };
  }
  insert({ inputHash, id, sipCallHash, request, planHash }) {
    this.assertWritable();
    return this.db.transaction(() => {
      this.assertUnlocked();
      const previous = this.get(request.operationId);
      if (previous) {
        if (previous.input_hash !== inputHash) throw sessionError('OWNER_APPROVAL_IDEMPOTENCY_CONFLICT');
        return false;
      }
      if (this.db.prepare("SELECT 1 FROM owner_approval_jobs WHERE state IN ('pending_approval','dispatching')").get()) {
        throw sessionError('OWNER_APPROVAL_BUSY');
      }
      this.db.prepare('INSERT INTO owner_approval_jobs VALUES(?,?,?,?,?,?,?,NULL,?,?)').run(
        request.operationId, inputHash, id, sipCallHash, canonicalJson(request), planHash,
        'pending_approval', this.now(), this.now());
      return true;
    }).immediate();
  }
  transition(id, from, to, result = null) {
    this.assertWritable();
    return this.db.prepare(`UPDATE owner_approval_jobs SET state=?, result_json=?, updated_at=?
      WHERE operation_id=? AND state=?`).run(to, result ? canonicalJson(result) : null, this.now(), id, from).changes === 1;
  }
  consume(record) {
    this.assertWritable(); this.assertUnlocked();
    return this.db.prepare('INSERT OR IGNORE INTO owner_approval_evidence_replay VALUES(?,?,?)')
      .run(record.evidenceSha256, hash({ key: record.keyId, nonce: record.nonce }), record.expiresAt).changes === 1;
  }
  lock() {
    this.assertWritable(); this.db.prepare('UPDATE owner_approval_control SET locked=1 WHERE singleton=1').run();
  }
}

function approvalPrompt(prepared) {
  const plan = requestPlan(prepared.request);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(prepared.label) || plan.message.length > 1200) {
    throw sessionError('OWNER_APPROVAL_INSTRUCTION_TOO_LONG');
  }
  return `Approve sending an instruction to ${plan.provider} session ${prepared.label}, reference ${plan.sessionId.slice(-8)}. ` +
    `Instruction begins. ${plan.message} Instruction ends. This uses that session's existing permissions. ` +
    'After this prompt finishes, press pound to send or star to cancel.';
}

class OwnerApprovalCoordinator {
  constructor({ store, broker, attester, armPrivateKey, armKeyId, executionPrivateKey, executionKeyId,
    controllerArmPublicKeys, pbxAttesterPublicKeys, now = Date.now, assertAdmission }) {
    if (typeof assertAdmission !== 'function') throw sessionError('OWNER_APPROVAL_ADMISSION_REQUIRED');
    this.store = store; this.broker = broker; this.attester = attester;
    this.now = now; this.assertAdmission = assertAdmission; this.active = new Map(); this.preparing = false;
    this.armIssuer = createPbxArmIssuer({ privateKey: armPrivateKey, keyId: armKeyId, now, ttlSeconds: 120 });
    this.armVerifier = createPbxArmVerifier({ publicKeys: controllerArmPublicKeys, now });
    this.authority = createTelecap2ControllerAuthority({ executionPrivateKey, executionKeyId,
      controllerArmPublicKeys, pbxAttesterPublicKeys, pbxEvidenceReplayStore: store, now });
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
      return this.store.result(input.operationId);
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
      const prompt = approvalPrompt(prepared);
      const handle = await this.attester.resolveCall(sipCallId);
      this.store.assertUnlocked(); await this.assertAdmission();
      const armToken = this.armIssuer.issue({ approvalId: `approval-${crypto.randomUUID()}`,
        jobId: plan.operationId, operation: 'owner-session-message', requestHash: hash(plan.message),
        planHash: hash(plan), target: `owner-${plan.provider}:${plan.sessionId}`, provider: plan.provider,
        profile: `owner-${plan.provider}-session`, prompt, pbxCallHandle: handle });
      const arm = this.armVerifier.verify(armToken);
      const admitted = this.store.insert({ inputHash, id: input.id, sipCallHash: hash(sipCallId),
        request: prepared.request, planHash: hash(plan) });
      if (admitted) {
        const work = this.run(input.id, prepared.request, armToken, arm).catch(() => {
          // Storage failure never permits continuing an external effect.
          this.store.lock();
        });
        this.active.set(input.operationId, work);
        void work.finally(() => this.active.delete(input.operationId)).catch(() => {});
      }
      return this.store.result(input.operationId);
    } finally { this.preparing = false; }
  }
  async run(id, request, armToken, arm) {
    let phase = 'pending_approval';
    try {
      const evidence = await this.attester.attest(armToken);
      this.store.assertUnlocked();
      if (this.store.get(request.operationId)?.state !== phase || this.now() >= arm.claims.exp * 1000) {
        throw sessionError('OWNER_APPROVAL_NO_LONGER_CURRENT');
      }
      await this.assertAdmission();
      this.store.assertUnlocked();
      const consumed = this.authority.consumePbxEvidence(evidence.evidenceToken, { armToken });
      // Durable dispatch intent precedes one-time capability creation and send.
      if (!this.store.transition(request.operationId, phase, 'dispatching')) throw sessionError('OWNER_APPROVAL_NO_LONGER_CURRENT');
      phase = 'dispatching';
      const capability = this.authority.issue({ consumedPbxEvidence: consumed });
      const result = await this.broker.deliver({ id, request, capability, approval: {
        approvalId: arm.claims.approval_id, evidenceSha256: digestToken(evidence.evidenceToken) } });
      const state = ['accepted', 'submitted_unconfirmed'].includes(result?.state) ? result.state : 'outcome_unknown';
      if (result?.operationId !== request.operationId || result?.completed !== false) {
        throw sessionError('OWNER_APPROVAL_RESULT_INVALID');
      }
      this.store.transition(request.operationId, phase, state, { state, completed: false });
    } catch (error) {
      this.store.transition(request.operationId, phase, phase === 'dispatching' ? 'outcome_unknown' : 'refused', {
        code: /^(?:OWNER|PBX)_[A-Z_]+$/.test(error.code || '') ? error.code : 'OWNER_APPROVAL_UNCONFIRMED', completed: false });
    }
  }
  cancel(operationId) {
    const refused = this.store.transition(operationId, 'pending_approval', 'refused', {
      code: 'OWNER_APPROVAL_CANCELLED', completed: false });
    return { ...this.store.result(operationId), deliveryPrevented: refused, promptStopped: false };
  }
  async reconcile(operationId) {
    const row = this.store.get(operationId);
    if (!row || row.state !== 'outcome_unknown') return this.store.result(operationId);
    let result;
    try { result = await this.broker.result(row.operation_id, row.plan_hash); } catch { return this.store.result(operationId); }
    if (result?.operationId === row.operation_id && result?.completed === false &&
        ['accepted', 'submitted_unconfirmed'].includes(result.state)) {
      this.store.transition(row.operation_id, 'outcome_unknown', result.state, { state: result.state, completed: false });
    }
    return this.store.result(operationId);
  }
  async recover() {
    if (this.preparing || this.active.size) throw sessionError('OWNER_APPROVAL_BUSY');
    for (const row of this.store.db.prepare("SELECT * FROM owner_approval_jobs WHERE state IN ('pending_approval','dispatching')").all()) {
      if (row.state === 'pending_approval') {
        this.store.transition(row.operation_id, row.state, 'refused', { code: 'OWNER_APPROVAL_INTERRUPTED', completed: false });
      } else {
        let result;
        try { result = await this.broker.result(row.operation_id, row.plan_hash); } catch { result = null; }
        const state = result?.operationId === row.operation_id && result?.completed === false &&
          ['accepted', 'submitted_unconfirmed'].includes(result.state) ? result.state : 'outcome_unknown';
        this.store.transition(row.operation_id, row.state, state, { state, completed: false });
      }
    }
  }
  async panic() {
    this.store.lock();
    const results = await Promise.allSettled([this.broker.panic(), this.attester.panic()]);
    const broker = results[0].status === 'fulfilled' ? results[0].value : null;
    const attester = results[1].status === 'fulfilled' ? results[1].value : null;
    return { locked: true, quiesced: false,
      deliveryQuiesced: !this.preparing && this.active.size === 0 &&
        broker?.locked === true && broker.deliveryQuiesced === true &&
        attester?.locked === true && attester.quiesced === true };
  }
}
module.exports = { OwnerApprovalStore, OwnerApprovalCoordinator, approvalPrompt };
