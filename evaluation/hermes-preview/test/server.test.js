'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { unavailableSnapshot } = require('../aggregate-store');
const { readLaunchToken, readTrialEpoch } = require('../runtime-files');
const { buildScorecard } = require('../scorecard');
const { composeSnapshot } = require('../snapshot-schema');
const {
  MAX_CONNECTIONS,
  MAX_IN_FLIGHT,
  MAX_REQUESTS_PER_MINUTE,
  TOKEN_HEADER,
  createDashboardServer,
  readComposedSnapshot,
} = require('../server');

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const NOW = new Date('2026-08-27T12:00:00.000Z');
const TRIAL_EPOCH = '2026-08-22T00:00:00.000Z';
const EVIDENCE_SAMPLED_AT = '2026-08-27T11:59:58.000Z';
const HEALTH_SAMPLED_AT = '2026-08-27T11:59:59.000Z';

function passingEvidence() {
  return {
    available: true,
    windowDays: 14,
    evidenceSampledAt: EVIDENCE_SAMPLED_AT,
    trialStartedAt: TRIAL_EPOCH,
    windowStartedAt: TRIAL_EPOCH,
    sessions: {
      total: 8, last24Hours: 1, activeDays: 4, closed: 8, failed: 0, active: 0,
      completionRatePercent: 100, averageDurationSeconds: 90,
    },
    jobs: {
      total: 3, completed: 3, failed: 0, canceled: 0, active: 0,
      completionRatePercent: 100, averageDurationSeconds: 20,
    },
    turns: { user: 22 },
    usage: {
      records: 5, responseRecords: 3, validResponseRecords: 3, transcriptionRecords: 2,
      totalTokens: 1200, inputTokens: 800, outputTokens: 400,
      inputAudioTokens: 100, outputAudioTokens: 80, cachedInputTokens: 50,
    },
  };
}

function passingHealth() {
  return {
    healthSampledAt: HEALTH_SAMPLED_AT,
    voiceApp: { reachable: true, healthy: true },
    realtime: {
      reachable: true,
      healthy: true,
      configured: true,
      stateHealthy: true,
      capacityHealthy: true,
      capacityObservation: 'proven_healthy',
      voiceExecutionLocked: true,
      voiceExecutionPersistent: true,
    },
    controller: { reachable: true, healthy: false, providerCount: null },
  };
}

function passingSnapshot() {
  return composeSnapshot({ evidence: passingEvidence(), health: passingHealth(), now: NOW });
}

test('machine evidence requires manual review and never authorizes investment', () => {
  const result = buildScorecard(passingEvidence(), passingHealth());
  assert.equal(result.decision, 'machine_evidence_threshold_met');
  assert.match(result.headline, /manual review required/iu);
  assert.equal(result.manualReviewRequired, true);
  assert.equal(result.investmentAuthorized, false);
  assert.equal(result.productionAuthorized, false);
  assert.equal(result.passed, result.total);
  assert.equal(result.failed, 0);
  assert.equal(result.unknown, 0);
});

test('realtime gate distinguishes explicit false from unknown and requires exact true', () => {
  for (const key of ['healthy', 'configured', 'stateHealthy', 'capacityHealthy']) {
    const failedHealth = passingHealth();
    failedHealth.realtime[key] = false;
    if (key === 'capacityHealthy') {
      failedHealth.realtime.capacityObservation = 'reported_unhealthy';
    }
    const failed = buildScorecard(passingEvidence(), failedHealth);
    assert.equal(failed.checks.find((check) => check.key === 'realtime_health').status, 'fail');

    const unknownHealth = passingHealth();
    unknownHealth.realtime[key] = null;
    if (key === 'capacityHealthy') {
      unknownHealth.realtime.capacityObservation = 'unsupported';
    }
    const unknown = buildScorecard(passingEvidence(), unknownHealth);
    assert.equal(unknown.checks.find((check) => check.key === 'realtime_health').status,
      'unknown');
  }
  const passing = buildScorecard(passingEvidence(), passingHealth());
  assert.equal(passing.checks.find((check) => check.key === 'realtime_health').status, 'pass');

  const capacityUnknown = passingHealth();
  capacityUnknown.realtime.capacityHealthy = null;
  capacityUnknown.realtime.capacityObservation = 'unsupported';
  const unknownResult = buildScorecard(passingEvidence(), capacityUnknown);
  assert.equal(unknownResult.unknown, 1);
  assert.equal(unknownResult.failed, 0);

  const capacityFailed = passingHealth();
  capacityFailed.realtime.capacityHealthy = false;
  capacityFailed.realtime.capacityObservation = 'reported_unhealthy';
  const failedResult = buildScorecard(passingEvidence(), capacityFailed);
  assert.equal(failedResult.failed, 1);
  assert.equal(failedResult.unknown, 0);
});

test('controller response coexists with intentionally false readiness under panic', () => {
  const health = passingHealth();
  assert.equal(health.controller.healthy, false);
  const result = buildScorecard(passingEvidence(), health);
  const controller = result.checks.find((check) => check.key === 'controller_reachable');
  assert.equal(controller.status, 'pass');
  assert.match(controller.label, /readiness intentionally false under panic/iu);
  assert.equal(result.decision, 'machine_evidence_threshold_met');

  health.controller.reachable = false;
  assert.equal(
    buildScorecard(passingEvidence(), health)
      .checks.find((check) => check.key === 'controller_reachable').status,
    'fail',
  );
});

test('missing persistent panic proof is an unconditional stop', () => {
  const health = passingHealth();
  health.realtime.voiceExecutionPersistent = null;
  const result = buildScorecard(passingEvidence(), health);
  assert.equal(result.decision, 'stop_and_restore_panic_lock');
  assert.equal(result.productionAuthorized, false);
});

test('nonhealthy Realtime observation cannot prove panic safety', () => {
  const health = passingHealth();
  health.realtime.healthy = false;
  health.realtime.voiceExecutionLocked = true;
  health.realtime.voiceExecutionPersistent = true;
  const result = buildScorecard(passingEvidence(), health);
  assert.equal(result.checks.find((check) => check.key === 'panic_preserved').status, 'fail');
  assert.equal(result.decision, 'stop_and_restore_panic_lock');
});

test('unavailable evidence has a distinct repair decision and unknown observations', () => {
  const unavailable = unavailableSnapshot(TRIAL_EPOCH, TRIAL_EPOCH, EVIDENCE_SAMPLED_AT);
  const result = buildScorecard(unavailable, passingHealth());
  assert.equal(result.decision, 'repair_evidence_lane');
  assert.equal(result.checks.find((check) => check.key === 'sessions').observed, 'unavailable');
  assert.equal(result.productionAuthorized, false);
  const snapshot = composeSnapshot({ evidence: unavailable, health: passingHealth(), now: NOW });
  assert.equal(snapshot.evidence.sessions.total, null);
  assert.equal(snapshot.scorecard.decision, 'repair_evidence_lane');
});

test('snapshot composition validates chronology and aggregate relations before scoring', () => {
  const rejected = (mutate) => {
    const evidence = passingEvidence();
    const health = passingHealth();
    mutate(evidence, health);
    assert.throws(() => composeSnapshot({ evidence, health, now: NOW }));
  };

  rejected((evidence) => { evidence.sessions.last24Hours = evidence.sessions.total + 1; });
  rejected((evidence) => { evidence.sessions.total -= 1; });
  rejected((evidence) => { evidence.jobs.total -= 1; });
  rejected((evidence) => {
    evidence.usage.validResponseRecords = evidence.usage.responseRecords + 1;
  });
  rejected((evidence) => { evidence.usage.records -= 1; });
  rejected((evidence) => { evidence.usage.totalTokens += 1; });
  rejected((evidence) => { evidence.usage.cachedInputTokens = evidence.usage.inputTokens + 1; });
  rejected((_evidence, health) => {
    health.realtime.capacityObservation = 'SENSITIVE_NONCANONICAL_OBSERVATION';
  });
  rejected((_evidence, health) => { health.realtime.capacityObservation = 'unsupported'; });
  rejected((_evidence, health) => {
    health.realtime.capacityHealthy = null;
    health.realtime.capacityObservation = 'reported_unhealthy';
  });
  for (const stateHealthy of [false, null]) {
    rejected((_evidence, health) => { health.realtime.stateHealthy = stateHealthy; });
  }
  for (const service of ['voiceApp', 'realtime', 'controller']) {
    rejected((_evidence, health) => {
      health[service].reachable = false;
      health[service].healthy = true;
    });
  }
  rejected((evidence) => { evidence.windowStartedAt = '2026-08-22T00:00:01.000Z'; });
  rejected((evidence) => { evidence.evidenceSampledAt = '2026-08-27T12:00:00.000Z'; });
  rejected((_evidence, health) => { health.healthSampledAt = '2026-08-27T12:00:01.000Z'; });

  const evidence = passingEvidence();
  evidence.sessions.completionRatePercent = 1;
  evidence.jobs.completionRatePercent = 2;
  const snapshot = composeSnapshot({ evidence, health: passingHealth(), now: NOW });
  assert.equal(snapshot.evidenceSampledAt, EVIDENCE_SAMPLED_AT);
  assert.equal(snapshot.healthSampledAt, HEALTH_SAMPLED_AT);
  assert.equal(snapshot.evidence.sessions.completionRatePercent, 100);
  assert.equal(snapshot.evidence.jobs.completionRatePercent, 100);

  const rolling = passingEvidence();
  rolling.trialStartedAt = '2026-08-01T00:00:00.000Z';
  rolling.windowStartedAt = '2026-08-13T11:59:58.000Z';
  assert.equal(
    composeSnapshot({ evidence: rolling, health: passingHealth(), now: NOW })
      .evidence.windowStartedAt,
    rolling.windowStartedAt,
  );
  rolling.windowStartedAt = '2026-08-13T11:59:58.001Z';
  assert.throws(() => composeSnapshot({ evidence: rolling, health: passingHealth(), now: NOW }));
});

test('accounting gate requires a validated positive response record', () => {
  const evidence = passingEvidence();
  evidence.usage.validResponseRecords = 0;
  evidence.usage.totalTokens = 0;
  const result = buildScorecard(evidence, passingHealth());
  assert.equal(result.checks.find((check) => check.key === 'usage_recorded').status, 'fail');
});

test('session gate requires five terminal sessions and rejects stale active rows', () => {
  const evidence = passingEvidence();
  evidence.sessions = {
    ...evidence.sessions,
    total: 5,
    closed: 1,
    failed: 0,
    active: 4,
    completionRatePercent: 100,
  };
  const result = buildScorecard(evidence, passingHealth());
  assert.equal(result.checks.find((check) => check.key === 'sessions').status, 'fail');
  assert.equal(result.decision, 'continue_bounded_hermes_evaluation');
});

test('missing terminal reliability is unknown while an explicit low rate fails', () => {
  const evidence = passingEvidence();
  evidence.sessions.completionRatePercent = null;
  let reliability = buildScorecard(evidence, passingHealth())
    .checks.find((check) => check.key === 'session_reliability');
  assert.equal(reliability.status, 'unknown');
  assert.equal(reliability.observed, 'not enough evidence');

  evidence.sessions.completionRatePercent = 80;
  reliability = buildScorecard(evidence, passingHealth())
    .checks.find((check) => check.key === 'session_reliability');
  assert.equal(reliability.status, 'fail');
});

test('job aggregates remain descriptive and zero jobs are not scored', () => {
  const evidence = passingEvidence();
  evidence.jobs = {
    total: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    active: 0,
    completionRatePercent: null,
    averageDurationSeconds: null,
  };
  const result = buildScorecard(evidence, passingHealth());
  assert.equal(result.checks.some((check) => check.key === 'jobs'), false);
  assert.equal(result.decision, 'machine_evidence_threshold_met');
});

test('runtime scalar readers require owned 0600 regular files with exact shapes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-runtime-files-'));
  const tokenPath = path.join(directory, 'launch-token');
  const epochPath = path.join(directory, 'trial-epoch');
  const symlinkPath = path.join(directory, 'launch-token-link');
  try {
    fs.writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
    fs.writeFileSync(epochPath, TRIAL_EPOCH, { mode: 0o600 });
    assert.equal(readLaunchToken(tokenPath), TOKEN);
    assert.equal(readTrialEpoch(epochPath), TRIAL_EPOCH);
    fs.chmodSync(tokenPath, 0o640);
    assert.throws(() => readLaunchToken(tokenPath));
    fs.chmodSync(tokenPath, 0o600);
    fs.symlinkSync(tokenPath, symlinkPath);
    assert.throws(() => readLaunchToken(symlinkPath));
    fs.writeFileSync(epochPath, '2026-02-31T00:00:00.000Z', { mode: 0o600 });
    assert.throws(() => readTrialEpoch(epochPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('composed snapshot reader rejects stale/unsafe files and strips unexpected fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-snapshot-'));
  const snapshotPath = path.join(directory, 'summary.json');
  try {
    const snapshot = passingSnapshot();
    snapshot.rawTranscript = 'SENSITIVE_RAW_TRANSCRIPT';
    snapshot.evidence.secret = 'SENSITIVE_EVIDENCE_SECRET';
    snapshot.scorecard.manualChecks.push('SENSITIVE_SCORECARD_SECRET');
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
    const sanitized = readComposedSnapshot(snapshotPath, NOW);
    assert.doesNotMatch(JSON.stringify(sanitized), /SENSITIVE/u);
    assert.equal(sanitized.scorecard.decision, 'machine_evidence_threshold_met');
    assert.throws(() => readComposedSnapshot(
      snapshotPath,
      new Date(NOW.getTime() + 76_000),
    ));
    fs.chmodSync(snapshotPath, 0o640);
    assert.throws(() => readComposedSnapshot(snapshotPath, NOW));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP facade is cache-only, token-gated, GET/HEAD-only, and globally bounded', async (t) => {
  const staticAssets = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><title>fixture</title>') }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', body: Buffer.from("'use strict';") }],
    ['/styles.css', { type: 'text/css; charset=utf-8', body: Buffer.from('body{}') }],
  ]);
  let snapshotReads = 0;
  const server = createDashboardServer({
    launchToken: TOKEN,
    staticAssets,
    snapshotReader: () => { snapshotReads += 1; return passingSnapshot(); },
    now: () => NOW,
    rateNow: () => NOW.getTime(),
  });
  assert.equal(server.headersTimeout, 5000);
  assert.equal(server.requestTimeout, 5000);
  assert.equal(server.keepAliveTimeout, 1000);
  assert.equal(server.timeout, 5000);
  assert.equal(server.maxHeadersCount, 32);
  assert.equal(server.maxRequestsPerSocket, 20);
  assert.equal(server.maxConnections, MAX_CONNECTIONS);
  assert.equal(MAX_IN_FLIGHT, 4);
  assert.equal(MAX_REQUESTS_PER_MINUTE, 120);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const publicResponse = await fetch(`${base}/`);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
  assert.match(publicResponse.headers.get('content-security-policy'), /default-src 'none'/u);
  assert.match(publicResponse.headers.get('content-security-policy'), /media-src 'none'/u);
  assert.equal(publicResponse.headers.get('permissions-policy'),
    'camera=(), microphone=(), geolocation=(), display-capture=(), usb=()');

  const unauthorized = await fetch(`${base}/api/summary`);
  assert.equal(unauthorized.status, 401);
  assert.equal(snapshotReads, 0);

  const wrong = await fetch(`${base}/api/summary`, {
    headers: { 'X-Teleagent-Evaluation-Token': `${TOKEN.slice(0, 42)}x` },
  });
  assert.equal(wrong.status, 401);
  assert.equal(snapshotReads, 0);

  const authenticated = await fetch(`${base}/api/summary`, {
    headers: { 'X-Teleagent-Evaluation-Token': TOKEN },
  });
  assert.equal(authenticated.status, 200);
  const payload = await authenticated.json();
  assert.equal(payload.mode, 'read_only_cached_evidence');
  assert.equal(payload.boundary.panicPreserved, true);
  assert.equal(payload.boundary.snapshotAccess, 'sanitized_cache_only');
  assert.equal(payload.boundary.mutationControlsExposed, false);
  assert.equal(payload.boundary.rootOrSessionTargetingExposed, false);
  assert.equal(payload.scorecard.productionAuthorized, false);
  assert.equal(payload.scorecard.manualReviewRequired, true);
  assert.equal(payload.scorecard.investmentAuthorized, false);
  assert.equal(payload.evidenceSampledAt, EVIDENCE_SAMPLED_AT);
  assert.equal(payload.healthSampledAt, HEALTH_SAMPLED_AT);
  assert.equal(payload.evidence.trialStartedAt, TRIAL_EPOCH);
  assert.equal(payload.evidence.windowStartedAt, TRIAL_EPOCH);
  assert.equal(snapshotReads, 1);

  const headResponse = await fetch(`${base}/api/summary`, {
    method: 'HEAD',
    headers: { 'X-Teleagent-Evaluation-Token': TOKEN },
  });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), '');

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await fetch(`${base}/api/summary`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  assert.equal((await fetch(`${base}/api/unlock`)).status, 404);
  assert.equal((await fetch(`${base}/api/call`)).status, 404);
  assert.equal((await fetch(`${base}/api/dispatch`)).status, 404);
  assert.equal((await fetch(`${base}/api/session`)).status, 404);
  assert.equal(TOKEN_HEADER, 'x-teleagent-evaluation-token');
});

test('HTTP facade enforces the fixed global request budget', async (t) => {
  const server = createDashboardServer({
    launchToken: TOKEN,
    staticAssets: new Map([
      ['/', { type: 'text/plain; charset=utf-8', body: Buffer.from('ok') }],
    ]),
    snapshotReader: () => passingSnapshot(),
    now: () => NOW,
    rateNow: () => NOW.getTime(),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (let count = 0; count < MAX_REQUESTS_PER_MINUTE; count += 1) {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const limited = await fetch(`${base}/`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});
