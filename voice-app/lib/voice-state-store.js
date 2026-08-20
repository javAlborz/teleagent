'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ACTIVE_JOB_STATUSES = ['awaiting_approval', 'queued', 'running'];
const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'canceled'];

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

function normalizePreferenceKey(key) {
  return String(key || '').trim().toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '_').slice(0, 80);
}

function normalizeThread(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    ...row,
    freshSession: Boolean(row.fresh_session),
    requiresApproval: Boolean(row.requires_approval),
    riskReasons: parseJson(row.risk_reasons_json, []),
    fullResult: parseJson(row.result_json, null),
    jobKind: row.job_kind || 'managed_agent',
    operation: parseJson(row.operation_json, null),
  };
}

class VoiceStateStore {
  constructor({ dbPath = ':memory:' } = {}) {
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      const stateDirectory = path.dirname(dbPath);
      fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      fs.chmodSync(stateDirectory, 0o700);
    }

    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }

    this._migrate();
    this.recoverInterruptedRealtimeSessions();
    this.recoverInterruptedJobs();
    if (dbPath !== ':memory:') fs.chmodSync(dbPath, 0o600);
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
    this._addColumnIfMissing('approvals', 'method', 'TEXT');
    this._addColumnIfMissing('approvals', 'decided_by', 'TEXT');
    this._addColumnIfMissing('approvals', 'decision_metadata_json', "TEXT NOT NULL DEFAULT '{}'");
  }

  _addColumnIfMissing(table, column, definition) {
    if (!/^[a-z_]+$/i.test(table) || !/^[a-z_]+$/i.test(column)) {
      throw new Error('Invalid migration identifier');
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  health() {
    const result = this.db.prepare('SELECT 1 AS ok').get();
    return {
      ok: result?.ok === 1,
      path: this.dbPath,
    };
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  recoverInterruptedJobs() {
    const timestamp = nowIso();
    return this.db.prepare(`
      UPDATE jobs
      SET status = 'failed',
          error = 'Voice service restarted before the agent task finished.',
          completed_at = ?,
          updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(timestamp, timestamp).changes;
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
    callbackDialUri = null,
    metadata = {},
  }) {
    const id = makeId('vt');
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO voice_threads (
        id, caller_id, selected_profile, callback_target, callback_dial_uri,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(callerId || 'unknown'),
      selectedProfile,
      callbackTarget,
      callbackDialUri,
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
    callbackDialUri = null,
    metadata = {},
  }) {
    if (resume) {
      const found = this.findResumableThread(callerId, { ttlSeconds: resumeTtlSeconds });
      if (found.thread) {
        this.touchThread(found.thread.id, { callbackTarget, callbackDialUri });
        return { thread: this.getThread(found.thread.id), resumed: true, reason: 'found' };
      }

      return {
        thread: this.createThread({
          callerId,
          selectedProfile,
          callbackTarget,
          callbackDialUri,
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
        callbackDialUri,
        metadata,
      }),
      resumed: false,
      reason: 'fresh',
    };
  }

  touchThread(threadId, { callbackTarget, callbackDialUri } = {}) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE voice_threads
      SET updated_at = ?,
          status = 'active',
          closed_at = NULL,
          callback_target = COALESCE(?, callback_target),
          callback_dial_uri = COALESCE(?, callback_dial_uri)
      WHERE id = ?
    `).run(timestamp, callbackTarget || null, callbackDialUri || null, threadId);
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
    return this.db.prepare(`
      SELECT * FROM agent_sessions WHERE voice_thread_id = ? AND profile = ?
    `).get(threadId, profile) || null;
  }

  listAgentSessions(threadId) {
    return this.db.prepare(`
      SELECT
        s.profile,
        s.provider,
        s.bridge_session_key,
        s.provider_session_id,
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
    providerSessionId = null,
  }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO agent_sessions (
        voice_thread_id, profile, provider, bridge_session_key,
        provider_session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(voice_thread_id, profile) DO UPDATE SET
        provider = excluded.provider,
        bridge_session_key = excluded.bridge_session_key,
        provider_session_id = COALESCE(excluded.provider_session_id, agent_sessions.provider_session_id),
        updated_at = excluded.updated_at
    `).run(
      voiceThreadId,
      profile,
      provider,
      bridgeSessionKey,
      providerSessionId,
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
          AND status IN ('awaiting_approval', 'queued', 'running')
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
      this.db.prepare(`
        INSERT INTO jobs (
          id, voice_thread_id, realtime_session_id, tool_call_id, profile,
          provider, request, job_kind, operation_json, fresh_session, requires_approval, notification_mode,
          status, risk_level, risk_reasons_json, request_hash, approval_summary,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

      return { created: true, duplicate: false, busy: false, job: this.getJob(id) };
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
            AND status IN ('awaiting_approval', 'queued', 'running')
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

  listAllActiveJobs() {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('awaiting_approval', 'queued', 'running')
      ORDER BY created_at ASC
    `).all().map(normalizeJob);
  }

  markJobRunning(jobId) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(timestamp, timestamp, jobId);
    return result.changes > 0 ? this.getJob(jobId) : null;
  }

  markJobCompleted(jobId, { fullResult = null, voiceResult = null } = {}) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE jobs
      SET status = 'completed', result_json = ?, voice_result = ?, error = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(serialize(fullResult), voiceResult, timestamp, timestamp, jobId);
    return this.getJob(jobId);
  }

  markJobFailed(jobId, error) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE jobs
      SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(String(error || 'Agent task failed').slice(0, 4000), timestamp, timestamp, jobId);
    return this.getJob(jobId);
  }

  cancelJob(jobId, reason = 'Canceled by caller') {
    const timestamp = nowIso();
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE approvals SET status = 'rejected', decided_at = ?
        WHERE job_id = ? AND status = 'pending'
      `).run(timestamp, jobId);
      this.db.prepare(`
        UPDATE jobs
        SET status = 'canceled', error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('awaiting_approval', 'queued', 'running')
      `).run(String(reason).slice(0, 1000), timestamp, timestamp, jobId);
      this.db.prepare(`
        UPDATE voice_threads
        SET focused_approval_job_id = NULL, updated_at = ?
        WHERE focused_approval_job_id = ?
      `).run(timestamp, jobId);
      return this.getJob(jobId);
    });
    return transaction();
  }

  cancelAllActiveJobs(reason = 'Voice emergency stop') {
    const timestamp = nowIso();
    const safeReason = String(reason || 'Voice emergency stop').slice(0, 1000);
    const transaction = this.db.transaction(() => {
      const jobs = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('awaiting_approval', 'queued', 'running')
        ORDER BY created_at ASC
      `).all();

      if (jobs.length === 0) return [];

      this.db.prepare(`
        UPDATE approvals
        SET status = 'rejected', decided_at = ?
        WHERE status = 'pending'
          AND job_id IN (
            SELECT id FROM jobs
            WHERE status IN ('awaiting_approval', 'queued', 'running')
          )
      `).run(timestamp);
      this.db.prepare(`
        UPDATE jobs
        SET status = 'canceled', error = ?, completed_at = ?, updated_at = ?
        WHERE status IN ('awaiting_approval', 'queued', 'running')
      `).run(safeReason, timestamp, timestamp);
      this.db.prepare(`
        UPDATE voice_threads SET focused_approval_job_id = NULL, updated_at = ?
        WHERE focused_approval_job_id IS NOT NULL
      `).run(timestamp);

      return jobs.map((job) => this.getJob(job.id));
    });
    return transaction();
  }

  approveFocusedJob(threadId, {
    method = 'dtmf-pound',
    decidedBy = 'caller',
    metadata = {},
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
      if (!job) return null;

      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE approvals
        SET status = 'approved', decided_at = ?, method = ?, decided_by = ?, decision_metadata_json = ?
        WHERE job_id = ? AND status = 'pending'
      `).run(timestamp, method, decidedBy, serialize(metadata) || '{}', job.id);
      this.db.prepare(`
        UPDATE jobs
        SET status = 'queued', approved_at = ?, approval_method = ?, updated_at = ?
        WHERE id = ? AND status = 'awaiting_approval'
      `).run(timestamp, method, timestamp, job.id);
      this.db.prepare(`
        UPDATE voice_threads SET focused_approval_job_id = NULL, updated_at = ? WHERE id = ?
      `).run(timestamp, threadId);
      return this.getJob(job.id);
    });
    return transaction();
  }

  approveNextJob(threadId) {
    return this.approveFocusedJob(threadId);
  }

  getFocusedJob(threadId) {
    return normalizeJob(this.db.prepare(`
      SELECT * FROM jobs
      WHERE voice_thread_id = ?
        AND status IN ('awaiting_approval', 'running', 'queued')
      ORDER BY
        CASE status
          WHEN 'awaiting_approval' THEN 0
          WHEN 'running' THEN 1
          ELSE 2
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
  TERMINAL_JOB_STATUSES,
  VoiceStateStore,
};
