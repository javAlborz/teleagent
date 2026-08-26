'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const TERMINAL_STATES = new Set(['completed', 'failed_pre_delivery', 'outcome_unknown']);
const ACTIVE_STATES = new Set(['prepared', 'commit_claimed', 'delivery_started']);
const PROVIDER_USERS = Object.freeze({
  claude: 'teleagent-claude-worker',
  codex: 'teleagent-codex-worker',
});

class WorkerSessionOperationStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerSessionOperationStoreError';
    this.code = code;
  }
}

function storeError(code, message) {
  throw new WorkerSessionOperationStoreError(code, message);
}

function bounded(value, name, max = 512) {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\u0000-\u001F\u007F]/.test(text)) {
    storeError('WORKER_SESSION_REQUEST_INVALID', `${name} is invalid.`);
  }
  return text;
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function secureStateDirectory(dbPath, expectedUid) {
  const directory = path.dirname(path.resolve(dbPath));
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid ||
      (stat.mode & 0o077) !== 0) {
    storeError(
      'WORKER_SESSION_STORAGE_UNSAFE',
      'Worker session state must use a worker-owned mode-0700 directory.'
    );
  }
  if (fs.existsSync(dbPath)) {
    const file = fs.lstatSync(dbPath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== expectedUid ||
        (file.mode & 0o077) !== 0) {
      storeError('WORKER_SESSION_STORAGE_UNSAFE', 'Worker session database permissions are unsafe.');
    }
  }
}

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function requestHash(request) {
  return crypto.createHash('sha256').update(stableJson({
    operationId: String(request.operationId || ''),
    target: String(request.target || ''),
    message: String(request.message || ''),
    sessionFingerprint: String(request.sessionFingerprint || ''),
    timeoutMs: Number.parseInt(request.timeoutMs, 10) || 0,
  })).digest('hex');
}

class WorkerSessionOperationStore {
  constructor({
    dbPath = ':memory:',
    expectedUid = typeof process.getuid === 'function' ? process.getuid() : 0,
    strictOwnership = dbPath !== ':memory:',
    now = () => new Date(),
  } = {}) {
    if (strictOwnership && dbPath !== ':memory:') secureStateDirectory(dbPath, expectedUid);
    this.now = now;
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      fs.chmodSync(dbPath, 0o600);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_session_operations (
        operation_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        target TEXT NOT NULL,
        stable_target TEXT NOT NULL,
        session_fingerprint TEXT NOT NULL,
        provider TEXT NOT NULL,
        operation_marker TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'commit_claimed', 'delivery_started', 'completed',
          'failed_pre_delivery', 'outcome_unknown'
        )),
        revision INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS worker_session_operation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL REFERENCES worker_session_operations(operation_id),
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS worker_session_events_no_update
      BEFORE UPDATE ON worker_session_operation_events BEGIN
        SELECT RAISE(ABORT, 'worker session events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS worker_session_events_no_delete
      BEFORE DELETE ON worker_session_operation_events BEGIN
        SELECT RAISE(ABORT, 'worker session events are append-only');
      END;

      CREATE TABLE IF NOT EXISTS worker_session_pane_attestations (
        creation_id TEXT PRIMARY KEY,
        pane_id TEXT UNIQUE,
        session_name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        provider_user TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        launcher_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'retired')),
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        retired_at TEXT
      );

      CREATE TABLE IF NOT EXISTS worker_session_pane_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        creation_id TEXT NOT NULL REFERENCES worker_session_pane_attestations(creation_id),
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS worker_session_pane_events_no_update
      BEFORE UPDATE ON worker_session_pane_events BEGIN
        SELECT RAISE(ABORT, 'worker session pane events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS worker_session_pane_events_no_delete
      BEFORE DELETE ON worker_session_pane_events BEGIN
        SELECT RAISE(ABORT, 'worker session pane events are append-only');
      END;

      CREATE TABLE IF NOT EXISTS worker_session_control (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        panic_locked INTEGER NOT NULL CHECK (panic_locked IN (0, 1)),
        reason TEXT,
        source TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS worker_session_control_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS worker_session_control_events_no_update
      BEFORE UPDATE ON worker_session_control_events BEGIN
        SELECT RAISE(ABORT, 'worker session control events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS worker_session_control_events_no_delete
      BEFORE DELETE ON worker_session_control_events BEGIN
        SELECT RAISE(ABORT, 'worker session control events are append-only');
      END;
    `);
    const initializedAt = this._now();
    this.db.prepare(`
      INSERT OR IGNORE INTO worker_session_control (
        singleton, panic_locked, reason, source, updated_at
      ) VALUES (1, 0, NULL, NULL, ?)
    `).run(initializedAt);
  }

  _now() {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new Error('Worker session store clock is invalid.');
    }
    return date.toISOString();
  }

  _assertPanicUnlocked() {
    const row = this.db.prepare(
      'SELECT panic_locked FROM worker_session_control WHERE singleton = 1'
    ).get();
    if (!row || row.panic_locked !== 0) {
      storeError('WORKER_SESSION_PANIC_LOCKED', 'Worker mutation is locked by panic.');
    }
  }

  close() {
    if (this.db.open) this.db.close();
  }

  panicStatus() {
    const row = this.db.prepare(
      'SELECT panic_locked, reason, source, updated_at FROM worker_session_control WHERE singleton = 1'
    ).get();
    if (!row) storeError('WORKER_SESSION_CONTROL_UNAVAILABLE', 'Worker panic state is unavailable.');
    const active = this.db.prepare(`
      SELECT operation_id FROM worker_session_operations
      WHERE state IN ('prepared', 'commit_claimed', 'delivery_started')
      ORDER BY operation_id
    `).all().map((entry) => entry.operation_id);
    return {
      locked: row.panic_locked === 1,
      reason: row.reason,
      source: row.source,
      updatedAt: row.updated_at,
      activeOperationIds: active,
      activeOperationCount: active.length,
    };
  }

  panic({ reason = 'worker_session_panic', source = 'controller' } = {}) {
    const timestamp = this._now();
    const safeReason = String(reason || 'worker_session_panic').slice(0, 160);
    const safeSource = String(source || 'controller').slice(0, 80);
    const transaction = this.db.transaction(() => {
      const before = this.db.prepare(
        'SELECT panic_locked FROM worker_session_control WHERE singleton = 1'
      ).get();
      const active = this.db.prepare(`
        SELECT * FROM worker_session_operations
        WHERE state IN ('prepared', 'commit_claimed', 'delivery_started')
        ORDER BY operation_id
      `).all();
      this.db.prepare(`
        UPDATE worker_session_control
        SET panic_locked = 1, reason = ?, source = ?, updated_at = ?
        WHERE singleton = 1
      `).run(safeReason, safeSource, timestamp);
      for (const row of active) {
        const state = row.state === 'delivery_started' ? 'outcome_unknown' : 'failed_pre_delivery';
        const code = row.state === 'delivery_started'
          ? 'TARGET_DELIVERY_OUTCOME_UNKNOWN'
          : 'WORKER_SESSION_PANIC_CANCELED';
        this.db.prepare(`
          UPDATE worker_session_operations
          SET state = ?, revision = revision + 1, error_code = ?, error_message = ?,
              completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND revision = ?
        `).run(
          state, code,
          row.state === 'delivery_started'
            ? 'Panic interrupted work after the delivery boundary; outcome is unknown.'
            : 'Panic canceled work before the delivery boundary.',
          timestamp, timestamp, row.operation_id, row.revision
        );
        this._event(row.operation_id, 'panic_fenced', {
          previousState: row.state,
          terminalState: state,
        }, timestamp);
      }
      this.db.prepare(`
        INSERT INTO worker_session_control_events (event_type, details_json, created_at)
        VALUES ('panic_locked', ?, ?)
      `).run(stableJson({
        reason: safeReason,
        source: safeSource,
        reasserted: before?.panic_locked === 1,
        activeOperationIds: active.map((row) => row.operation_id),
      }), timestamp);
      return {
        accepted: true,
        persisted: true,
        alreadyLocked: before?.panic_locked === 1,
        activeOperationIds: active.map((row) => row.operation_id),
      };
    });
    return transaction.immediate();
  }

  unlockPanic() {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const status = this.panicStatus();
      if (status.activeOperationCount !== 0) {
        storeError('WORKER_SESSION_NOT_QUIESCENT', 'Worker operations remain active.');
      }
      this.db.prepare(`
        UPDATE worker_session_control
        SET panic_locked = 0, reason = NULL, source = NULL, updated_at = ?
        WHERE singleton = 1
      `).run(timestamp);
      this.db.prepare(`
        INSERT INTO worker_session_control_events (event_type, details_json, created_at)
        VALUES ('panic_unlocked', '{}', ?)
      `).run(timestamp);
      return { success: true, persisted: true, quiesced: true, wasLocked: status.locked };
    });
    return transaction.immediate();
  }

  _event(operationId, eventType, details, timestamp) {
    this.db.prepare(`
      INSERT INTO worker_session_operation_events (
        operation_id, event_type, details_json, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(operationId, eventType, stableJson(details || {}), timestamp);
  }

  _normalize(row) {
    if (!row) return null;
    return {
      operationId: row.operation_id,
      requestHash: row.request_hash,
      target: row.target,
      stableTarget: row.stable_target,
      sessionFingerprint: row.session_fingerprint,
      provider: row.provider,
      operationMarker: row.operation_marker,
      state: row.state,
      terminal: TERMINAL_STATES.has(row.state),
      active: ACTIVE_STATES.has(row.state),
      revision: row.revision,
      result: parseJson(row.result_json, null),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  _normalizePane(row) {
    if (!row) return null;
    return {
      creationId: row.creation_id,
      paneId: row.pane_id,
      sessionName: row.session_name,
      provider: row.provider,
      providerUser: row.provider_user,
      providerSessionId: row.provider_session_id,
      workspace: row.workspace,
      launcherPath: row.launcher_path,
      state: row.state,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      retiredAt: row.retired_at,
    };
  }

  _paneEvent(creationId, eventType, details, timestamp) {
    this.db.prepare(`
      INSERT INTO worker_session_pane_events (
        creation_id, event_type, details_json, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(creationId, eventType, stableJson(details || {}), timestamp);
  }

  planPaneAttestation(input = {}) {
    const normalized = {
      creationId: bounded(input.creationId, 'creationId', 160),
      sessionName: bounded(input.sessionName, 'sessionName', 100),
      provider: bounded(input.provider, 'provider', 16),
      providerUser: bounded(input.providerUser, 'providerUser', 64),
      providerSessionId: bounded(input.providerSessionId, 'providerSessionId', 64),
      workspace: bounded(input.workspace, 'workspace', 1024),
      launcherPath: bounded(input.launcherPath, 'launcherPath', 256),
    };
    if (!/^session_[A-Za-z0-9]{16,128}$/.test(normalized.creationId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(normalized.sessionName) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(normalized.providerSessionId) ||
        PROVIDER_USERS[normalized.provider] !== normalized.providerUser ||
        !path.isAbsolute(normalized.workspace) || path.normalize(normalized.workspace) !== normalized.workspace ||
        !path.isAbsolute(normalized.launcherPath) || path.normalize(normalized.launcherPath) !== normalized.launcherPath) {
      storeError('WORKER_SESSION_ATTESTATION_INVALID', 'The exact provider pane plan is invalid.');
    }
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      this._assertPanicUnlocked();
      const existing = this.db.prepare(
        'SELECT * FROM worker_session_pane_attestations WHERE creation_id = ?'
      ).get(normalized.creationId);
      if (existing) {
        if (existing.session_name !== normalized.sessionName ||
            existing.provider !== normalized.provider ||
            existing.provider_user !== normalized.providerUser ||
            existing.provider_session_id !== normalized.providerSessionId ||
            existing.workspace !== normalized.workspace ||
            existing.launcher_path !== normalized.launcherPath) {
          storeError(
            'WORKER_SESSION_ATTESTATION_CONFLICT',
            'The creation ID is already bound to a different provider pane plan.'
          );
        }
        return { created: false, row: existing };
      }
      this.db.prepare(`
        INSERT INTO worker_session_pane_attestations (
          creation_id, session_name, provider, provider_user, provider_session_id,
          workspace, launcher_path, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
      `).run(
        normalized.creationId, normalized.sessionName, normalized.provider,
        normalized.providerUser, normalized.providerSessionId, normalized.workspace,
        normalized.launcherPath, timestamp, timestamp
      );
      this._paneEvent(normalized.creationId, 'pane_planned', {
        provider: normalized.provider,
        providerSessionId: normalized.providerSessionId,
        sessionName: normalized.sessionName,
      }, timestamp);
      return {
        created: true,
        row: this.db.prepare(
          'SELECT * FROM worker_session_pane_attestations WHERE creation_id = ?'
        ).get(normalized.creationId),
      };
    });
    const result = transaction.immediate();
    return { created: result.created, attestation: this._normalizePane(result.row) };
  }

  activatePaneAttestation(creationId, paneId) {
    const normalizedCreationId = bounded(creationId, 'creationId', 160);
    const normalizedPaneId = bounded(paneId, 'paneId', 32);
    if (!/^%[1-9][0-9]*$/.test(normalizedPaneId)) {
      storeError('WORKER_SESSION_ATTESTATION_INVALID', 'The stable tmux pane ID is invalid.');
    }
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      this._assertPanicUnlocked();
      const row = this.db.prepare(
        'SELECT * FROM worker_session_pane_attestations WHERE creation_id = ?'
      ).get(normalizedCreationId);
      if (!row) storeError('WORKER_SESSION_ATTESTATION_NOT_FOUND', 'The pane plan was not found.');
      if (row.state === 'active' && row.pane_id === normalizedPaneId) return row;
      if (row.state !== 'planned' || row.pane_id) {
        storeError('WORKER_SESSION_ATTESTATION_CAS_FAILED', 'The pane plan cannot be activated.');
      }
      const update = this.db.prepare(`
        UPDATE worker_session_pane_attestations
        SET pane_id = ?, state = 'active', revision = revision + 1, updated_at = ?
        WHERE creation_id = ? AND state = 'planned' AND pane_id IS NULL AND revision = ?
      `).run(normalizedPaneId, timestamp, normalizedCreationId, row.revision);
      if (update.changes !== 1) {
        storeError('WORKER_SESSION_ATTESTATION_CAS_FAILED', 'The pane plan changed during activation.');
      }
      this._paneEvent(normalizedCreationId, 'pane_activated', { paneId: normalizedPaneId }, timestamp);
      return this.db.prepare(
        'SELECT * FROM worker_session_pane_attestations WHERE creation_id = ?'
      ).get(normalizedCreationId);
    });
    return this._normalizePane(transaction.immediate());
  }

  getPaneAttestationByCreationId(creationId) {
    return this._normalizePane(this.db.prepare(
      'SELECT * FROM worker_session_pane_attestations WHERE creation_id = ?'
    ).get(String(creationId || '')) || null);
  }

  getPaneAttestationByPaneId(paneId) {
    return this._normalizePane(this.db.prepare(
      'SELECT * FROM worker_session_pane_attestations WHERE pane_id = ? AND state = \'active\''
    ).get(String(paneId || '')) || null);
  }

  listPaneAttestations({ state = 'active' } = {}) {
    const safeState = String(state || '').trim();
    if (!['planned', 'active', 'retired'].includes(safeState)) {
      storeError('WORKER_SESSION_ATTESTATION_INVALID', 'The pane state is invalid.');
    }
    return this.db.prepare(
      'SELECT * FROM worker_session_pane_attestations WHERE state = ? ORDER BY creation_id'
    ).all(safeState).map((row) => this._normalizePane(row));
  }

  retirePaneAttestation(creationId, reason = 'pane_absent') {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM worker_session_pane_attestations WHERE creation_id = ?'
      ).get(bounded(creationId, 'creationId', 160));
      if (!row || row.state === 'retired') return row || null;
      this.db.prepare(`
        UPDATE worker_session_pane_attestations
        SET state = 'retired', revision = revision + 1, retired_at = ?, updated_at = ?
        WHERE creation_id = ? AND revision = ?
      `).run(timestamp, timestamp, row.creation_id, row.revision);
      this._paneEvent(row.creation_id, 'pane_retired', {
        reason: String(reason || 'pane_absent').slice(0, 100),
      }, timestamp);
      return this.db.prepare(
        'SELECT * FROM worker_session_pane_attestations WHERE creation_id = ?'
      ).get(row.creation_id);
    });
    return this._normalizePane(transaction.immediate());
  }

  get(operationId) {
    return this._normalize(this.db.prepare(
      'SELECT * FROM worker_session_operations WHERE operation_id = ?'
    ).get(String(operationId || '')) || null);
  }

  listEvents(operationId) {
    return this.db.prepare(`
      SELECT sequence, operation_id, event_type, details_json, created_at
      FROM worker_session_operation_events
      WHERE operation_id = ? ORDER BY sequence
    `).all(String(operationId || '')).map((row) => ({
      sequence: row.sequence,
      operationId: row.operation_id,
      eventType: row.event_type,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }

  _assertIdentity(row, input) {
    if (row.request_hash !== input.requestHash || row.target !== input.target ||
        row.stable_target !== input.stableTarget ||
        row.session_fingerprint !== input.sessionFingerprint ||
        row.provider !== input.provider || row.operation_marker !== input.operationMarker) {
      storeError(
        'WORKER_SESSION_IDEMPOTENCY_CONFLICT',
        'The operation ID is already bound to a different exact session request.'
      );
    }
  }

  prepare(input = {}) {
    const normalized = {
      operationId: bounded(input.operationId, 'operationId', 200),
      requestHash: bounded(input.requestHash, 'requestHash', 64),
      target: bounded(input.target, 'target'),
      stableTarget: bounded(input.stableTarget, 'stableTarget'),
      sessionFingerprint: bounded(input.sessionFingerprint, 'sessionFingerprint', 128),
      provider: bounded(input.provider, 'provider', 32),
      operationMarker: bounded(input.operationMarker, 'operationMarker', 512),
    };
    if (!/^[a-f0-9]{64}$/.test(normalized.requestHash)) {
      storeError('WORKER_SESSION_REQUEST_INVALID', 'requestHash must be one lowercase SHA-256 digest.');
    }
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      this._assertPanicUnlocked();
      const existing = this.db.prepare(
        'SELECT * FROM worker_session_operations WHERE operation_id = ?'
      ).get(normalized.operationId);
      if (existing) {
        this._assertIdentity(existing, normalized);
        return { created: false, row: existing };
      }
      this.db.prepare(`
        INSERT INTO worker_session_operations (
          operation_id, request_hash, target, stable_target, session_fingerprint,
          provider, operation_marker, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
      `).run(
        normalized.operationId, normalized.requestHash, normalized.target,
        normalized.stableTarget, normalized.sessionFingerprint, normalized.provider,
        normalized.operationMarker, timestamp, timestamp
      );
      this._event(normalized.operationId, 'prepared', {
        stableTarget: normalized.stableTarget,
        provider: normalized.provider,
        requestHash: normalized.requestHash,
      }, timestamp);
      return {
        created: true,
        row: this.db.prepare(
          'SELECT * FROM worker_session_operations WHERE operation_id = ?'
        ).get(normalized.operationId),
      };
    });
    const result = transaction.immediate();
    return { created: result.created, operation: this._normalize(result.row) };
  }

  claimCommit(operationId, expectedRequestHash) {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      this._assertPanicUnlocked();
      const row = this.db.prepare(
        'SELECT * FROM worker_session_operations WHERE operation_id = ?'
      ).get(bounded(operationId, 'operationId', 200));
      if (!row) storeError('WORKER_SESSION_OPERATION_NOT_FOUND', 'The prepared operation was not found.');
      if (row.request_hash !== expectedRequestHash) {
        storeError('WORKER_SESSION_IDEMPOTENCY_CONFLICT', 'The exact session request changed.');
      }
      if (row.state !== 'prepared') return { claimed: false, row };
      this.db.prepare(`
        UPDATE worker_session_operations
        SET state = 'commit_claimed', revision = revision + 1, updated_at = ?
        WHERE operation_id = ? AND state = 'prepared' AND revision = ?
      `).run(timestamp, row.operation_id, row.revision);
      this._event(row.operation_id, 'commit_claimed', {}, timestamp);
      return {
        claimed: true,
        row: this.db.prepare(
          'SELECT * FROM worker_session_operations WHERE operation_id = ?'
        ).get(row.operation_id),
      };
    });
    const result = transaction.immediate();
    return { claimed: result.claimed, operation: this._normalize(result.row) };
  }

  markDeliveryStarted(operationId, expectedRequestHash) {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM worker_session_operations WHERE operation_id = ?'
      ).get(operationId);
      if (!row || row.request_hash !== expectedRequestHash || row.state !== 'commit_claimed') {
        storeError('WORKER_SESSION_DELIVERY_CAS_FAILED', 'The worker delivery boundary changed.');
      }
      this.db.prepare(`
        UPDATE worker_session_operations
        SET state = 'delivery_started', revision = revision + 1, updated_at = ?
        WHERE operation_id = ? AND revision = ?
      `).run(timestamp, operationId, row.revision);
      this._event(operationId, 'delivery_started', {
        operationMarker: row.operation_marker,
      }, timestamp);
      return this.get(operationId);
    });
    return transaction.immediate();
  }

  _finish(operationId, state, { result = null, errorCode = null, errorMessage = null } = {}) {
    const timestamp = this._now();
    const serializedResult = result === null ? null : stableJson(result);
    if (serializedResult && Buffer.byteLength(serializedResult) > 128 * 1024) {
      storeError('WORKER_SESSION_RESULT_TOO_LARGE', 'The worker session result is too large.');
    }
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM worker_session_operations WHERE operation_id = ?'
      ).get(operationId);
      if (!row) storeError('WORKER_SESSION_OPERATION_NOT_FOUND', 'The operation was not found.');
      if (row.state === 'completed') return row;
      if (TERMINAL_STATES.has(row.state)) return row;
      this.db.prepare(`
        UPDATE worker_session_operations
        SET state = ?, revision = revision + 1, result_json = ?, error_code = ?,
            error_message = ?, completed_at = ?, updated_at = ?
        WHERE operation_id = ? AND revision = ?
      `).run(
        state, serializedResult, errorCode ? String(errorCode).slice(0, 100) : null,
        errorMessage ? String(errorMessage).slice(0, 2000) : null,
        timestamp, timestamp, operationId, row.revision
      );
      this._event(operationId, state, { errorCode: errorCode || null }, timestamp);
      return this.db.prepare(
        'SELECT * FROM worker_session_operations WHERE operation_id = ?'
      ).get(operationId);
    });
    return this._normalize(transaction.immediate());
  }

  complete(operationId, result) {
    return this._finish(operationId, 'completed', { result });
  }

  completeReconciled(operationId, result, {
    operationMarker,
    sessionFingerprint,
  } = {}) {
    const timestamp = this._now();
    const serializedResult = stableJson(result);
    if (Buffer.byteLength(serializedResult) > 128 * 1024) {
      storeError('WORKER_SESSION_RESULT_TOO_LARGE', 'The worker session result is too large.');
    }
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM worker_session_operations WHERE operation_id = ?'
      ).get(bounded(operationId, 'operationId', 200));
      if (!row) storeError('WORKER_SESSION_OPERATION_NOT_FOUND', 'The operation was not found.');
      if (row.state === 'completed') return row;
      if (!['delivery_started', 'outcome_unknown'].includes(row.state)) {
        storeError(
          'WORKER_SESSION_RECONCILIATION_CAS_FAILED',
          'Only a delivery-bound operation can be completed by reconciliation.'
        );
      }
      if (row.operation_marker !== operationMarker ||
          row.session_fingerprint !== sessionFingerprint ||
          result?.delivered !== true || result?.response_verified !== true) {
        storeError(
          'WORKER_SESSION_RECONCILIATION_EVIDENCE_INVALID',
          'Exact marker, session, delivery, and final-response evidence is required.'
        );
      }
      const update = this.db.prepare(`
        UPDATE worker_session_operations
        SET state = 'completed', revision = revision + 1, result_json = ?,
            error_code = NULL, error_message = NULL, completed_at = ?, updated_at = ?
        WHERE operation_id = ? AND revision = ?
          AND state IN ('delivery_started', 'outcome_unknown')
      `).run(serializedResult, timestamp, timestamp, row.operation_id, row.revision);
      if (update.changes !== 1) {
        storeError('WORKER_SESSION_RECONCILIATION_CAS_FAILED', 'The operation changed during reconciliation.');
      }
      this._event(row.operation_id, 'completed_by_exact_reconciliation', {
        operationMarker: row.operation_marker,
        sessionFingerprint: row.session_fingerprint,
      }, timestamp);
      return this.db.prepare(
        'SELECT * FROM worker_session_operations WHERE operation_id = ?'
      ).get(row.operation_id);
    });
    return this._normalize(transaction.immediate());
  }

  failPreDelivery(operationId, error) {
    return this._finish(operationId, 'failed_pre_delivery', {
      errorCode: error?.code || 'WORKER_SESSION_PRE_DELIVERY_FAILED',
      errorMessage: error?.message || 'The session delivery failed before its durable boundary.',
    });
  }

  outcomeUnknown(operationId, error) {
    return this._finish(operationId, 'outcome_unknown', {
      errorCode: error?.code || 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
      errorMessage: error?.message || 'The exact worker-owned session delivery outcome is unknown.',
    });
  }

  recoverInterrupted() {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const claimed = this.db.prepare(`
        SELECT * FROM worker_session_operations WHERE state = 'commit_claimed'
      `).all();
      for (const row of claimed) {
        this.db.prepare(`
          UPDATE worker_session_operations
          SET state = 'prepared', revision = revision + 1, updated_at = ?
          WHERE operation_id = ? AND revision = ?
        `).run(timestamp, row.operation_id, row.revision);
        this._event(row.operation_id, 'commit_claim_recovered_pre_delivery', {}, timestamp);
      }
      const started = this.db.prepare(`
        SELECT * FROM worker_session_operations WHERE state = 'delivery_started'
      `).all();
      for (const row of started) {
        // A durable delivery boundary means the message must never be resent,
        // but it does not mean the provider has stopped. Keep the operation in
        // its reconciliation state so the exact marker/final response can be
        // adopted after restart.
        this.db.prepare(`
          UPDATE worker_session_operations
          SET revision = revision + 1, updated_at = ?
          WHERE operation_id = ? AND revision = ?
        `).run(timestamp, row.operation_id, row.revision);
        this._event(row.operation_id, 'delivery_reconciliation_required', {
          resent: false,
        }, timestamp);
      }
      return { recoveredPreDelivery: claimed.length, reconciliationRequired: started.length };
    });
    return transaction.immediate();
  }
}

module.exports = {
  WorkerSessionOperationStore,
  WorkerSessionOperationStoreError,
  requestHash,
  secureStateDirectory,
};
