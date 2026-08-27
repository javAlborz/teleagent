'use strict';

const { DatabaseSync } = require('node:sqlite');

const LIVE_STATE_DATABASE = '/state/voice-state.sqlite';
const LOOKBACK_DAYS = 14;

function safeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(number));
}

function safeRate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function tokenInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function addToken(totals, field, value) {
  const number = tokenInteger(value);
  if (number === null) return;
  totals[field] = safeInteger(totals[field] + number);
}

function preferredToken(primary, fallback) {
  return tokenInteger(primary) === null ? fallback : primary;
}

// Select only documented token paths. Recursive key matching can double-count
// a future nested summary that happens to reuse a token field name.
function sumTokenFields(value, totals) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  addToken(totals, 'total_tokens', value.total_tokens);
  addToken(totals, 'input_tokens', value.input_tokens);
  addToken(totals, 'output_tokens', value.output_tokens);
  addToken(totals, 'input_audio_tokens', preferredToken(
    value.input_audio_tokens,
    value.input_token_details?.audio_tokens,
  ));
  addToken(totals, 'output_audio_tokens', preferredToken(
    value.output_audio_tokens,
    value.output_token_details?.audio_tokens,
  ));
  addToken(totals, 'cached_input_tokens', preferredToken(
    value.cached_input_tokens,
    value.input_token_details?.cached_tokens,
  ));
  return true;
}

function hasPositiveResponseAccounting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const total = tokenInteger(value.total_tokens);
  const input = tokenInteger(value.input_tokens);
  const output = tokenInteger(value.output_tokens);
  return total !== null && total > 0 && input !== null && output !== null &&
    input <= Number.MAX_SAFE_INTEGER - output && total === input + output;
}

function parseExactIso(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return parsed;
}

function requireBoundedTime(value, lowerBound, upperBound) {
  const parsed = parseExactIso(value);
  if (!parsed || parsed.getTime() < lowerBound.getTime() ||
      parsed.getTime() > upperBound.getTime()) {
    throw new Error('invalid evidence timestamp');
  }
  return parsed;
}

function validateEvidenceTimestamps(database, windowTime, nowTime) {
  const sessions = database.prepare(`
    SELECT status, opened_at, closed_at
    FROM realtime_sessions
    WHERE opened_at >= ? AND opened_at <= ?
  `).all(windowTime.toISOString(), nowTime.toISOString());
  for (const session of sessions) {
    const opened = requireBoundedTime(session.opened_at, windowTime, nowTime);
    if (session.closed_at !== null) {
      requireBoundedTime(session.closed_at, opened, nowTime);
    } else if (session.status === 'closed' || session.status === 'failed') {
      throw new Error('terminal session is missing a timestamp');
    }
  }

  const children = [
    ['jobs', 'created_at', 'completed_at', true],
    ['voice_events', 'created_at', null, false],
    ['realtime_usage', 'created_at', null, false],
  ];
  for (const [table, createdColumn, completedColumn, hasStatus] of children) {
    const terminalProjection = completedColumn ? `, child.${completedColumn}` : '';
    const statusProjection = hasStatus ? ', child.status' : '';
    const rows = database.prepare(`
      WITH cohort_sessions AS (
        SELECT id, voice_thread_id, opened_at
        FROM realtime_sessions
        WHERE opened_at >= ? AND opened_at <= ?
      )
      SELECT child.${createdColumn}, cohort_sessions.opened_at,
        child.voice_thread_id AS child_thread_id,
        cohort_sessions.voice_thread_id AS session_thread_id
        ${terminalProjection}${statusProjection}
      FROM ${table} AS child
      INNER JOIN cohort_sessions
        ON cohort_sessions.id = child.realtime_session_id
      WHERE child.${createdColumn} >= ? AND child.${createdColumn} <= ?
    `).all(
      windowTime.toISOString(), nowTime.toISOString(),
      windowTime.toISOString(), nowTime.toISOString(),
    );
    for (const row of rows) {
      if (row.child_thread_id !== row.session_thread_id) {
        throw new Error('child/session cohort mismatch');
      }
      const opened = requireBoundedTime(row.opened_at, windowTime, nowTime);
      const created = requireBoundedTime(row[createdColumn], opened, nowTime);
      if (completedColumn && row[completedColumn] !== null) {
        requireBoundedTime(row[completedColumn], created, nowTime);
      } else if (completedColumn && ['completed', 'failed', 'canceled', 'outcome_unknown']
        .includes(row.status)) {
        throw new Error('terminal job is missing a timestamp');
      }
    }
  }
}

function unavailableSnapshot(
  trialStartedAt = null,
  windowStartedAt = null,
  evidenceSampledAt = null,
) {
  return {
    available: false,
    windowDays: LOOKBACK_DAYS,
    evidenceSampledAt,
    trialStartedAt,
    windowStartedAt,
    sessions: {
      total: null, last24Hours: null, activeDays: null, closed: null, failed: null,
      active: null, completionRatePercent: null, averageDurationSeconds: null,
    },
    jobs: {
      total: null, completed: null, failed: null, canceled: null, active: null,
      completionRatePercent: null, averageDurationSeconds: null,
    },
    turns: { user: null },
    usage: {
      records: null, responseRecords: null, validResponseRecords: null,
      transcriptionRecords: null, totalTokens: null, inputTokens: null,
      outputTokens: null, inputAudioTokens: null, outputAudioTokens: null,
      cachedInputTokens: null,
    },
  };
}

function readAggregateEvidence({
  databasePath = LIVE_STATE_DATABASE,
  now = new Date(),
  trialEpoch,
  Database = DatabaseSync,
} = {}) {
  const nowTime = parseExactIso(now);
  const epochTime = parseExactIso(trialEpoch);
  if (!nowTime) {
    return unavailableSnapshot();
  }

  const evidenceSampledAt = nowTime.toISOString();
  if (!epochTime || epochTime.getTime() > nowTime.getTime()) {
    return unavailableSnapshot(null, null, evidenceSampledAt);
  }

  const rollingCutoffTime = nowTime.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const cohortTime = new Date(Math.max(epochTime.getTime(), rollingCutoffTime));
  const trialStartedAt = epochTime.toISOString();
  const windowStartedAt = cohortTime.toISOString();
  const upperBound = nowTime.toISOString();
  const dayCutoff = new Date(nowTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const snapshot = unavailableSnapshot(trialStartedAt, windowStartedAt, evidenceSampledAt);
  let database;
  let transactionOpen = false;

  try {
    database = new Database(databasePath, { readOnly: true, allowExtension: false });
    database.exec('BEGIN');
    transactionOpen = true;
    validateEvidenceTimestamps(database, cohortTime, nowTime);

    const sessions = database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN opened_at >= ? THEN 1 ELSE 0 END) AS last_24_hours,
        COUNT(DISTINCT substr(opened_at, 1, 10)) AS active_days,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('connecting', 'connected') THEN 1 ELSE 0 END) AS active,
        AVG(CASE
          WHEN closed_at IS NOT NULL
          THEN unixepoch(closed_at) - unixepoch(opened_at)
          ELSE NULL
        END) AS average_duration_seconds
      FROM realtime_sessions
      WHERE opened_at >= ? AND opened_at <= ?
    `).get(dayCutoff, windowStartedAt, upperBound);

    const jobs = database.prepare(`
      WITH cohort_sessions AS (
        SELECT id, voice_thread_id, opened_at
        FROM realtime_sessions
        WHERE opened_at >= ? AND opened_at <= ?
      )
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN jobs.status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN jobs.status IN ('failed', 'outcome_unknown') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN jobs.status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
        SUM(CASE WHEN jobs.status IN (
          'awaiting_approval', 'queued', 'running', 'reconciling', 'cancel_requested'
        ) THEN 1 ELSE 0 END) AS active,
        AVG(CASE
          WHEN jobs.completed_at IS NOT NULL
          THEN unixepoch(jobs.completed_at) - unixepoch(jobs.created_at)
          ELSE NULL
        END) AS average_duration_seconds
      FROM jobs
      INNER JOIN cohort_sessions
        ON cohort_sessions.id = jobs.realtime_session_id
        AND cohort_sessions.voice_thread_id = jobs.voice_thread_id
      WHERE jobs.created_at >= ? AND jobs.created_at <= ?
        AND jobs.created_at >= cohort_sessions.opened_at
    `).get(windowStartedAt, upperBound, windowStartedAt, upperBound);

    const turns = database.prepare(`
      WITH cohort_sessions AS (
        SELECT id, voice_thread_id, opened_at
        FROM realtime_sessions
        WHERE opened_at >= ? AND opened_at <= ?
      )
      SELECT COUNT(*) AS total
      FROM voice_events
      INNER JOIN cohort_sessions
        ON cohort_sessions.id = voice_events.realtime_session_id
        AND cohort_sessions.voice_thread_id = voice_events.voice_thread_id
      WHERE voice_events.created_at >= ? AND voice_events.created_at <= ?
        AND voice_events.created_at >= cohort_sessions.opened_at
        AND voice_events.role = 'user' AND voice_events.kind = 'transcript'
    `).get(windowStartedAt, upperBound, windowStartedAt, upperBound);

    const usageRows = database.prepare(`
      WITH cohort_sessions AS (
        SELECT id, voice_thread_id, opened_at
        FROM realtime_sessions
        WHERE opened_at >= ? AND opened_at <= ?
      )
      SELECT realtime_usage.kind, realtime_usage.usage_json
      FROM realtime_usage
      INNER JOIN cohort_sessions
        ON cohort_sessions.id = realtime_usage.realtime_session_id
        AND cohort_sessions.voice_thread_id = realtime_usage.voice_thread_id
      WHERE realtime_usage.created_at >= ? AND realtime_usage.created_at <= ?
        AND realtime_usage.created_at >= cohort_sessions.opened_at
    `).all(windowStartedAt, upperBound, windowStartedAt, upperBound);

    const closed = safeInteger(sessions.closed);
    const sessionFailures = safeInteger(sessions.failed);
    const completedJobs = safeInteger(jobs.completed);
    const failedJobs = safeInteger(jobs.failed);
    const canceledJobs = safeInteger(jobs.canceled);
    const tokenTotals = {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      input_audio_tokens: 0,
      output_audio_tokens: 0,
      cached_input_tokens: 0,
    };
    let responseRecords = 0;
    let validResponseRecords = 0;
    let transcriptionRecords = 0;

    for (const row of usageRows) {
      if (row.kind === 'response') responseRecords += 1;
      if (row.kind === 'transcription') transcriptionRecords += 1;
      try {
        const usage = JSON.parse(row.usage_json);
        sumTokenFields(usage, tokenTotals);
        if (row.kind === 'response' && hasPositiveResponseAccounting(usage)) {
          validResponseRecords += 1;
        }
      } catch {
        // Malformed rows are descriptive only; they cannot pass accounting.
      }
    }

    const result = {
      available: true,
      windowDays: LOOKBACK_DAYS,
      evidenceSampledAt,
      trialStartedAt,
      windowStartedAt,
      sessions: {
        total: safeInteger(sessions.total),
        last24Hours: safeInteger(sessions.last_24_hours),
        activeDays: safeInteger(sessions.active_days),
        closed,
        failed: sessionFailures,
        active: safeInteger(sessions.active),
        completionRatePercent: safeRate(closed, closed + sessionFailures),
        averageDurationSeconds: sessions.average_duration_seconds === null
          ? null : safeInteger(sessions.average_duration_seconds),
      },
      jobs: {
        total: safeInteger(jobs.total),
        completed: completedJobs,
        failed: failedJobs,
        canceled: canceledJobs,
        active: safeInteger(jobs.active),
        completionRatePercent: safeRate(
          completedJobs,
          completedJobs + failedJobs + canceledJobs,
        ),
        averageDurationSeconds: jobs.average_duration_seconds === null
          ? null : safeInteger(jobs.average_duration_seconds),
      },
      turns: { user: safeInteger(turns.total) },
      usage: {
        records: safeInteger(usageRows.length),
        responseRecords: safeInteger(responseRecords),
        validResponseRecords: safeInteger(validResponseRecords),
        transcriptionRecords: safeInteger(transcriptionRecords),
        totalTokens: tokenTotals.total_tokens,
        inputTokens: tokenTotals.input_tokens,
        outputTokens: tokenTotals.output_tokens,
        inputAudioTokens: tokenTotals.input_audio_tokens,
        outputAudioTokens: tokenTotals.output_audio_tokens,
        cachedInputTokens: tokenTotals.cached_input_tokens,
      },
    };
    database.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* Keep the failure generic. */ }
      transactionOpen = false;
    }
    return snapshot;
  } finally {
    try { database?.close(); } catch { /* Never expose storage diagnostics. */ }
  }
}

module.exports = {
  LIVE_STATE_DATABASE,
  LOOKBACK_DAYS,
  hasPositiveResponseAccounting,
  readAggregateEvidence,
  sumTokenFields,
  unavailableSnapshot,
};
