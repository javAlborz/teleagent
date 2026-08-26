'use strict';

const {
  createApprovalCapabilityVerifier,
  hashApprovalPlan,
} = require('../lib/voice-approval-capability');
const crypto = require('node:crypto');
const {
  PRIVILEGED_ACTION_METHOD,
  PRIVILEGED_ACTION_PROFILE,
  PRIVILEGED_ACTION_PROVIDER,
  buildPrivilegedActionApprovalPlan,
  privilegedActionRequestHash,
  validateCanonicalPrivilegedActionPlan,
} = require('../lib/privileged-action-plan');
const { readRootOwnedFile } = require('./policy');

const REPLAY_TABLE = 'privileged_action_capability_replay';

class PrivilegedActionAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrivilegedActionAuthorizationError';
    this.code = code;
  }
}

function authorizationError(code, message) {
  throw new PrivilegedActionAuthorizationError(code, message);
}

function authorizePrivilegedAction({
  verifier,
  jobId,
  callId,
  actionPlan,
  authorization,
} = {}) {
  if (!verifier?.consumeSync) {
    authorizationError(
      'PRIVILEGED_APPROVAL_VERIFIER_UNAVAILABLE',
      'The privileged approval verifier is unavailable.'
    );
  }
  const plan = validateCanonicalPrivilegedActionPlan(actionPlan);
  const approvalPlan = buildPrivilegedActionApprovalPlan({ jobId, callId, actionPlan: plan });
  let claims;
  try {
    claims = verifier.consumeSync(authorization?.capability, {
      jobId,
      requestHash: privilegedActionRequestHash(plan),
      planHash: hashApprovalPlan(approvalPlan),
      target: plan.target,
      provider: PRIVILEGED_ACTION_PROVIDER,
      profile: PRIVILEGED_ACTION_PROFILE,
    });
  } catch (error) {
    authorizationError(
      error?.code || 'PRIVILEGED_APPROVAL_REJECTED',
      'The exact privileged action needs a fresh focused phone approval.'
    );
  }
  // This is the only approval shape stored with a privileged action. The
  // capability, its bearer digest, and its nonce remain confined to the
  // verifier/replay table and never enter action, audit, or outbox records.
  return Object.freeze({
    allowed: true,
    method: PRIVILEGED_ACTION_METHOD,
    approved_at: new Date(claims.iat * 1000).toISOString(),
    capability_key_id: claims.key_id,
    job_id: claims.job_id,
    call_id: callId,
    request_sha256: claims.request_sha256,
    plan_sha256: claims.plan_sha256,
    target: claims.target,
    provider: claims.provider,
    profile: claims.profile,
  });
}

function createHashedSqliteCapabilityReplayStore(db, replayKey) {
  const key = Buffer.from(replayKey || '');
  if (!db?.exec || !db?.prepare || key.length < 32) {
    authorizationError(
      'PRIVILEGED_REPLAY_CONFIG_INVALID',
      'A SQLite database and independent replay-fingerprint key are required.'
    );
  }
  // The raw capability, token digest, and nonce are deliberately not durable.
  // A separate keyed fingerprint retains consume-once semantics without
  // creating a usable bearer artifact or a plaintext nonce inventory.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${REPLAY_TABLE} (
      replay_fingerprint TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${REPLAY_TABLE}_expires_idx
      ON ${REPLAY_TABLE}(expires_at);
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ${REPLAY_TABLE} (
      replay_fingerprint, job_id, purpose, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const purge = db.prepare(`DELETE FROM ${REPLAY_TABLE} WHERE expires_at <= ?`);
  return Object.freeze({
    consume(record) {
      const fingerprint = crypto.createHmac('sha256', key)
        .update(record.keyId)
        .update('\0')
        .update(record.nonce)
        .digest('hex');
      return insert.run(
        fingerprint, record.jobId, record.purpose, record.expiresAt, record.consumedAt
      ).changes === 1;
    },
    purgeExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
      return purge.run(nowSeconds).changes;
    },
  });
}

function parseReplayKey(value) {
  const buffer = Buffer.from(value || '');
  const text = buffer.toString('utf8').trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  if (buffer.length >= 32 && buffer.length <= 128) return buffer;
  authorizationError(
    'PRIVILEGED_REPLAY_CONFIG_INVALID',
    'The independent replay-fingerprint key must contain at least 32 bytes.'
  );
}

function createConfiguredPrivilegedActionVerifier({
  environment = process.env,
  sqliteDatabase,
  expectedUid = 0,
  now = Date.now,
} = {}) {
  const keyId = String(environment.PRIVILEGED_ACTION_APPROVAL_KEY_ID || '').trim();
  const publicKeyFile = String(
    environment.PRIVILEGED_ACTION_APPROVAL_PUBLIC_KEY_FILE || ''
  ).trim();
  const replayKeyFile = String(
    environment.PRIVILEGED_ACTION_REPLAY_KEY_FILE || ''
  ).trim();
  if (!keyId || !publicKeyFile || !replayKeyFile) {
    authorizationError(
      'PRIVILEGED_APPROVAL_CONFIG_MISSING',
      'The privileged Ed25519 key ID/public key and independent replay key are required.'
    );
  }
  if (!sqliteDatabase) {
    authorizationError(
      'PRIVILEGED_APPROVAL_STORAGE_MISSING',
      'The privileged SQLite database is required for replay protection.'
    );
  }
  let publicKey;
  let replayKey;
  try {
    publicKey = readRootOwnedFile(publicKeyFile, { expectedUid, maxBytes: 64 * 1024 });
    replayKey = parseReplayKey(readRootOwnedFile(replayKeyFile, {
      expectedUid,
      maxBytes: 1024,
    }));
    return createApprovalCapabilityVerifier({
      publicKeys: { [keyId]: publicKey },
      replayStore: createHashedSqliteCapabilityReplayStore(sqliteDatabase, replayKey),
      now,
    });
  } catch (error) {
    if (error instanceof PrivilegedActionAuthorizationError) throw error;
    authorizationError(
      'PRIVILEGED_APPROVAL_CONFIG_INVALID',
      'The privileged Ed25519 verification key could not be loaded securely.'
    );
  } finally {
    publicKey = null;
    replayKey?.fill(0);
  }
}

module.exports = {
  PrivilegedActionAuthorizationError,
  REPLAY_TABLE,
  authorizePrivilegedAction,
  createConfiguredPrivilegedActionVerifier,
  createHashedSqliteCapabilityReplayStore,
};
