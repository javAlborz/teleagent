'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const TASK_STATES = Object.freeze([
  'queued',
  'running',
  'cancel_requested',
  'completed',
  'failed',
  'canceled',
]);
const ACTIVE_TASK_STATES = Object.freeze(['queued', 'running', 'cancel_requested']);
const LEASED_TASK_STATES = Object.freeze(['running', 'cancel_requested']);
const TERMINAL_TASK_STATES = Object.freeze(['completed', 'failed', 'canceled']);

class ExecutorTaskStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExecutorTaskStoreError';
    this.code = code;
    this.details = details;
  }
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableValue(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Task data must contain finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Task data must not contain circular references');
    seen.add(value);
    const result = value.map((entry) => stableValue(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Task data must not contain circular references');
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = stableValue(value[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Task data cannot contain ${typeof value} values`);
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeBoundedString(value, field, { max = 200, required = true } = {}) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) {
    throw new ExecutorTaskStoreError('INVALID_ARGUMENT', `${field} is required`, { field });
  }
  if (normalized.length > max || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new ExecutorTaskStoreError(
      'INVALID_ARGUMENT',
      `${field} must be at most ${max} characters and contain no control characters`,
      { field }
    );
  }
  return normalized || null;
}

function normalizeLeaseMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(resolved) || resolved < 1000 || resolved > 24 * 60 * 60 * 1000) {
    throw new ExecutorTaskStoreError(
      'INVALID_LEASE',
      'leaseMs must be between 1 second and 24 hours'
    );
  }
  return resolved;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('ExecutorTaskStore clock returned an invalid date');
  }
  return date;
}

function addMilliseconds(isoTimestamp, milliseconds) {
  return new Date(Date.parse(isoTimestamp) + milliseconds).toISOString();
}

function hashLeaseToken(token) {
  return sha256(String(token || ''));
}

function leaseMatches(storedHash, token) {
  if (!storedHash || !token) return false;
  const candidate = hashLeaseToken(token);
  const stored = Buffer.from(storedHash, 'hex');
  const provided = Buffer.from(candidate, 'hex');
  return stored.length === provided.length && crypto.timingSafeEqual(stored, provided);
}

function serializeNullable(value) {
  if (value === undefined || value === null) return null;
  return stableJson(value);
}

function isTerminal(state) {
  return TERMINAL_TASK_STATES.includes(state);
}

class ExecutorTaskStore {
  constructor({
    dbPath = ':memory:',
    now = () => new Date(),
    defaultLeaseMs = 30000,
    busyTimeoutMs = 5000,
  } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    this.defaultLeaseMs = normalizeLeaseMs(defaultLeaseMs, 30000);
    this.busyTimeoutMs = Math.max(1, Number.parseInt(busyTimeoutMs, 10) || 5000);

    if (dbPath !== ':memory:') {
      const stateDirectory = path.dirname(dbPath);
      fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      fs.chmodSync(stateDirectory, 0o700);
    }

    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
    }

    this._migrate();
    if (dbPath !== ':memory:') fs.chmodSync(dbPath, 0o600);
  }

  _timestamp() {
    return asDate(this.now()).toISOString();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executor_tasks (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        task_type TEXT NOT NULL,
        call_id TEXT,
        voice_origin INTEGER NOT NULL DEFAULT 1 CHECK (voice_origin IN (0, 1)),
        request_json TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL CHECK (
          state IN ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'canceled')
        ),
        revision INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at TEXT,
        worker_id TEXT,
        lease_token_hash TEXT,
        lease_acquired_at TEXT,
        heartbeat_at TEXT,
        lease_expires_at TEXT,
        execution_json TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        cancel_reason TEXT,
        cancel_source TEXT,
        cancel_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS executor_tasks_state_created_idx
        ON executor_tasks(state, created_at, id);
      CREATE INDEX IF NOT EXISTS executor_tasks_call_state_idx
        ON executor_tasks(call_id, state, created_at);
      CREATE INDEX IF NOT EXISTS executor_tasks_lease_idx
        ON executor_tasks(state, lease_expires_at);

      CREATE TABLE IF NOT EXISTS executor_cancellation_reservations (
        idempotency_key TEXT PRIMARY KEY,
        call_id TEXT,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS executor_cancellation_reservations_call_idx
        ON executor_cancellation_reservations(call_id, updated_at);

      CREATE TABLE IF NOT EXISTS executor_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        task_id TEXT REFERENCES executor_tasks(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS executor_events_task_sequence_idx
        ON executor_events(task_id, sequence);

      CREATE TABLE IF NOT EXISTS executor_control (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        panic_locked INTEGER NOT NULL DEFAULT 0 CHECK (panic_locked IN (0, 1)),
        panic_reason TEXT,
        panic_source TEXT,
        locked_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS executor_events_append_only_update
      BEFORE UPDATE ON executor_events
      BEGIN
        SELECT RAISE(ABORT, 'executor_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS executor_events_append_only_delete
      BEFORE DELETE ON executor_events
      BEGIN
        SELECT RAISE(ABORT, 'executor_events is append-only');
      END;
    `);

    this._addColumnIfMissing('executor_tasks', 'revision', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumnIfMissing('executor_tasks', 'available_at', 'TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS executor_tasks_available_idx
        ON executor_tasks(state, available_at, created_at, id);
    `);

    const timestamp = this._timestamp();
    this.db.prepare(`
      INSERT INTO executor_control (singleton, updated_at)
      VALUES (1, ?)
      ON CONFLICT(singleton) DO NOTHING
    `).run(timestamp);
  }

  _addColumnIfMissing(table, column, definition) {
    if (!/^[a-z_]+$/i.test(table) || !/^[a-z_]+$/i.test(column)) {
      throw new Error('Invalid migration identifier');
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    }
    return false;
  }

  _appendEvent({ taskId = null, eventType, actor, details = {}, timestamp = null }) {
    const createdAt = timestamp || this._timestamp();
    const eventId = makeId('xevt');
    this.db.prepare(`
      INSERT INTO executor_events (
        event_id, task_id, event_type, actor, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      taskId,
      normalizeBoundedString(eventType, 'eventType', { max: 100 }),
      normalizeBoundedString(actor, 'actor', { max: 200 }),
      stableJson(details || {}),
      createdAt
    );
    return eventId;
  }

  _taskRow(taskId) {
    return this.db.prepare('SELECT * FROM executor_tasks WHERE id = ?').get(taskId) || null;
  }

  _cancellationReservationRow(idempotencyKey) {
    return this.db.prepare(`
      SELECT * FROM executor_cancellation_reservations WHERE idempotency_key = ?
    `).get(idempotencyKey) || null;
  }

  _normalizeCancellationReservation(row) {
    if (!row) return null;
    return {
      idempotencyKey: row.idempotency_key,
      callId: row.call_id,
      reason: row.reason,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _reserveCancellation({ idempotencyKey, callId = null, reason, source, timestamp }) {
    const existing = this._cancellationReservationRow(idempotencyKey);
    this.db.prepare(`
      INSERT INTO executor_cancellation_reservations (
        idempotency_key, call_id, reason, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        call_id = COALESCE(executor_cancellation_reservations.call_id, excluded.call_id),
        reason = excluded.reason,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(idempotencyKey, callId, reason, source, timestamp, timestamp);
    this._appendEvent({
      eventType: existing ? 'cancellation_reservation_reasserted' : 'cancellation_reserved',
      actor: source,
      details: { idempotencyKey, callId, reason },
      timestamp,
    });
    return this._cancellationReservationRow(idempotencyKey);
  }

  _normalizeTask(row, observedAt = this._timestamp()) {
    if (!row) return null;
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      taskType: row.task_type,
      callId: row.call_id,
      voiceOrigin: Boolean(row.voice_origin),
      request: parseJson(row.request_json, {}),
      requestHash: row.request_hash,
      metadata: parseJson(row.metadata_json, {}),
      state: row.state,
      revision: row.revision,
      terminal: isTerminal(row.state),
      cancelRequested: row.state === 'cancel_requested',
      attempt: row.attempt,
      availableAt: row.available_at,
      workerId: row.worker_id,
      leaseAcquiredAt: row.lease_acquired_at,
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
      leaseExpired: LEASED_TASK_STATES.includes(row.state) && (
        !row.lease_token_hash || !row.lease_expires_at || row.lease_expires_at <= observedAt
      ),
      hasLease: Boolean(row.lease_token_hash),
      execution: parseJson(row.execution_json, null),
      result: parseJson(row.result_json, null),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      cancelReason: row.cancel_reason,
      cancelSource: row.cancel_source,
      cancelRequestedAt: row.cancel_requested_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  _assertTask(row, taskId) {
    if (!row) {
      throw new ExecutorTaskStoreError('TASK_NOT_FOUND', `Executor task ${taskId} was not found`, {
        taskId,
      });
    }
  }

  _assertLease(row, leaseToken, workerId = null) {
    if (!LEASED_TASK_STATES.includes(row.state)) {
      throw new ExecutorTaskStoreError(
        'TASK_NOT_RUNNING',
        `Task ${row.id} is ${row.state}, not leased`,
        { taskId: row.id, state: row.state }
      );
    }
    if (!leaseMatches(row.lease_token_hash, leaseToken)) {
      throw new ExecutorTaskStoreError('LEASE_MISMATCH', `Lease for task ${row.id} is invalid`, {
        taskId: row.id,
      });
    }
    if (workerId && row.worker_id !== workerId) {
      throw new ExecutorTaskStoreError('LEASE_OWNER_MISMATCH', `Task ${row.id} belongs to another worker`, {
        taskId: row.id,
        expectedWorkerId: row.worker_id,
      });
    }
  }

  health() {
    const result = this.db.prepare('SELECT 1 AS ok').get();
    return {
      ok: result?.ok === 1,
      path: this.dbPath,
      journalMode: this.db.pragma('journal_mode', { simple: true }),
      panic: this.getPanicStatus(),
    };
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  submitTask({
    idempotencyKey,
    taskType = 'managed_agent',
    callId = null,
    voiceOrigin = true,
    request = {},
    metadata = {},
    actor = 'controller',
  }) {
    const normalizedKey = normalizeBoundedString(idempotencyKey, 'idempotencyKey', { max: 200 });
    const normalizedType = normalizeBoundedString(taskType, 'taskType', { max: 100 });
    const normalizedCallId = normalizeBoundedString(callId, 'callId', {
      max: 200,
      required: false,
    });
    const requestJson = stableJson(request || {});
    const metadataJson = stableJson(metadata || {});
    const requestHash = sha256(stableJson({
      callId: normalizedCallId,
      request: parseJson(requestJson, {}),
      taskType: normalizedType,
      voiceOrigin: Boolean(voiceOrigin),
    }));
    const timestamp = this._timestamp();

    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT * FROM executor_tasks WHERE idempotency_key = ?'
      ).get(normalizedKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ExecutorTaskStoreError(
            'IDEMPOTENCY_CONFLICT',
            `Idempotency key ${normalizedKey} is already bound to another request`,
            { idempotencyKey: normalizedKey, taskId: existing.id }
          );
        }
        return { created: false, row: existing };
      }

      const control = this.db.prepare(
        'SELECT panic_locked, panic_reason FROM executor_control WHERE singleton = 1'
      ).get();
      const cancellationReservation = voiceOrigin
        ? this._cancellationReservationRow(normalizedKey)
        : null;
      if (voiceOrigin && control?.panic_locked && !cancellationReservation) {
        throw new ExecutorTaskStoreError(
          'EXECUTION_PANIC_LOCKED',
          'Phone-originated executor tasks are locked by the panic control',
          { reason: control.panic_reason }
        );
      }

      const id = makeId('xtask');
      const initialState = cancellationReservation ? 'canceled' : 'queued';
      const cancellationTimestamp = cancellationReservation ? timestamp : null;
      this.db.prepare(`
        INSERT INTO executor_tasks (
          id, idempotency_key, task_type, call_id, voice_origin,
          request_json, request_hash, metadata_json, state,
          cancel_reason, cancel_source, cancel_requested_at, completed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        normalizedKey,
        normalizedType,
        normalizedCallId,
        voiceOrigin ? 1 : 0,
        requestJson,
        requestHash,
        metadataJson,
        initialState,
        cancellationReservation?.reason || null,
        cancellationReservation?.source || null,
        cancellationTimestamp,
        cancellationTimestamp,
        timestamp,
        timestamp
      );
      this._appendEvent({
        taskId: id,
        eventType: cancellationReservation ? 'task_canceled_by_reservation' : 'task_submitted',
        actor,
        details: {
          idempotencyKey: normalizedKey,
          requestHash,
          ...(cancellationReservation ? {
            reason: cancellationReservation.reason,
            reservationSource: cancellationReservation.source,
            reservationCreatedAt: cancellationReservation.created_at,
          } : {}),
        },
        timestamp,
      });
      return { created: true, row: this._taskRow(id) };
    });

    const result = transaction.immediate();
    return {
      created: result.created,
      task: this._normalizeTask(result.row, timestamp),
    };
  }

  getTask(taskId) {
    return this._normalizeTask(this._taskRow(String(taskId || '')));
  }

  getTaskByIdempotencyKey(idempotencyKey) {
    const key = normalizeBoundedString(idempotencyKey, 'idempotencyKey', { max: 200 });
    const row = this.db.prepare(
      'SELECT * FROM executor_tasks WHERE idempotency_key = ?'
    ).get(key);
    return this._normalizeTask(row || null);
  }

  getCancellationReservation(idempotencyKey) {
    const key = normalizeBoundedString(idempotencyKey, 'idempotencyKey', { max: 200 });
    return this._normalizeCancellationReservation(this._cancellationReservationRow(key));
  }

  reserveCancellation({
    idempotencyKey,
    callId = null,
    reason = 'cancel_requested',
    source = 'controller',
  }) {
    const normalizedKey = normalizeBoundedString(idempotencyKey, 'idempotencyKey', { max: 200 });
    const normalizedCallId = normalizeBoundedString(callId, 'callId', {
      max: 200,
      required: false,
    });
    const normalizedReason = normalizeBoundedString(reason, 'reason', { max: 200 });
    const normalizedSource = normalizeBoundedString(source, 'source', { max: 200 });
    const timestamp = this._timestamp();
    const transaction = this.db.transaction(() => this._reserveCancellation({
      idempotencyKey: normalizedKey,
      callId: normalizedCallId,
      reason: normalizedReason,
      source: normalizedSource,
      timestamp,
    }));
    return this._normalizeCancellationReservation(transaction.immediate());
  }

  listTasks({ states = null, callId = null, limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    const clauses = [];
    const parameters = [];
    const normalizedStates = states === null
      ? []
      : [...new Set([].concat(states).map((state) => String(state)))];
    for (const state of normalizedStates) {
      if (!TASK_STATES.includes(state)) {
        throw new ExecutorTaskStoreError('INVALID_STATE', `Unknown executor task state: ${state}`);
      }
    }
    if (normalizedStates.length > 0) {
      clauses.push(`state IN (${normalizedStates.map(() => '?').join(', ')})`);
      parameters.push(...normalizedStates);
    }
    if (callId !== null && callId !== undefined) {
      clauses.push('call_id = ?');
      parameters.push(String(callId));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM executor_tasks
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, safeLimit);
    const observedAt = this._timestamp();
    return rows.map((row) => this._normalizeTask(row, observedAt));
  }

  claimNext({ workerId, leaseMs = this.defaultLeaseMs, taskTypes = null } = {}) {
    const normalizedWorkerId = normalizeBoundedString(workerId, 'workerId', { max: 200 });
    const duration = normalizeLeaseMs(leaseMs, this.defaultLeaseMs);
    const normalizedTypes = taskTypes === null
      ? []
      : [...new Set([].concat(taskTypes).map((value) =>
          normalizeBoundedString(value, 'taskType', { max: 100 })
        ))];
    const timestamp = this._timestamp();
    const leaseExpiresAt = addMilliseconds(timestamp, duration);
    const leaseToken = crypto.randomBytes(32).toString('base64url');
    const leaseTokenHash = hashLeaseToken(leaseToken);

    const transaction = this.db.transaction(() => {
      const control = this.db.prepare(
        'SELECT panic_locked FROM executor_control WHERE singleton = 1'
      ).get();
      const clauses = ["state = 'queued'", '(available_at IS NULL OR available_at <= ?)'];
      const parameters = [timestamp];
      if (control?.panic_locked) clauses.push('voice_origin = 0');
      if (normalizedTypes.length > 0) {
        clauses.push(`task_type IN (${normalizedTypes.map(() => '?').join(', ')})`);
        parameters.push(...normalizedTypes);
      }
      const row = this.db.prepare(`
        SELECT * FROM executor_tasks
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get(...parameters);
      if (!row) return null;

      const update = this.db.prepare(`
        UPDATE executor_tasks
        SET state = 'running',
            revision = revision + 1,
            attempt = attempt + 1,
            worker_id = ?,
            lease_token_hash = ?,
            lease_acquired_at = ?,
            heartbeat_at = ?,
            lease_expires_at = ?,
            available_at = NULL,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(
        normalizedWorkerId,
        leaseTokenHash,
        timestamp,
        timestamp,
        leaseExpiresAt,
        timestamp,
        timestamp,
        row.id
      );
      if (update.changes !== 1) return null;

      this._appendEvent({
        taskId: row.id,
        eventType: 'lease_acquired',
        actor: normalizedWorkerId,
        details: { leaseExpiresAt, attempt: row.attempt + 1 },
        timestamp,
      });
      return this._taskRow(row.id);
    });

    const row = transaction.immediate();
    if (!row) return null;
    return {
      task: this._normalizeTask(row, timestamp),
      leaseToken,
    };
  }

  heartbeat({
    taskId,
    leaseToken,
    workerId = null,
    leaseMs = this.defaultLeaseMs,
    execution = undefined,
  }) {
    const duration = normalizeLeaseMs(leaseMs, this.defaultLeaseMs);
    const normalizedWorkerId = workerId === null
      ? null
      : normalizeBoundedString(workerId, 'workerId', { max: 200 });
    const timestamp = this._timestamp();
    const leaseExpiresAt = addMilliseconds(timestamp, duration);
    const executionJson = execution === undefined ? null : serializeNullable(execution);

    const transaction = this.db.transaction(() => {
      const row = this._taskRow(taskId);
      this._assertTask(row, taskId);
      this._assertLease(row, leaseToken, normalizedWorkerId);
      this.db.prepare(`
        UPDATE executor_tasks
        SET heartbeat_at = ?,
            lease_expires_at = ?,
            execution_json = COALESCE(?, execution_json),
            revision = revision + 1,
            updated_at = ?
        WHERE id = ?
      `).run(timestamp, leaseExpiresAt, executionJson, timestamp, taskId);
      this._appendEvent({
        taskId,
        eventType: 'lease_heartbeat',
        actor: row.worker_id,
        details: { leaseExpiresAt, executionUpdated: execution !== undefined },
        timestamp,
      });
      return this._taskRow(taskId);
    });
    const row = transaction.immediate();
    return this._normalizeTask(row, timestamp);
  }

  deferLeasedTask({
    taskId,
    leaseToken,
    workerId = null,
    delayMs = 1000,
    reason = 'provider_capacity_unavailable',
  }) {
    const timestamp = this._timestamp();
    const normalizedWorkerId = workerId === null
      ? null
      : normalizeBoundedString(workerId, 'workerId', { max: 200 });
    const normalizedReason = normalizeBoundedString(reason, 'reason', { max: 200 });
    const boundedDelay = Math.max(100, Math.min(Number.parseInt(delayMs, 10) || 1000, 30000));
    const availableAt = addMilliseconds(timestamp, boundedDelay);
    const transaction = this.db.transaction(() => {
      const row = this._taskRow(taskId);
      this._assertTask(row, taskId);
      this._assertLease(row, leaseToken, normalizedWorkerId);
      if (row.state === 'cancel_requested') {
        throw new ExecutorTaskStoreError(
          'TASK_CANCEL_REQUESTED',
          `Task ${taskId} cannot be deferred after cancellation`,
          { taskId }
        );
      }
      const update = this.db.prepare(`
        UPDATE executor_tasks
        SET state = 'queued',
            revision = revision + 1,
            worker_id = NULL,
            lease_token_hash = NULL,
            lease_acquired_at = NULL,
            heartbeat_at = NULL,
            lease_expires_at = NULL,
            execution_json = NULL,
            started_at = NULL,
            available_at = ?,
            updated_at = ?
        WHERE id = ? AND state = 'running'
      `).run(availableAt, timestamp, taskId);
      if (update.changes !== 1) {
        throw new ExecutorTaskStoreError(
          'TASK_NOT_RUNNING',
          `Task ${taskId} could not be deferred`,
          { taskId }
        );
      }
      this._appendEvent({
        taskId,
        eventType: 'task_deferred_for_provider_capacity',
        actor: row.worker_id,
        details: { reason: normalizedReason, delayMs: boundedDelay, availableAt },
        timestamp,
      });
      return this._taskRow(taskId);
    });
    return this._normalizeTask(transaction.immediate(), timestamp);
  }

  releaseLease({ taskId, leaseToken, workerId = null, reason = 'worker_shutdown' }) {
    const timestamp = this._timestamp();
    const normalizedWorkerId = workerId === null
      ? null
      : normalizeBoundedString(workerId, 'workerId', { max: 200 });
    const normalizedReason = normalizeBoundedString(reason, 'reason', { max: 200 });
    const transaction = this.db.transaction(() => {
      const row = this._taskRow(taskId);
      this._assertTask(row, taskId);
      this._assertLease(row, leaseToken, normalizedWorkerId);
      this.db.prepare(`
        UPDATE executor_tasks
        SET worker_id = NULL,
            lease_token_hash = NULL,
            lease_expires_at = ?,
            revision = revision + 1,
            updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, taskId);
      this._appendEvent({
        taskId,
        eventType: 'lease_released',
        actor: row.worker_id,
        details: { reason: normalizedReason },
        timestamp,
      });
      return this._taskRow(taskId);
    });
    return this._normalizeTask(transaction.immediate(), timestamp);
  }

  completeTask({
    taskId,
    leaseToken,
    workerId = null,
    result = null,
    allowAfterCancellation = false,
  }) {
    return this._finishTask({
      taskId,
      leaseToken,
      workerId,
      state: 'completed',
      result,
      actor: workerId || 'worker',
      allowAfterCancellation: Boolean(allowAfterCancellation),
    });
  }

  failTask({
    taskId,
    leaseToken,
    workerId = null,
    errorCode = 'EXECUTION_FAILED',
    errorMessage,
    result = null,
  }) {
    return this._finishTask({
      taskId,
      leaseToken,
      workerId,
      state: 'failed',
      result,
      errorCode,
      errorMessage,
      actor: workerId || 'worker',
    });
  }

  acknowledgeCanceled({ taskId, leaseToken, workerId = null, result = null }) {
    return this._finishTask({
      taskId,
      leaseToken,
      workerId,
      state: 'canceled',
      result,
      actor: workerId || 'worker',
      requireCancellation: true,
    });
  }

  _finishTask({
    taskId,
    leaseToken,
    workerId,
    state,
    result,
    errorCode = null,
    errorMessage = null,
    actor,
    requireCancellation = false,
    allowAfterCancellation = false,
  }) {
    const timestamp = this._timestamp();
    const normalizedWorkerId = workerId === null
      ? null
      : normalizeBoundedString(workerId, 'workerId', { max: 200 });
    const transaction = this.db.transaction(() => {
      const row = this._taskRow(taskId);
      this._assertTask(row, taskId);
      this._assertLease(row, leaseToken, normalizedWorkerId);
      if (requireCancellation && row.state !== 'cancel_requested') {
        throw new ExecutorTaskStoreError(
          'CANCELLATION_NOT_REQUESTED',
          `Task ${taskId} has no pending cancellation`,
          { taskId, state: row.state }
        );
      }
      if (!requireCancellation && state === 'completed' && row.state === 'cancel_requested' &&
          !allowAfterCancellation) {
        throw new ExecutorTaskStoreError(
          'TASK_CANCEL_REQUESTED',
          `Task ${taskId} must acknowledge cancellation instead of completing`,
          { taskId }
        );
      }
      this.db.prepare(`
        UPDATE executor_tasks
        SET state = ?,
            revision = revision + 1,
            result_json = ?,
            error_code = ?,
            error_message = ?,
            worker_id = NULL,
            lease_token_hash = NULL,
            lease_expires_at = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        state,
        serializeNullable(result),
        errorCode ? normalizeBoundedString(errorCode, 'errorCode', { max: 100 }) : null,
        errorMessage ? String(errorMessage).slice(0, 16000) : null,
        timestamp,
        timestamp,
        taskId
      );
      this._appendEvent({
        taskId,
        eventType: `task_${state}`,
        actor,
        details: {
          errorCode: errorCode || null,
          cancellationAcknowledged: requireCancellation,
          completedAfterCancellation: state === 'completed' && row.state === 'cancel_requested',
        },
        timestamp,
      });
      return this._taskRow(taskId);
    });
    return this._normalizeTask(transaction.immediate(), timestamp);
  }

  requestCancellation({ taskId, reason = 'cancel_requested', source = 'controller' }) {
    const timestamp = this._timestamp();
    const normalizedReason = normalizeBoundedString(reason, 'reason', { max: 200 });
    const normalizedSource = normalizeBoundedString(source, 'source', { max: 200 });
    const transaction = this.db.transaction(() => {
      const row = this._taskRow(taskId);
      this._assertTask(row, taskId);
      if (isTerminal(row.state) || row.state === 'cancel_requested') {
        return { changed: false, row };
      }
      const nextState = row.state === 'queued' ? 'canceled' : 'cancel_requested';
      const completedAt = nextState === 'canceled' ? timestamp : null;
      this.db.prepare(`
        UPDATE executor_tasks
        SET state = ?,
            revision = revision + 1,
            cancel_reason = ?,
            cancel_source = ?,
            cancel_requested_at = ?,
            completed_at = COALESCE(?, completed_at),
            updated_at = ?
        WHERE id = ? AND state IN ('queued', 'running')
      `).run(
        nextState,
        normalizedReason,
        normalizedSource,
        timestamp,
        completedAt,
        timestamp,
        taskId
      );
      this._appendEvent({
        taskId,
        eventType: nextState === 'canceled' ? 'task_canceled' : 'cancellation_requested',
        actor: normalizedSource,
        details: { reason: normalizedReason, previousState: row.state },
        timestamp,
      });
      return { changed: true, row: this._taskRow(taskId) };
    });
    const result = transaction.immediate();
    return { changed: result.changed, task: this._normalizeTask(result.row, timestamp) };
  }

  cancelCallTasks({
    callId,
    idempotencyKey = null,
    reason = 'call_canceled',
    source = 'controller',
  }) {
    const normalizedCallId = normalizeBoundedString(callId, 'callId', { max: 200 });
    const normalizedIdempotencyKey = idempotencyKey === null || idempotencyKey === undefined
      ? null
      : normalizeBoundedString(idempotencyKey, 'idempotencyKey', { max: 200 });
    return this._cancelMatchingTasks({
      whereSql: 'call_id = ?',
      parameters: [normalizedCallId],
      cancellationReservation: normalizedIdempotencyKey ? {
        idempotencyKey: normalizedIdempotencyKey,
        callId: normalizedCallId,
      } : null,
      reason,
      source,
      eventType: 'call_cancellation_requested',
    });
  }

  _cancelMatchingTasks({
    whereSql,
    parameters,
    cancellationReservation = null,
    reason,
    source,
    eventType,
  }) {
    const timestamp = this._timestamp();
    const normalizedReason = normalizeBoundedString(reason, 'reason', { max: 200 });
    const normalizedSource = normalizeBoundedString(source, 'source', { max: 200 });
    const transaction = this.db.transaction(() => {
      const reservation = cancellationReservation
        ? this._reserveCancellation({
            ...cancellationReservation,
            reason: normalizedReason,
            source: normalizedSource,
            timestamp,
          })
        : null;
      const rows = this.db.prepare(`
        SELECT * FROM executor_tasks
        WHERE ${whereSql} AND state IN ('queued', 'running')
        ORDER BY created_at, id
      `).all(...parameters);
      const taskIds = [];
      let immediatelyCanceled = 0;
      let cancellationRequested = 0;
      for (const row of rows) {
        const nextState = row.state === 'queued' ? 'canceled' : 'cancel_requested';
        this.db.prepare(`
          UPDATE executor_tasks
          SET state = ?, revision = revision + 1,
              cancel_reason = ?, cancel_source = ?, cancel_requested_at = ?,
              completed_at = CASE WHEN ? = 'canceled' THEN ? ELSE completed_at END,
              updated_at = ?
          WHERE id = ? AND state = ?
        `).run(
          nextState,
          normalizedReason,
          normalizedSource,
          timestamp,
          nextState,
          timestamp,
          timestamp,
          row.id,
          row.state
        );
        this._appendEvent({
          taskId: row.id,
          eventType: row.state === 'queued' ? 'task_canceled' : eventType,
          actor: normalizedSource,
          details: { reason: normalizedReason, previousState: row.state },
          timestamp,
        });
        taskIds.push(row.id);
        if (nextState === 'canceled') immediatelyCanceled += 1;
        else cancellationRequested += 1;
      }
      return {
        taskIds,
        immediatelyCanceled,
        cancellationRequested,
        reservation: this._normalizeCancellationReservation(reservation),
      };
    });
    return transaction.immediate();
  }

  panic({ reason = 'voice_panic_stop', source = 'panic_control' } = {}) {
    const timestamp = this._timestamp();
    const normalizedReason = normalizeBoundedString(reason, 'reason', { max: 200 });
    const normalizedSource = normalizeBoundedString(source, 'source', { max: 200 });
    const transaction = this.db.transaction(() => {
      const previous = this.db.prepare(
        'SELECT * FROM executor_control WHERE singleton = 1'
      ).get();
      this.db.prepare(`
        UPDATE executor_control
        SET panic_locked = 1,
            panic_reason = ?,
            panic_source = ?,
            locked_at = COALESCE(locked_at, ?),
            updated_at = ?
        WHERE singleton = 1
      `).run(normalizedReason, normalizedSource, timestamp, timestamp);

      const rows = this.db.prepare(`
        SELECT * FROM executor_tasks
        WHERE voice_origin = 1 AND state IN ('queued', 'running', 'cancel_requested')
        ORDER BY created_at, id
      `).all();
      const taskIds = [];
      let immediatelyCanceled = 0;
      let cancellationRequested = 0;
      let cancellationReasserted = 0;
      for (const row of rows) {
        const nextState = row.state === 'queued' ? 'canceled' : 'cancel_requested';
        this.db.prepare(`
          UPDATE executor_tasks
          SET state = ?, revision = revision + 1,
              cancel_reason = ?, cancel_source = ?, cancel_requested_at = ?,
              completed_at = CASE WHEN ? = 'canceled' THEN ? ELSE completed_at END,
              updated_at = ?
          WHERE id = ? AND state = ?
        `).run(
          nextState,
          normalizedReason,
          normalizedSource,
          timestamp,
          nextState,
          timestamp,
          timestamp,
          row.id,
          row.state
        );
        this._appendEvent({
          taskId: row.id,
          eventType: row.state === 'queued'
            ? 'task_canceled'
            : (row.state === 'cancel_requested'
              ? 'panic_cancellation_reasserted'
              : 'panic_cancellation_requested'),
          actor: normalizedSource,
          details: { reason: normalizedReason, previousState: row.state },
          timestamp,
        });
        taskIds.push(row.id);
        if (nextState === 'canceled') immediatelyCanceled += 1;
        else if (row.state === 'cancel_requested') cancellationReasserted += 1;
        else cancellationRequested += 1;
      }
      this._appendEvent({
        eventType: previous.panic_locked ? 'panic_reasserted' : 'panic_locked',
        actor: normalizedSource,
        details: {
          reason: normalizedReason,
          affectedTaskIds: taskIds,
        },
        timestamp,
      });
      return {
        alreadyLocked: Boolean(previous.panic_locked),
        taskIds,
        immediatelyCanceled,
        cancellationRequested,
        cancellationReasserted,
      };
    });
    const result = transaction.immediate();
    const panic = this.getPanicStatus();
    return {
      ...result,
      accepted: true,
      persisted: panic.locked,
      quiesced: panic.quiesced,
      activeTaskIds: panic.activeTaskIds,
      activeCount: panic.activeCount,
      panic,
    };
  }

  unlockPanic({ source = 'operator' } = {}) {
    const timestamp = this._timestamp();
    const normalizedSource = normalizeBoundedString(source, 'source', { max: 200 });
    const transaction = this.db.transaction(() => {
      const previous = this.db.prepare(
        'SELECT * FROM executor_control WHERE singleton = 1'
      ).get();
      this.db.prepare(`
        UPDATE executor_control
        SET panic_locked = 0,
            panic_reason = NULL,
            panic_source = NULL,
            locked_at = NULL,
            updated_at = ?
        WHERE singleton = 1
      `).run(timestamp);
      this._appendEvent({
        eventType: previous.panic_locked ? 'panic_unlocked' : 'panic_unlock_reasserted',
        actor: normalizedSource,
        details: {
          previousReason: previous.panic_reason,
          previousSource: previous.panic_source,
        },
        timestamp,
      });
      return Boolean(previous.panic_locked);
    });
    const wasLocked = transaction.immediate();
    return { wasLocked, panic: this.getPanicStatus() };
  }

  getPanicStatus() {
    const row = this.db.prepare(
      'SELECT * FROM executor_control WHERE singleton = 1'
    ).get();
    const activeRows = this.db.prepare(`
      SELECT id FROM executor_tasks
      WHERE voice_origin = 1 AND state IN ('queued', 'running', 'cancel_requested')
      ORDER BY created_at, id
    `).all();
    const activeTaskIds = activeRows.map((entry) => entry.id);
    return {
      locked: Boolean(row?.panic_locked),
      accepted: Boolean(row?.panic_locked),
      persisted: Boolean(row?.panic_locked),
      quiesced: activeTaskIds.length === 0,
      activeTaskIds,
      activeCount: activeTaskIds.length,
      reason: row?.panic_reason || null,
      source: row?.panic_source || null,
      lockedAt: row?.locked_at || null,
      updatedAt: row?.updated_at || null,
    };
  }

  listReconciliationCandidates({ includeLiveLeases = false, limit = 1000 } = {}) {
    const timestamp = this._timestamp();
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 10000));
    const rows = includeLiveLeases
      ? this.db.prepare(`
          SELECT * FROM executor_tasks
          WHERE state IN ('running', 'cancel_requested')
          ORDER BY updated_at, id
          LIMIT ?
        `).all(safeLimit)
      : this.db.prepare(`
          SELECT * FROM executor_tasks
          WHERE state IN ('running', 'cancel_requested')
            AND (lease_token_hash IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY updated_at, id
          LIMIT ?
        `).all(timestamp, safeLimit);
    return rows.map((row) => this._normalizeTask(row, timestamp));
  }

  reconcileTask({
    taskId,
    disposition,
    workerId = null,
    leaseMs = this.defaultLeaseMs,
    reason = 'executor_restart_reconciliation',
    expectedRevision = null,
    expectedUpdatedAt = null,
    force = false,
    result = null,
    errorCode = null,
    errorMessage = null,
  }) {
    const normalizedDisposition = String(disposition || '').trim();
    if (!['adopt', 'requeue', 'complete', 'cancel', 'fail'].includes(normalizedDisposition)) {
      throw new ExecutorTaskStoreError(
        'INVALID_RECONCILIATION',
        'disposition must be adopt, requeue, complete, cancel, or fail'
      );
    }
    const normalizedReason = normalizeBoundedString(reason, 'reason', { max: 500 });
    const normalizedWorkerId = normalizedDisposition === 'adopt'
      ? normalizeBoundedString(workerId, 'workerId', { max: 200 })
      : null;
    const duration = normalizedDisposition === 'adopt'
      ? normalizeLeaseMs(leaseMs, this.defaultLeaseMs)
      : null;
    const timestamp = this._timestamp();
    const leaseToken = normalizedDisposition === 'adopt'
      ? crypto.randomBytes(32).toString('base64url')
      : null;

    const transaction = this.db.transaction(() => {
      const row = this._taskRow(taskId);
      this._assertTask(row, taskId);
      if (!LEASED_TASK_STATES.includes(row.state)) {
        throw new ExecutorTaskStoreError(
          'TASK_NOT_RECONCILABLE',
          `Task ${taskId} is ${row.state}`,
          { taskId, state: row.state }
        );
      }
      if (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt) {
        throw new ExecutorTaskStoreError(
          'RECONCILIATION_STALE',
          `Task ${taskId} changed after it was inspected`,
          { taskId, expectedUpdatedAt, actualUpdatedAt: row.updated_at }
        );
      }
      if (expectedRevision !== null && Number.parseInt(expectedRevision, 10) !== row.revision) {
        throw new ExecutorTaskStoreError(
          'RECONCILIATION_STALE',
          `Task ${taskId} changed after it was inspected`,
          {
            taskId,
            expectedRevision: Number.parseInt(expectedRevision, 10),
            actualRevision: row.revision,
          }
        );
      }
      const leaseIsLive = Boolean(
        row.lease_token_hash && row.lease_expires_at && row.lease_expires_at > timestamp
      );
      if (leaseIsLive && !force) {
        throw new ExecutorTaskStoreError(
          'LEASE_STILL_LIVE',
          `Task ${taskId} still has a live lease`,
          { taskId, leaseExpiresAt: row.lease_expires_at }
        );
      }

      if (normalizedDisposition === 'adopt') {
        const leaseExpiresAt = addMilliseconds(timestamp, duration);
        this.db.prepare(`
          UPDATE executor_tasks
          SET revision = revision + 1,
              worker_id = ?, lease_token_hash = ?, lease_acquired_at = ?, heartbeat_at = ?,
              lease_expires_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          normalizedWorkerId,
          hashLeaseToken(leaseToken),
          timestamp,
          timestamp,
          leaseExpiresAt,
          timestamp,
          taskId
        );
        this._appendEvent({
          taskId,
          eventType: 'lease_adopted',
          actor: normalizedWorkerId,
          details: {
            reason: normalizedReason,
            previousWorkerId: row.worker_id,
            leaseExpiresAt,
            forced: Boolean(force),
          },
          timestamp,
        });
      } else if (normalizedDisposition === 'requeue') {
        if (row.state === 'cancel_requested') {
          throw new ExecutorTaskStoreError(
            'TASK_CANCEL_REQUESTED',
            `Task ${taskId} must be canceled or adopted to finish cancellation`,
            { taskId }
          );
        }
        this.db.prepare(`
          UPDATE executor_tasks
          SET state = 'queued', revision = revision + 1,
              worker_id = NULL, lease_token_hash = NULL,
              lease_acquired_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
              execution_json = NULL, started_at = NULL, available_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(timestamp, taskId);
        this._appendEvent({
          taskId,
          eventType: 'task_requeued_after_reconciliation',
          actor: 'reconciler',
          details: { reason: normalizedReason, previousWorkerId: row.worker_id },
          timestamp,
        });
      } else {
        const nextState = normalizedDisposition === 'complete'
          ? 'completed'
          : (normalizedDisposition === 'cancel' ? 'canceled' : 'failed');
        const terminalErrorCode = nextState === 'failed'
          ? normalizeBoundedString(errorCode || 'RECONCILIATION_FAILED', 'errorCode', { max: 100 })
          : null;
        const terminalErrorMessage = nextState === 'failed'
          ? String(errorMessage || normalizedReason).slice(0, 16000)
          : null;
        this.db.prepare(`
          UPDATE executor_tasks
          SET state = ?, revision = revision + 1,
              worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
              result_json = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextState,
          serializeNullable(result),
          terminalErrorCode,
          terminalErrorMessage,
          timestamp,
          timestamp,
          taskId
        );
        this._appendEvent({
          taskId,
          eventType: nextState === 'completed'
            ? 'task_completed_after_reconciliation'
            : (nextState === 'canceled'
              ? 'task_canceled_after_reconciliation'
              : 'task_failed_after_reconciliation'),
          actor: 'reconciler',
          details: {
            reason: normalizedReason,
            previousWorkerId: row.worker_id,
            errorCode: terminalErrorCode,
          },
          timestamp,
        });
      }
      return this._taskRow(taskId);
    });

    const row = transaction.immediate();
    return {
      task: this._normalizeTask(row, timestamp),
      leaseToken,
    };
  }

  listEvents({ taskId = null, afterSequence = 0, limit = 1000 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 10000));
    const safeAfter = Math.max(0, Number.parseInt(afterSequence, 10) || 0);
    const rows = taskId
      ? this.db.prepare(`
          SELECT * FROM executor_events
          WHERE task_id = ? AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(taskId, safeAfter, safeLimit)
      : this.db.prepare(`
          SELECT * FROM executor_events
          WHERE sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(safeAfter, safeLimit);
    return rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      taskId: row.task_id,
      eventType: row.event_type,
      actor: row.actor,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }
}

module.exports = {
  ExecutorTaskStore,
  ExecutorTaskStoreError,
  TASK_STATES,
  ACTIVE_TASK_STATES,
  LEASED_TASK_STATES,
  TERMINAL_TASK_STATES,
};
