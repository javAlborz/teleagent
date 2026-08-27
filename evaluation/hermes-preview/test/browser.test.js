'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const CLOCK_START = Date.parse('2026-08-27T12:00:10.000Z');

const selectors = [
  '#auth-panel', '#auth-title', '#auth-detail', '#dashboard', '#refresh',
  '#sample-time', '#snapshot-validity', '#cohort-time', '#window-time',
  '#boundary-title', '#boundary-detail', '#boundary-badge', '#capacity-limit',
  '#decision-title', '#score-value', '#score-total', '#metric-sessions',
  '#metric-days', '#metric-turns', '#metric-reliability', '#metric-jobs',
  '#metric-tokens', '#checks', '#manual-checks', '#health-voice',
  '#health-realtime', '#health-capacity', '#health-controller', '#health-panic',
];

function element(initial = {}) {
  return {
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    children: [],
    listeners: new Map(),
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    ...initial,
  };
}

function payload({ capacityHealthy = true, expiresAt = '2026-08-27T12:01:15.000Z' } = {}) {
  const capacityUnknown = capacityHealthy === null;
  const capacityBlocks = capacityHealthy !== true;
  return {
    generatedAt: '2026-08-27T12:00:00.000Z',
    expiresAt,
    boundary: { panicPreserved: true, productionAuthorized: false },
    evidence: {
      trialStartedAt: '2026-08-01T00:00:00.000Z',
      windowStartedAt: '2026-08-13T12:00:00.000Z',
      sessions: { total: 8, activeDays: 4, completionRatePercent: 100 },
      turns: { user: 22 },
      jobs: { total: 3, completed: 2 },
      usage: { totalTokens: 1200 },
    },
    health: {
      voiceApp: { healthy: true },
      realtime: {
        reachable: true, healthy: true, configured: true, stateHealthy: true,
        capacityHealthy,
      },
      // Readiness is intentionally false while persistent panic is held. The
      // dashboard reports this as a connectivity observation, not health.
      controller: { reachable: true, healthy: false },
    },
    scorecard: {
      decision: capacityBlocks
        ? 'continue_bounded_hermes_evaluation' : 'machine_evidence_threshold_met',
      headline: capacityBlocks
        ? 'Continue the bounded Hermes evaluation' : 'Machine evidence threshold met; manual review required',
      passed: capacityBlocks ? 9 : 10,
      unknown: capacityUnknown ? 1 : 0,
      failed: capacityHealthy === false ? 1 : 0,
      total: 10,
      productionAuthorized: false,
      manualReviewRequired: true,
      investmentAuthorized: false,
      checks: [{
        key: 'realtime_health',
        label: 'Realtime state and durable-state capacity healthy',
        status: capacityUnknown ? 'unknown' : (capacityBlocks ? 'fail' : 'pass'),
        observed: capacityUnknown ? 'unknown' : (capacityBlocks ? 'not healthy' : 'healthy'),
      }],
      manualChecks: ['Record lived call quality outside this surface'],
    },
  };
}

function createClock(start = CLOCK_START) {
  let now = start;
  let nextTimer = 1;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(callback, delay = 0) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    jump(milliseconds) { now += milliseconds; },
  };
}

function makeHarness(fetchPlan, { clock = createClock() } = {}) {
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  elements.get('#dashboard').hidden = true;
  elements.get('#capacity-limit').hidden = true;
  const intervalCallbacks = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const fetchCalls = [];

  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length === 0 ? [clock.now] : args));
    }
    static now() { return clock.now; }
  }

  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    const next = fetchPlan.shift();
    if (typeof next === 'function') return next({ url, options });
    return next;
  };
  const documentObject = {
    visibilityState: 'visible',
    querySelector: (selector) => elements.get(selector),
    createElement: () => element(),
    addEventListener: (name, listener) => documentListeners.set(name, listener),
  };
  const windowObject = {
    location: { hash: `#token=${TOKEN}`, pathname: '/', search: '' },
    history: { replaceState() {} },
    setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval(callback) { intervalCallbacks.push(callback); return intervalCallbacks.length; },
    addEventListener: (name, listener) => windowListeners.set(name, listener),
  };
  const context = {
    AbortController,
    Date: ClockDate,
    URLSearchParams,
    Intl,
    fetch: fetchImpl,
    document: documentObject,
    window: windowObject,
  };

  vm.runInNewContext(appSource, context);
  return {
    clock,
    documentListeners,
    elements,
    fetchCalls,
    intervalCallbacks,
    windowListeners,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (body) => ({ ok: true, json: async () => body });

test('render distinguishes fixed trial epoch, rolling window, and legacy capacity unknown', async () => {
  const harness = makeHarness([response(payload({ capacityHealthy: null }))]);
  await settle();
  await settle();

  assert.equal(harness.elements.get('#dashboard').hidden, false);
  assert.notEqual(
    harness.elements.get('#cohort-time').textContent,
    harness.elements.get('#window-time').textContent,
  );
  assert.equal(harness.elements.get('#capacity-limit').hidden, false);
  assert.equal(harness.elements.get('#health-capacity').textContent, 'Unknown · unsupported');
  assert.equal(harness.elements.get('#checks').children[0].className, 'unknown');
  assert.match(harness.elements.get('#checks').children[0].children[1].textContent,
    /legacy durable-state capacity telemetry unsupported/u);
  assert.equal(harness.elements.get('#metric-jobs').textContent, '2 / 3');
  assert.equal(harness.elements.get('#health-controller').textContent,
    'Responded · readiness fenced');
  assert.match(harness.elements.get('#snapshot-validity').textContent, /Current/u);
});

test('reported unhealthy capacity remains distinct from unsupported telemetry', async () => {
  const harness = makeHarness([response(payload({ capacityHealthy: false }))]);
  await settle();
  await settle();

  assert.equal(harness.elements.get('#capacity-limit').hidden, true);
  assert.equal(harness.elements.get('#health-capacity').textContent, 'Unhealthy · reported');
  assert.equal(harness.elements.get('#checks').children[0].className, 'fail');
});

test('a failed refresh hides and invalidates a previously successful safety snapshot', async () => {
  const harness = makeHarness([
    response(payload()),
    { ok: false, json: async () => ({}) },
  ]);
  await settle();
  await settle();
  assert.equal(harness.elements.get('#dashboard').hidden, false);
  assert.equal(harness.elements.get('#boundary-badge').textContent, 'Fenced');

  harness.intervalCallbacks[0]();
  await settle();
  await settle();
  assert.equal(harness.elements.get('#dashboard').hidden, true);
  assert.equal(harness.elements.get('#auth-panel').hidden, false);
  assert.equal(harness.elements.get('#boundary-badge').textContent, 'Unknown');
  assert.match(harness.elements.get('#boundary-title').textContent, /unavailable/u);
  assert.equal(harness.elements.get('#sample-time').textContent, 'Latest snapshot unavailable');
});

test('snapshot expiry hides green output locally without another fetch', async () => {
  const harness = makeHarness([response(payload())]);
  await settle();
  await settle();
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.elements.get('#dashboard').hidden, false);

  harness.clock.advance(65_000);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.elements.get('#dashboard').hidden, true);
  assert.equal(harness.elements.get('#snapshot-validity').textContent,
    'Expired · fresh snapshot required');
  assert.equal(harness.elements.get('#boundary-badge').textContent, 'Unknown');
});

test('focus rechecks expiry after browser timer suspension', async () => {
  const harness = makeHarness([response(payload())]);
  await settle();
  await settle();
  harness.clock.jump(65_000);
  harness.windowListeners.get('focus')();
  assert.equal(harness.elements.get('#dashboard').hidden, true);
  assert.equal(harness.elements.get('#auth-title').textContent, 'The last snapshot expired');
  assert.equal(typeof harness.windowListeners.get('pageshow'), 'function');
  assert.equal(typeof harness.documentListeners.get('visibilitychange'), 'function');
});

test('a hung refresh is aborted within the bounded timeout and cannot preserve green', async () => {
  const hung = ({ options }) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const harness = makeHarness([response(payload()), hung]);
  await settle();
  await settle();
  harness.intervalCallbacks[0]();
  await settle();
  assert.equal(harness.elements.get('#dashboard').hidden, false);

  harness.clock.advance(5000);
  await settle();
  await settle();
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.fetchCalls[1].options.signal.aborted, true);
  assert.equal(harness.elements.get('#dashboard').hidden, true);
  assert.equal(harness.elements.get('#boundary-badge').textContent, 'Unknown');
});

test('expired, overlong, or authorization-ambiguous payloads never render', async () => {
  const expired = payload({ expiresAt: '2026-08-27T12:00:05.000Z' });
  const overlong = payload({ expiresAt: '2026-08-27T12:05:00.000Z' });
  const ambiguous = payload();
  delete ambiguous.scorecard.investmentAuthorized;
  for (const body of [expired, overlong, ambiguous]) {
    const harness = makeHarness([response(body)]);
    await settle();
    await settle();
    assert.equal(harness.elements.get('#dashboard').hidden, true);
    assert.equal(harness.elements.get('#boundary-badge').textContent, 'Unknown');
  }
});
