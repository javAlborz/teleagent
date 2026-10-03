'use strict';

// Dormant host-side delivery coordinator. It has no HTTP entrypoint, production
// service, or trust keys. Existing worker/personal tmux boundaries are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { canonicalizeTargetSessionMessage } = require('../lib/target-session-message');
const { targetSessionOperationMarker } = require('../lib/voice-authorization-plan');
const {
  createTelecap2Verifier, canonicalJson, PBX_EVIDENCE_METHOD,
} = require('../lib/telecap2-execution-capability');
const { sessionError } = require('./owner-session-endpoint');
const { validId } = require('./owner-codex-client');

function hash(value) { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }

function requestPlan(input) {
  if (!input || Object.keys(input).some((key) => ![
    'operationId', 'provider', 'sessionId', 'sessionFingerprint', 'message', 'expectedTurnId',
  ].includes(key)) || !/^job_[A-Za-z0-9]{1,128}$/.test(input.operationId) ||
      !['codex', 'claude'].includes(input.provider) || !validId(input.sessionId) ||
      !/^[a-f0-9]{64}$/.test(input.sessionFingerprint) ||
      (input.expectedTurnId != null &&
        (input.provider !== 'codex' || !validId(input.expectedTurnId)))) {
    throw sessionError('OWNER_SESSION_REQUEST_INVALID');
  }
  return Object.freeze({ version: 1, kind: 'owner_session_message',
    operationId: input.operationId, provider: input.provider,
    sessionId: input.sessionId, sessionFingerprint: input.sessionFingerprint,
    expectedTurnId: input.expectedTurnId ?? null,
    message: canonicalizeTargetSessionMessage(input.message),
    marker: targetSessionOperationMarker(input.operationId) });
}

async function inspectOwnerSession(client, provider, sessionId) {
  if (!['codex', 'claude'].includes(provider) || !validId(sessionId)) {
    throw sessionError('OWNER_SESSION_TARGET_INVALID');
  }
  if (provider === 'codex' && !(await client.loaded()).includes(sessionId)) {
    throw sessionError('OWNER_SESSION_NOT_LOADED');
  }
  const session = await client.read(sessionId);
  if (provider === 'codex' && (!['idle', 'active'].includes(session.status) ||
      !session.canAcceptDirectInput)) throw sessionError('OWNER_SESSION_NOT_INTERACTIVE');
  client.assertIdentity();
  const activeTurnId = provider === 'codex' && session.status === 'active'
    ? await client.activeTurn(sessionId) : null;
  if (provider === 'codex' && session.status === 'active' && !activeTurnId) {
    throw sessionError('OWNER_SESSION_TURN_CHANGED');
  }
  return Object.freeze({ provider, sessionId, cwd: session.cwd, status: session.status,
    activeTurnId,
    sessionFingerprint: hash({ provider, sessionId, cwd: session.cwd, endpoint: client.identity }) });
}

class OwnerSessionDeliveryStore {
  constructor({ dbPath, now = Date.now } = {}) {
    if (typeof dbPath !== 'string') throw sessionError('OWNER_SESSION_STORAGE_REQUIRED');
    if (dbPath !== ':memory:') {
      const directory = path.dirname(path.resolve(dbPath));
      const stat = fs.lstatSync(directory);
      if (fs.realpathSync(directory) !== directory || !stat.isDirectory() ||
          stat.uid !== process.getuid() || (stat.mode & 0o077)) {
        throw sessionError('OWNER_SESSION_STORAGE_UNSAFE');
      }
      // Create securely before SQLite opens it; never follow an existing link.
      const fd = fs.openSync(dbPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const file = fs.fstatSync(fd);
        if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) || file.nlink !== 1) {
          throw sessionError('OWNER_SESSION_STORAGE_UNSAFE');
        }
      } finally { fs.closeSync(fd); }
    }
    this.now = now;
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 1000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_session_deliveries (
        operation_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('dispatching','accepted','submitted_unconfirmed','outcome_unknown')),
        receipt_json TEXT, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS owner_session_replay (
        nonce_hash TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS owner_session_control (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), locked INTEGER NOT NULL CHECK(locked IN (0,1))
      ) STRICT;
      INSERT OR IGNORE INTO owner_session_control VALUES (1,0);
    `);
  }

  get(operationId, planHash) {
    const row = this.db.prepare('SELECT * FROM owner_session_deliveries WHERE operation_id=?').get(operationId);
    if (!row) return null;
    if (row.plan_hash !== planHash) throw sessionError('OWNER_SESSION_IDEMPOTENCY_CONFLICT');
    return { operationId, state: row.state === 'dispatching' ? 'outcome_unknown' : row.state,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, completed: false };
  }

  admit(plan, token, expected, publicKeys) {
    return this.admitOnce(plan, () => {
      const verifier = createTelecap2Verifier({ publicKeys, now: this.now,
        consumeReplay: (record) => this.db.prepare(`
          INSERT OR IGNORE INTO owner_session_replay VALUES (?,?,?)
        `).run(hash({ key: record.controllerKeyFingerprint, nonce: record.nonce }),
          record.tokenSha256, record.expiresAt).changes === 1 });
      verifier.authorize(token, expected);
    });
  }

  // Only the enabled, controller-only native-forward route may use this.
  // It records dispatch intent, not fabricated handset approval evidence.
  admitNative(plan) { return this.admitOnce(plan, () => {}); }

  admitOnce(plan, authorize) {
    if (this.db.inTransaction) throw sessionError('OWNER_SESSION_STORAGE_TRANSACTION_ACTIVE');
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT locked FROM owner_session_control WHERE singleton=1').get()?.locked !== 0) {
        throw sessionError('OWNER_SESSION_PANIC_LOCKED');
      }
      const previous = this.get(plan.operationId, hash(plan));
      if (previous) return { admitted: false, previous };
      authorize();
      // Replay consumption and durable intent commit together, before any bytes
      // carrying the instruction can leave. Never persist token or message.
      this.db.prepare('INSERT INTO owner_session_deliveries VALUES (?,?,?,NULL,?)')
        .run(plan.operationId, hash(plan), 'dispatching', this.now());
      return { admitted: true };
    }).immediate();
  }

  finish(plan, receipt) {
    const state = ['accepted', 'submitted_unconfirmed'].includes(receipt?.state)
      ? receipt.state : 'outcome_unknown';
    const safeReceipt = state === 'accepted'
      ? { state, turnId: receipt.turnId, completed: false }
      : state === 'submitted_unconfirmed'
        ? { state, messageId: receipt.messageId, completed: false }
        : { state, completed: false };
    this.db.prepare(`UPDATE owner_session_deliveries SET state=?,receipt_json=?
      WHERE operation_id=? AND plan_hash=? AND state='dispatching'`)
      .run(state, JSON.stringify(safeReceipt), plan.operationId, hash(plan));
    return this.get(plan.operationId, hash(plan));
  }

  isLocked() { return this.db.prepare('SELECT locked FROM owner_session_control WHERE singleton=1').get()?.locked !== 0; }

  lock() {
    this.db.prepare('UPDATE owner_session_control SET locked=1 WHERE singleton=1').run();
    // Owner agents remain outside Teleagent's process boundary. Locking delivery
    // cannot establish their quiescence; do not claim panic STOPPED.
    return { locked: true, quiesced: false };
  }
  close() { this.db.close(); }
}

async function deliverOwnerSession({ client, store, request, capability, authority, beforeAdmission = () => {}, nativePermissions = false }) {
  const plan = requestPlan(request);
  const previous = store.get(plan.operationId, hash(plan));
  if (previous) return previous;
  const current = await inspectOwnerSession(client, plan.provider, plan.sessionId);
  if (current.sessionFingerprint !== plan.sessionFingerprint) {
    throw sessionError('OWNER_SESSION_IDENTITY_CHANGED');
  }
  if (plan.provider === 'codex' && current.activeTurnId !== plan.expectedTurnId) {
    throw sessionError('OWNER_SESSION_TURN_CHANGED');
  }
  // authority is trusted controller/host configuration, never phone/model input.
  // The caller supplies the evidence binding from its independently verified arm.
  const expected = nativePermissions ? null : { ...authority.bindings,
    evidenceMethod: PBX_EVIDENCE_METHOD, jobId: plan.operationId,
    operation: 'owner-session-message', requestHash: hash(plan.message), planHash: hash(plan),
    target: `owner-${plan.provider}:${plan.sessionId}`, provider: plan.provider,
    profile: `owner-${plan.provider}-session` };
  const checked = beforeAdmission();
  if (checked && typeof checked.then === 'function') {
    throw sessionError('OWNER_SESSION_ASYNC_ADMISSION_GUARD');
  }
  const admitted = nativePermissions ? store.admitNative(plan)
    : store.admit(plan, capability, expected, authority.publicKeys);
  if (!admitted.admitted) return admitted.previous;
  // No await between admission and handing the exact immutable input to the
  // client. Client rechecks process/socket/session identity at its send boundary.
  let receipt;
  try {
    receipt = await client.deliver({ threadId: plan.sessionId,
      message: `${plan.message}\n${plan.marker}`, expectedTurnId: plan.expectedTurnId });
  } catch { receipt = { state: 'outcome_unknown' }; }
  return store.finish(plan, receipt);
}

module.exports = {
  OwnerSessionDeliveryStore, inspectOwnerSession, requestPlan, deliverOwnerSession, hash,
};
