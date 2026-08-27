'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { canonicalizeApprovalPlan } = require('../lib/voice-approval-capability');

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'outcome_unknown']);
const LEASED_STATES = new Set(['running', 'cancel_requested']);

class PrivilegedActionStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrivilegedActionStoreError';
    this.code = code;
    this.details = details;
  }
}

function storeError(code, message, details = {}) {
  throw new PrivilegedActionStoreError(code, message, details);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function stableJson(value) {
  return canonicalizeApprovalPlan(value);
}

function parseJson(value, fallback = null) {
  try {
    return value === null || value === undefined ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sha256Hex(value, field) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    storeError('INVALID_ARGUMENT', `${field} must be an exact SHA-256 digest.`, { field });
  }
  return text;
}

function bounded(value, field, max = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\u0000-\u001F\u007F]/.test(text)) {
    storeError('INVALID_ARGUMENT', `${field} is invalid.`, { field });
  }
  return text;
}

function leaseMatches(storedHash, leaseToken) {
  if (!storedHash || !leaseToken) return false;
  const left = Buffer.from(storedHash, 'hex');
  const right = Buffer.from(sha256(leaseToken), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function assertSecureStoragePath(dbPath, expectedUid, expectedGid) {
  const directory = path.dirname(path.resolve(dbPath));
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch {
    storeError('PRIVILEGED_STORAGE_UNSAFE', 'The privileged state directory must already exist.');
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      directoryStat.uid !== expectedUid || directoryStat.gid !== expectedGid ||
      (directoryStat.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory) {
    storeError(
      'PRIVILEGED_STORAGE_UNSAFE',
      'The privileged state directory must be root-owned and accessible only by root.'
    );
  }
  if (fs.existsSync(dbPath)) {
    const stat = fs.lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid ||
        stat.gid !== expectedGid || stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 || fs.realpathSync(dbPath) !== dbPath) {
      storeError('PRIVILEGED_STORAGE_UNSAFE', 'The privileged database has unsafe ownership or mode.');
    }
  }
}

class PrivilegedActionStore {
  constructor({
    dbPath = ':memory:',
    expectedUid = 0,
    expectedGid = typeof process.getegid === 'function' ? process.getegid() : 0,
    strictOwnership = dbPath !== ':memory:',
    now = () => new Date(),
    leaseMs = 15000,
    assertStorageOpen = () => {},
    admitNewWork = () => {},
  } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    this.leaseMs = Math.max(1000, Math.min(Number.parseInt(leaseMs, 10) || 15000, 3600000));
    if (typeof assertStorageOpen !== 'function' || typeof admitNewWork !== 'function') {
      storeError('PRIVILEGED_STORAGE_UNSAFE', 'Privileged state admission callbacks are invalid.');
    }
    this.admitNewWork = admitNewWork;
    assertStorageOpen();
    if (strictOwnership && dbPath !== ':memory:') {
      assertSecureStoragePath(dbPath, expectedUid, expectedGid);
    }
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      fs.chmodSync(dbPath, 0o600);
    }
    this._migrate();
    if (strictOwnership && dbPath !== ':memory:') {
      assertSecureStoragePath(dbPath, expectedUid, expectedGid);
    }
  }

  _assertNewWorkAdmission() {
    try {
      this.admitNewWork();
    } catch (error) {
      storeError(
        'PRIVILEGED_STATE_CAPACITY_EXHAUSTED',
        'Privileged durable-state reserve is exhausted; new actions are refused.',
        { cause: error?.code || 'state_admission_failed' }
      );
    }
  }

  _now() {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new Error('Privileged action store clock is invalid.');
    }
    return date.toISOString();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS privileged_actions (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        target TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'running', 'cancel_requested', 'completed', 'failed', 'canceled',
          'outcome_unknown'
        )),
        revision INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT,
        lease_token_hash TEXT,
        lease_expires_at TEXT,
        execution_json TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        cancel_reason TEXT,
        cancel_source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS privileged_actions_state_idx
        ON privileged_actions(state, created_at, id);

      CREATE TABLE IF NOT EXISTS privileged_action_processes (
        process_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES privileged_actions(id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL CHECK (purpose IN ('main', 'observation')),
        marker_hash TEXT NOT NULL UNIQUE,
        argv_hash TEXT NOT NULL,
        pid INTEGER,
        process_start_ticks TEXT,
        process_group_id INTEGER,
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'spawned', 'recovery_blocked', 'quiesced'
        )),
        prepared_at TEXT NOT NULL,
        spawned_at TEXT,
        quiesced_at TEXT,
        updated_at TEXT NOT NULL,
        evidence_json TEXT
      );

      CREATE INDEX IF NOT EXISTS privileged_action_processes_recovery_idx
        ON privileged_action_processes(state, prepared_at, process_id);

      CREATE TABLE IF NOT EXISTS privileged_action_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        action_id TEXT REFERENCES privileged_actions(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS privileged_action_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        outbox_id TEXT NOT NULL UNIQUE,
        action_id TEXT REFERENCES privileged_actions(id) ON DELETE RESTRICT,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS privileged_action_control (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        panic_locked INTEGER NOT NULL DEFAULT 0 CHECK (panic_locked IN (0, 1)),
        recovery_blocked INTEGER NOT NULL DEFAULT 0 CHECK (recovery_blocked IN (0, 1)),
        recovery_details_json TEXT,
        reason TEXT,
        source TEXT,
        locked_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS privileged_action_cancellations (
        idempotency_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS privileged_action_outbox_consumers (
        consumer_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS privileged_action_audit_no_update
      BEFORE UPDATE ON privileged_action_audit BEGIN
        SELECT RAISE(ABORT, 'privileged action audit is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS privileged_action_audit_no_delete
      BEFORE DELETE ON privileged_action_audit BEGIN
        SELECT RAISE(ABORT, 'privileged action audit is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS privileged_action_outbox_no_update
      BEFORE UPDATE ON privileged_action_outbox BEGIN
        SELECT RAISE(ABORT, 'privileged action outbox is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS privileged_action_outbox_no_delete
      BEFORE DELETE ON privileged_action_outbox BEGIN
        SELECT RAISE(ABORT, 'privileged action outbox is append-only');
      END;
    `);
    this._ensureColumn(
      'privileged_action_control',
      'recovery_blocked',
      'INTEGER NOT NULL DEFAULT 0 CHECK (recovery_blocked IN (0, 1))'
    );
    this._ensureColumn('privileged_action_control', 'recovery_details_json', 'TEXT');
    const timestamp = this._now();
    this.db.prepare(`
      INSERT INTO privileged_action_control (singleton, updated_at)
      VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING
    `).run(timestamp);
  }

  _ensureColumn(table, column, definition) {
    const existing = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() {
    if (this.db.open) this.db.close();
  }

  _row(id) {
    return this.db.prepare('SELECT * FROM privileged_actions WHERE id = ?').get(id) || null;
  }

  _normalized(row) {
    if (!row) return null;
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id,
      callId: row.call_id,
      target: row.target,
      plan: parseJson(row.plan_json, {}),
      planHash: row.plan_hash,
      approval: parseJson(row.approval_json, {}),
      state: row.state,
      terminal: TERMINAL_STATES.has(row.state),
      revision: row.revision,
      attempt: row.attempt,
      workerId: row.worker_id,
      leaseExpiresAt: row.lease_expires_at,
      execution: parseJson(row.execution_json, null),
      result: parseJson(row.result_json, null),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      cancelReason: row.cancel_reason,
      cancelSource: row.cancel_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  _append({ actionId = null, eventType, actor, details, timestamp }) {
    this.db.prepare(`
      INSERT INTO privileged_action_audit (
        event_id, action_id, event_type, actor, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      makeId('paevt'), actionId, bounded(eventType, 'eventType', 100),
      bounded(actor, 'actor', 200), stableJson(details || {}), timestamp
    );
    this.db.prepare(`
      INSERT INTO privileged_action_outbox (
        outbox_id, action_id, topic, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      makeId('paout'), actionId, `privileged_action.${eventType}`,
      stableJson({ actionId, eventType, ...details }), timestamp
    );
  }

  submitAction({
    idempotencyKey,
    jobId,
    callId,
    target,
    plan,
    planHash,
    approval,
    actor = 'voice_controller',
  }) {
    const key = bounded(idempotencyKey, 'idempotencyKey');
    const normalizedJobId = bounded(jobId, 'jobId');
    const normalizedCallId = bounded(callId, 'callId');
    const normalizedTarget = bounded(target, 'target', 512);
    const planJson = stableJson(plan);
    const approvalJson = stableJson(approval);
    const normalizedPlanHash = bounded(planHash, 'planHash', 64);
    const requestIdentity = sha256(stableJson({
      jobId: normalizedJobId,
      callId: normalizedCallId,
      target: normalizedTarget,
      plan,
      planHash: normalizedPlanHash,
    }));
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT * FROM privileged_actions WHERE idempotency_key = ?'
      ).get(key);
      if (existing) {
        const existingIdentity = sha256(stableJson({
          jobId: existing.job_id,
          callId: existing.call_id,
          target: existing.target,
          plan: parseJson(existing.plan_json, {}),
          planHash: existing.plan_hash,
        }));
        if (existingIdentity !== requestIdentity) {
          storeError('IDEMPOTENCY_CONFLICT', 'The idempotency key is bound to another action.', {
            actionId: existing.id,
          });
        }
        return { created: false, row: existing };
      }
      const control = this.db.prepare(
        'SELECT panic_locked, reason FROM privileged_action_control WHERE singleton = 1'
      ).get();
      if (control.panic_locked) {
        storeError('PRIVILEGED_PANIC_LOCKED', 'Privileged actions are locked by panic control.', {
          reason: control.reason,
        });
      }
      this._assertNewWorkAdmission();
      const id = makeId('pact');
      this.db.prepare(`
        INSERT INTO privileged_actions (
          id, idempotency_key, job_id, call_id, target, plan_json, plan_hash,
          approval_json, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        id, key, normalizedJobId, normalizedCallId, normalizedTarget, planJson,
        normalizedPlanHash, approvalJson, timestamp, timestamp
      );
      this._append({
        actionId: id,
        eventType: 'submitted',
        actor,
        details: { idempotencyKey: key, planHash: normalizedPlanHash, target: normalizedTarget },
        timestamp,
      });
      return { created: true, row: this._row(id) };
    });
    const result = transaction.immediate();
    return { created: result.created, action: this._normalized(result.row) };
  }

  getAction(id) {
    return this._normalized(this._row(String(id || '')));
  }

  getByIdempotencyKey(key) {
    const row = this.db.prepare(
      'SELECT * FROM privileged_actions WHERE idempotency_key = ?'
    ).get(bounded(key, 'idempotencyKey'));
    return this._normalized(row || null);
  }

  getByIdempotencyKeyIfPresent(key) {
    const value = String(key || '').trim();
    if (!value) return null;
    return this.getByIdempotencyKey(value);
  }

  claimNext({ workerId = 'root-broker', leaseMs = this.leaseMs } = {}) {
    const worker = bounded(workerId, 'workerId');
    const duration = Math.max(1000, Math.min(Number.parseInt(leaseMs, 10) || this.leaseMs, 3600000));
    const leaseToken = crypto.randomBytes(32).toString('base64url');
    const timestamp = this._now();
    const expiresAt = new Date(Date.parse(timestamp) + duration).toISOString();
    const transaction = this.db.transaction(() => {
      const control = this.db.prepare(
        'SELECT panic_locked FROM privileged_action_control WHERE singleton = 1'
      ).get();
      if (control.panic_locked) return null;
      const row = this.db.prepare(`
        SELECT * FROM privileged_actions WHERE state = 'queued'
        ORDER BY created_at, id LIMIT 1
      `).get();
      if (!row) return null;
      const execution = {
        stage: 'execution_intent_persisted',
        planHash: row.plan_hash,
        attemptedAt: timestamp,
      };
      const update = this.db.prepare(`
        UPDATE privileged_actions
        SET state = 'running', revision = revision + 1, attempt = attempt + 1,
            worker_id = ?, lease_token_hash = ?, lease_expires_at = ?,
            execution_json = ?, started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(
        worker, sha256(leaseToken), expiresAt, stableJson(execution),
        timestamp, timestamp, row.id
      );
      if (update.changes !== 1) return null;
      this._append({
        actionId: row.id,
        eventType: 'execution_intent_persisted',
        actor: worker,
        details: { attempt: row.attempt + 1, leaseExpiresAt: expiresAt },
        timestamp,
      });
      return this._row(row.id);
    });
    const row = transaction.immediate();
    return row ? { action: this._normalized(row), leaseToken } : null;
  }

  _assertLease(row, leaseToken, workerId) {
    if (!row || !LEASED_STATES.has(row.state)) {
      storeError('ACTION_NOT_RUNNING', 'The privileged action is not running.');
    }
    if (!leaseMatches(row.lease_token_hash, leaseToken) ||
        (workerId && row.worker_id !== workerId)) {
      storeError('LEASE_MISMATCH', 'The privileged action lease is invalid.');
    }
  }

  heartbeat({ actionId, leaseToken, workerId, execution = undefined }) {
    const timestamp = this._now();
    const expiresAt = new Date(Date.parse(timestamp) + this.leaseMs).toISOString();
    const transaction = this.db.transaction(() => {
      const row = this._row(actionId);
      this._assertLease(row, leaseToken, workerId);
      this.db.prepare(`
        UPDATE privileged_actions SET revision = revision + 1, lease_expires_at = ?,
          execution_json = COALESCE(?, execution_json), updated_at = ? WHERE id = ?
      `).run(expiresAt, execution === undefined ? null : stableJson(execution), timestamp, actionId);
      return this._row(actionId);
    });
    return this._normalized(transaction.immediate());
  }

  _processRow(processId) {
    return this.db.prepare(
      'SELECT * FROM privileged_action_processes WHERE process_id = ?'
    ).get(String(processId || '')) || null;
  }

  _normalizedProcess(row) {
    if (!row) return null;
    return {
      processId: row.process_id,
      actionId: row.action_id,
      purpose: row.purpose,
      markerHash: row.marker_hash,
      argvHash: row.argv_hash,
      pid: row.pid,
      processStartTicks: row.process_start_ticks,
      processGroupId: row.process_group_id,
      state: row.state,
      preparedAt: row.prepared_at,
      spawnedAt: row.spawned_at,
      quiescedAt: row.quiesced_at,
      updatedAt: row.updated_at,
      evidence: parseJson(row.evidence_json, null),
    };
  }

  prepareProcessExecution({
    actionId,
    leaseToken,
    workerId,
    processId,
    purpose,
    markerHash,
    argvHash,
  }) {
    const normalizedProcessId = bounded(processId, 'processId');
    const normalizedPurpose = String(purpose || '');
    if (!['main', 'observation'].includes(normalizedPurpose)) {
      storeError('INVALID_ARGUMENT', 'purpose must be main or observation.');
    }
    const normalizedMarkerHash = sha256Hex(markerHash, 'markerHash');
    const normalizedArgvHash = sha256Hex(argvHash, 'argvHash');
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const action = this._row(actionId);
      this._assertLease(action, leaseToken, workerId);
      const previousExecution = parseJson(action.execution_json, {});
      this.db.prepare(`
        INSERT INTO privileged_action_processes (
          process_id, action_id, purpose, marker_hash, argv_hash, state,
          prepared_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)
      `).run(
        normalizedProcessId,
        actionId,
        normalizedPurpose,
        normalizedMarkerHash,
        normalizedArgvHash,
        timestamp,
        timestamp
      );
      this.db.prepare(`
        UPDATE privileged_actions SET revision = revision + 1,
          execution_json = ?, updated_at = ? WHERE id = ?
      `).run(stableJson({
        ...previousExecution,
        stage: 'process_spawn_prepared',
        process_id: normalizedProcessId,
        purpose: normalizedPurpose,
        argv_sha256: normalizedArgvHash,
        prepared_at: timestamp,
      }), timestamp, actionId);
      this._append({
        actionId,
        eventType: 'process_spawn_prepared',
        actor: workerId,
        details: {
          processId: normalizedProcessId,
          purpose: normalizedPurpose,
          argvHash: normalizedArgvHash,
        },
        timestamp,
      });
      return this._processRow(normalizedProcessId);
    });
    return this._normalizedProcess(transaction.immediate());
  }

  recordProcessSpawned({
    actionId,
    leaseToken,
    workerId,
    processId,
    markerHash,
    pid,
    processStartTicks,
    processGroupId,
  }) {
    const normalizedPid = Number(pid);
    const normalizedGroup = Number(processGroupId);
    const normalizedStart = String(processStartTicks || '');
    if (!Number.isInteger(normalizedPid) || normalizedPid <= 1 ||
        !Number.isInteger(normalizedGroup) || normalizedGroup <= 1 ||
        !/^\d+$/.test(normalizedStart)) {
      storeError('INVALID_ARGUMENT', 'The spawned Linux process identity is invalid.');
    }
    const normalizedMarkerHash = sha256Hex(markerHash, 'markerHash');
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const action = this._row(actionId);
      this._assertLease(action, leaseToken, workerId);
      const processRow = this._processRow(processId);
      if (!processRow || processRow.action_id !== actionId || processRow.state !== 'prepared' ||
          processRow.marker_hash !== normalizedMarkerHash) {
        storeError(
          'PROCESS_RECORD_MISMATCH',
          'The durable process preparation does not match the spawned process.'
        );
      }
      this.db.prepare(`
        UPDATE privileged_action_processes
        SET pid = ?, process_start_ticks = ?, process_group_id = ?, state = 'spawned',
          spawned_at = ?, updated_at = ?
        WHERE process_id = ? AND state = 'prepared'
      `).run(
        normalizedPid,
        normalizedStart,
        normalizedGroup,
        timestamp,
        timestamp,
        processId
      );
      const previousExecution = parseJson(action.execution_json, {});
      this.db.prepare(`
        UPDATE privileged_actions SET revision = revision + 1,
          execution_json = ?, updated_at = ? WHERE id = ?
      `).run(stableJson({
        ...previousExecution,
        stage: 'process_spawned',
        process_id: processId,
        purpose: processRow.purpose,
        pid: normalizedPid,
        process_start_ticks: normalizedStart,
        process_group_id: normalizedGroup,
        spawned_at: timestamp,
      }), timestamp, actionId);
      this._append({
        actionId,
        eventType: 'process_spawned',
        actor: workerId,
        details: {
          processId,
          purpose: processRow.purpose,
          pid: normalizedPid,
          processStartTicks: normalizedStart,
          processGroupId: normalizedGroup,
        },
        timestamp,
      });
      return this._processRow(processId);
    });
    return this._normalizedProcess(transaction.immediate());
  }

  getProcessRecord(processId) {
    return this._normalizedProcess(this._processRow(processId));
  }

  listProcessRecoveryRecords({ includeQuiesced = false } = {}) {
    const rows = includeQuiesced
      ? this.db.prepare(`
          SELECT * FROM privileged_action_processes ORDER BY prepared_at, process_id
        `).all()
      : this.db.prepare(`
          SELECT * FROM privileged_action_processes WHERE state != 'quiesced'
          ORDER BY prepared_at, process_id
        `).all();
    return rows.map((row) => this._normalizedProcess(row));
  }

  markProcessRecoveryBlocked({ processId, reason, evidence = null, actor = 'root_broker_recovery' }) {
    const timestamp = this._now();
    const normalizedReason = bounded(reason, 'reason', 1000);
    const transaction = this.db.transaction(() => {
      const row = this._processRow(processId);
      if (!row) storeError('PROCESS_RECORD_NOT_FOUND', 'The process record was not found.');
      if (row.state === 'quiesced') {
        storeError('PROCESS_ALREADY_QUIESCED', 'A quiesced process record cannot be blocked.');
      }
      this.db.prepare(`
        UPDATE privileged_action_processes SET state = 'recovery_blocked',
          evidence_json = ?, updated_at = ? WHERE process_id = ?
      `).run(stableJson({ reason: normalizedReason, ...(evidence || {}) }), timestamp, processId);
      this._append({
        actionId: row.action_id,
        eventType: 'process_recovery_blocked',
        actor,
        details: { processId, reason: normalizedReason },
        timestamp,
      });
      return this._processRow(processId);
    });
    return this._normalizedProcess(transaction.immediate());
  }

  recordProcessQuiesced({ processId, markerHash, evidence = null, actor = 'root_broker' }) {
    const normalizedMarkerHash = sha256Hex(markerHash, 'markerHash');
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const row = this._processRow(processId);
      if (!row) storeError('PROCESS_RECORD_NOT_FOUND', 'The process record was not found.');
      const left = Buffer.from(row.marker_hash, 'hex');
      const right = Buffer.from(normalizedMarkerHash, 'hex');
      if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        storeError('PROCESS_RECORD_MISMATCH', 'The process marker does not match its durable record.');
      }
      if (row.state === 'quiesced') return row;
      this.db.prepare(`
        UPDATE privileged_action_processes SET state = 'quiesced', quiesced_at = ?,
          evidence_json = ?, updated_at = ? WHERE process_id = ?
      `).run(timestamp, stableJson(evidence || {}), timestamp, processId);
      this._append({
        actionId: row.action_id,
        eventType: 'process_quiesced',
        actor,
        details: { processId, purpose: row.purpose },
        timestamp,
      });
      return this._processRow(processId);
    });
    return this._normalizedProcess(transaction.immediate());
  }

  _finish({ actionId, leaseToken, workerId, state, result = null, errorCode = null,
    errorMessage = null, actor = workerId }) {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const row = this._row(actionId);
      this._assertLease(row, leaseToken, workerId);
      if (state === 'completed' && row.state === 'cancel_requested') {
        storeError('CANCEL_REQUESTED', 'A canceled privileged action cannot complete normally.');
      }
      const normalizedErrorCode = errorCode ? bounded(errorCode, 'errorCode', 100) : null;
      this.db.prepare(`
        UPDATE privileged_actions SET state = ?, revision = revision + 1,
          worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
          result_json = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        state, result === null ? null : stableJson(result), normalizedErrorCode,
        errorMessage ? String(errorMessage).slice(0, 16000) : null,
        timestamp, timestamp, actionId
      );
      this._append({
        actionId,
        eventType: state,
        actor,
        details: { errorCode: normalizedErrorCode, resultAvailable: result !== null },
        timestamp,
      });
      return this._row(actionId);
    });
    return this._normalized(transaction.immediate());
  }

  completeAction(input) {
    return this._finish({ ...input, state: 'completed' });
  }

  failAction(input) {
    return this._finish({ ...input, state: 'failed' });
  }

  acknowledgeCanceled(input) {
    return this._finish({ ...input, state: 'canceled' });
  }

  markOutcomeUnknown(input) {
    return this._finish({
      ...input,
      state: 'outcome_unknown',
      errorCode: input.errorCode || 'PRIVILEGED_ACTION_OUTCOME_UNKNOWN',
      errorMessage: input.errorMessage ||
        'The privileged process may have changed state, but its exact outcome was not verified.',
    });
  }

  requestCancellation({ actionId, reason = 'caller_pressed_star', source = 'voice_controller',
    expectedRevision = null }) {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const row = this._row(actionId);
      if (!row) storeError('ACTION_NOT_FOUND', 'The privileged action was not found.');
      if (expectedRevision !== null && Number(expectedRevision) !== row.revision) {
        storeError('CAS_MISMATCH', 'The privileged action changed before cancellation.');
      }
      if (TERMINAL_STATES.has(row.state) || row.state === 'cancel_requested') {
        return { changed: false, row };
      }
      const nextState = row.state === 'queued' ? 'canceled' : 'cancel_requested';
      this.db.prepare(`
        UPDATE privileged_actions SET state = ?, revision = revision + 1,
          cancel_reason = ?, cancel_source = ?, completed_at = CASE WHEN ? = 'canceled' THEN ? ELSE completed_at END,
          updated_at = ? WHERE id = ? AND revision = ?
      `).run(
        nextState, bounded(reason, 'reason', 500), bounded(source, 'source'),
        nextState, timestamp, timestamp, actionId, row.revision
      );
      this._append({
        actionId,
        eventType: nextState === 'canceled' ? 'canceled' : 'cancel_requested',
        actor: source,
        details: { reason, previousState: row.state },
        timestamp,
      });
      return { changed: true, row: this._row(actionId) };
    });
    const result = transaction.immediate();
    return { changed: result.changed, action: this._normalized(result.row) };
  }

  getCancellationByIdempotencyKey(key) {
    const value = String(key || '').trim();
    if (!value) return null;
    const row = this.db.prepare(
      'SELECT * FROM privileged_action_cancellations WHERE idempotency_key = ?'
    ).get(bounded(value, 'idempotencyKey'));
    return row ? {
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id,
      reason: row.reason,
      source: row.source,
      createdAt: row.created_at,
    } : null;
  }

  requestCancellationByIdempotency({
    idempotencyKey,
    jobId,
    reason = 'caller_pressed_star',
    source = 'voice_controller',
  } = {}) {
    const key = bounded(idempotencyKey, 'idempotencyKey');
    const normalizedJobId = bounded(jobId, 'jobId');
    const normalizedReason = bounded(reason, 'reason', 500);
    const normalizedSource = bounded(source, 'source');
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const action = this.db.prepare(
        'SELECT * FROM privileged_actions WHERE idempotency_key = ?'
      ).get(key);
      if (action) {
        if (action.job_id !== normalizedJobId) {
          storeError('IDEMPOTENCY_CONFLICT', 'The cancellation key belongs to another job.');
        }
        return { tombstoned: false, action: this.requestCancellation({
          actionId: action.id,
          reason: normalizedReason,
          source: normalizedSource,
        }) };
      }
      const existing = this.db.prepare(
        'SELECT * FROM privileged_action_cancellations WHERE idempotency_key = ?'
      ).get(key);
      if (existing) {
        if (existing.job_id !== normalizedJobId) {
          storeError('IDEMPOTENCY_CONFLICT', 'The cancellation key belongs to another job.');
        }
        return { tombstoned: true, created: false, cancellation: existing };
      }
      this.db.prepare(`
        INSERT INTO privileged_action_cancellations (
          idempotency_key, job_id, reason, source, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(key, normalizedJobId, normalizedReason, normalizedSource, timestamp);
      this._append({
        eventType: 'cancellation_tombstoned',
        actor: normalizedSource,
        details: { idempotencyKey: key, jobId: normalizedJobId, reason: normalizedReason },
        timestamp,
      });
      return {
        tombstoned: true,
        created: true,
        cancellation: this.db.prepare(
          'SELECT * FROM privileged_action_cancellations WHERE idempotency_key = ?'
        ).get(key),
      };
    });
    const result = transaction.immediate();
    if (result.action) return result.action;
    return {
      tombstoned: true,
      created: result.created,
      cancellation: {
        idempotencyKey: result.cancellation.idempotency_key,
        jobId: result.cancellation.job_id,
        reason: result.cancellation.reason,
        source: result.cancellation.source,
        createdAt: result.cancellation.created_at,
      },
    };
  }

  panic({ reason = 'voice_panic_stop', source = 'voice_controller' } = {}) {
    const normalizedReason = bounded(reason, 'reason', 500);
    const normalizedSource = bounded(source, 'source');
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const control = this.db.prepare(
        'SELECT * FROM privileged_action_control WHERE singleton = 1'
      ).get();
      this.db.prepare(`
        UPDATE privileged_action_control SET panic_locked = 1, reason = ?, source = ?,
          locked_at = COALESCE(locked_at, ?), updated_at = ? WHERE singleton = 1
      `).run(normalizedReason, normalizedSource, timestamp, timestamp);
      const rows = this.db.prepare(`
        SELECT * FROM privileged_actions
        WHERE state IN ('queued', 'running', 'cancel_requested')
        ORDER BY created_at
      `).all();
      const actionIds = [];
      const canceledActionIds = [];
      for (const row of rows) {
        const nextState = row.state === 'queued' ? 'canceled' : 'cancel_requested';
        this.db.prepare(`
          UPDATE privileged_actions SET state = ?, revision = revision + 1,
            cancel_reason = ?, cancel_source = ?, completed_at = CASE WHEN ? = 'canceled' THEN ? ELSE completed_at END,
            updated_at = ? WHERE id = ? AND revision = ?
        `).run(nextState, normalizedReason, normalizedSource, nextState, timestamp, timestamp, row.id, row.revision);
        this._append({
          actionId: row.id,
          eventType: nextState === 'canceled'
            ? 'canceled'
            : (row.state === 'cancel_requested' ? 'cancel_reasserted' : 'cancel_requested'),
          actor: normalizedSource,
          details: { reason: normalizedReason, panic: true, previousState: row.state },
          timestamp,
        });
        actionIds.push(row.id);
        if (nextState === 'canceled') canceledActionIds.push(row.id);
      }
      const activeActionIds = this.db.prepare(`
        SELECT id FROM privileged_actions
        WHERE state IN ('running', 'cancel_requested') ORDER BY created_at, id
      `).all().map((row) => row.id);
      const unquiescedProcessCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM privileged_action_processes WHERE state != 'quiesced'
      `).get().count;
      const quiesced = activeActionIds.length === 0 &&
        unquiescedProcessCount === 0 && !Boolean(control.recovery_blocked);
      this._append({
        eventType: control.panic_locked ? 'panic_reasserted' : 'panic_locked',
        actor: normalizedSource,
        details: {
          reason: normalizedReason,
          actionIds,
          activeActionIds,
          canceledActionIds,
          unquiescedProcessCount,
          recoveryBlocked: Boolean(control.recovery_blocked),
          quiesced,
        },
        timestamp,
      });
      return {
        accepted: true,
        persisted: true,
        alreadyLocked: Boolean(control.panic_locked),
        actionIds,
        activeActionIds,
        activeActionCount: activeActionIds.length,
        unquiescedProcessCount,
        canceledActionIds,
        recoveryBlocked: Boolean(control.recovery_blocked),
        quiesced,
      };
    });
    const result = transaction.immediate();
    return { ...result, panic: this.getPanicStatus() };
  }

  countActiveActions() {
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM privileged_actions
      WHERE state IN ('running', 'cancel_requested')
    `).get().count;
  }

  unlockPanic({ source = 'local_operator', activeChildCount = null } = {}) {
    if (activeChildCount !== 0) {
      storeError(
        'PRIVILEGED_QUIESCENCE_UNVERIFIED',
        'Panic unlock requires a verified zero count of marked privileged child processes.'
      );
    }
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const activeActionCount = this.countActiveActions();
      if (activeActionCount !== 0) {
        storeError(
          'PRIVILEGED_ACTIONS_ACTIVE',
          'Panic unlock is refused while durable privileged actions remain active.',
          { activeActionCount }
        );
      }
      const previous = this.getPanicStatus();
      const unquiescedProcessCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM privileged_action_processes WHERE state != 'quiesced'
      `).get().count;
      if (previous.recoveryBlocked || unquiescedProcessCount !== 0) {
        storeError(
          'PRIVILEGED_RECOVERY_BLOCKED',
          'Panic unlock is refused until every durable privileged child record is verified quiescent.',
          { unquiescedProcessCount }
        );
      }
      this.db.prepare(`
        UPDATE privileged_action_control SET panic_locked = 0, reason = NULL, source = NULL,
          locked_at = NULL, updated_at = ? WHERE singleton = 1
      `).run(timestamp);
      this._append({
        eventType: previous.locked ? 'panic_unlocked' : 'panic_unlock_reasserted',
        actor: source,
        details: {
          previousReason: previous.reason,
          activeActionCount,
          activeChildCount,
          unquiescedProcessCount,
        },
        timestamp,
      });
      return previous.locked;
    });
    return { wasLocked: transaction.immediate(), panic: this.getPanicStatus() };
  }

  getPanicStatus() {
    const row = this.db.prepare(
      'SELECT * FROM privileged_action_control WHERE singleton = 1'
    ).get();
    return {
      locked: Boolean(row.panic_locked),
      recoveryBlocked: Boolean(row.recovery_blocked),
      recoveryDetails: parseJson(row.recovery_details_json, null),
      reason: row.reason,
      source: row.source,
      lockedAt: row.locked_at,
      updatedAt: row.updated_at,
    };
  }

  setRecoveryBarrier({
    reason = 'privileged_child_recovery_required',
    source = 'root_broker_recovery',
    details = {},
  } = {}) {
    const normalizedReason = bounded(reason, 'reason', 500);
    const normalizedSource = bounded(source, 'source');
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const previous = this.getPanicStatus();
      this.db.prepare(`
        UPDATE privileged_action_control
        SET panic_locked = 1, recovery_blocked = 1, recovery_details_json = ?,
          reason = ?, source = ?, locked_at = COALESCE(locked_at, ?), updated_at = ?
        WHERE singleton = 1
      `).run(
        stableJson(details || {}),
        normalizedReason,
        normalizedSource,
        timestamp,
        timestamp
      );
      this._append({
        eventType: previous.recoveryBlocked
          ? 'process_recovery_barrier_reasserted'
          : 'process_recovery_barrier_set',
        actor: normalizedSource,
        details: { reason: normalizedReason, ...(details || {}) },
        timestamp,
      });
      return this.getPanicStatus();
    });
    return transaction.immediate();
  }

  clearRecoveryBarrier({
    source = 'root_broker_recovery',
    details = {},
    activeChildCount = null,
  } = {}) {
    if (activeChildCount !== 0) {
      storeError(
        'PRIVILEGED_QUIESCENCE_UNVERIFIED',
        'Recovery can clear only after a verified zero count of marked privileged children.'
      );
    }
    const normalizedSource = bounded(source, 'source');
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const activeActionCount = this.countActiveActions();
      if (activeActionCount !== 0) {
        storeError(
          'PRIVILEGED_ACTIONS_ACTIVE',
          'Recovery cannot clear while privileged actions remain active.',
          { activeActionCount }
        );
      }
      const outstanding = this.db.prepare(`
        SELECT COUNT(*) AS count FROM privileged_action_processes WHERE state != 'quiesced'
      `).get().count;
      if (outstanding !== 0) {
        storeError(
          'PRIVILEGED_RECOVERY_BLOCKED',
          'Recovery cannot clear while a durable child process record remains unresolved.',
          { outstanding }
        );
      }
      const previous = this.getPanicStatus();
      this.db.prepare(`
        UPDATE privileged_action_control
        SET recovery_blocked = 0, recovery_details_json = NULL, updated_at = ?
        WHERE singleton = 1
      `).run(timestamp);
      this._append({
        eventType: previous.recoveryBlocked
          ? 'process_recovery_barrier_cleared'
          : 'process_recovery_barrier_clear_reasserted',
        actor: normalizedSource,
        details: { panicRemainsLocked: true, activeActionCount, ...(details || {}) },
        timestamp,
      });
      return this.getPanicStatus();
    });
    return transaction.immediate();
  }

  recoverInterrupted() {
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM privileged_actions WHERE state IN ('running', 'cancel_requested')
        ORDER BY updated_at, id
      `).all();
      const actionIds = [];
      for (const row of rows) {
        const cancellationRequested = row.state === 'cancel_requested';
        const state = 'outcome_unknown';
        const result = {
          success: false,
          code: 'PRIVILEGED_ACTION_OUTCOME_UNKNOWN',
          error: 'The root broker restarted after execution intent was durable; the action was not resent.',
          execution: parseJson(row.execution_json, null),
          cancellation_requested: cancellationRequested,
        };
        this.db.prepare(`
          UPDATE privileged_actions SET state = ?, revision = revision + 1,
            worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
            result_json = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(
          state, stableJson(result), 'PRIVILEGED_ACTION_OUTCOME_UNKNOWN',
          result.error, timestamp, timestamp, row.id, row.revision
        );
        this._append({
          actionId: row.id,
          eventType: 'outcome_unknown_after_restart',
          actor: 'root_broker_recovery',
          details: { previousState: row.state, cancellationRequested, resent: false },
          timestamp,
        });
        actionIds.push(row.id);
      }
      return actionIds;
    });
    return transaction.immediate();
  }

  listAudit({ actionId = null, afterSequence = 0, limit = 1000 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 10000));
    const rows = actionId
      ? this.db.prepare(`
          SELECT * FROM privileged_action_audit WHERE action_id = ? AND sequence > ?
          ORDER BY sequence LIMIT ?
        `).all(actionId, afterSequence, safeLimit)
      : this.db.prepare(`
          SELECT * FROM privileged_action_audit WHERE sequence > ? ORDER BY sequence LIMIT ?
        `).all(afterSequence, safeLimit);
    return rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      actionId: row.action_id,
      eventType: row.event_type,
      actor: row.actor,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }

  listOutbox({ afterSequence = 0, limit = 1000 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 10000));
    return this.db.prepare(`
      SELECT * FROM privileged_action_outbox WHERE sequence > ? ORDER BY sequence LIMIT ?
    `).all(afterSequence, safeLimit).map((row) => ({
      sequence: row.sequence,
      outboxId: row.outbox_id,
      actionId: row.action_id,
      topic: row.topic,
      payload: parseJson(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  listOutboxForConsumer({ consumerId, limit = 1000 } = {}) {
    const consumer = bounded(consumerId, 'consumerId');
    const receipt = this.db.prepare(
      'SELECT * FROM privileged_action_outbox_consumers WHERE consumer_id = ?'
    ).get(consumer);
    return {
      consumerId: consumer,
      lastSequence: receipt?.last_sequence || 0,
      events: this.listOutbox({ afterSequence: receipt?.last_sequence || 0, limit }),
    };
  }

  acknowledgeOutbox({ consumerId, sequence, expectedPrevious = null } = {}) {
    const consumer = bounded(consumerId, 'consumerId');
    const nextSequence = Number.parseInt(sequence, 10);
    if (!Number.isInteger(nextSequence) || nextSequence < 0) {
      storeError('INVALID_ARGUMENT', 'sequence must be a non-negative integer.');
    }
    const timestamp = this._now();
    const transaction = this.db.transaction(() => {
      const receipt = this.db.prepare(
        'SELECT * FROM privileged_action_outbox_consumers WHERE consumer_id = ?'
      ).get(consumer);
      const previous = receipt?.last_sequence || 0;
      if (expectedPrevious !== null && Number(expectedPrevious) !== previous) {
        storeError('CAS_MISMATCH', 'The outbox consumer cursor changed.');
      }
      if (nextSequence < previous) {
        storeError('CAS_MISMATCH', 'An outbox consumer cursor cannot move backward.');
      }
      const maximum = this.db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM privileged_action_outbox'
      ).get().sequence;
      if (nextSequence > maximum) {
        storeError('INVALID_ARGUMENT', 'The outbox cursor cannot advance past durable events.');
      }
      this.db.prepare(`
        INSERT INTO privileged_action_outbox_consumers (consumer_id, last_sequence, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(consumer_id) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          updated_at = excluded.updated_at
      `).run(consumer, nextSequence, timestamp);
      return { consumerId: consumer, previousSequence: previous, lastSequence: nextSequence };
    });
    return transaction.immediate();
  }
}

module.exports = {
  PrivilegedActionStore,
  PrivilegedActionStoreError,
  assertSecureStoragePath,
};
