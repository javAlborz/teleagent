import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const ACTIVE_CALL_STATES = Object.freeze([
  'accept_intent',
  'accepted',
  'sideband_attaching',
  'attached',
  'reject_intent',
  'hangup_intent',
  'outcome_unknown',
]);
const ACTIVE_STATE_SQL = ACTIVE_CALL_STATES.map(() => '?').join(', ');
const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

function safeWebhookId(value) {
  if (typeof value !== 'string' || !WEBHOOK_ID_PATTERN.test(value)) {
    throw new TypeError('webhook-id is missing or invalid');
  }
  return value;
}

function safeOptionalIdentifier(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength || /[\r\n\0]/u.test(value)) {
    throw new TypeError('Webhook metadata contains an invalid identifier');
  }
  return value;
}

function safeOutcome(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    throw new TypeError('Webhook outcome is invalid');
  }
  return value;
}

function validateStateDirectory(directory, { expectedUid, expectedGid, strictOwnership }) {
  if (!strictOwnership) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pathMetadata = lstatSync(directory);
  if (pathMetadata.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error('SIP state directory must not be a symbolic link');
  }
  const metadata = statSync(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o7777) !== 0o700) {
    throw new Error('SIP state directory must be a private mode-0700 directory');
  }
  if (strictOwnership && (metadata.uid !== expectedUid || metadata.gid !== expectedGid)) {
    throw new Error('SIP state directory must be owned by the exact service identity');
  }
  if (!strictOwnership && metadata.uid !== 0 && metadata.uid !== expectedUid) {
    throw new Error('SIP state directory must be owned by root or the service user');
  }
}

function validateExistingStateFile(
  filePath,
  { expectedUid, expectedGid, strictOwnership },
  { required = false } = {},
) {
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || realpathSync(filePath) !== filePath) {
      throw new Error('SIP state database files must be regular, non-symlink files');
    }
    if ((metadata.mode & 0o7777) !== 0o600) {
      throw new Error('SIP state database files must be private mode-0600 files');
    }
    if (strictOwnership && (metadata.uid !== expectedUid || metadata.gid !== expectedGid)) {
      throw new Error('SIP state database files must be owned by the exact service identity');
    }
    if (!strictOwnership && metadata.uid !== 0 && metadata.uid !== expectedUid) {
      throw new Error('SIP state database files must be private and owned by root or the service user');
    }
  } catch (error) {
    if (error.code !== 'ENOENT' || required) throw error;
  }
}

function databaseRecord(row) {
  if (!row) return null;
  return {
    callId: row.call_id,
    webhookId: row.webhook_id,
    authenticatedPrincipal: row.authenticated_principal,
    decision: row.decision,
    state: row.state,
    rejectStatus: row.reject_status,
    failureCode: row.failure_code,
    closeReason: row.close_reason,
    recoveryReason: row.recovery_reason,
    hangupConfirmed: row.hangup_confirmed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GatewayStateStore {
  #filePath;
  #clock;
  #db = null;
  #healthy = true;
  #reserveCallTransaction = null;
  #expectedUid;
  #expectedGid;
  #strictOwnership;
  #storageGuard;
  #databaseFactory;

  constructor({
    filePath,
    clock = () => Date.now(),
    expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : 0,
    expectedGid = typeof process.getegid === 'function' ? process.getegid() : 0,
    strictOwnership = false,
    storageGuard = null,
    databaseFactory = (filename, options) => new Database(filename, options),
  }) {
    if (!path.isAbsolute(filePath)) throw new TypeError('State database path must be absolute');
    if (strictOwnership && !storageGuard) {
      throw new TypeError('Production SIP state requires a durable-storage guard');
    }
    this.#filePath = filePath;
    this.#clock = clock;
    this.#expectedUid = expectedUid;
    this.#expectedGid = expectedGid;
    this.#strictOwnership = strictOwnership;
    this.#storageGuard = storageGuard ?? Object.freeze({
      assertOpen() {},
      assertNewRecord() {},
      inspect: () => ({ admitted: true }),
    });
    this.#databaseFactory = databaseFactory;
  }

  get healthy() {
    return this.#healthy && this.#db?.open === true;
  }

  get filePath() {
    return this.#filePath;
  }

  get capacityAvailable() {
    try {
      return this.#storageGuard.inspect()?.admitted === true;
    } catch {
      return false;
    }
  }

  async init() {
    if (this.#db) return;
    // Admission must run before mkdir, SQLite, WAL, schema, or any other
    // persistent open. createApp also runs it before the lifetime lock.
    this.#storageGuard.assertOpen();
    const directory = path.dirname(this.#filePath);
    const ownership = {
      expectedUid: this.#expectedUid,
      expectedGid: this.#expectedGid,
      strictOwnership: this.#strictOwnership,
    };
    validateStateDirectory(directory, ownership);
    validateExistingStateFile(this.#filePath, ownership, { required: this.#strictOwnership });
    for (const candidate of [`${this.#filePath}-wal`, `${this.#filePath}-shm`]) {
      validateExistingStateFile(candidate, ownership);
    }

    try {
      // The root-authored initialization marker is re-bound on both sides of
      // the path-only SQLite API open. Holding this private directory and
      // checking the marker again closes direct/replacement starts; the only
      // residual is a same-UID race inside the native open itself.
      this.#storageGuard.assertFileIdentity?.(this.#filePath);
      this.#db = this.#databaseFactory(this.#filePath, {
        timeout: 5_000,
        fileMustExist: this.#strictOwnership,
      });
      this.#storageGuard.assertFileIdentity?.(this.#filePath);
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = FULL');
      this.#db.pragma('foreign_keys = ON');
      this.#db.pragma('busy_timeout = 5000');
      this.#db.pragma('trusted_schema = OFF');
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_events (
          webhook_id TEXT PRIMARY KEY,
          event_id TEXT,
          event_type TEXT,
          call_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('verified', 'processing', 'completed')),
          outcome TEXT,
          verified_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        ) STRICT;

        CREATE TABLE IF NOT EXISTS calls (
          call_id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          authenticated_principal TEXT,
          decision TEXT NOT NULL,
          state TEXT NOT NULL,
          reject_status INTEGER,
          failure_code TEXT,
          close_reason TEXT,
          recovery_reason TEXT,
          hangup_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (hangup_confirmed IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (webhook_id) REFERENCES webhook_events(webhook_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS calls_state_index ON calls(state);
        CREATE INDEX IF NOT EXISTS webhook_events_call_index ON webhook_events(call_id);
      `);
      chmodSync(this.#filePath, 0o600);
      this.#hardenSidecarFiles();
      for (const candidate of [this.#filePath, `${this.#filePath}-wal`, `${this.#filePath}-shm`]) {
        validateExistingStateFile(candidate, ownership);
      }
      this.#reserveCallTransaction = this.#db.transaction((parameters) => (
        this.#reserveCall(parameters)
      ));
    } catch (error) {
      this.#healthy = false;
      this.#db?.close();
      this.#db = null;
      throw error;
    }
  }

  recordVerifiedWebhook(webhookId, metadata = {}) {
    return this.#run(() => {
      const id = safeWebhookId(webhookId);
      const eventId = safeOptionalIdentifier(metadata.eventId, 256);
      const eventType = safeOptionalIdentifier(metadata.eventType, 128);
      const callId = safeOptionalIdentifier(metadata.callId, 256);
      const existing = this.#db.prepare(
        'SELECT * FROM webhook_events WHERE webhook_id = ?',
      ).get(id);
      if (existing) {
        if (
          existing.event_id !== eventId
          || existing.event_type !== eventType
          || existing.call_id !== callId
        ) {
          throw new TypeError('webhook-id was reused with different verified metadata');
        }
        return {
          inserted: false,
          duplicate: existing.state === 'completed',
          record: this.#webhookRecord(existing),
        };
      }

      this.#storageGuard.assertNewRecord();
      const now = this.#clock();
      this.#db.prepare(`
        INSERT INTO webhook_events (
          webhook_id, event_id, event_type, call_id, state, verified_at, updated_at
        ) VALUES (?, ?, ?, ?, 'verified', ?, ?)
      `).run(id, eventId, eventType, callId, now, now);
      return {
        inserted: true,
        duplicate: false,
        record: this.getWebhook(id),
      };
    });
  }

  reserveCall(parameters) {
    return this.#run(() => this.#reserveCallTransaction({
      ...parameters,
      webhookId: safeWebhookId(parameters.webhookId),
    }));
  }

  #reserveCall(parameters) {
    const {
      webhookId,
      callId,
      authenticatedPrincipal = null,
      decision,
      reason,
      statusCode = null,
      maxActiveCalls,
    } = parameters;
    const webhook = this.#db.prepare(
      'SELECT state FROM webhook_events WHERE webhook_id = ?',
    ).get(webhookId);
    if (!webhook) throw new Error('Verified webhook record is required before call reservation');
    const existing = this.#db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
    const now = this.#clock();
    this.#db.prepare(`
      UPDATE webhook_events
      SET state = CASE WHEN state = 'completed' THEN state ELSE 'processing' END,
          updated_at = ?
      WHERE webhook_id = ?
    `).run(now, webhookId);
    if (existing) {
      return { inserted: false, record: databaseRecord(existing) };
    }

    let durableDecision = reason;
    let state;
    let durableStatus = statusCode;
    if (decision === 'accept') {
      const count = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM calls WHERE state IN (${ACTIVE_STATE_SQL})
      `).get(...ACTIVE_CALL_STATES).count;
      if (count >= maxActiveCalls) {
        durableDecision = 'capacity_reached';
        state = 'reject_intent';
        durableStatus = 486;
      } else {
        state = 'accept_intent';
      }
    } else if (decision === 'reject') {
      state = 'reject_intent';
    } else {
      throw new TypeError('Call decision must be accept or reject');
    }

    // This assertion is inside the transaction and immediately precedes the
    // first new call identity. Throwing rolls back the webhook state update;
    // existing-call retries and later recovery updates do not pass this gate.
    this.#storageGuard.assertNewRecord();
    this.#db.prepare(`
      INSERT INTO calls (
        call_id, webhook_id, authenticated_principal, decision, state,
        reject_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      callId,
      webhookId,
      authenticatedPrincipal,
      durableDecision,
      state,
      durableStatus,
      now,
      now,
    );
    return {
      inserted: true,
      record: this.getCall(callId),
    };
  }

  updateCall(callId, state, fields = {}) {
    return this.#run(() => {
      const existing = this.#db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
      if (!existing) throw new Error(`Unknown durable SIP call ${callId}`);
      const next = {
        rejectStatus: Object.hasOwn(fields, 'rejectStatus')
          ? fields.rejectStatus
          : existing.reject_status,
        failureCode: Object.hasOwn(fields, 'failureCode')
          ? fields.failureCode
          : existing.failure_code,
        closeReason: Object.hasOwn(fields, 'closeReason')
          ? fields.closeReason
          : existing.close_reason,
        recoveryReason: Object.hasOwn(fields, 'recoveryReason')
          ? fields.recoveryReason
          : existing.recovery_reason,
        hangupConfirmed: fields.hangupConfirmed === undefined
          ? existing.hangup_confirmed
          : Number(Boolean(fields.hangupConfirmed)),
      };
      this.#db.prepare(`
        UPDATE calls
        SET state = ?, reject_status = ?, failure_code = ?, close_reason = ?,
            recovery_reason = ?, hangup_confirmed = ?, updated_at = ?
        WHERE call_id = ?
      `).run(
        state,
        next.rejectStatus,
        next.failureCode,
        next.closeReason,
        next.recoveryReason,
        next.hangupConfirmed,
        this.#clock(),
        callId,
      );
      return this.getCall(callId);
    });
  }

  completeWebhook(webhookId, outcome) {
    return this.#run(() => {
      const id = safeWebhookId(webhookId);
      const normalizedOutcome = safeOutcome(outcome);
      const now = this.#clock();
      const result = this.#db.prepare(`
        UPDATE webhook_events
        SET state = 'completed', outcome = ?, completed_at = ?, updated_at = ?
        WHERE webhook_id = ?
      `).run(normalizedOutcome, now, now, id);
      if (result.changes !== 1) throw new Error('Cannot complete an unknown webhook');
      return this.getWebhook(id);
    });
  }

  getWebhook(webhookId) {
    return this.#run(() => this.#webhookRecord(
      this.#db.prepare('SELECT * FROM webhook_events WHERE webhook_id = ?').get(webhookId),
    ));
  }

  #webhookRecord(row) {
    if (!row) return null;
    return {
      id: row.webhook_id,
      eventId: row.event_id,
      eventType: row.event_type,
      callId: row.call_id,
      state: row.state,
      outcome: row.outcome,
      verifiedAt: row.verified_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  getCall(callId) {
    return this.#run(() => databaseRecord(
      this.#db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId),
    ));
  }

  activeRecords() {
    return this.#run(() => this.#db.prepare(`
      SELECT * FROM calls WHERE state IN (${ACTIVE_STATE_SQL}) ORDER BY created_at ASC
    `).all(...ACTIVE_CALL_STATES).map(databaseRecord));
  }

  summary() {
    return this.#run(() => {
      const rows = this.#db.prepare(
        'SELECT state, COUNT(*) AS count FROM calls GROUP BY state',
      ).all();
      const states = Object.fromEntries(rows.map((row) => [row.state, row.count]));
      const active = ACTIVE_CALL_STATES.reduce((total, state) => total + (states[state] ?? 0), 0);
      const tracked = rows.reduce((total, row) => total + row.count, 0);
      return { active, tracked, states };
    });
  }

  durability() {
    return this.#run(() => ({
      journalMode: this.#db.pragma('journal_mode', { simple: true }),
      synchronous: this.#db.pragma('synchronous', { simple: true }),
    }));
  }

  async close() {
    if (!this.#db) return;
    const database = this.#db;
    try {
      database.pragma('wal_checkpoint(TRUNCATE)');
      this.#hardenSidecarFiles();
    } finally {
      if (database.open) database.close();
      this.#db = null;
    }
  }

  #hardenSidecarFiles() {
    for (const filePath of [this.#filePath, `${this.#filePath}-wal`, `${this.#filePath}-shm`]) {
      try {
        const metadata = lstatSync(filePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          const error = new Error('SIP state database path changed to an unsafe file type');
          error.code = 'EACCES';
          throw error;
        }
        chmodSync(filePath, 0o600);
        validateExistingStateFile(filePath, {
          expectedUid: this.#expectedUid,
          expectedGid: this.#expectedGid,
          strictOwnership: this.#strictOwnership,
        });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  #run(operation) {
    if (!this.#db) throw new Error('SIP gateway state store is not initialized');
    try {
      const result = operation();
      this.#hardenSidecarFiles();
      return result;
    } catch (error) {
      if (typeof error?.code === 'string' && (
        error.code.startsWith('SQLITE_')
        || ['EACCES', 'EIO', 'ENOSPC', 'EROFS'].includes(error.code)
      )) {
        this.#healthy = false;
      }
      throw error;
    }
  }
}

export const activeCallStates = ACTIVE_CALL_STATES;
