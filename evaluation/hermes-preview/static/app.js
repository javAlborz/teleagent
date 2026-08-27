'use strict';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FETCH_TIMEOUT_MS = 5000;
const REFRESH_INTERVAL_MS = 30_000;
const VALIDITY_TICK_MS = 5000;
const SNAPSHOT_TTL_MS = 75_000;
const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);

const authPanel = document.querySelector('#auth-panel');
const authTitle = document.querySelector('#auth-title');
const authDetail = document.querySelector('#auth-detail');
const dashboard = document.querySelector('#dashboard');
const refreshButton = document.querySelector('#refresh');
let activeSnapshotTiming = null;
let validityTimer = null;

function setText(selector, value) {
  document.querySelector(selector).textContent = String(value);
}

function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : '—';
}

function formatRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return '—';
  return `${formatNumber(numerator)} / ${formatNumber(denominator)}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function healthState(values) {
  if (values.some((value) => value === false)) return false;
  return values.every((value) => value === true) ? true : null;
}

function healthText(value, {
  positive = 'Healthy',
  negative = 'Unhealthy',
  unknown = 'Unknown',
} = {}) {
  if (value === true) return positive;
  if (value === false) return negative;
  return unknown;
}

function clearValidityTimer() {
  if (validityTimer !== null) window.clearTimeout(validityTimer);
  validityTimer = null;
}

function invalidateDashboard({ expired = false } = {}) {
  clearValidityTimer();
  activeSnapshotTiming = null;
  dashboard.hidden = true;
  setText('#sample-time', expired ? 'Last snapshot expired' : 'Latest snapshot unavailable');
  setText('#snapshot-validity', expired ? 'Expired · fresh snapshot required' : 'Unknown');
  document.querySelector('#snapshot-validity').className =
    `validity ${expired ? 'expired' : 'unknown'}`;
  setText('#cohort-time', 'Unavailable');
  setText('#window-time', 'Unavailable');
  setText('#boundary-title', 'Read-only evidence · current safety state unavailable');
  setText('#boundary-detail', 'Do not rely on the previous snapshot. Restore the evidence lane before proceeding.');
  const badge = document.querySelector('#boundary-badge');
  badge.textContent = 'Unknown';
  badge.className = 'badge fail';
  authPanel.hidden = false;
  authTitle.textContent = expired ? 'The last snapshot expired' : 'Evidence is unavailable';
  authDetail.textContent = expired
    ? 'The dashboard was hidden locally. Refresh to require a newly valid snapshot.'
    : 'Use a fresh URL from the Hermes evaluation wrapper, then retry.';
}

function updateSnapshotValidity() {
  if (!activeSnapshotTiming) return false;
  const now = Date.now();
  if (now >= activeSnapshotTiming.expiresAt) {
    invalidateDashboard({ expired: true });
    return false;
  }
  const age = Math.max(0, now - activeSnapshotTiming.generatedAt);
  const remaining = activeSnapshotTiming.expiresAt - now;
  setText('#snapshot-validity',
    `Current · ${formatDuration(age)} old · ${formatDuration(remaining)} remaining`);
  document.querySelector('#snapshot-validity').className = 'validity current';
  clearValidityTimer();
  validityTimer = window.setTimeout(
    updateSnapshotValidity,
    Math.max(1, Math.min(VALIDITY_TICK_MS, remaining)),
  );
  return true;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('invalid snapshot');
  const generatedAt = Date.parse(payload.generatedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) ||
      expiresAt - generatedAt !== SNAPSHOT_TTL_MS ||
      generatedAt > now + 5000 || expiresAt <= now) {
    throw new Error('expired snapshot');
  }
  if (payload.boundary?.productionAuthorized !== false ||
      payload.scorecard?.productionAuthorized !== false ||
      payload.scorecard?.manualReviewRequired !== true ||
      payload.scorecard?.investmentAuthorized !== false) {
    throw new Error('invalid authorization boundary');
  }
  const scoreCounts = [
    payload.scorecard.passed,
    payload.scorecard.unknown,
    payload.scorecard.failed,
    payload.scorecard.total,
  ];
  if (!scoreCounts.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      payload.scorecard.passed + payload.scorecard.unknown + payload.scorecard.failed !==
        payload.scorecard.total) {
    throw new Error('invalid score counts');
  }
  return { generatedAt, expiresAt };
}

function eligibilityHeadline(scorecard) {
  if (scorecard.decision === 'machine_evidence_threshold_met') {
    return 'Machine evidence threshold met';
  }
  return scorecard.headline;
}

function render(payload) {
  const timing = validatePayload(payload);
  const { boundary, evidence, health, scorecard } = payload;
  setText('#sample-time', new Date(payload.generatedAt).toLocaleString());
  setText('#cohort-time', evidence.trialStartedAt
    ? new Date(evidence.trialStartedAt).toLocaleString() : 'Unavailable');
  setText('#window-time', evidence.windowStartedAt
    ? new Date(evidence.windowStartedAt).toLocaleString() : 'Unavailable');

  const lockProven = boundary.panicPreserved === true;
  setText('#boundary-title', lockProven
    ? 'Read-only evidence · persistent panic preserved'
    : 'Read-only evidence · persistent panic not proven');
  setText('#boundary-detail', lockProven
    ? 'Execution remains fenced while this surface reads sanitized aggregate evidence.'
    : 'Stop the evaluation and restore the persistent panic boundary before proceeding.');
  const badge = document.querySelector('#boundary-badge');
  badge.textContent = lockProven ? 'Fenced' : 'Stop';
  badge.className = `badge ${lockProven ? 'pass' : 'fail'}`;

  const capacityUnsupported = health.realtime.capacityObservation === 'unsupported';
  document.querySelector('#capacity-limit').hidden = !capacityUnsupported;
  setText('#decision-title', eligibilityHeadline(scorecard));
  setText('#score-value', scorecard.passed);
  setText('#score-total',
    `${scorecard.passed} pass · ${scorecard.unknown} unknown · ${scorecard.failed} fail`);
  setText('#metric-sessions', formatNumber(evidence.sessions.total));
  setText('#metric-days', formatNumber(evidence.sessions.activeDays));
  setText('#metric-turns', formatNumber(evidence.turns.user));
  setText('#metric-reliability', evidence.sessions.completionRatePercent === null
    ? '—' : `${evidence.sessions.completionRatePercent}%`);
  setText('#metric-jobs', formatRatio(evidence.jobs.completed, evidence.jobs.total));
  setText('#metric-tokens', formatNumber(evidence.usage.totalTokens));

  const checks = document.querySelector('#checks');
  checks.replaceChildren(...scorecard.checks.map((check) => {
    const row = document.createElement('li');
    const isLegacyCapacityBlock = capacityUnsupported && check.status === 'unknown' &&
      (check.key === 'realtime_health' || check.key === 'realtime_capacity');
    const allowedStatus = ['pass', 'fail', 'unknown', 'blocked'].includes(check.status)
      ? check.status : 'unknown';
    row.className = allowedStatus;
    const label = document.createElement('span');
    label.textContent = check.label;
    const observed = document.createElement('strong');
    observed.textContent = isLegacyCapacityBlock
      ? 'blocked · legacy durable-state capacity telemetry unsupported'
      : String(check.observed);
    row.append(label, observed);
    return row;
  }));

  const manual = document.querySelector('#manual-checks');
  manual.replaceChildren(...scorecard.manualChecks.map((label) => {
    const row = document.createElement('li');
    row.textContent = label;
    return row;
  }));

  setText('#health-voice', healthText(health.voiceApp.healthy));
  setText('#health-realtime', healthText(healthState([
    health.realtime.reachable,
    health.realtime.healthy,
    health.realtime.configured,
    health.realtime.stateHealthy,
  ])));
  setText('#health-capacity', healthText(health.realtime.capacityHealthy, {
    positive: 'Healthy · proven',
    negative: 'Unhealthy · reported',
    unknown: capacityUnsupported ? 'Unknown · unsupported' : 'Unknown · not proven',
  }));
  setText('#health-controller', healthText(health.controller.reachable, {
    positive: 'Responded · readiness fenced',
    negative: 'Unreachable',
    unknown: 'Unknown',
  }));
  setText('#health-panic', healthText(
    lockProven, { positive: 'Locked · persistent', negative: 'Not proven' },
  ));

  activeSnapshotTiming = timing;
  updateSnapshotValidity();
}

async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch('/api/summary', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Teleagent-Evaluation-Token': token,
      },
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function refresh() {
  if (refreshButton.disabled) return;
  refreshButton.disabled = true;
  try {
    const response = await fetchSnapshot();
    if (!response.ok) throw new Error('snapshot unavailable');
    const payload = await response.json();
    render(payload);
    authPanel.hidden = true;
    dashboard.hidden = false;
  } catch {
    invalidateDashboard();
  } finally {
    refreshButton.disabled = false;
  }
}

function recheckSnapshot() {
  if (activeSnapshotTiming) updateSnapshotValidity();
}

if (!TOKEN_PATTERN.test(token)) {
  authTitle.textContent = 'A valid fragment launch token is required';
  authDetail.textContent = 'Run the URL command on Hermes and open the exact URL it prints.';
} else {
  refreshButton.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheckSnapshot();
  });
  window.addEventListener('pageshow', recheckSnapshot);
  window.addEventListener('focus', recheckSnapshot);
  refresh();
  window.setInterval(refresh, REFRESH_INTERVAL_MS);
}
