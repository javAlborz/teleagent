'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const {
  hasPositiveResponseAccounting,
  readAggregateEvidence,
  sumTokenFields,
} = require('../aggregate-store');
const { MAX_HEALTH_BYTES, readLoopbackHealth } = require('../health');
const { VoiceStateStore } = require('../../../voice-app/lib/voice-state-store');

const NOW = new Date('2026-08-27T12:00:00.000Z');
const TRIAL_EPOCH = '2026-08-22T00:00:00.000Z';

function makeDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-evaluation-'));
  const databasePath = path.join(directory, 'state.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE realtime_sessions (
      id TEXT, voice_thread_id TEXT, call_id TEXT, status TEXT, error TEXT,
      opened_at TEXT, closed_at TEXT
    );
    CREATE TABLE jobs (
      id TEXT, voice_thread_id TEXT, realtime_session_id TEXT,
      request TEXT, status TEXT, error TEXT,
      created_at TEXT, completed_at TEXT
    );
    CREATE TABLE voice_events (
      id INTEGER, voice_thread_id TEXT, realtime_session_id TEXT,
      role TEXT, kind TEXT, content TEXT, created_at TEXT
    );
    CREATE TABLE realtime_usage (
      id INTEGER, voice_thread_id TEXT, realtime_session_id TEXT,
      kind TEXT, model TEXT, usage_json TEXT, created_at TEXT
    );
  `);
  return { directory, databasePath, database };
}

test('positive response accounting requires an exact total/input/output relation', () => {
  assert.equal(hasPositiveResponseAccounting({
    total_tokens: 10, input_tokens: 6, output_tokens: 4,
  }), true);
  assert.equal(hasPositiveResponseAccounting({
    total_tokens: 11, input_tokens: 6, output_tokens: 4,
  }), false);
  assert.equal(hasPositiveResponseAccounting({
    total_tokens: 10, input_tokens: 10, output_tokens: null,
  }), false);
});

test('root token-detail aliases take precedence and are never double-counted', () => {
  const totals = {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    input_audio_tokens: 0,
    output_audio_tokens: 0,
    cached_input_tokens: 0,
  };
  sumTokenFields({
    total_tokens: 10,
    input_tokens: 6,
    output_tokens: 4,
    input_audio_tokens: 3,
    output_audio_tokens: 2,
    cached_input_tokens: 1,
    input_token_details: { audio_tokens: 30, cached_tokens: 10 },
    output_token_details: { audio_tokens: 20 },
  }, totals);
  assert.deepEqual(totals, {
    total_tokens: 10,
    input_tokens: 6,
    output_tokens: 4,
    input_audio_tokens: 3,
    output_audio_tokens: 2,
    cached_input_tokens: 1,
  });
});

test('aggregate reader returns only counts and allowlisted numeric usage', () => {
  const fixture = makeDatabase();
  try {
    const insertSession = fixture.database.prepare(`
      INSERT INTO realtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const sensitive = 'SENSITIVE_CALLER_TRANSCRIPT_REQUEST_ERROR_PATH_SECRET';
    const rows = [
      ['secret-session-1', 'trial-thread', sensitive, 'closed', null, '2026-08-27T10:00:00.000Z', '2026-08-27T10:01:00.000Z'],
      ['secret-session-2', 'trial-thread', sensitive, 'closed', null, '2026-08-25T10:00:00.000Z', '2026-08-25T10:02:00.000Z'],
      ['secret-session-3', 'trial-thread', sensitive, 'closed', null, '2026-08-23T10:00:00.000Z', '2026-08-23T10:03:00.000Z'],
      ['secret-session-4', 'trial-thread', sensitive, 'closed', null, '2026-08-23T11:00:00.000Z', '2026-08-23T11:04:00.000Z'],
      ['secret-session-5', 'trial-thread', sensitive, 'closed', null, '2026-08-23T12:00:00.000Z', '2026-08-23T12:05:00.000Z'],
      ['secret-session-6', 'trial-thread', sensitive, 'failed', sensitive, '2026-08-23T13:00:00.000Z', '2026-08-23T13:01:00.000Z'],
      ['pre-epoch-session', 'old-thread', sensitive, 'closed', null, '2026-08-20T10:00:00.000Z', '2026-08-20T10:01:00.000Z'],
      ['future-session', 'future-thread', sensitive, 'closed', null, '2026-08-28T10:00:00.000Z', '2026-08-28T10:01:00.000Z'],
    ];
    for (const row of rows) insertSession.run(...row);

    const insertJob = fixture.database.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insertJob.run('secret-job-1', 'trial-thread', 'secret-session-2', sensitive, 'completed', null,
      '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:10.000Z');
    insertJob.run('secret-job-2', 'trial-thread', 'secret-session-2', sensitive, 'failed', sensitive,
      '2026-08-26T11:00:00.000Z', '2026-08-26T11:00:20.000Z');
    insertJob.run('pre-epoch-job', 'old-thread', 'pre-epoch-session', sensitive, 'completed', null,
      '2026-08-20T11:00:00.000Z', '2026-08-20T11:00:20.000Z');
    insertJob.run('future-job', 'future-thread', 'future-session', sensitive, 'completed', null,
      '2026-08-28T11:00:00.000Z', '2026-08-28T11:00:20.000Z');

    fixture.database.prepare('INSERT INTO voice_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      1, 'trial-thread', 'secret-session-1', 'user', 'transcript', sensitive,
      '2026-08-27T10:00:30.000Z',
    );
    fixture.database.prepare('INSERT INTO voice_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      2, 'old-thread', 'pre-epoch-session', 'user', 'transcript', sensitive,
      '2026-08-20T12:00:00.000Z',
    );
    fixture.database.prepare('INSERT INTO voice_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      3, 'future-thread', 'future-session', 'user', 'transcript', sensitive,
      '2026-08-28T12:00:00.000Z',
    );
    fixture.database.prepare('INSERT INTO realtime_usage VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      1,
      'trial-thread',
      'secret-session-1',
      'response',
      sensitive,
      JSON.stringify({
        total_tokens: 100,
        input_tokens: 60,
        output_tokens: 40,
        input_token_details: { audio_tokens: 30, cached_tokens: 10 },
        secret: sensitive,
      }),
      '2026-08-27T10:00:40.000Z',
    );
    fixture.database.prepare('INSERT INTO realtime_usage VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      2,
      'trial-thread',
      'secret-session-1',
      'transcription',
      sensitive,
      JSON.stringify({ input_audio_tokens: 22, request: sensitive }),
      '2026-08-27T10:00:50.000Z',
    );
    fixture.database.prepare('INSERT INTO realtime_usage VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      3, 'trial-thread', 'secret-session-1', 'response', sensitive, '{malformed',
      '2026-08-27T10:00:55.000Z',
    );
    fixture.database.prepare('INSERT INTO realtime_usage VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      4, 'old-thread', 'pre-epoch-session', 'response', sensitive,
      JSON.stringify({ total_tokens: 9000, input_tokens: 8000, output_tokens: 1000 }),
      '2026-08-20T12:02:00.000Z',
    );
    fixture.database.prepare('INSERT INTO realtime_usage VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      5, 'future-thread', 'future-session', 'response', sensitive,
      JSON.stringify({ total_tokens: 7000, input_tokens: 6000, output_tokens: 1000 }),
      '2026-08-28T12:02:00.000Z',
    );
    fixture.database.close();

    const result = readAggregateEvidence({
      databasePath: fixture.databasePath,
      now: NOW,
      trialEpoch: TRIAL_EPOCH,
    });
    assert.equal(result.available, true);
    assert.equal(result.evidenceSampledAt, NOW.toISOString());
    assert.equal(result.trialStartedAt, TRIAL_EPOCH);
    assert.equal(result.windowStartedAt, TRIAL_EPOCH);
    assert.deepEqual(result.sessions, {
      total: 6,
      last24Hours: 1,
      activeDays: 3,
      closed: 5,
      failed: 1,
      active: 0,
      completionRatePercent: 83.3,
      averageDurationSeconds: 160,
    });
    assert.equal(result.jobs.total, 2);
    assert.equal(result.jobs.completed, 1);
    assert.equal(result.turns.user, 1);
    assert.equal(result.usage.records, 3);
    assert.equal(result.usage.responseRecords, 2);
    assert.equal(result.usage.validResponseRecords, 1);
    assert.equal(result.usage.transcriptionRecords, 1);
    assert.equal(result.usage.totalTokens, 100);
    assert.equal(result.usage.inputTokens, 60);
    assert.equal(result.usage.outputTokens, 40);
    assert.equal(result.usage.inputAudioTokens, 52);
    assert.equal(result.usage.cachedInputTokens, 10);
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|secret-session|secret-job/u);
  } finally {
    try { fixture.database.close(); } catch { /* Already closed in the success path. */ }
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('aggregate reader fails closed without returning database details', () => {
  const result = readAggregateEvidence({
    databasePath: '/definitely/not/a/live/state/database.sqlite',
    now: NOW,
    trialEpoch: TRIAL_EPOCH,
  });
  assert.equal(result.available, false);
  assert.equal(result.evidenceSampledAt, NOW.toISOString());
  assert.equal(result.sessions.total, null);
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.trialStartedAt, TRIAL_EPOCH);
  assert.equal(result.windowStartedAt, TRIAL_EPOCH);
  assert.doesNotMatch(JSON.stringify(result), /definitely|database\.sqlite/u);
});

test('aggregate reader rejects a future trial epoch', () => {
  const result = readAggregateEvidence({
    databasePath: '/not-opened.sqlite',
    now: NOW,
    trialEpoch: '2026-08-28T00:00:00.000Z',
  });
  assert.equal(result.available, false);
  assert.equal(result.evidenceSampledAt, NOW.toISOString());
  assert.equal(result.trialStartedAt, null);
  assert.equal(result.windowStartedAt, null);
});

test('trial epoch remains stable when the evidence window rolls forward', () => {
  const trialStartedAt = '2026-08-01T00:00:00.000Z';
  const result = readAggregateEvidence({
    databasePath: '/definitely/not/a/live/state/database.sqlite',
    now: NOW,
    trialEpoch: trialStartedAt,
  });
  assert.equal(result.trialStartedAt, trialStartedAt);
  assert.equal(result.windowStartedAt, '2026-08-13T12:00:00.000Z');
});

test('rolling cohort includes the exact cutoff and excludes children of pre-window sessions', () => {
  const fixture = makeDatabase();
  const cutoff = '2026-08-13T12:00:00.000Z';
  try {
    const insertSession = fixture.database.prepare(
      'INSERT INTO realtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertSession.run('before', 'old-thread', 'old-call', 'closed', null,
      '2026-08-13T11:59:00.000Z', '2026-08-13T11:59:30.000Z');
    insertSession.run('boundary', 'trial-thread', 'trial-call', 'closed', null,
      cutoff, '2026-08-13T12:01:00.000Z');
    insertSession.run('after', 'trial-thread', 'trial-call-2', 'closed', null,
      '2026-08-14T12:00:00.000Z', '2026-08-14T12:01:00.000Z');

    const insertJob = fixture.database.prepare(
      'INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertJob.run('boundary-job', 'trial-thread', 'boundary', 'request', 'completed', null,
      cutoff, '2026-08-13T12:00:10.000Z');
    insertJob.run('old-parent-new-job', 'old-thread', 'before', 'request', 'completed', null,
      '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:10.000Z');

    const insertEvent = fixture.database.prepare(
      'INSERT INTO voice_events VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertEvent.run(1, 'trial-thread', 'boundary', 'user', 'transcript', 'private', cutoff);
    insertEvent.run(2, 'old-thread', 'before', 'user', 'transcript', 'private',
      '2026-08-14T12:00:00.000Z');

    const insertUsage = fixture.database.prepare(
      'INSERT INTO realtime_usage VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertUsage.run(1, 'trial-thread', 'boundary', 'response', 'model',
      JSON.stringify({ total_tokens: 10, input_tokens: 6, output_tokens: 4 }), cutoff);
    insertUsage.run(2, 'old-thread', 'before', 'response', 'model',
      JSON.stringify({ total_tokens: 100, input_tokens: 60, output_tokens: 40 }),
      '2026-08-14T12:00:00.000Z');
    fixture.database.close();

    const result = readAggregateEvidence({
      databasePath: fixture.databasePath,
      now: NOW,
      trialEpoch: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(result.available, true);
    assert.equal(result.windowStartedAt, cutoff);
    assert.equal(result.sessions.total, 2);
    assert.equal(result.jobs.total, 1);
    assert.equal(result.turns.user, 1);
    assert.equal(result.usage.records, 1);
    assert.equal(result.usage.totalTokens, 10);
  } finally {
    try { fixture.database.close(); } catch { /* Already closed. */ }
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('aggregate evidence fails closed on noncanonical, reversed, or future terminal times', () => {
  const invalidClosedTimes = [
    '2026-08-26T10:01:00Z',
    '2026-08-26T09:59:59.000Z',
    '2026-08-28T10:01:00.000Z',
  ];
  for (const [index, closedAt] of invalidClosedTimes.entries()) {
    const fixture = makeDatabase();
    try {
      fixture.database.prepare(
        'INSERT INTO realtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`invalid-${index}`, 'thread', 'call', 'closed', null,
        '2026-08-26T10:00:00.000Z', closedAt);
      fixture.database.close();
      const result = readAggregateEvidence({
        databasePath: fixture.databasePath,
        now: NOW,
        trialEpoch: TRIAL_EPOCH,
      });
      assert.equal(result.available, false, closedAt);
      assert.equal(result.sessions.total, null);
    } finally {
      try { fixture.database.close(); } catch { /* Already closed. */ }
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  }

  const fixture = makeDatabase();
  try {
    fixture.database.prepare(
      'INSERT INTO realtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('session', 'thread', 'call', 'closed', null,
      '2026-08-26T09:00:00.000Z', '2026-08-26T09:30:00.000Z');
    fixture.database.prepare(
      'INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('job', 'thread', 'session', 'request', 'completed', null,
      '2026-08-26T10:00:00.000Z', '2026-08-26T09:59:59.000Z');
    fixture.database.close();
    assert.equal(readAggregateEvidence({
      databasePath: fixture.databasePath,
      now: NOW,
      trialEpoch: TRIAL_EPOCH,
    }).available, false);
  } finally {
    try { fixture.database.close(); } catch { /* Already closed. */ }
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('in-window child/session thread mismatches fail evidence integrity', () => {
  const fixture = makeDatabase();
  try {
    fixture.database.prepare(
      'INSERT INTO realtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('session', 'session-thread', 'call', 'closed', null,
      '2026-08-26T10:00:00.000Z', '2026-08-26T10:01:00.000Z');
    fixture.database.prepare(
      'INSERT INTO voice_events VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1, 'different-thread', 'session', 'user', 'transcript', 'private',
      '2026-08-26T10:00:30.000Z');
    fixture.database.close();

    const result = readAggregateEvidence({
      databasePath: fixture.databasePath,
      now: NOW,
      trialEpoch: TRIAL_EPOCH,
    });
    assert.equal(result.available, false);
    assert.equal(result.turns.user, null);
  } finally {
    try { fixture.database.close(); } catch { /* Already closed. */ }
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('aggregate queries remain compatible with the production state schema', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-schema-contract-'));
  const databasePath = path.join(directory, 'voice-state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new VoiceStateStore({ dbPath: databasePath });
  store.close();

  const result = readAggregateEvidence({ databasePath, now: NOW, trialEpoch: TRIAL_EPOCH });
  assert.equal(result.available, true);
  assert.equal(result.sessions.total, 0);
  assert.equal(result.usage.validResponseRecords, 0);
});

test('read-only aggregation keeps one SQLite WAL snapshot while a writer commits', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-wal-contract-'));
  const databasePath = path.join(directory, 'voice-state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new VoiceStateStore({ dbPath: databasePath });
  store.close();

  const setup = new DatabaseSync(databasePath);
  setup.exec('PRAGMA journal_mode = WAL');
  setup.prepare(`
    INSERT INTO voice_threads (
      id, caller_id, selected_profile, status, summary, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('thread', 'caller', 'default', 'active', '', '{}',
    '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
  setup.prepare(`
    INSERT INTO realtime_sessions (
      id, voice_thread_id, call_id, model, status, opened_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('initial', 'thread', 'call-1', 'model', 'closed',
    '2026-08-26T10:00:00.000Z', '2026-08-26T10:01:00.000Z',
    '2026-08-26T10:01:00.000Z');
  setup.close();

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(shared);
  const worker = new Worker(`
    'use strict';
    const { DatabaseSync } = require('node:sqlite');
    const { workerData } = require('node:worker_threads');
    const state = new Int32Array(workerData.shared);
    const database = new DatabaseSync(workerData.databasePath);
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
    Atomics.wait(state, 0, 1);
    database.prepare(\`
      INSERT INTO realtime_sessions (
        id, voice_thread_id, call_id, model, status, opened_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    \`).run('concurrent', 'thread', 'call-2', 'model', 'closed',
      '2026-08-26T11:00:00.000Z', '2026-08-26T11:01:00.000Z',
      '2026-08-26T11:01:00.000Z');
    database.close();
    Atomics.store(state, 0, 3);
    Atomics.notify(state, 0);
  `, { eval: true, workerData: { databasePath, shared } });
  const workerExit = once(worker, 'exit');
  assert.notEqual(Atomics.wait(state, 0, 0, 5000), 'timed-out');
  assert.equal(Atomics.load(state, 0), 1);

  let interleaved = false;
  class InterleavingReadOnlyDatabase {
    constructor(filePath, options) {
      this.database = new DatabaseSync(filePath, options);
    }

    exec(sql) {
      return this.database.exec(sql);
    }

    prepare(sql) {
      const statement = this.database.prepare(sql);
      if (!interleaved && sql.includes('SELECT status, opened_at, closed_at')) {
        return {
          all: (...parameters) => {
            const rows = statement.all(...parameters);
            interleaved = true;
            Atomics.store(state, 0, 2);
            Atomics.notify(state, 0);
            assert.notEqual(Atomics.wait(state, 0, 2, 5000), 'timed-out');
            assert.equal(Atomics.load(state, 0), 3);
            return rows;
          },
        };
      }
      return statement;
    }

    close() {
      return this.database.close();
    }
  }

  const result = readAggregateEvidence({
    databasePath,
    now: NOW,
    trialEpoch: TRIAL_EPOCH,
    Database: InterleavingReadOnlyDatabase,
  });
  assert.equal(result.available, true);
  assert.equal(result.sessions.total, 1);
  const [exitCode] = await workerExit;
  assert.equal(exitCode, 0);

  const verification = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verification.prepare('SELECT COUNT(*) AS total FROM realtime_sessions').get().total, 2);
  verification.close();
});

test('loopback health selector discards upstream diagnostics and identities', async () => {
  const sensitive = 'SENSITIVE_PROVIDER_ID_ERROR_PATH_SECRET';
  const bodies = new Map([
    ['http://127.0.0.1:3000/health', { status: 'healthy', error: sensitive }],
    ['http://127.0.0.1:3000/api/realtime-health', {
      status: 'healthy',
      configured: true,
      model: sensitive,
      state: { ok: true, capacity: { ok: true } },
      voiceExecution: { locked: true, persistent: true, reason: sensitive },
    }],
    ['http://127.0.0.1:3333/health', {
      status: 'ok', ready: true, providers: [sensitive, 'another-private-provider'], error: sensitive,
    }],
  ]);
  const fetchImpl = async (url) => new Response(JSON.stringify(bodies.get(url)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const result = await readLoopbackHealth({ fetchImpl, now: () => NOW });
  assert.equal(result.healthSampledAt, NOW.toISOString());
  assert.equal(result.voiceApp.healthy, true);
  assert.equal(result.realtime.capacityHealthy, true);
  assert.equal(result.realtime.capacityObservation, 'proven_healthy');
  assert.equal(result.realtime.voiceExecutionLocked, true);
  assert.equal(result.realtime.voiceExecutionPersistent, true);
  assert.equal(result.controller.providerCount, 2);
  assert.deepEqual(Object.keys(result.realtime).sort(), [
    'capacityHealthy',
    'capacityObservation',
    'configured',
    'healthy',
    'reachable',
    'stateHealthy',
    'voiceExecutionLocked',
    'voiceExecutionPersistent',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|private-provider|error|path|reason/u);
});

test('canonical Realtime capacity refusal reports false without accepting other health proof', async () => {
  const sensitive = 'SENSITIVE_503_DIAGNOSTIC_PATH_IDENTITY';
  const fetchImpl = async (url) => {
    if (!url.endsWith('/api/realtime-health')) {
      return new Response(JSON.stringify({ status: 'healthy' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      status: 'unhealthy',
      configured: true,
      state: {
        ok: true,
        capacity: { ok: false },
      },
      voiceExecution: { locked: true, persistent: true, reason: sensitive },
      identity: sensitive,
    }), { status: 503 });
  };

  const result = await readLoopbackHealth({ fetchImpl, now: () => NOW });
  assert.equal(result.realtime.reachable, true);
  assert.equal(result.realtime.healthy, false);
  assert.equal(result.realtime.capacityHealthy, false);
  assert.equal(result.realtime.capacityObservation, 'reported_unhealthy');
  assert.equal(result.realtime.configured, null);
  assert.equal(result.realtime.stateHealthy, null);
  assert.equal(result.realtime.voiceExecutionLocked, null);
  assert.equal(result.realtime.voiceExecutionPersistent, null);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|diagnostic|path|identity|availableBytes/u);
});

test('health collection rejects non-2xx, malformed, and oversized bodies without leakage', async () => {
  const sensitive = 'SENSITIVE_UPSTREAM_DIAGNOSTIC';
  const fetchImpl = async (url) => {
    if (url.endsWith('/health') && url.includes(':3000')) {
      return new Response(JSON.stringify({ status: 'healthy', error: sensitive }), { status: 503 });
    }
    if (url.endsWith('/api/realtime-health')) {
      return new Response(`{malformed-${sensitive}`, { status: 200 });
    }
    return new Response(`${sensitive}${'x'.repeat(MAX_HEALTH_BYTES + 1)}`, { status: 200 });
  };

  const result = await readLoopbackHealth({ fetchImpl, now: () => NOW });
  assert.equal(result.voiceApp.reachable, true);
  assert.equal(result.voiceApp.healthy, false);
  assert.equal(result.realtime.reachable, false);
  assert.equal(result.realtime.healthy, false);
  assert.equal(result.realtime.capacityHealthy, null);
  assert.equal(result.realtime.capacityObservation, 'not_proven');
  assert.equal(result.controller.reachable, false);
  assert.equal(result.controller.healthy, false);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|diagnostic|malformed/u);
});

test('missing Realtime capacity remains unknown rather than passing by default', async () => {
  const fetchImpl = async (url) => {
    const body = url.endsWith('/api/realtime-health')
      ? {
          status: 'healthy', configured: true, state: { ok: true },
          voiceExecution: { locked: true, persistent: true },
        }
      : { status: 'healthy' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await readLoopbackHealth({ fetchImpl, now: () => NOW });
  assert.equal(result.realtime.healthy, true);
  assert.equal(result.realtime.stateHealthy, true);
  assert.equal(result.realtime.capacityHealthy, null);
  assert.equal(result.realtime.capacityObservation, 'unsupported');
});

test('malformed, oversized, and noncanonical capacity reports remain unknown', async () => {
  const sensitive = 'SENSITIVE_INVALID_CAPACITY_REPORT';
  const cases = [
    () => new Response(`{malformed-${sensitive}`, { status: 200 }),
    () => new Response(JSON.stringify({
      status: 'healthy',
      state: { ok: true, capacity: { ok: true, diagnostic: `${sensitive}${'x'.repeat(MAX_HEALTH_BYTES)}` } },
    }), { status: 200 }),
    () => new Response(JSON.stringify({
      status: 'healthy', state: { ok: true, capacity: { ok: false, diagnostic: sensitive } },
    }), { status: 200 }),
    () => new Response(JSON.stringify({
      status: 'unhealthy', state: { ok: false, capacity: { ok: true, diagnostic: sensitive } },
    }), { status: 503 }),
    () => new Response(JSON.stringify({
      status: 'unhealthy', state: { ok: false, capacity: { ok: false, diagnostic: sensitive } },
    }), { status: 500 }),
    () => new Response(JSON.stringify({
      status: 'unhealthy', state: { ok: false, capacity: { ok: 'false', diagnostic: sensitive } },
    }), { status: 503 }),
    () => new Response(JSON.stringify({
      status: 'ok', state: { ok: true, capacity: { ok: true } },
    }), { status: 201 }),
    () => new Response(JSON.stringify({
      ready: true, state: { ok: true, capacity: { ok: true } },
    }), { status: 200 }),
    () => new Response(JSON.stringify({
      status: 'healthy', state: { ok: true, capacity: { ok: true, diagnostic: sensitive } },
    }), { status: 200 }),
    () => new Response(JSON.stringify({
      status: 'unhealthy', state: { ok: false, capacity: { ok: false, diagnostic: sensitive } },
    }), { status: 503 }),
  ];

  for (const responseFactory of cases) {
    const fetchImpl = async (url) => url.endsWith('/api/realtime-health')
      ? responseFactory()
      : new Response(JSON.stringify({ status: 'healthy' }), { status: 200 });
    const result = await readLoopbackHealth({ fetchImpl, now: () => NOW });
    assert.equal(result.realtime.capacityHealthy, null);
    assert.equal(result.realtime.capacityObservation, 'not_proven');
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|diagnostic/u);
  }
});

test('nonhealthy Realtime responses cannot assert panic-lock proof', async () => {
  const fetchImpl = async (url) => {
    const realtime = url.endsWith('/api/realtime-health');
    return new Response(JSON.stringify(realtime ? {
      status: 'healthy',
      configured: true,
      state: { ok: true, capacity: { ok: true } },
      voiceExecution: { locked: true, persistent: true },
    } : { status: 'healthy' }), { status: realtime ? 503 : 200 });
  };
  const result = await readLoopbackHealth({ fetchImpl, now: () => NOW });
  assert.equal(result.realtime.reachable, true);
  assert.equal(result.realtime.healthy, false);
  assert.equal(result.realtime.configured, null);
  assert.equal(result.realtime.capacityHealthy, null);
  assert.equal(result.realtime.capacityObservation, 'not_proven');
  assert.equal(result.realtime.voiceExecutionLocked, null);
  assert.equal(result.realtime.voiceExecutionPersistent, null);
});
