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
    fullResult: parseJson(row.result_json, null),
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
    `);
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

    this.db.prepare(`
      DELETE FROM voice_events
      WHERE voice_thread_id = ?
        AND id NOT IN (
          SELECT id FROM voice_events
          WHERE voice_thread_id = ?
          ORDER BY id DESC
          LIMIT 100
        )
    `).run(voiceThreadId, voiceThreadId);

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
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 12, 100));
    return this.db.prepare(`
      SELECT id, role, kind, content, created_at
      FROM voice_events
      WHERE voice_thread_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(threadId, safeLimit).reverse();
  }

  getAgentSession(threadId, profile) {
    return this.db.prepare(`
      SELECT * FROM agent_sessions WHERE voice_thread_id = ? AND profile = ?
    `).get(threadId, profile) || null;
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
    freshSession = false,
    requiresApproval = false,
    notificationMode = 'in_call',
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

      const id = makeId('job');
      const timestamp = nowIso();
      const status = requiresApproval ? 'awaiting_approval' : 'queued';
      this.db.prepare(`
        INSERT INTO jobs (
          id, voice_thread_id, realtime_session_id, tool_call_id, profile,
          provider, request, fresh_session, requires_approval, notification_mode,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        voiceThreadId,
        realtimeSessionId,
        toolCallId,
        profile,
        provider,
        String(request || '').trim(),
        freshSession ? 1 : 0,
        requiresApproval ? 1 : 0,
        notificationMode,
        status,
        timestamp,
        timestamp
      );

      if (requiresApproval) {
        this.db.prepare(`
          INSERT INTO approvals (id, job_id, action, status, requested_at)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(makeId('approval'), id, String(request || '').trim().slice(0, 1000), timestamp);
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
      return this.getJob(jobId);
    });
    return transaction();
  }

  approveNextJob(threadId) {
    const transaction = this.db.transaction(() => {
      const job = this.db.prepare(`
        SELECT * FROM jobs
        WHERE voice_thread_id = ? AND status = 'awaiting_approval'
        ORDER BY created_at ASC
        LIMIT 1
      `).get(threadId);
      if (!job) return null;

      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE approvals SET status = 'approved', decided_at = ?
        WHERE job_id = ? AND status = 'pending'
      `).run(timestamp, job.id);
      this.db.prepare(`
        UPDATE jobs SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'awaiting_approval'
      `).run(timestamp, job.id);
      return this.getJob(job.id);
    });
    return transaction();
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
        selectedProfile: thread.selected_profile,
        summary: thread.summary,
        updatedAt: thread.updated_at,
      },
      agentSessions: this.db.prepare(`
        SELECT profile, provider, bridge_session_key, provider_session_id, updated_at
        FROM agent_sessions
        WHERE voice_thread_id = ?
        ORDER BY profile
      `).all(threadId),
      jobs: this.listJobs(threadId, { limit: 8 }),
      events: this.listRecentEvents(threadId, 10),
    };
  }
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  VoiceStateStore,
};
