'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ACTIVE_JOB_STATUSES = [
  'awaiting_approval',
  'queued',
  'running',
  'reconciling',
  'cancel_requested',
];
const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'canceled', 'outcome_unknown'];
const OUTBOUND_QUIESCENCE_CONFIRMATION = 'PBX_AND_MEDIA_QUIESCENCE_VERIFIED';

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serialize(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function withoutProviderSessionFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const sanitized = { ...value };
  delete sanitized.session_id;
  delete sanitized.sessionId;
  return sanitized;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sanitizeOutboundRequest(request) {
  const safe = request && typeof request === 'object' && !Array.isArray(request)
    ? { ...request }
    : {};
  delete safe.webhookUrl;
  delete safe.dialUri;
  return safe;
}

function normalizePreferenceKey(key) {
  return String(key || '').trim().toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '_').slice(0, 80);
}

function normalizeThread(row) {
  if (!row) return null;
  const normalized = {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
  // Legacy Contact-derived callback routes are intentionally neither exposed
  // nor reused. Outbound routing is server-owned.
  delete normalized.callback_dial_uri;
  return normalized;
}

function normalizeJob(row) {
  if (!row) return null;
  const fullResult = withoutProviderSessionFields(parseJson(row.result_json, null));
  return {
    ...row,
    // These legacy columns remain only for in-place schema compatibility.
    // Provider-native continuity is never part of the voice state contract.
    resume_session_id: null,
    freshSession: Boolean(row.fresh_session),
    requiresApproval: Boolean(row.requires_approval),
    riskReasons: parseJson(row.risk_reasons_json, []),
    fullResult,
    jobKind: row.job_kind || 'managed_agent',
    operation: parseJson(row.operation_json, null),
    approvalArmed: Boolean(row.approval_armed_at),
    approvalArmMetadata: parseJson(row.approval_arm_metadata_json, null),
    approvalArmCallId: row.approval_arm_call_id || null,
    approvalArmRealtimeSessionId: row.approval_arm_realtime_session_id || null,
  };
}

class VoiceStateStore {
  constructor({
    dbPath = ':memory:',
    managePermissions = true,
  } = {}) {
    this.dbPath = dbPath;

    if (dbPath !== ':memory:' && managePermissions) {
      const stateDirectory = path.dirname(dbPath);
      fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      fs.chmodSync(stateDirectory, 0o700);
    }

    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      // Approval, job, audit, and callback-outbox rows share commit truth. FULL
      // prevents an acknowledged WAL commit from being lost on power failure.
      this.db.pragma('synchronous = FULL');
    }

    this._migrate();
    if (dbPath !== ':memory:' && managePermissions) fs.chmodSync(dbPath, 0o600);
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS voice_threads (
        id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        selected_profile TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT NOT NULL DEFAULT '',
        callback_target TEXT,
        callback_dial_uri TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS voice_threads_caller_updated_idx
        ON voice_threads(caller_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS realtime_sessions (
        id TEXT PRIMARY KEY,
        voice_thread_id TEXT NOT NULL REFERENCES voice_threads(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        openai_session_id TEXT,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connecting',
        error TEXT,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS realtime_sessions_thread_idx
        ON realtime_sessions(voice_thread_id, opened_at DESC);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        voice_thread_id TEXT NOT NULL REFERENCES voice_threads(id) ON DELETE CASCADE,
        profile TEXT NOT NULL,
        provider TEXT NOT NULL,
        bridge_session_key TEXT NOT NULL,
        provider_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (voice_thread_id, profile)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        voice_thread_id TEXT NOT NULL REFERENCES voice_threads(id) ON DELETE CASCADE,
        realtime_session_id TEXT NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        provider TEXT NOT NULL,
        request TEXT NOT NULL,
        job_kind TEXT NOT NULL DEFAULT 'managed_agent',
        operation_json TEXT,
        fresh_session INTEGER NOT NULL DEFAULT 0,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        notification_mode TEXT NOT NULL DEFAULT 'in_call',
        status TEXT NOT NULL,
        voice_result TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (realtime_session_id, tool_call_id)
      );

      CREATE INDEX IF NOT EXISTS jobs_thread_created_idx
        ON jobs(voice_thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_profile_status_idx
        ON jobs(voice_thread_id, profile, status);

      CREATE TABLE IF NOT EXISTS job_callback_outbox (
        idempotency_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS job_callback_outbox_due_idx
        ON job_callback_outbox(state, available_at, lease_expires_at);

      CREATE TABLE IF NOT EXISTS outbound_call_inbox (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        call_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        intent_at TEXT,
        terminal_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS operator_preferences (
        caller_id TEXT NOT NULL,
        preference_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (caller_id, preference_key)
      );

      CREATE TABLE IF NOT EXISTS operation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        voice_thread_id TEXT REFERENCES voice_threads(id) ON DELETE SET NULL,
        realtime_session_id TEXT REFERENCES realtime_sessions(id) ON DELETE SET NULL,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        caller_id TEXT NOT NULL,
        action TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        profile TEXT,
        request_hash TEXT,
        scope_text TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS operation_audit_thread_idx
        ON operation_audit(voice_thread_id, id DESC);
      CREATE INDEX IF NOT EXISTS operation_audit_job_idx
        ON operation_audit(job_id, id ASC);

      CREATE TABLE IF NOT EXISTS realtime_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        voice_thread_id TEXT NOT NULL REFERENCES voice_threads(id) ON DELETE CASCADE,
        realtime_session_id TEXT NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        model TEXT,
        usage_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS realtime_usage_thread_idx
        ON realtime_usage(voice_thread_id, id ASC);
      CREATE INDEX IF NOT EXISTS realtime_usage_session_idx
        ON realtime_usage(realtime_session_id, id ASC);

      CREATE TABLE IF NOT EXISTS voice_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voice_thread_id TEXT NOT NULL REFERENCES voice_threads(id) ON DELETE CASCADE,
        realtime_session_id TEXT REFERENCES realtime_sessions(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS voice_events_thread_idx
        ON voice_events(voice_thread_id, id DESC);

      CREATE TRIGGER IF NOT EXISTS operation_audit_append_only_update
      BEFORE UPDATE ON operation_audit
      BEGIN
        SELECT RAISE(ABORT, 'operation_audit is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS operation_audit_append_only_delete
      BEFORE DELETE ON operation_audit
      BEGIN
        SELECT RAISE(ABORT, 'operation_audit is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS voice_events_append_only_update
      BEFORE UPDATE ON voice_events
      BEGIN
        SELECT RAISE(ABORT, 'voice_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS voice_events_append_only_delete
      BEFORE DELETE ON voice_events
      BEGIN
        SELECT RAISE(ABORT, 'voice_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS realtime_usage_append_only_update
      BEFORE UPDATE ON realtime_usage
      BEGIN
        SELECT RAISE(ABORT, 'realtime_usage is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS realtime_usage_append_only_delete
      BEFORE DELETE ON realtime_usage
      BEGIN
        SELECT RAISE(ABORT, 'realtime_usage is append-only');
      END;
    `);

    this._addColumnIfMissing('voice_threads', 'focused_approval_job_id', 'TEXT');
    this._addColumnIfMissing('jobs', 'risk_level', "TEXT NOT NULL DEFAULT 'read_only'");
    this._addColumnIfMissing('jobs', 'job_kind', "TEXT NOT NULL DEFAULT 'managed_agent'");
    this._addColumnIfMissing('jobs', 'operation_json', 'TEXT');
    this._addColumnIfMissing('jobs', 'risk_reasons_json', "TEXT NOT NULL DEFAULT '[]'");
    this._addColumnIfMissing('jobs', 'request_hash', 'TEXT');
    this._addColumnIfMissing('jobs', 'approval_summary', 'TEXT');
    this._addColumnIfMissing('jobs', 'approved_at', 'TEXT');
    this._addColumnIfMissing('jobs', 'approval_method', 'TEXT');
    this._addColumnIfMissing('jobs', 'approval_prompt_hash', 'TEXT');
    this._addColumnIfMissing('jobs', 'approval_prompt_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumnIfMissing('jobs', 'approval_armed_at', 'TEXT');
    this._addColumnIfMissing('jobs', 'approval_arm_metadata_json', 'TEXT');
    this._addColumnIfMissing('jobs', 'approval_arm_call_id', 'TEXT');
    this._addColumnIfMissing('jobs', 'approval_arm_realtime_session_id', 'TEXT');
    const notificationStatusAdded = this._addColumnIfMissing(
      'jobs',
      'notification_status',
      "TEXT NOT NULL DEFAULT 'pending'"
    );
    this._addColumnIfMissing('jobs', 'notification_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumnIfMissing('jobs', 'notification_last_attempt_at', 'TEXT');
    this._addColumnIfMissing('jobs', 'notification_delivered_at', 'TEXT');
    this._addColumnIfMissing('jobs', 'bridge_session_key', 'TEXT');
    this._addColumnIfMissing('jobs', 'resume_session_id', 'TEXT');
    // One-way Route B migration: keep Teleagent's bridge key, but erase every
    // provider-native session identifier before any recoverable job is read.
    this.db.prepare(`
      UPDATE agent_sessions SET provider_session_id = NULL
      WHERE provider_session_id IS NOT NULL
    `).run();
    this.db.prepare(`
      UPDATE jobs SET resume_session_id = NULL
      WHERE resume_session_id IS NOT NULL
    `).run();
    for (const row of this.db.prepare(`
      SELECT id, result_json FROM jobs WHERE result_json IS NOT NULL
    `).all()) {
      const result = parseJson(row.result_json, null);
      if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
      if (!Object.hasOwn(result, 'session_id') && !Object.hasOwn(result, 'sessionId')) continue;
      delete result.session_id;
      delete result.sessionId;
      this.db.prepare('UPDATE jobs SET result_json = ? WHERE id = ?')
        .run(serialize(result), row.id);
    }
    this._addColumnIfMissing('jobs', 'executor_task_id', 'TEXT');
    this._addColumnIfMissing('jobs', 'reconcile_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumnIfMissing('jobs', 'reconcile_after', 'TEXT');
    this._addColumnIfMissing('jobs', 'lifecycle_revision', 'INTEGER NOT NULL DEFAULT 0');
    if (notificationStatusAdded) {
      // Terminal rows that predate durable delivery tracking may already have
      // been announced. Do not replay an unbounded legacy backlog on resume.
      this.db.prepare(`
        UPDATE jobs SET notification_status = 'skipped'
        WHERE status IN ('completed', 'failed', 'canceled')
      `).run();
    }
    const callbackBackfillAt = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO job_callback_outbox (
        idempotency_key, job_id, state, attempts, available_at,
        created_at, updated_at
      )
      SELECT 'callback:' || id, id, 'pending', notification_attempts, ?,
             COALESCE(completed_at, updated_at), ?
      FROM jobs
      WHERE notification_mode = 'callback'
        AND status IN ('completed', 'failed', 'outcome_unknown')
        AND notification_status IN ('pending', 'attempted')
    `).run(callbackBackfillAt, callbackBackfillAt);
    this._addColumnIfMissing('approvals', 'method', 'TEXT');
    this._addColumnIfMissing('approvals', 'decided_by', 'TEXT');
    this._addColumnIfMissing('approvals', 'decision_metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    this._addColumnIfMissing('outbound_call_inbox', 'request_json', "TEXT NOT NULL DEFAULT '{}'");
    this._addColumnIfMissing('outbound_call_inbox', 'error', 'TEXT');
    this._addColumnIfMissing('outbound_call_inbox', 'intent_at', 'TEXT');
    this._addColumnIfMissing('outbound_call_inbox', 'terminal_at', 'TEXT');
    this._addColumnIfMissing('outbound_call_inbox', 'cancellation_requested_at', 'TEXT');
    this._addColumnIfMissing('outbound_call_inbox', 'recovery_barrier_at', 'TEXT');
    this._addColumnIfMissing('outbound_call_inbox', 'recovery_barrier_resolved_at', 'TEXT');
    this._addColumnIfMissing('outbound_call_inbox', 'recovery_barrier_resolution', 'TEXT');
    this._addColumnIfMissing('job_callback_outbox', 'outbound_call_id', 'TEXT');
    this._addColumnIfMissing('job_callback_outbox', 'outbound_handoff_at', 'TEXT');
    this._addColumnIfMissing('job_callback_outbox', 'outbound_terminal_state', 'TEXT');
    this.db.prepare(`
      UPDATE outbound_call_inbox SET state = 'queued'
      WHERE state = 'reserved'
    `).run();
    this._removeLegacyOutboundUnsafeData();
  }

  _removeLegacyOutboundUnsafeData() {
    this.db.prepare(`
      UPDATE voice_threads SET callback_dial_uri = NULL
      WHERE callback_dial_uri IS NOT NULL
    `).run();
    const rows = this.db.prepare(`
      SELECT idempotency_key, request_json
      FROM outbound_call_inbox
      WHERE request_json LIKE '%"webhookUrl"%'
         OR request_json LIKE '%"dialUri"%'
    `).all();
    const update = this.db.prepare(`
      UPDATE outbound_call_inbox
      SET request_json = ?, request_hash = ?, updated_at = ?
      WHERE idempotency_key = ?
    `);
    const scrub = this.db.transaction(() => {
      for (const row of rows) {
        const request = parseJson(row.request_json, {});
        if (!request || typeof request !== 'object') continue;
        const hadUnsafeRoute = Object.hasOwn(request, 'webhookUrl') ||
          Object.hasOwn(request, 'dialUri');
        if (!hadUnsafeRoute) continue;
        delete request.webhookUrl;
        delete request.dialUri;
        update.run(
          serialize(request) || '{}',
          crypto.createHash('sha256').update(canonicalJson(request)).digest('hex'),
          nowIso(),
          row.idempotency_key
        );
      }
    });
    scrub.immediate();
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

  health() {
    const result = this.db.prepare('SELECT 1 AS ok').get();
    return {
      ok: result?.ok === 1,
      durable: this.dbPath !== ':memory:',
    };
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  recoverInterruptedJobs() {
    const timestamp = nowIso();
    return this.db.prepare(`
      UPDATE jobs
      SET status = 'reconciling',
          error = 'Voice service restarted; durable executor reconciliation is pending.',
          completed_at = NULL,
          reconcile_after = ?,
          lifecycle_revision = lifecycle_revision + 1,
          updated_at = ?
      WHERE status = 'running'
    `).run(timestamp, timestamp).changes;
  }

  recoverInterruptedOutboundCalls() {
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const interrupted = this.db.prepare(`
        SELECT idempotency_key, call_id, state FROM outbound_call_inbox
        WHERE state IN ('dial_intent', 'accepted', 'cancel_requested')
      `).all();
      if (interrupted.length === 0) return 0;
      const result = this.db.prepare(`
        UPDATE outbound_call_inbox
        SET state = 'outcome_unknown',
            error = CASE
              WHEN state = 'cancel_requested'
                THEN 'Voice service restarted before outbound cancellation quiescence was confirmed.'
              ELSE 'Voice service restarted after the durable dial intent; the call was not redialed.'
            END,
            recovery_barrier_at = COALESCE(recovery_barrier_at, ?),
            recovery_barrier_resolved_at = NULL,
            recovery_barrier_resolution = NULL,
            terminal_at = COALESCE(terminal_at, ?), updated_at = ?
        WHERE state IN ('dial_intent', 'accepted', 'cancel_requested')
      `).run(timestamp, timestamp, timestamp);
      for (const row of interrupted) {
        this._reconcileCallbackForOutbound(row.idempotency_key, timestamp);
        this.appendAuditEvent({
          callerId: 'system',
          action: 'outbound_recovery_barrier_armed',
          riskLevel: 'high',
          scopeText: row.call_id,
          metadata: {
            call_id: row.call_id,
            prior_state: row.state,
            reason: 'voice_runtime_restart',
          },
        });
      }
      return result.changes;
    });
    return transaction.immediate();
  }

  recoverInterruptedRealtimeSessions() {
    const sessions = this.db.prepare(`
      SELECT realtime_sessions.*, voice_threads.caller_id
      FROM realtime_sessions
      JOIN voice_threads ON voice_threads.id = realtime_sessions.voice_thread_id
      WHERE realtime_sessions.status IN ('connecting', 'connected')
    `).all();
    if (sessions.length === 0) return 0;

    const timestamp = nowIso();
    const error = 'Voice service restarted before the Realtime call closed.';
    const recover = this.db.transaction(() => {
      const updateSession = this.db.prepare(`
        UPDATE realtime_sessions
        SET status = 'failed', error = ?, closed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('connecting', 'connected')
      `);
      const closeThread = this.db.prepare(`
        UPDATE voice_threads
        SET status = 'idle', closed_at = ?, updated_at = ?
        WHERE id = ?
      `);

      for (const session of sessions) {
        updateSession.run(error, timestamp, timestamp, session.id);
        this.appendAuditEvent({
          voiceThreadId: session.voice_thread_id,
          realtimeSessionId: session.id,
          callerId: session.caller_id,
          action: 'realtime_session_recovered',
          riskLevel: 'read_only',
          scopeText: `call=${session.call_id}`,
          metadata: {
            previous_status: session.status,
            model: session.model,
            reason: 'voice_service_restart',
          },
        });
      }
      for (const threadId of new Set(sessions.map((session) => session.voice_thread_id))) {
        closeThread.run(timestamp, timestamp, threadId);
      }
    });
    recover();
    return sessions.length;
  }

  createThread({
    callerId,
    selectedProfile = 'codex-terra',
    callbackTarget = null,
    metadata = {},
  }) {
    const id = makeId('vt');
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO voice_threads (
        id, caller_id, selected_profile, callback_target,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(callerId || 'unknown'),
      selectedProfile,
      callbackTarget,
      serialize(metadata) || '{}',
      timestamp,
      timestamp
    );
    return this.getThread(id);
  }

  getThread(threadId) {
    return normalizeThread(
      this.db.prepare('SELECT * FROM voice_threads WHERE id = ?').get(threadId)
    );
  }

  findResumableThread(callerId, { ttlSeconds = null } = {}) {
    const row = this.db.prepare(`
      SELECT *
      FROM voice_threads
      WHERE caller_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(String(callerId || 'unknown'));

    if (!row) return { thread: null, reason: 'not_found' };

    const ttl = Number.parseInt(ttlSeconds, 10);
    if (Number.isInteger(ttl) && ttl > 0) {
      const updatedAt = Date.parse(row.updated_at);
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > ttl * 1000) {
        return { thread: null, reason: 'expired' };
      }
    }

    return { thread: normalizeThread(row), reason: 'found' };
  }

  resolveThread({
    callerId,
    resume = false,
    selectedProfile = 'codex-terra',
    resumeTtlSeconds = null,
    callbackTarget = null,
    metadata = {},
  }) {
    if (resume) {
      const found = this.findResumableThread(callerId, { ttlSeconds: resumeTtlSeconds });
      if (found.thread) {
        this.touchThread(found.thread.id, { callbackTarget });
        return { thread: this.getThread(found.thread.id), resumed: true, reason: 'found' };
      }

      return {
        thread: this.createThread({
          callerId,
          selectedProfile,
          callbackTarget,
          metadata,
        }),
        resumed: false,
        reason: found.reason,
      };
    }

    return {
      thread: this.createThread({
        callerId,
        selectedProfile,
        callbackTarget,
        metadata,
      }),
      resumed: false,
      reason: 'fresh',
    };
  }

  touchThread(threadId, { callbackTarget } = {}) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE voice_threads
      SET updated_at = ?,
          status = 'active',
          closed_at = NULL,
          callback_target = COALESCE(?, callback_target),
          callback_dial_uri = NULL
      WHERE id = ?
    `).run(timestamp, callbackTarget || null, threadId);
  }

  closeThread(threadId) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE voice_threads
      SET status = 'idle', closed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, threadId);
  }

  setSelectedProfile(threadId, profile) {
    this.db.prepare(`
      UPDATE voice_threads SET selected_profile = ?, updated_at = ? WHERE id = ?
    `).run(profile, nowIso(), threadId);
    return this.getThread(threadId);
  }

  createRealtimeSession({ voiceThreadId, callId, model }) {
    const id = makeId('rts');
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO realtime_sessions (
        id, voice_thread_id, call_id, model, opened_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, voiceThreadId, callId, model, timestamp, timestamp);
    this.touchThread(voiceThreadId);
    return this.getRealtimeSession(id);
  }

  getRealtimeSession(sessionId) {
    return this.db.prepare('SELECT * FROM realtime_sessions WHERE id = ?').get(sessionId) || null;
  }

  markRealtimeSessionConnected(sessionId, openaiSessionId) {
    this.db.prepare(`
      UPDATE realtime_sessions
      SET openai_session_id = ?, status = 'connected', updated_at = ?
      WHERE id = ?
    `).run(openaiSessionId || null, nowIso(), sessionId);
  }

  markRealtimeSessionClosed(sessionId, { error = null } = {}) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE realtime_sessions
      SET status = ?, error = ?, closed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(error ? 'failed' : 'closed', error, timestamp, timestamp, sessionId);
  }

  appendEvent({ voiceThreadId, realtimeSessionId = null, role, kind, content }) {
    const value = String(content || '').trim();
    if (!value) return null;

    const timestamp = nowIso();
    const clipped = value.slice(0, 8000);
    const result = this.db.prepare(`
      INSERT INTO voice_events (
        voice_thread_id, realtime_session_id, role, kind, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(voiceThreadId, realtimeSessionId, role, kind, clipped, timestamp);

    this._refreshSummary(voiceThreadId);
    return result.lastInsertRowid;
  }

  _refreshSummary(threadId) {
    const events = this.db.prepare(`
      SELECT role, kind, content
      FROM voice_events
      WHERE voice_thread_id = ?
      ORDER BY id DESC
      LIMIT 12
    `).all(threadId).reverse();

    const summary = events
      .map((event) => `${event.role}/${event.kind}: ${event.content.replaceAll(/\s+/g, ' ').slice(0, 500)}`)
      .join('\n')
      .slice(-6000);

    this.db.prepare(`
      UPDATE voice_threads SET summary = ?, updated_at = ? WHERE id = ?
    `).run(summary, nowIso(), threadId);
  }

  listRecentEvents(threadId, limit = 12) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 12, 500));
    return this.db.prepare(`
      SELECT id, role, kind, content, created_at
      FROM voice_events
      WHERE voice_thread_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(threadId, safeLimit).reverse();
  }

  listCallerEvents(callerId, { limit = 20, role = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 20, 200));
    const rows = role
      ? this.db.prepare(`
          SELECT e.id, e.voice_thread_id, e.realtime_session_id, e.role, e.kind, e.content, e.created_at
          FROM voice_events e
          JOIN voice_threads t ON t.id = e.voice_thread_id
          WHERE t.caller_id = ? AND e.role = ?
          ORDER BY e.id DESC
          LIMIT ?
        `).all(String(callerId || 'unknown'), role, safeLimit)
      : this.db.prepare(`
          SELECT e.id, e.voice_thread_id, e.realtime_session_id, e.role, e.kind, e.content, e.created_at
          FROM voice_events e
          JOIN voice_threads t ON t.id = e.voice_thread_id
          WHERE t.caller_id = ?
          ORDER BY e.id DESC
          LIMIT ?
        `).all(String(callerId || 'unknown'), safeLimit);
    return rows.reverse();
  }

  getLatestUserEvent(threadId) {
    return this.db.prepare(`
      SELECT id, role, kind, content, created_at
      FROM voice_events
      WHERE voice_thread_id = ? AND role = 'user' AND kind = 'transcript'
      ORDER BY id DESC
      LIMIT 1
    `).get(threadId) || null;
  }

  setPreference({ callerId, key, value, sourceText = null }) {
    const preferenceKey = normalizePreferenceKey(key);
    if (!preferenceKey) throw new Error('Preference key is required');
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO operator_preferences (
        caller_id, preference_key, value_json, source_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(caller_id, preference_key) DO UPDATE SET
        value_json = excluded.value_json,
        source_text = excluded.source_text,
        updated_at = excluded.updated_at
    `).run(
      String(callerId || 'unknown'),
      preferenceKey,
      serialize(value) || 'null',
      sourceText ? String(sourceText).slice(0, 1000) : null,
      timestamp,
      timestamp
    );
    return this.getPreference(callerId, preferenceKey);
  }

  getPreference(callerId, key) {
    const row = this.db.prepare(`
      SELECT * FROM operator_preferences WHERE caller_id = ? AND preference_key = ?
    `).get(String(callerId || 'unknown'), normalizePreferenceKey(key));
    return row ? { ...row, value: parseJson(row.value_json, null) } : null;
  }

  listPreferences(callerId) {
    return this.db.prepare(`
      SELECT * FROM operator_preferences WHERE caller_id = ? ORDER BY preference_key
    `).all(String(callerId || 'unknown')).map((row) => ({
      ...row,
      value: parseJson(row.value_json, null),
    }));
  }

  deletePreference(callerId, key) {
    return this.db.prepare(`
      DELETE FROM operator_preferences WHERE caller_id = ? AND preference_key = ?
    `).run(String(callerId || 'unknown'), normalizePreferenceKey(key)).changes > 0;
  }

  appendAuditEvent({
    voiceThreadId = null,
    realtimeSessionId = null,
    jobId = null,
    callerId = 'unknown',
    action,
    riskLevel = 'read_only',
    profile = null,
    requestHash = null,
    scopeText = null,
    metadata = {},
  }) {
    const eventId = makeId('audit');
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO operation_audit (
        event_id, voice_thread_id, realtime_session_id, job_id, caller_id,
        action, risk_level, profile, request_hash, scope_text, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      voiceThreadId,
      realtimeSessionId,
      jobId,
      String(callerId || 'unknown'),
      String(action || 'unknown'),
      String(riskLevel || 'read_only'),
      profile,
      requestHash,
      scopeText ? String(scopeText).slice(0, 4000) : null,
      serialize(metadata) || '{}',
      createdAt
    );
    return { event_id: eventId, created_at: createdAt };
  }

  listAuditEvents({ threadId = null, jobId = null, limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    let rows;
    if (jobId) {
      rows = this.db.prepare('SELECT * FROM operation_audit WHERE job_id = ? ORDER BY id LIMIT ?').all(jobId, safeLimit);
    } else if (threadId) {
      rows = this.db.prepare('SELECT * FROM operation_audit WHERE voice_thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, safeLimit).reverse();
    } else {
      rows = this.db.prepare('SELECT * FROM operation_audit ORDER BY id DESC LIMIT ?').all(safeLimit).reverse();
    }
    return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }));
  }

  recordRealtimeUsage({
    eventKey,
    voiceThreadId,
    realtimeSessionId,
    kind,
    model = null,
    usage,
  }) {
    if (!eventKey || !usage || typeof usage !== 'object') return false;
    return this.db.prepare(`
      INSERT OR IGNORE INTO realtime_usage (
        event_key, voice_thread_id, realtime_session_id, kind, model, usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(eventKey).slice(0, 240),
      voiceThreadId,
      realtimeSessionId,
      String(kind || 'response').slice(0, 40),
      model ? String(model).slice(0, 120) : null,
      serialize(usage) || '{}',
      nowIso()
    ).changes > 0;
  }

  getRealtimeUsageSummary({ threadId = null, sessionId = null } = {}) {
    const rows = sessionId
      ? this.db.prepare('SELECT kind, model, usage_json FROM realtime_usage WHERE realtime_session_id = ? ORDER BY id').all(sessionId)
      : this.db.prepare('SELECT kind, model, usage_json FROM realtime_usage WHERE voice_thread_id = ? ORDER BY id').all(threadId);
    const summary = {
      records: rows.length,
      response_count: 0,
      transcription_count: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      input_text_tokens: 0,
      input_audio_tokens: 0,
      cached_input_tokens: 0,
      cached_text_tokens: 0,
      cached_audio_tokens: 0,
      output_text_tokens: 0,
      output_audio_tokens: 0,
      models: [],
    };
    const models = new Set();
    const add = (field, value) => {
      const number = Number(value);
      if (Number.isFinite(number)) summary[field] += number;
    };
    for (const row of rows) {
      const usage = parseJson(row.usage_json, {});
      if (row.kind === 'transcription') summary.transcription_count += 1;
      else summary.response_count += 1;
      if (row.model) models.add(row.model);
      add('total_tokens', usage.total_tokens);
      add('input_tokens', usage.input_tokens);
      add('output_tokens', usage.output_tokens);
      add('input_text_tokens', usage.input_token_details?.text_tokens);
      add('input_audio_tokens', usage.input_token_details?.audio_tokens);
      add('cached_input_tokens', usage.input_token_details?.cached_tokens);
      add('cached_text_tokens', usage.input_token_details?.cached_tokens_details?.text_tokens);
      add('cached_audio_tokens', usage.input_token_details?.cached_tokens_details?.audio_tokens);
      add('output_text_tokens', usage.output_token_details?.text_tokens);
      add('output_audio_tokens', usage.output_token_details?.audio_tokens);
    }
    summary.models = [...models];
    return summary;
  }

  getAgentSession(threadId, profile) {
    const session = this.db.prepare(`
      SELECT * FROM agent_sessions WHERE voice_thread_id = ? AND profile = ?
    `).get(threadId, profile) || null;
    return session ? { ...session, provider_session_id: null } : null;
  }

  listAgentSessions(threadId) {
    return this.db.prepare(`
      SELECT
        s.profile,
        s.provider,
        s.bridge_session_key,
        s.created_at,
        s.updated_at,
        j.id AS latest_job_id,
        j.status AS latest_job_status,
        j.voice_result AS latest_voice_result
      FROM agent_sessions s
      LEFT JOIN jobs j ON j.id = (
        SELECT id FROM jobs
        WHERE voice_thread_id = s.voice_thread_id AND profile = s.profile
        ORDER BY created_at DESC LIMIT 1
      )
      WHERE s.voice_thread_id = ?
      ORDER BY s.profile
    `).all(threadId);
  }

  upsertAgentSession({
    voiceThreadId,
    profile,
    provider,
    bridgeSessionKey,
  }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO agent_sessions (
        voice_thread_id, profile, provider, bridge_session_key,
        provider_session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(voice_thread_id, profile) DO UPDATE SET
        provider = excluded.provider,
        bridge_session_key = excluded.bridge_session_key,
        provider_session_id = NULL,
        updated_at = excluded.updated_at
    `).run(
      voiceThreadId,
      profile,
      provider,
      bridgeSessionKey,
      timestamp,
      timestamp
    );
    return this.getAgentSession(voiceThreadId, profile);
  }

  clearAgentSession(threadId, profile) {
    return this.db.prepare(`
      DELETE FROM agent_sessions WHERE voice_thread_id = ? AND profile = ?
    `).run(threadId, profile).changes > 0;
  }

  createJob({
    voiceThreadId,
    realtimeSessionId,
    toolCallId,
    profile,
    provider,
    request,
    jobKind = 'managed_agent',
    operation = null,
    freshSession = false,
    requiresApproval = false,
    notificationMode = 'in_call',
    riskLevel = 'read_only',
    riskReasons = [],
    requestHash = null,
    approvalSummary = null,
    approvalPrompt = null,
    auditAction = null,
    auditMetadata = {},
    event = null,
  }) {
    const transaction = this.db.transaction(() => {
      const duplicate = this.db.prepare(`
        SELECT * FROM jobs WHERE realtime_session_id = ? AND tool_call_id = ?
      `).get(realtimeSessionId, toolCallId);
      if (duplicate) {
        return { created: false, duplicate: true, job: normalizeJob(duplicate) };
      }

      const busy = this.db.prepare(`
        SELECT * FROM jobs
        WHERE voice_thread_id = ? AND profile = ?
          AND status IN ('awaiting_approval', 'queued', 'running', 'reconciling', 'cancel_requested')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(voiceThreadId, profile);
      if (busy) {
        return { created: false, duplicate: false, busy: true, job: normalizeJob(busy) };
      }

      if (requiresApproval) {
        const focused = this.db.prepare(`
          SELECT * FROM jobs
          WHERE voice_thread_id = ? AND status = 'awaiting_approval'
          ORDER BY created_at ASC LIMIT 1
        `).get(voiceThreadId);
        if (focused) {
          return {
            created: false,
            duplicate: false,
            busy: false,
            approvalBusy: true,
            job: normalizeJob(focused),
          };
        }
      }

      const id = makeId('job');
      const timestamp = nowIso();
      const status = requiresApproval ? 'awaiting_approval' : 'queued';
      const exactApprovalPrompt = requiresApproval
        ? String(approvalPrompt || '').trim()
        : '';
      if (requiresApproval && !exactApprovalPrompt) {
        throw new Error('An exact spoken approval prompt is required for approval-gated jobs.');
      }
      const approvalPromptHash = requiresApproval
        ? crypto.createHash('sha256').update(exactApprovalPrompt).digest('hex')
        : null;
      this.db.prepare(`
        INSERT INTO jobs (
          id, voice_thread_id, realtime_session_id, tool_call_id, profile,
          provider, request, job_kind, operation_json, fresh_session, requires_approval, notification_mode,
          status, risk_level, risk_reasons_json, request_hash, approval_summary,
          approval_prompt_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        voiceThreadId,
        realtimeSessionId,
        toolCallId,
        profile,
        provider,
        String(request || '').trim(),
        String(jobKind || 'managed_agent'),
        serialize(operation),
        freshSession ? 1 : 0,
        requiresApproval ? 1 : 0,
        notificationMode,
        status,
        riskLevel,
        serialize(riskReasons) || '[]',
        requestHash,
        approvalSummary,
        approvalPromptHash,
        timestamp,
        timestamp
      );

      if (requiresApproval) {
        this.db.prepare(`
          INSERT INTO approvals (id, job_id, action, status, requested_at)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(makeId('approval'), id, String(approvalSummary || request || '').trim().slice(0, 1000), timestamp);
        this.db.prepare(`
          UPDATE voice_threads SET focused_approval_job_id = ?, updated_at = ? WHERE id = ?
        `).run(id, timestamp, voiceThreadId);
      }

      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (auditAction) {
        this._recordJobEffects(row, {
          auditAction,
          auditMetadata,
          auditRiskLevel: riskLevel,
          event,
          enqueueCallback: false,
          timestamp,
        });
      }

      return { created: true, duplicate: false, busy: false, job: normalizeJob(row) };
    });

    return transaction();
  }

  getJob(jobId) {
    return normalizeJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId));
  }

  listJobs(threadId, { limit = 10, activeOnly = false } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 50));
    const rows = activeOnly
      ? this.db.prepare(`
          SELECT * FROM jobs
          WHERE voice_thread_id = ?
            AND status IN ('awaiting_approval', 'queued', 'running', 'reconciling', 'cancel_requested')
          ORDER BY created_at DESC
          LIMIT ?
        `).all(threadId, safeLimit)
      : this.db.prepare(`
          SELECT * FROM jobs
          WHERE voice_thread_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(threadId, safeLimit);
    return rows.map(normalizeJob);
  }

  findRecentEquivalentJob({
    threadId,
    profile,
    jobKind = 'managed_agent',
    requestHash,
    maxAgeMs = 300000,
  } = {}) {
    if (!threadId || !profile || !requestHash) return null;
    const cutoff = new Date(Date.now() - Math.max(1000, Number(maxAgeMs) || 300000)).toISOString();
    return normalizeJob(this.db.prepare(`
      SELECT * FROM jobs
      WHERE voice_thread_id = ? AND profile = ? AND job_kind = ?
        AND request_hash = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(threadId, profile, jobKind, requestHash, cutoff));
  }

  listAllActiveJobs() {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('awaiting_approval', 'queued', 'running', 'reconciling', 'cancel_requested')
      ORDER BY created_at ASC
    `).all().map(normalizeJob);
  }

  listRecoverableJobs() {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'queued'
         OR status IN ('reconciling', 'cancel_requested')
      ORDER BY created_at ASC
    `).all().map(normalizeJob);
  }

  markJobRunning(jobId, {
    auditAction = 'job_started',
    auditMetadata = {},
    auditRiskLevel = null,
  } = {}) {
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = 'running', started_at = COALESCE(started_at, ?),
            error = NULL, reconcile_after = NULL,
            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(timestamp, timestamp, jobId);
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (result.changes === 1) {
        this._recordJobEffects(row, {
          auditAction,
          auditMetadata,
          auditRiskLevel,
          timestamp,
        });
      }
      return result.changes === 1 ? normalizeJob(row) : null;
    });
    return transaction();
  }

  bindJobAgentSession({ jobId, provider, bridgeSessionKey }) {
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      let row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row) return { changed: false, job: null, session: null };
      const persistedSession = this.db.prepare(`
        SELECT * FROM agent_sessions WHERE voice_thread_id = ? AND profile = ?
      `).get(row.voice_thread_id, row.profile);
      if (persistedSession) persistedSession.provider_session_id = null;
      if (row.bridge_session_key) {
        const session = persistedSession?.bridge_session_key === row.bridge_session_key
          ? persistedSession
          : {
              voice_thread_id: row.voice_thread_id,
              profile: row.profile,
              provider: provider || row.provider,
              bridge_session_key: row.bridge_session_key,
              provider_session_id: null,
            };
        return { changed: false, job: normalizeJob(row), session };
      }
      if (!['queued', 'reconciling'].includes(row.status)) {
        return { changed: false, job: normalizeJob(row), session: null };
      }

      let session = row.fresh_session ? null : persistedSession;
      if (!session) {
        if (!bridgeSessionKey) throw new Error('A bridge session key is required for a new job binding');
        session = {
          voice_thread_id: row.voice_thread_id,
          profile: row.profile,
          provider: provider || row.provider,
          bridge_session_key: bridgeSessionKey,
          provider_session_id: null,
        };
      }

      const update = this.db.prepare(`
        UPDATE jobs
        SET bridge_session_key = ?, resume_session_id = NULL,
            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND bridge_session_key IS NULL
          AND status IN ('queued', 'reconciling')
      `).run(
        session.bridge_session_key,
        timestamp,
        jobId
      );
      row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      return { changed: update.changes === 1, job: normalizeJob(row), session };
    });
    return transaction();
  }

  adoptExecutorJobBinding({ jobId, bridgeSessionKey, provider = null }) {
    if (!bridgeSessionKey) return { changed: false, job: this.getJob(jobId), session: null };
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row) return { changed: false, job: null, session: null };
      const update = this.db.prepare(`
        UPDATE jobs
        SET bridge_session_key = ?, resume_session_id = NULL,
            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND (bridge_session_key IS NULL OR bridge_session_key != ?)
          AND status IN ('queued', 'running', 'reconciling', 'cancel_requested')
      `).run(bridgeSessionKey, timestamp, jobId, bridgeSessionKey);
      return {
        changed: update.changes === 1,
        job: this.getJob(jobId),
        session: {
          voice_thread_id: row.voice_thread_id,
          profile: row.profile,
          provider: provider || row.provider,
          bridge_session_key: bridgeSessionKey,
          provider_session_id: null,
        },
      };
    });
    return transaction();
  }

  _recordJobEffects(row, {
    auditAction,
    auditMetadata = {},
    auditRiskLevel = null,
    event = null,
    enqueueCallback = false,
    timestamp = nowIso(),
  } = {}) {
    const job = normalizeJob(row);
    if (!job) return;
    const thread = this.db.prepare('SELECT caller_id FROM voice_threads WHERE id = ?')
      .get(job.voice_thread_id);
    if (event?.content) {
      this.appendEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        role: event.role || 'tool',
        kind: event.kind || 'agent_result',
        content: event.content,
      });
    }
    if (auditAction) {
      this.appendAuditEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        jobId: job.id,
        callerId: thread?.caller_id || 'unknown',
        action: auditAction,
        riskLevel: auditRiskLevel || job.risk_level || 'read_only',
        profile: job.profile,
        requestHash: job.request_hash,
        scopeText: job.approval_summary || job.request,
        metadata: auditMetadata,
      });
    }
    if (enqueueCallback && job.notification_mode === 'callback' &&
        job.notification_status === 'pending') {
      this.db.prepare(`
        INSERT OR IGNORE INTO job_callback_outbox (
          idempotency_key, job_id, state, attempts, available_at,
          created_at, updated_at
        ) VALUES (?, ?, 'pending', 0, ?, ?, ?)
      `).run(`callback:${job.id}`, job.id, timestamp, timestamp, timestamp);
    }
  }

  completeJobCas(jobId, {
    fullResult = null,
    voiceResult = null,
    agentSession = null,
    auditAction = 'job_completed',
    auditMetadata = {},
    auditRiskLevel = null,
    event = null,
  } = {}) {
    const timestamp = nowIso();
    const persistedResult = withoutProviderSessionFields(fullResult);
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = 'completed', result_json = ?, voice_result = ?, error = NULL,
            completed_at = ?, reconcile_after = NULL, updated_at = ?,
            notification_status = 'pending', lifecycle_revision = lifecycle_revision + 1
        WHERE id = ? AND status IN ('running', 'reconciling', 'cancel_requested')
      `).run(serialize(persistedResult), voiceResult, timestamp, timestamp, jobId);
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (result.changes === 1) {
        if (agentSession?.bridgeSessionKey) {
          this.upsertAgentSession({
            voiceThreadId: row.voice_thread_id,
            profile: row.profile,
            provider: agentSession.provider || row.provider,
            bridgeSessionKey: agentSession.bridgeSessionKey,
          });
        }
        this._recordJobEffects(row, {
          auditAction,
          auditMetadata,
          auditRiskLevel,
          event,
          enqueueCallback: true,
          timestamp,
        });
      }
      return { changed: result.changes === 1, job: normalizeJob(row) };
    });
    return transaction();
  }

  markJobCompleted(jobId, options = {}) {
    return this.completeJobCas(jobId, options).job;
  }

  failJobCas(jobId, error, {
    auditAction = 'job_failed',
    auditMetadata = {},
    auditRiskLevel = null,
    event = null,
  } = {}) {
    const timestamp = nowIso();
    const safeError = String(error || 'Agent task failed').slice(0, 4000);
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = 'failed', error = ?, completed_at = ?, updated_at = ?,
            reconcile_after = NULL, notification_status = 'pending',
            lifecycle_revision = lifecycle_revision + 1
        WHERE id = ? AND status IN ('queued', 'running', 'reconciling', 'cancel_requested')
      `).run(safeError, timestamp, timestamp, jobId);
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (result.changes === 1) {
        this._recordJobEffects(row, {
          auditAction,
          auditMetadata: { error: safeError, ...auditMetadata },
          auditRiskLevel,
          event,
          enqueueCallback: true,
          timestamp,
        });
      }
      return { changed: result.changes === 1, job: normalizeJob(row) };
    });
    return transaction();
  }

  markJobFailed(jobId, error) {
    return this.failJobCas(jobId, error).job;
  }

  cancelJobCas(jobId, reason = 'Canceled by caller', {
    auditAction = 'job_canceled',
    auditMetadata = {},
    auditRiskLevel = null,
  } = {}) {
    const timestamp = nowIso();
    const safeReason = String(reason).slice(0, 1000);
    const transaction = this.db.transaction(() => {
      const approval = this.db.prepare(`
        UPDATE approvals SET status = 'rejected', decided_at = ?
        WHERE job_id = ? AND status = 'pending'
      `).run(timestamp, jobId);
      const update = this.db.prepare(`
        UPDATE jobs
        SET status = 'canceled', error = ?, completed_at = ?, updated_at = ?,
            reconcile_after = NULL, notification_status = 'skipped',
            lifecycle_revision = lifecycle_revision + 1
        WHERE id = ?
          AND status IN ('awaiting_approval', 'queued', 'running', 'reconciling', 'cancel_requested')
      `).run(safeReason, timestamp, timestamp, jobId);
      this.db.prepare(`
        UPDATE voice_threads
        SET focused_approval_job_id = NULL, updated_at = ?
        WHERE focused_approval_job_id = ?
      `).run(timestamp, jobId);
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (update.changes === 1) {
        this._recordJobEffects(row, {
          auditAction,
          auditMetadata: { reason: safeReason, ...auditMetadata },
          auditRiskLevel,
          enqueueCallback: false,
          timestamp,
        });
      }
      return {
        changed: update.changes === 1,
        approvalChanged: approval.changes === 1,
        job: normalizeJob(row),
      };
    });
    return transaction();
  }

  cancelJob(jobId, reason = 'Canceled by caller') {
    return this.cancelJobCas(jobId, reason).job;
  }

  requestJobCancellation(jobId, reason = 'Canceled by caller', {
    auditMetadata = {},
    requestedAuditAction = 'job_cancel_requested',
    terminalAuditAction = 'job_canceled',
  } = {}) {
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row || TERMINAL_JOB_STATUSES.includes(row.status)) {
        return { changed: false, terminal: Boolean(row), job: normalizeJob(row) };
      }
      if (row.status === 'cancel_requested') {
        return { changed: false, terminal: false, job: normalizeJob(row) };
      }
      const immediatelyCanceled = row.status === 'awaiting_approval' ||
        (row.status === 'queued' && !row.started_at);
      const nextStatus = immediatelyCanceled ? 'canceled' : 'cancel_requested';
      this.db.prepare(`
        UPDATE approvals SET status = 'rejected', decided_at = ?
        WHERE job_id = ? AND status = 'pending'
      `).run(timestamp, jobId);
      const update = this.db.prepare(`
        UPDATE jobs
        SET status = ?, error = ?,
            completed_at = CASE WHEN ? = 'canceled' THEN ? ELSE NULL END,
            notification_status = CASE WHEN ? = 'canceled' THEN 'skipped' ELSE notification_status END,
            reconcile_after = CASE WHEN ? = 'cancel_requested' THEN ? ELSE NULL END,
            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(
        nextStatus,
        String(reason).slice(0, 1000),
        nextStatus,
        timestamp,
        nextStatus,
        nextStatus,
        timestamp,
        timestamp,
        jobId,
        row.status
      );
      this.db.prepare(`
        UPDATE voice_threads SET focused_approval_job_id = NULL, updated_at = ?
        WHERE focused_approval_job_id = ?
      `).run(timestamp, jobId);
      const updatedRow = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (update.changes === 1) {
        this._recordJobEffects(updatedRow, {
          auditAction: immediatelyCanceled ? terminalAuditAction : requestedAuditAction,
          auditMetadata: { reason: String(reason).slice(0, 1000), ...auditMetadata },
          timestamp,
        });
      }
      return {
        changed: update.changes === 1,
        terminal: immediatelyCanceled,
        job: normalizeJob(updatedRow),
      };
    });
    return transaction();
  }

  deferJobReconciliation({ jobId, error, executorTaskId = null, delayMs = 1000 } = {}) {
    const timestamp = nowIso();
    const reconcileAfter = new Date(Date.now() + Math.max(10, Number(delayMs) || 1000)).toISOString();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row || !['queued', 'running', 'reconciling', 'cancel_requested'].includes(row.status)) {
        return { changed: false, job: normalizeJob(row) };
      }
      const nextStatus = row.status === 'cancel_requested' ? 'cancel_requested' : 'reconciling';
      const update = this.db.prepare(`
        UPDATE jobs
        SET status = ?, error = ?, executor_task_id = COALESCE(?, executor_task_id),
            reconcile_attempts = reconcile_attempts + 1, reconcile_after = ?,
            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(
        nextStatus,
        String(error || 'Durable executor reconciliation pending').slice(0, 4000),
        executorTaskId,
        reconcileAfter,
        timestamp,
        jobId,
        row.status
      );
      return { changed: update.changes === 1, job: this.getJob(jobId) };
    });
    return transaction();
  }

  markJobRunningAfterReconciliation(jobId) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'running', error = NULL, reconcile_after = NULL,
          lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE id = ? AND status = 'reconciling'
    `).run(timestamp, jobId);
    return result.changes === 1 ? this.getJob(jobId) : null;
  }

  recordExecutorTask(jobId, task) {
    if (!task?.id) return { changed: false, job: this.getJob(jobId) };
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE jobs
      SET executor_task_id = ?, lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE id = ? AND (executor_task_id IS NULL OR executor_task_id != ?)
    `).run(String(task.id), timestamp, jobId, String(task.id));
    return { changed: result.changes === 1, job: this.getJob(jobId) };
  }

  markJobOutcomeUnknown(jobId, reason = 'The delivery outcome could not be reconciled after restart.', {
    auditAction = 'job_outcome_unknown',
    auditMetadata = {},
    auditRiskLevel = null,
    event = null,
  } = {}) {
    const timestamp = nowIso();
    const safeReason = String(reason).slice(0, 4000);
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = 'outcome_unknown', error = ?, completed_at = ?, updated_at = ?,
            reconcile_after = NULL, notification_status = 'pending',
            lifecycle_revision = lifecycle_revision + 1
        WHERE id = ? AND status IN ('running', 'reconciling', 'cancel_requested')
      `).run(safeReason, timestamp, timestamp, jobId);
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (result.changes === 1) {
        this._recordJobEffects(row, {
          auditAction,
          auditMetadata: { reason: safeReason, ...auditMetadata },
          auditRiskLevel,
          event,
          enqueueCallback: true,
          timestamp,
        });
      }
      return { changed: result.changes === 1, job: normalizeJob(row) };
    });
    return transaction();
  }

  cancelAwaitingApprovalsForThread(threadId, reason = 'Approval canceled before execution', {
    auditAction = 'approval_canceled',
    auditMetadata = {},
  } = {}) {
    const timestamp = nowIso();
    const safeReason = String(reason || 'Approval canceled before execution').slice(0, 1000);
    const transaction = this.db.transaction(() => {
      const jobs = this.db.prepare(`
        SELECT * FROM jobs
        WHERE voice_thread_id = ? AND status = 'awaiting_approval'
        ORDER BY created_at ASC
      `).all(threadId);
      if (jobs.length === 0) return [];

      this.db.prepare(`
        UPDATE approvals
        SET status = 'rejected', decided_at = ?, method = 'voice-lifecycle',
            decided_by = 'teleagent'
        WHERE status = 'pending'
          AND job_id IN (
            SELECT id FROM jobs
            WHERE voice_thread_id = ? AND status = 'awaiting_approval'
          )
      `).run(timestamp, threadId);
      this.db.prepare(`
        UPDATE jobs
        SET status = 'canceled', error = ?, completed_at = ?, updated_at = ?,
            notification_status = 'skipped',
            lifecycle_revision = lifecycle_revision + 1
        WHERE voice_thread_id = ? AND status = 'awaiting_approval'
      `).run(safeReason, timestamp, timestamp, threadId);
      this.db.prepare(`
        UPDATE voice_threads
        SET focused_approval_job_id = NULL, updated_at = ?
        WHERE id = ?
      `).run(timestamp, threadId);
      return jobs.map((job) => {
        const updated = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
        this._recordJobEffects(updated, {
          auditAction,
          auditMetadata: { reason: safeReason, ...auditMetadata },
          auditRiskLevel: updated.risk_level || 'mutating',
          timestamp,
        });
        return normalizeJob(updated);
      });
    });
    return transaction();
  }

  expireAwaitingApprovals({ threadId = null, maxAgeMs = 300000 } = {}) {
    const safeMaxAgeMs = Math.max(1000, Number.parseInt(maxAgeMs, 10) || 300000);
    const cutoff = new Date(Date.now() - safeMaxAgeMs).toISOString();
    const threadClause = threadId ? 'AND voice_thread_id = ?' : '';
    const params = threadId ? [cutoff, threadId] : [cutoff];
    const expiredThreadIds = this.db.prepare(`
      SELECT DISTINCT voice_thread_id FROM jobs
      WHERE status = 'awaiting_approval' AND created_at < ? ${threadClause}
    `).all(...params).map((row) => row.voice_thread_id);
    const expired = [];
    for (const expiredThreadId of expiredThreadIds) {
      expired.push(...this.cancelAwaitingApprovalsForThread(
        expiredThreadId,
        'Approval expired before pound confirmation',
        {
          auditAction: 'approval_expired',
          auditMetadata: { ttl_ms: safeMaxAgeMs },
        }
      ));
    }
    return expired;
  }

  cancelAllActiveJobs(reason = 'Voice emergency stop') {
    return this.requestAllJobCancellations(reason).map((entry) => entry.job);
  }

  requestAllJobCancellations(reason = 'Voice emergency stop', {
    keepPendingJobIds = [],
    auditMetadata = {},
  } = {}) {
    const timestamp = nowIso();
    const safeReason = String(reason || 'Voice emergency stop').slice(0, 1000);
    const pendingIds = new Set(
      Array.isArray(keepPendingJobIds) ? keepPendingJobIds.map(String) : []
    );
    const transaction = this.db.transaction(() => {
      const jobs = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('awaiting_approval', 'queued', 'running', 'reconciling', 'cancel_requested')
        ORDER BY created_at ASC
      `).all();

      if (jobs.length === 0) return [];

      this.db.prepare(`
        UPDATE approvals
        SET status = 'rejected', decided_at = ?
        WHERE status = 'pending'
          AND job_id IN (
            SELECT id FROM jobs
            WHERE status IN ('awaiting_approval', 'queued', 'running', 'reconciling', 'cancel_requested')
          )
      `).run(timestamp);
      const results = [];
      for (const job of jobs) {
        if (job.status === 'cancel_requested') {
          results.push({ changed: false, terminal: false, job: normalizeJob(job) });
          continue;
        }
        const immediatelyCanceled = !pendingIds.has(job.id) &&
          (job.status === 'awaiting_approval' || (job.status === 'queued' && !job.started_at));
        const nextStatus = immediatelyCanceled ? 'canceled' : 'cancel_requested';
        const update = this.db.prepare(`
          UPDATE jobs
          SET status = ?, error = ?,
              completed_at = CASE WHEN ? = 'canceled' THEN ? ELSE NULL END,
              notification_status = CASE WHEN ? = 'canceled' THEN 'skipped' ELSE notification_status END,
              reconcile_after = CASE WHEN ? = 'cancel_requested' THEN ? ELSE NULL END,
              lifecycle_revision = lifecycle_revision + 1, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(
          nextStatus,
          safeReason,
          nextStatus,
          timestamp,
          nextStatus,
          nextStatus,
          timestamp,
          timestamp,
          job.id,
          job.status
        );
        results.push({
          changed: update.changes === 1,
          terminal: immediatelyCanceled,
          job: this.getJob(job.id),
        });
        if (update.changes === 1) {
          const updated = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
          this._recordJobEffects(updated, {
            auditAction: immediatelyCanceled
              ? 'emergency_stop_canceled'
              : 'emergency_stop_requested',
            auditMetadata: { reason: safeReason, ...auditMetadata },
            timestamp,
          });
        }
      }
      this.db.prepare(`
        UPDATE voice_threads SET focused_approval_job_id = NULL, updated_at = ?
        WHERE focused_approval_job_id IS NOT NULL
      `).run(timestamp);

      return results;
    });
    return transaction();
  }

  approveFocusedJobCas(threadId, {
    method = 'dtmf-pound',
    decidedBy = 'caller',
    metadata = {},
    callId = null,
    realtimeSessionId = null,
  } = {}) {
    const transaction = this.db.transaction(() => {
      const job = this.db.prepare(`
        SELECT j.* FROM jobs j
        JOIN voice_threads t ON t.id = j.voice_thread_id
        WHERE j.voice_thread_id = ?
          AND j.status = 'awaiting_approval'
          AND (t.focused_approval_job_id = j.id OR t.focused_approval_job_id IS NULL)
        ORDER BY CASE WHEN t.focused_approval_job_id = j.id THEN 0 ELSE 1 END, j.created_at ASC
        LIMIT 1
      `).get(threadId);
      if (!job) return { changed: false, job: null };
      if (!job.approval_armed_at || !job.approval_prompt_hash) {
        return { changed: false, job: this.getJob(job.id), reason: 'approval_not_armed' };
      }
      const currentCallId = String(callId || '').trim();
      const currentRealtimeSessionId = String(realtimeSessionId || '').trim();
      if (!currentCallId || !currentRealtimeSessionId ||
          job.approval_arm_call_id !== currentCallId ||
          job.approval_arm_realtime_session_id !== currentRealtimeSessionId) {
        return {
          changed: false,
          job: this.getJob(job.id),
          reason: 'approval_session_mismatch',
        };
      }

      const timestamp = nowIso();
      const approvalUpdate = this.db.prepare(`
        UPDATE approvals
        SET status = 'approved', decided_at = ?, method = ?, decided_by = ?, decision_metadata_json = ?
        WHERE job_id = ? AND status = 'pending'
      `).run(timestamp, method, decidedBy, serialize(metadata) || '{}', job.id);
      if (approvalUpdate.changes !== 1) {
        return { changed: false, job: this.getJob(job.id) };
      }
      const jobUpdate = this.db.prepare(`
        UPDATE jobs
        SET status = 'queued', approved_at = ?, approval_method = ?,
            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND status = 'awaiting_approval'
          AND approval_arm_call_id = ? AND approval_arm_realtime_session_id = ?
      `).run(
        timestamp,
        method,
        timestamp,
        job.id,
        currentCallId,
        currentRealtimeSessionId
      );
      if (jobUpdate.changes !== 1) {
        throw new Error(`Approval state changed while approving job ${job.id}`);
      }
      this.db.prepare(`
        UPDATE voice_threads SET focused_approval_job_id = NULL, updated_at = ? WHERE id = ?
      `).run(timestamp, threadId);
      const approvedJob = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
      this._recordJobEffects(approvedJob, {
        auditAction: 'approval_granted',
        auditMetadata: {
          method,
          decided_by: decidedBy,
          call_id: currentCallId,
          realtime_session_id: currentRealtimeSessionId,
          ...metadata,
        },
        auditRiskLevel: approvedJob.risk_level || 'mutating',
        timestamp,
      });
      return { changed: true, job: normalizeJob(approvedJob) };
    });
    return transaction();
  }

  armFocusedApproval(threadId, {
    spokenPrompt,
    purpose,
    responseId = null,
    itemId = null,
    playbackCompletedAt = null,
    playoutMarker = null,
    playoutBoundary = null,
    callId = null,
    realtimeSessionId = null,
  } = {}) {
    const prompt = String(spokenPrompt || '').trim();
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.* FROM jobs j
        JOIN voice_threads t ON t.id = j.voice_thread_id
        WHERE j.voice_thread_id = ? AND j.status = 'awaiting_approval'
          AND t.focused_approval_job_id = j.id
        LIMIT 1
      `).get(threadId);
      if (!row) return { changed: false, job: null, reason: 'no_focused_approval' };
      const currentCallId = String(callId || '').trim();
      const currentRealtimeSessionId = String(realtimeSessionId || '').trim();
      const marker = String(playoutMarker || '').trim();
      if (purpose !== 'approval_prompt' || !playbackCompletedAt ||
          !currentCallId || !currentRealtimeSessionId ||
          playoutBoundary !== 'freeswitch_playout_marker' ||
          !marker || marker.length > 500 || /[\u0000-\u001F\u007F]/.test(marker) ||
          typeof row.approval_prompt_hash !== 'string') {
        return { changed: false, job: normalizeJob(row), reason: 'playback_not_verified' };
      }
      const expected = Buffer.from(row.approval_prompt_hash, 'hex');
      const actual = Buffer.from(promptHash, 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return { changed: false, job: normalizeJob(row), reason: 'prompt_mismatch' };
      }
      const metadata = {
        purpose,
        response_id: responseId ? String(responseId).slice(0, 200) : null,
        item_id: itemId ? String(itemId).slice(0, 200) : null,
        playback_completed_at: String(playbackCompletedAt).slice(0, 100),
        call_id: currentCallId.slice(0, 200),
        realtime_session_id: currentRealtimeSessionId.slice(0, 200),
        playout_marker_hash: crypto.createHash('sha256').update(marker).digest('hex'),
        boundary: 'freeswitch_playout_marker',
      };
      const update = this.db.prepare(`
        UPDATE jobs SET approval_armed_at = ?, approval_arm_metadata_json = ?,
          approval_arm_call_id = ?, approval_arm_realtime_session_id = ?,
          lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND status = 'awaiting_approval' AND approval_armed_at IS NULL
      `).run(
        timestamp,
        serialize(metadata),
        currentCallId,
        currentRealtimeSessionId,
        timestamp,
        row.id
      );
      const armedJob = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id);
      if (update.changes === 1) {
        this._recordJobEffects(armedJob, {
          auditAction: 'approval_prompt_armed',
          auditMetadata: metadata,
          auditRiskLevel: armedJob.risk_level || 'mutating',
          timestamp,
        });
      }
      return {
        changed: update.changes === 1,
        job: normalizeJob(armedJob),
        reason: update.changes === 1 ? null : 'already_armed',
      };
    });
    return transaction();
  }

  invalidateFocusedApprovalArm(threadId, {
    callId = null,
    realtimeSessionId = null,
    reason = 'realtime_session_ended',
  } = {}) {
    const expectedCallId = String(callId || '').trim() || null;
    const expectedRealtimeSessionId = String(realtimeSessionId || '').trim() || null;
    const safeReason = String(reason || 'realtime_session_ended').slice(0, 200);
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.* FROM jobs j
        JOIN voice_threads t ON t.id = j.voice_thread_id
        WHERE j.voice_thread_id = ? AND j.status = 'awaiting_approval'
          AND t.focused_approval_job_id = j.id
          AND j.approval_armed_at IS NOT NULL
        LIMIT 1
      `).get(threadId);
      if (!row) return { changed: false, job: null, reason: 'approval_not_armed' };
      if ((expectedCallId && row.approval_arm_call_id !== expectedCallId) ||
          (expectedRealtimeSessionId &&
            row.approval_arm_realtime_session_id !== expectedRealtimeSessionId)) {
        return { changed: false, job: normalizeJob(row), reason: 'approval_session_mismatch' };
      }
      const update = this.db.prepare(`
        UPDATE jobs
        SET approval_armed_at = NULL, approval_arm_metadata_json = NULL,
            approval_arm_call_id = NULL, approval_arm_realtime_session_id = NULL,
            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND status = 'awaiting_approval' AND approval_armed_at IS NOT NULL
          AND (? IS NULL OR approval_arm_call_id = ?)
          AND (? IS NULL OR approval_arm_realtime_session_id = ?)
      `).run(
        timestamp,
        row.id,
        expectedCallId,
        expectedCallId,
        expectedRealtimeSessionId,
        expectedRealtimeSessionId
      );
      const updated = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id);
      if (update.changes === 1) {
        this._recordJobEffects(updated, {
          auditAction: 'approval_prompt_disarmed',
          auditMetadata: {
            reason: safeReason,
            call_id: row.approval_arm_call_id,
            realtime_session_id: row.approval_arm_realtime_session_id,
          },
          auditRiskLevel: row.risk_level || 'mutating',
          timestamp,
        });
      }
      return {
        changed: update.changes === 1,
        job: normalizeJob(updated),
        reason: update.changes === 1 ? null : 'approval_session_mismatch',
      };
    });
    return transaction();
  }

  noteApprovalPromptFailure(threadId, {
    maxAttempts = 3,
    reason = 'approval_prompt_not_verifiable',
    responseId = null,
  } = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(maxAttempts, 10) || 3, 10));
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.* FROM jobs j
        JOIN voice_threads t ON t.id = j.voice_thread_id
        WHERE j.voice_thread_id = ? AND j.status = 'awaiting_approval'
          AND t.focused_approval_job_id = j.id
        LIMIT 1
      `).get(threadId);
      if (!row) return { changed: false, job: null, exhausted: false, attempts: 0 };
      const update = this.db.prepare(`
        UPDATE jobs SET approval_prompt_attempts = approval_prompt_attempts + 1,
          lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE id = ? AND status = 'awaiting_approval' AND approval_armed_at IS NULL
      `).run(timestamp, row.id);
      const job = this.getJob(row.id);
      const attempts = Number(job?.approval_prompt_attempts || 0);
      if (update.changes === 1) {
        this._recordJobEffects(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id), {
          auditAction: 'approval_prompt_verification_failed',
          auditMetadata: {
            reason: String(reason).slice(0, 100),
            response_id: responseId ? String(responseId).slice(0, 200) : null,
            attempt: attempts,
            max_attempts: limit,
          },
          auditRiskLevel: job.risk_level || 'mutating',
          timestamp,
        });
      }
      return {
        changed: update.changes === 1,
        job,
        attempts,
        exhausted: update.changes === 1 && attempts >= limit,
      };
    });
    return transaction();
  }

  approveFocusedJob(threadId, options = {}) {
    const result = this.approveFocusedJobCas(threadId, options);
    return result.changed ? result.job : null;
  }

  markJobNotificationAttempt(jobId) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE jobs
      SET notification_status = 'attempted',
          notification_attempts = notification_attempts + 1,
          notification_last_attempt_at = ?, updated_at = ?
      WHERE id = ?
        AND status IN ('completed', 'failed', 'canceled', 'outcome_unknown')
        AND notification_status != 'delivered'
    `).run(timestamp, timestamp, jobId);
    return this.getJob(jobId);
  }

  markJobNotificationDelivered(jobId) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE jobs
      SET notification_status = 'delivered', notification_delivered_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('completed', 'failed', 'canceled', 'outcome_unknown')
    `).run(timestamp, timestamp, jobId);
    return this.getJob(jobId);
  }

  getCallbackOutbox(jobId) {
    const row = this.db.prepare(`
      SELECT * FROM job_callback_outbox WHERE job_id = ?
    `).get(jobId);
    return row ? {
      ...row,
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id,
      outboundCallId: row.outbound_call_id || null,
      outboundHandoffAt: row.outbound_handoff_at || null,
      outboundTerminalState: row.outbound_terminal_state || null,
    } : null;
  }

  claimCallbackOutbox({ jobId = null, workerId = 'voice-callback-worker', leaseMs = 30000 } = {}) {
    const timestamp = nowIso();
    const leaseExpiresAt = new Date(
      Date.now() + Math.max(1000, Math.min(Number(leaseMs) || 30000, 5 * 60000))
    ).toISOString();
    const leaseToken = crypto.randomUUID();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT o.*
        FROM job_callback_outbox o
        JOIN jobs j ON j.id = o.job_id
        WHERE (? IS NULL OR o.job_id = ?)
          AND j.notification_mode = 'callback'
          AND j.status IN ('completed', 'failed', 'outcome_unknown')
          AND (
            (o.state = 'pending' AND o.available_at <= ?)
            OR (o.state = 'delivering' AND o.lease_expires_at <= ?)
          )
        ORDER BY o.available_at, o.created_at
        LIMIT 1
      `).get(jobId, jobId, timestamp, timestamp);
      if (!row) return null;
      const update = this.db.prepare(`
        UPDATE job_callback_outbox
        SET state = 'delivering', attempts = attempts + 1,
            lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE idempotency_key = ?
          AND (
            (state = 'pending' AND available_at <= ?)
            OR (state = 'delivering' AND lease_expires_at <= ?)
          )
      `).run(
        leaseToken,
        leaseExpiresAt,
        timestamp,
        row.idempotency_key,
        timestamp,
        timestamp
      );
      if (update.changes !== 1) return null;
      this.db.prepare(`
        UPDATE jobs
        SET notification_status = 'attempted',
            notification_attempts = notification_attempts + 1,
            notification_last_attempt_at = ?, updated_at = ?
        WHERE id = ? AND notification_status != 'delivered'
      `).run(timestamp, timestamp, row.job_id);
      const claimed = this.db.prepare(`
        SELECT * FROM job_callback_outbox WHERE idempotency_key = ?
      `).get(row.idempotency_key);
      return {
        idempotencyKey: claimed.idempotency_key,
        jobId: claimed.job_id,
        attempts: claimed.attempts,
        workerId: String(workerId || 'voice-callback-worker'),
        leaseToken,
        leaseExpiresAt,
        job: normalizeJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(claimed.job_id)),
      };
    });
    return transaction.immediate();
  }

  acknowledgeCallbackOutbox({ idempotencyKey, leaseToken }) {
    const row = this.db.prepare(`
      SELECT * FROM job_callback_outbox
      WHERE idempotency_key = ? AND state = 'delivering' AND lease_token = ?
    `).get(idempotencyKey, leaseToken);
    return {
      changed: false,
      reason: 'outbound_terminal_truth_required',
      job: row ? this.getJob(row.job_id) : null,
    };
  }

  retryCallbackOutbox({ idempotencyKey, leaseToken, error, backoffMs = 1000 }) {
    const timestamp = nowIso();
    const availableAt = new Date(
      Date.now() + Math.max(10, Math.min(Number(backoffMs) || 1000, 5 * 60000))
    ).toISOString();
    const result = this.db.prepare(`
      UPDATE job_callback_outbox
      SET state = 'pending', available_at = ?, lease_token = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE idempotency_key = ? AND state = 'delivering' AND lease_token = ?
    `).run(
      availableAt,
      String(error || 'Callback delivery was not accepted').slice(0, 2000),
      timestamp,
      idempotencyKey,
      leaseToken
    );
    return { changed: result.changes === 1, availableAt };
  }

  _reconcileCallbackForOutbound(idempotencyKey, timestamp = nowIso()) {
    const outbox = this.db.prepare(`
      SELECT * FROM job_callback_outbox
      WHERE idempotency_key = ? AND outbound_call_id IS NOT NULL
    `).get(idempotencyKey);
    if (!outbox) return { changed: false, job: null, outbox: null };
    const outbound = this.db.prepare(`
      SELECT * FROM outbound_call_inbox
      WHERE idempotency_key = ? AND call_id = ?
    `).get(idempotencyKey, outbox.outbound_call_id);
    if (!outbound) return { changed: false, job: this.getJob(outbox.job_id), outbox };

    let outboxState = 'awaiting_outbound';
    let notificationStatus = 'attempted';
    let deliveredAt = null;
    let lastError = null;
    if (outbound.state === 'completed') {
      outboxState = 'delivered';
      notificationStatus = 'delivered';
      deliveredAt = timestamp;
    } else if (['failed', 'canceled'].includes(outbound.state)) {
      // Proven terminal non-delivery remains explicit and does not redial by
      // itself. A later retry must be a separately reviewed outbound attempt.
      outboxState = 'failed';
      notificationStatus = 'failed';
      lastError = outbound.error || `Outbound callback ended ${outbound.state}`;
    } else if (outbound.state === 'outcome_unknown') {
      outboxState = 'outcome_unknown';
      notificationStatus = 'outcome_unknown';
      lastError = outbound.error || 'Outbound callback delivery outcome is unknown';
    }

    if (outbox.state === outboxState &&
        (outbox.outbound_terminal_state || null) === (
          ['completed', 'failed', 'canceled', 'outcome_unknown'].includes(outbound.state)
            ? outbound.state
            : null
        )) {
      return { changed: false, job: this.getJob(outbox.job_id), outbox };
    }
    const terminalState = ['completed', 'failed', 'canceled', 'outcome_unknown'].includes(outbound.state)
      ? outbound.state
      : null;
    const update = this.db.prepare(`
      UPDATE job_callback_outbox
      SET state = ?, lease_token = NULL, lease_expires_at = NULL,
          last_error = ?, delivered_at = COALESCE(delivered_at, ?),
          outbound_terminal_state = ?, updated_at = ?
      WHERE idempotency_key = ? AND outbound_call_id = ?
        AND state != 'delivered'
    `).run(
      outboxState,
      lastError ? String(lastError).slice(0, 2000) : null,
      deliveredAt,
      terminalState,
      timestamp,
      idempotencyKey,
      outbox.outbound_call_id
    );
    if (update.changes !== 1) {
      return { changed: false, job: this.getJob(outbox.job_id), outbox: this.getCallbackOutbox(outbox.job_id) };
    }
    this.db.prepare(`
      UPDATE jobs
      SET notification_status = ?,
          notification_delivered_at = CASE
            WHEN ? = 'delivered' THEN COALESCE(notification_delivered_at, ?)
            ELSE notification_delivered_at
          END,
          updated_at = ?
      WHERE id = ? AND notification_status != 'delivered'
    `).run(notificationStatus, notificationStatus, deliveredAt, timestamp, outbox.job_id);

    if (terminalState) {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(outbox.job_id);
      const thread = job && this.db.prepare('SELECT caller_id FROM voice_threads WHERE id = ?')
        .get(job.voice_thread_id);
      this.appendAuditEvent({
        voiceThreadId: job?.voice_thread_id || null,
        realtimeSessionId: job?.realtime_session_id || null,
        jobId: outbox.job_id,
        callerId: thread?.caller_id || 'unknown',
        action: `callback_outbound_${terminalState}`,
        riskLevel: 'read_only',
        profile: job?.profile || null,
        metadata: {
          call_id: outbox.outbound_call_id,
          outbound_state: terminalState,
          delivery_state: outboxState,
        },
      });
    }
    return {
      changed: true,
      job: this.getJob(outbox.job_id),
      outbox: this.getCallbackOutbox(outbox.job_id),
    };
  }

  recordCallbackOutboundHandoff({ idempotencyKey, leaseToken, callId }) {
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const outbox = this.db.prepare(`
        SELECT * FROM job_callback_outbox
        WHERE idempotency_key = ? AND state = 'delivering' AND lease_token = ?
      `).get(idempotencyKey, leaseToken);
      if (!outbox) {
        const correlated = this.db.prepare(`
          SELECT * FROM job_callback_outbox
          WHERE idempotency_key = ? AND outbound_call_id = ?
        `).get(idempotencyKey, String(callId || '').trim());
        if (correlated) {
          return {
            changed: false,
            reason: null,
            job: this.getJob(correlated.job_id),
            outbox: this.getCallbackOutbox(correlated.job_id),
            callId: correlated.outbound_call_id,
          };
        }
        return { changed: false, reason: 'stale_callback_lease', job: null };
      }
      const outbound = this.db.prepare(`
        SELECT * FROM outbound_call_inbox
        WHERE idempotency_key = ? AND call_id = ?
      `).get(idempotencyKey, String(callId || '').trim());
      if (!outbound) {
        return {
          changed: false,
          reason: 'outbound_handoff_not_durable',
          job: this.getJob(outbox.job_id),
        };
      }
      const update = this.db.prepare(`
        UPDATE job_callback_outbox
        SET outbound_call_id = ?, outbound_handoff_at = COALESCE(outbound_handoff_at, ?),
            updated_at = ?
        WHERE idempotency_key = ? AND state = 'delivering' AND lease_token = ?
      `).run(outbound.call_id, timestamp, timestamp, idempotencyKey, leaseToken);
      if (update.changes !== 1) {
        return { changed: false, reason: 'stale_callback_lease', job: null };
      }
      const reconciled = this._reconcileCallbackForOutbound(idempotencyKey, timestamp);
      return { ...reconciled, callId: outbound.call_id, outboundState: outbound.state };
    });
    return transaction.immediate();
  }

  _bindCallbackOutboxToOutbound(idempotencyKey, callId, timestamp = nowIso()) {
    const outbox = this.db.prepare(`
      SELECT * FROM job_callback_outbox WHERE idempotency_key = ?
    `).get(idempotencyKey);
    if (!outbox || (outbox.outbound_call_id && outbox.outbound_call_id !== callId)) {
      return { changed: false, outbox: null };
    }
    const update = this.db.prepare(`
      UPDATE job_callback_outbox
      SET outbound_call_id = ?, outbound_handoff_at = COALESCE(outbound_handoff_at, ?),
          updated_at = ?
      WHERE idempotency_key = ? AND state != 'delivered'
        AND (outbound_call_id IS NULL OR outbound_call_id = ?)
    `).run(callId, timestamp, timestamp, idempotencyKey, callId);
    const reconciled = this._reconcileCallbackForOutbound(idempotencyKey, timestamp);
    return { changed: update.changes === 1 || reconciled.changed, outbox: reconciled.outbox };
  }

  listDueCallbackJobs({ limit = 20 } = {}) {
    const timestamp = nowIso();
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 20, 100));
    return this.db.prepare(`
      SELECT j.*
      FROM job_callback_outbox o
      JOIN jobs j ON j.id = o.job_id
      WHERE j.notification_mode = 'callback'
        AND j.status IN ('completed', 'failed', 'outcome_unknown')
        AND (
          (o.state = 'pending' AND o.available_at <= ?)
          OR (o.state = 'delivering' AND o.lease_expires_at <= ?)
        )
      ORDER BY o.available_at, o.created_at
      LIMIT ?
    `).all(timestamp, timestamp, safeLimit).map(normalizeJob);
  }

  nextCallbackOutboxDelay({ maximumMs = 5 * 60000 } = {}) {
    const row = this.db.prepare(`
      SELECT MIN(
        CASE WHEN state = 'delivering' THEN lease_expires_at ELSE available_at END
      ) AS due_at
      FROM job_callback_outbox
      WHERE state IN ('pending', 'delivering')
    `).get();
    if (!row?.due_at) return null;
    return Math.max(10, Math.min(Date.parse(row.due_at) - Date.now(), maximumMs));
  }

  reserveOutboundCall({ idempotencyKey, request, callId }) {
    const key = String(idempotencyKey || '').trim();
    const normalizedCallId = String(callId || '').trim();
    if (!key || key.length > 200 || /[\u0000-\u001F\u007F]/.test(key)) {
      throw new Error('A clean outbound idempotency key of at most 200 characters is required');
    }
    if (!normalizedCallId || normalizedCallId.length > 200) {
      throw new Error('An outbound call ID is required');
    }
    const safeRequest = sanitizeOutboundRequest(request);
    const requestHash = crypto.createHash('sha256').update(canonicalJson(safeRequest)).digest('hex');
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM outbound_call_inbox WHERE idempotency_key = ?
      `).get(key);
      if (existing) {
        const conflict = existing.request_hash !== requestHash;
        if (!conflict) {
          this._bindCallbackOutboxToOutbound(key, existing.call_id, timestamp);
        }
        return {
          created: false,
          conflict,
          idempotencyKey: key,
          callId: existing.call_id,
          state: existing.state,
          requestHash: existing.request_hash,
          request: parseJson(existing.request_json, {}),
          error: existing.error || null,
        };
      }
      this.db.prepare(`
        INSERT INTO outbound_call_inbox (
          idempotency_key, request_hash, request_json, call_id, state,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        key,
        requestHash,
        serialize(safeRequest) || '{}',
        normalizedCallId,
        timestamp,
        timestamp
      );
      this._bindCallbackOutboxToOutbound(key, normalizedCallId, timestamp);
      return {
        created: true,
        conflict: false,
        idempotencyKey: key,
        callId: normalizedCallId,
        state: 'queued',
        requestHash,
        request: safeRequest,
      };
    });
    return transaction.immediate();
  }

  claimOutboundCallIntent({ idempotencyKey, callId }) {
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE outbound_call_inbox
        SET state = 'dial_intent', intent_at = COALESCE(intent_at, ?),
            error = NULL, updated_at = ?
        WHERE idempotency_key = ? AND call_id = ? AND state = 'queued'
      `).run(timestamp, timestamp, idempotencyKey, callId);
      return {
        changed: result.changes === 1,
        record: this.getOutboundCall(idempotencyKey),
      };
    });
    return transaction.immediate();
  }

  requestOutboundCallCancellation({ callId, reason = 'Outbound call canceled' }) {
    const normalizedCallId = String(callId || '').trim();
    if (!normalizedCallId || normalizedCallId.length > 200 ||
        /[\u0000-\u001F\u007F]/.test(normalizedCallId)) {
      throw new Error('A clean outbound call ID is required');
    }
    const normalizedReason = String(reason || 'Outbound call canceled').slice(0, 2000);
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM outbound_call_inbox WHERE call_id = ?
      `).get(normalizedCallId);
      if (!existing) return { found: false, changed: false, record: null };
      if (existing.state === 'queued') {
        const update = this.db.prepare(`
          UPDATE outbound_call_inbox
          SET state = 'canceled', error = ?, cancellation_requested_at = ?,
              terminal_at = COALESCE(terminal_at, ?), updated_at = ?
          WHERE call_id = ? AND state = 'queued'
        `).run(normalizedReason, timestamp, timestamp, timestamp, normalizedCallId);
        this._reconcileCallbackForOutbound(existing.idempotency_key, timestamp);
        return {
          found: true,
          changed: update.changes === 1,
          terminal: true,
          record: this.getOutboundCallByCallId(normalizedCallId),
        };
      }
      if (existing.state === 'dial_intent') {
        const update = this.db.prepare(`
          UPDATE outbound_call_inbox
          SET state = 'cancel_requested', error = ?, cancellation_requested_at = ?, updated_at = ?
          WHERE call_id = ? AND state = 'dial_intent'
        `).run(normalizedReason, timestamp, timestamp, normalizedCallId);
        this._reconcileCallbackForOutbound(existing.idempotency_key, timestamp);
        return {
          found: true,
          changed: update.changes === 1,
          terminal: false,
          record: this.getOutboundCallByCallId(normalizedCallId),
        };
      }
      return {
        found: true,
        changed: false,
        terminal: ['completed', 'failed', 'canceled', 'outcome_unknown'].includes(existing.state),
        record: this._normalizeOutboundCall(existing),
      };
    });
    return transaction.immediate();
  }

  requestAllOutboundCallCancellations(reason = 'Voice emergency stop') {
    const active = this.listActiveOutboundCalls({ limit: 1000 });
    return active.map((record) => this.requestOutboundCallCancellation({
      callId: record.callId,
      reason,
    }));
  }

  markOutboundCallTerminal({ idempotencyKey, callId, state, error = null }) {
    if (!['completed', 'failed', 'canceled', 'outcome_unknown'].includes(state)) {
      throw new Error('Outbound terminal state must be completed, failed, canceled, or outcome_unknown');
    }
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE outbound_call_inbox
        SET state = ?, error = ?, terminal_at = COALESCE(terminal_at, ?),
            recovery_barrier_at = CASE
              WHEN ? = 'outcome_unknown' THEN COALESCE(recovery_barrier_at, ?)
              ELSE recovery_barrier_at
            END,
            recovery_barrier_resolved_at = CASE
              WHEN ? = 'outcome_unknown' THEN NULL
              ELSE recovery_barrier_resolved_at
            END,
            recovery_barrier_resolution = CASE
              WHEN ? = 'outcome_unknown' THEN NULL
              ELSE recovery_barrier_resolution
            END,
            updated_at = ?
        WHERE idempotency_key = ? AND call_id = ?
          AND state IN ('dial_intent', 'cancel_requested')
      `).run(
        state,
        error ? String(error).slice(0, 2000) : null,
        timestamp,
        state,
        timestamp,
        state,
        state,
        timestamp,
        idempotencyKey,
        callId
      );
      if (result.changes === 1) {
        this._reconcileCallbackForOutbound(idempotencyKey, timestamp);
        if (state === 'outcome_unknown') {
          this.appendAuditEvent({
            callerId: 'system',
            action: 'outbound_recovery_barrier_armed',
            riskLevel: 'high',
            scopeText: callId,
            metadata: {
              call_id: callId,
              reason: 'runtime_delivery_or_cleanup_uncertainty',
            },
          });
        }
      }
      return { changed: result.changes === 1, record: this.getOutboundCall(idempotencyKey) };
    });
    return transaction.immediate();
  }

  listQueuedOutboundCalls({ limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 20, 100));
    return this.db.prepare(`
      SELECT * FROM outbound_call_inbox
      WHERE state = 'queued'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(safeLimit).map((row) => this._normalizeOutboundCall(row));
  }

  listActiveOutboundCalls({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    return this.db.prepare(`
      SELECT * FROM outbound_call_inbox
      WHERE state IN ('queued', 'dial_intent', 'cancel_requested')
      ORDER BY created_at ASC
      LIMIT ?
    `).all(safeLimit).map((row) => this._normalizeOutboundCall(row));
  }

  listUnconfirmedOutboundCancellations({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    return this.db.prepare(`
      SELECT * FROM outbound_call_inbox
      WHERE cancellation_requested_at IS NOT NULL
        AND state IN ('cancel_requested', 'outcome_unknown')
      ORDER BY cancellation_requested_at ASC
      LIMIT ?
    `).all(safeLimit).map((row) => this._normalizeOutboundCall(row));
  }

  listOutboundRecoveryBarriers({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    return this.db.prepare(`
      SELECT * FROM outbound_call_inbox
      WHERE recovery_barrier_at IS NOT NULL
        AND recovery_barrier_resolved_at IS NULL
      ORDER BY recovery_barrier_at ASC
      LIMIT ?
    `).all(safeLimit).map((row) => this._normalizeOutboundCall(row));
  }

  resolveOutboundRecoveryBarrier({
    callId,
    confirmation,
    source = 'root_local_operator',
    runtimeFence,
  }) {
    const normalizedCallId = String(callId || '').trim();
    if (!normalizedCallId || normalizedCallId.length > 200 ||
        /[\u0000-\u001F\u007F]/.test(normalizedCallId)) {
      throw new Error('A clean outbound call ID is required');
    }
    if (confirmation !== OUTBOUND_QUIESCENCE_CONFIRMATION) {
      throw new Error(`Confirmation must be exactly ${OUTBOUND_QUIESCENCE_CONFIRMATION}`);
    }
    runtimeFence?.assertHeld?.();
    if (!runtimeFence?.held) {
      throw new Error('The offline outbound runtime fence is required for recovery resolution');
    }
    const normalizedSource = String(source || 'root_local_operator').slice(0, 100);
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM outbound_call_inbox WHERE call_id = ?
      `).get(normalizedCallId);
      if (!row || !row.recovery_barrier_at || row.recovery_barrier_resolved_at) {
        return { changed: false, reason: 'outbound_recovery_barrier_not_found', record: this._normalizeOutboundCall(row) };
      }
      const update = this.db.prepare(`
        UPDATE outbound_call_inbox
        SET recovery_barrier_resolved_at = ?, recovery_barrier_resolution = ?, updated_at = ?
        WHERE call_id = ? AND recovery_barrier_at IS NOT NULL
          AND recovery_barrier_resolved_at IS NULL
      `).run(timestamp, normalizedSource, timestamp, normalizedCallId);
      if (update.changes !== 1) {
        return { changed: false, reason: 'outbound_recovery_barrier_race', record: this.getOutboundCallByCallId(normalizedCallId) };
      }
      this.appendAuditEvent({
        callerId: 'local_operator',
        action: 'outbound_recovery_barrier_resolved',
        riskLevel: 'high',
        scopeText: normalizedCallId,
        metadata: {
          call_id: normalizedCallId,
          source: normalizedSource,
          quiescence_confirmation: OUTBOUND_QUIESCENCE_CONFIRMATION,
          prior_state: row.state,
        },
      });
      return { changed: true, record: this.getOutboundCallByCallId(normalizedCallId) };
    });
    return transaction.immediate();
  }

  listOutboundCalls({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    return this.db.prepare(`
      SELECT * FROM outbound_call_inbox
      ORDER BY created_at DESC
      LIMIT ?
    `).all(safeLimit).map((row) => this._normalizeOutboundCall(row));
  }

  _normalizeOutboundCall(row) {
    if (!row) return null;
    return {
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      request: parseJson(row.request_json, {}),
      callId: row.call_id,
      state: row.state,
      error: row.error || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      intentAt: row.intent_at || null,
      terminalAt: row.terminal_at || null,
      cancellationRequestedAt: row.cancellation_requested_at || null,
      recoveryBarrierAt: row.recovery_barrier_at || null,
      recoveryBarrierResolvedAt: row.recovery_barrier_resolved_at || null,
      recoveryRequired: Boolean(row.recovery_barrier_at && !row.recovery_barrier_resolved_at),
    };
  }

  getOutboundCall(idempotencyKey) {
    const row = this.db.prepare(`
      SELECT * FROM outbound_call_inbox WHERE idempotency_key = ?
    `).get(String(idempotencyKey || '').trim());
    return this._normalizeOutboundCall(row);
  }

  getOutboundCallByCallId(callId) {
    const row = this.db.prepare(`
      SELECT * FROM outbound_call_inbox WHERE call_id = ?
    `).get(String(callId || '').trim());
    return this._normalizeOutboundCall(row);
  }

  listPendingJobNotifications(threadId, { limit = 10 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 50));
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE voice_thread_id = ?
        AND status IN ('completed', 'failed', 'canceled', 'outcome_unknown')
        AND notification_mode IN ('in_call', 'resume')
        AND notification_status IN ('pending', 'attempted')
      ORDER BY completed_at ASC, created_at ASC
      LIMIT ?
    `).all(threadId, safeLimit).map(normalizeJob);
  }

  listPendingCallbackJobs({ limit = 20 } = {}) {
    return this.listDueCallbackJobs({ limit });
  }

  approveNextJob(threadId, options = {}) {
    return this.approveFocusedJob(threadId, options);
  }

  getFocusedJob(threadId) {
    return normalizeJob(this.db.prepare(`
      SELECT * FROM jobs
      WHERE voice_thread_id = ?
        AND status IN ('awaiting_approval', 'running', 'queued', 'reconciling', 'cancel_requested')
      ORDER BY
        CASE status
          WHEN 'awaiting_approval' THEN 0
          WHEN 'cancel_requested' THEN 1
          WHEN 'reconciling' THEN 2
          WHEN 'running' THEN 3
          ELSE 4
        END,
        created_at DESC
      LIMIT 1
    `).get(threadId));
  }

  getResumeContext(threadId) {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    return {
      thread: {
        id: thread.id,
        callerId: thread.caller_id,
        selectedProfile: thread.selected_profile,
        summary: thread.summary,
        updatedAt: thread.updated_at,
      },
      agentSessions: this.listAgentSessions(threadId),
      jobs: this.listJobs(threadId, { limit: 8 }),
      events: this.listRecentEvents(threadId, 16),
      preferences: this.listPreferences(thread.caller_id),
    };
  }
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  OUTBOUND_QUIESCENCE_CONFIRMATION,
  TERMINAL_JOB_STATUSES,
  VoiceStateStore,
};
