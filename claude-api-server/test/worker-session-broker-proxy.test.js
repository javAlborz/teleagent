'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createWorkerSessionBroker } = require('../worker-session-broker');
const { WorkerSessionOperationStore } = require('../worker-session-operation-store');
const { targetSessionOperationMarker } = require('../../lib/voice-authorization-plan');
const {
  FIXED_WORKER_SESSION_SOCKET_PATH,
  createWorkerSessionHttpClient,
  createWorkerSessionProxy,
  normalizeWorkerSessionProxyConfig,
} = require('../worker-session-proxy');

test('controller worker-session proxy is disabled by default and pins its Unix socket', () => {
  assert.deepEqual(normalizeWorkerSessionProxyConfig({}), {
    enabled: false,
    socketPath: FIXED_WORKER_SESSION_SOCKET_PATH,
    timeoutMs: 10000,
    healthPollMs: 2000,
  });
  assert.deepEqual(normalizeWorkerSessionProxyConfig({
    WORKER_SESSION_BROKER_ENABLED: 'true',
    WORKER_SESSION_BROKER_SOCKET_PATH: FIXED_WORKER_SESSION_SOCKET_PATH,
  }).enabled, true);
  assert.throws(
    () => normalizeWorkerSessionProxyConfig({
      WORKER_SESSION_BROKER_ENABLED: 'true',
      WORKER_SESSION_BROKER_SOCKET_PATH: '/tmp/worker.sock',
    }),
    /must be \/run\/teleagent-worker-session\/broker\.sock/
  );
});

function fixture(t, {
  sendImpl = null,
  reconcileImpl = null,
  boundaryImpl = null,
  providerControl = null,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-worker-session-'));
  const workspace = path.join(directory, 'workspace');
  const socketPath = path.join(directory, 'broker.sock');
  fs.mkdirSync(workspace);
  const store = new WorkerSessionOperationStore();
  let sends = 0;
  const inspector = {
    async execute(action, args) { return { action, args, bounded: true }; },
    async inspectWorkerSessionBoundary(target) {
      if (boundaryImpl) await boundaryImpl(target);
      return {
        target: 'worker:1.0',
        stable_target: '%12',
        provider: 'codex',
        cwd: workspace,
        agent_running: true,
        requested: target,
      };
    },
  };
  const controller = {
    async prepare() {
      return {
        target: 'worker:1.0',
        stable_target: '%12',
        provider: 'codex',
        session_fingerprint: 'a'.repeat(64),
      };
    },
    async send(input) {
      sends += 1;
      await input.onBeforeSubmit({
        stableTarget: '%12',
        provider: 'codex',
        operationMarker: targetSessionOperationMarker(input.operationId),
      });
      if (sendImpl) return sendImpl(input);
      return {
        success: true,
        delivered: true,
        response_verified: true,
        response: 'Worker provider replied.',
        stable_target: '%12',
        provider: 'codex',
      };
    },
    async reconcileOperation(input) {
      return reconcileImpl ? reconcileImpl(input) : {
        status: 'unknown', reason: 'operation_marker_not_observed',
      };
    },
    async interrupt() { return true; },
  };
  const broker = createWorkerSessionBroker({
    inspector,
    controller,
    store,
    workerHome: directory,
    inspectionRoots: [workspace],
    providerControl,
  });
  const listening = new Promise((resolve, reject) => {
    broker.server.once('error', reject);
    broker.server.listen(socketPath, resolve);
  });
  const proxy = createWorkerSessionProxy({ socketPath, pollIntervalMs: 10 });
  t.after(async () => {
    await broker.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { broker, controller, inspector, listening, proxy, store, workspace, sends: () => sends };
}

function sendRequest(overrides = {}) {
  return {
    target: '%12',
    message: 'Review the current diff.',
    sessionFingerprint: 'a'.repeat(64),
    timeoutMs: 30000,
    operationId: 'job_workerproxy1',
    ...overrides,
  };
}

test('worker broker rejects control-bearing target text before store or tmux delivery', async (t) => {
  const value = fixture(t);
  await value.listening;
  const operationId = 'job_controlinjection';
  await assert.rejects(value.proxy.controller.send(sendRequest({
    operationId,
    message: 'Visible approval\u001b[201~\n/hidden-command',
  })), (error) => error.code === 'INVALID_TARGET_MESSAGE');
  assert.equal(value.store.get(operationId), null);
  assert.equal(value.sends(), 0);
});

test('worker proxy exposes bounded inspection and exactly-once durable target delivery', async (t) => {
  const value = fixture(t);
  await value.listening;
  assert.deepEqual(await value.proxy.inspector.execute('git_status', { path: value.workspace }), {
    action: 'git_status', args: { path: value.workspace }, bounded: true,
  });
  const prepared = await value.proxy.controller.prepare({ target: '%12' });
  assert.equal(prepared.stable_target, '%12');

  const boundaries = [];
  const request = sendRequest({
    onBeforeSubmit: async (boundary) => boundaries.push(boundary),
  });
  const first = await value.proxy.controller.send(request);
  const second = await value.proxy.controller.send(request);
  assert.equal(first.response, 'Worker provider replied.');
  assert.deepEqual(second, first);
  assert.equal(value.sends(), 1);
  assert.equal(boundaries.length, 2);
  assert.equal(value.store.get(request.operationId).state, 'completed');

  await assert.rejects(
    value.proxy.controller.send({ ...request, message: 'A changed request.' }),
    { code: 'WORKER_SESSION_IDEMPOTENCY_CONFLICT' }
  );
  assert.equal(value.sends(), 1);

  await assert.rejects(
    value.proxy.inspector.execute('homelab_status', {}),
    { code: 'WORKER_SESSION_INSPECTION_DENIED' }
  );
});

test('worker broker keeps a restarted post-boundary operation reconciling without resend', async (t) => {
  const value = fixture(t, {
    reconcileImpl: async () => ({ status: 'unknown', reason: 'operation_marker_not_observed' }),
  });
  await value.listening;
  const request = sendRequest({ operationId: 'job_workerreconcile1' });
  const preflight = await value.proxy.controller.prepare({ target: request.target });
  assert.equal(preflight.stable_target, '%12');

  const requestHash = require('../worker-session-operation-store').requestHash(request);
  value.store.prepare({
    operationId: request.operationId,
    requestHash,
    target: request.target,
    stableTarget: '%12',
    sessionFingerprint: request.sessionFingerprint,
    provider: 'codex',
    operationMarker: targetSessionOperationMarker(request.operationId),
  });
  value.store.claimCommit(request.operationId, requestHash);
  value.store.markDeliveryStarted(request.operationId, requestHash);
  value.store.recoverInterrupted();

  const outcome = await value.proxy.controller.reconcileOperation(request);
  assert.equal(outcome.status, 'in_progress');
  assert.equal(outcome.delivered, false);
  assert.equal(value.store.get(request.operationId).state, 'delivery_started');
  assert.equal(value.sends(), 0);
});

test('ambiguous commit is reconciled with GET-like reads and is never posted twice', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-worker-ambiguous-'));
  const socketPath = path.join(directory, 'broker.sock');
  let commits = 0;
  let reconciles = 0;
  const request = sendRequest({ operationId: 'job_workerambiguous1' });
  const marker = targetSessionOperationMarker(request.operationId);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/session/send/preflight') {
        const body = JSON.parse(Buffer.concat(chunks));
        const { requestHash } = require('../worker-session-operation-store');
        res.end(JSON.stringify({
          success: true,
          operation: {
            operationId: body.operationId,
            requestHash: requestHash(body),
            target: body.target,
            stableTarget: '%12',
            sessionFingerprint: body.sessionFingerprint,
            provider: 'codex',
            operationMarker: marker,
          },
          prepared: {
            stable_target: '%12', provider: 'codex',
            session_fingerprint: body.sessionFingerprint, operation_marker: marker,
          },
        }));
      } else if (req.url === '/v1/session/send/commit') {
        commits += 1;
        req.socket.destroy();
      } else if (req.url === '/v1/session/reconcile') {
        reconciles += 1;
        res.end(JSON.stringify({
          success: true,
          outcome: {
            status: 'completed',
            result: { success: true, delivered: true, response_verified: true, response: 'Recovered.' },
          },
        }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const proxy = createWorkerSessionProxy({ socketPath, pollIntervalMs: 10 });
  const result = await proxy.controller.send(request);
  assert.equal(result.response, 'Recovered.');
  assert.equal(commits, 1);
  assert.equal(reconciles, 1);
});

test('broker close aborts and awaits active handlers before its store can close', async (t) => {
  let observedAbort = false;
  const value = fixture(t, {
    sendImpl: async (input) => {
      while (!input.signal.aborted) await delay(5);
      observedAbort = true;
      throw Object.assign(new Error('stopped'), { code: 'TARGET_MESSAGE_CANCELED' });
    },
  });
  await value.listening;
  const pending = value.proxy.controller.send(sendRequest({ operationId: 'job_closedrain' }));
  const rejected = assert.rejects(pending);
  while (value.broker.active.size === 0) await delay(5);
  await value.broker.close();
  await rejected;
  assert.equal(observedAbort, true);
  assert.equal(value.broker.active.size, 0);
  assert.doesNotThrow(() => value.store.get('job_closedrain'));
});

test('shutdown fences a request between commit claim and delivery and drains it before close', async (t) => {
  let boundaryCalls = 0;
  let releaseBoundary;
  let boundaryEntered;
  const entered = new Promise((resolve) => { boundaryEntered = resolve; });
  const barrier = new Promise((resolve) => { releaseBoundary = resolve; });
  const value = fixture(t, {
    boundaryImpl: async () => {
      boundaryCalls += 1;
      if (boundaryCalls === 1) {
        boundaryEntered();
        await barrier;
      }
    },
  });
  await value.listening;

  // Hold an already-admitted HTTP connection before shutdown. Completing its
  // headers afterward must hit the synchronous draining fence with 503.
  const parked = require('node:net').createConnection({ path: value.proxy.socketPath });
  await new Promise((resolve, reject) => {
    parked.once('connect', resolve);
    parked.once('error', reject);
  });
  parked.write('GET /health HTTP/1.1\r\nHost: unix\r\nConnection: close\r\n');

  const request = sendRequest({ operationId: 'job_closebarrier' });
  const hash = require('../worker-session-operation-store').requestHash(request);
  value.store.prepare({
    operationId: request.operationId,
    requestHash: hash,
    target: request.target,
    stableTarget: '%12',
    sessionFingerprint: request.sessionFingerprint,
    provider: 'codex',
    operationMarker: targetSessionOperationMarker(request.operationId),
  });
  const client = createWorkerSessionHttpClient({ socketPath: value.proxy.socketPath });
  const pending = client.request({
    method: 'POST',
    requestPath: '/v1/session/send/commit',
    body: request,
  });
  const settled = pending.then(
    (response) => ({ response, error: null }),
    (error) => ({ response: null, error })
  );
  await entered;
  const close = value.broker.close();
  let closeFinished = false;
  void close.then(() => { closeFinished = true; });
  await delay(20);
  assert.equal(closeFinished, false);

  let lateResponse = '';
  parked.on('data', (chunk) => { lateResponse += chunk; });
  const parkedEnded = new Promise((resolve) => parked.once('end', resolve));
  parked.write('\r\n');
  await parkedEnded;
  assert.match(lateResponse, /^HTTP\/1\.1 503 /);
  assert.match(lateResponse, /WORKER_SESSION_BROKER_DRAINING/);

  releaseBoundary();
  const outcome = await settled;
  if (outcome.response) {
    assert.equal(outcome.response.status, 503);
    assert.equal(outcome.response.payload.code, 'WORKER_SESSION_BROKER_DRAINING');
  } else {
    // An HTTP close racing the sanitized 503 is transport-ambiguous to the
    // caller, but the durable pre-delivery row below remains authoritative.
    assert.equal(outcome.error.code, 'WORKER_SESSION_BROKER_UNAVAILABLE');
  }
  await close;
  assert.equal(value.sends(), 0);
  assert.ok(
    ['prepared', 'failed_pre_delivery'].includes(value.store.get('job_closebarrier').state),
    'shutdown must leave only a safely retryable pre-delivery state'
  );
});

test('worker panic fences mutation, aborts delivery, reasserts providers, and unlocks only quiescent planes', async (t) => {
  let panicCalls = 0;
  let unlockCalls = 0;
  let sendAborted = false;
  const value = fixture(t, {
    providerControl: {
      async panic() {
        panicCalls += 1;
        return { success: true, accepted: true, persisted: true, quiesced: true };
      },
      async unlock() {
        unlockCalls += 1;
        return { success: true, persisted: true, quiesced: true };
      },
    },
    sendImpl: async ({ signal }) => {
      while (!signal.aborted) await delay(2);
      sendAborted = true;
      throw Object.assign(new Error('panic interrupted delivery'), {
        code: 'TARGET_MESSAGE_CANCELED',
      });
    },
  });
  await value.listening;
  const request = sendRequest({ operationId: 'job_workerpanic1' });
  const client = createWorkerSessionHttpClient({ socketPath: value.proxy.socketPath });
  const preflight = await client.request({
    method: 'POST', requestPath: '/v1/session/send/preflight', body: request,
  });
  assert.equal(preflight.status, 200);
  const pending = client.request({
    method: 'POST', requestPath: '/v1/session/send/commit', body: request,
  });
  while (value.broker.active.size === 0) await delay(2);

  const first = await value.proxy.panic({ reason: 'dial_nine', source: 'phone' });
  assert.equal(first.status, 200);
  assert.equal(first.payload.accepted, true);
  assert.equal(first.payload.persisted, true);
  assert.equal(first.payload.quiesced, true);
  assert.equal(sendAborted, true);
  const interrupted = await pending;
  assert.equal(interrupted.status, 409);
  assert.equal(interrupted.payload.code, 'TARGET_DELIVERY_OUTCOME_UNKNOWN');
  assert.equal(value.store.get(request.operationId).state, 'outcome_unknown');
  assert.equal(value.store.panicStatus().locked, true);

  await assert.rejects(
    value.proxy.controller.prepare({ target: '%12' }),
    { code: 'WORKER_SESSION_PANIC_LOCKED' }
  );
  const second = await value.proxy.panic({ reason: 'dial_nine_retry', source: 'phone' });
  assert.equal(second.status, 200);
  assert.equal(second.payload.alreadyLocked, true);
  assert.equal(panicCalls, 2, 'remote provider panic must be reasserted on every retry');

  const unlocked = await value.proxy.unlock();
  assert.equal(unlocked.success, true);
  assert.equal(unlocked.quiesced, true);
  assert.equal(unlockCalls, 1);
  assert.equal(value.store.panicStatus().locked, false);
  assert.equal((await value.proxy.controller.prepare({ target: '%12' })).stable_target, '%12');
});

test('worker panic remains partial when provider cgroup quiescence is unconfirmed', async (t) => {
  let providerQuiesced = false;
  const value = fixture(t, {
    providerControl: {
      async panic() {
        return {
          success: providerQuiesced,
          accepted: true,
          persisted: true,
          quiesced: providerQuiesced,
        };
      },
      async unlock() {
        return { success: false, persisted: true, quiesced: false };
      },
    },
  });
  await value.listening;
  const panic = await value.proxy.panic({ reason: 'dial_nine', source: 'phone' });
  assert.equal(panic.status, 503);
  assert.equal(panic.payload.accepted, true);
  assert.equal(panic.payload.persisted, true);
  assert.equal(panic.payload.quiesced, false);
  assert.equal(value.store.panicStatus().locked, true);
  await assert.rejects(value.proxy.unlock(), {
    code: 'WORKER_PROVIDER_UNLOCK_UNCONFIRMED',
  });
  assert.equal(value.store.panicStatus().locked, true);
  providerQuiesced = true;
});

test('cooperative supervisor failure escalates to the persistent root cgroup fence', async (t) => {
  const order = [];
  const value = fixture(t, {
    providerControl: {
      async panic() {
        order.push('cooperative-panic');
        throw new Error('hung supervisor control timed out');
      },
      async panicRoot() {
        order.push('root-panic');
        return { accepted: true, persisted: true, quiesced: true, launchCount: 1 };
      },
      async unlockRoot() {
        order.push('root-unlock');
        return { success: true, persisted: true, quiesced: true };
      },
      async unlock() {
        order.push('cooperative-unlock');
        return { success: true, persisted: true, quiesced: true };
      },
    },
  });
  await value.listening;
  const panic = await value.proxy.panic({ reason: 'hung_provider', source: 'phone' });
  assert.equal(panic.status, 200);
  assert.equal(panic.payload.quiesced, true);
  assert.equal(panic.payload.providers.rootFallback, true);
  assert.deepEqual(order, ['cooperative-panic', 'root-panic']);
  const unlocked = await value.proxy.unlock();
  assert.equal(unlocked.success, true);
  assert.deepEqual(order, [
    'cooperative-panic', 'root-panic', 'root-unlock', 'cooperative-unlock',
  ]);
  assert.equal(value.store.panicStatus().locked, false);
});

test('root recovery and cooperative unlock keep the local fence until every await succeeds', async (t) => {
  const order = [];
  let failAt = 'root-unlock';
  const value = fixture(t, {
    providerControl: {
      async panic() {
        return { accepted: true, persisted: true, quiesced: true };
      },
      async panicRoot() {
        order.push('root-panic');
        return { accepted: true, persisted: true, quiesced: true };
      },
      async unlockRoot() {
        order.push('root-unlock');
        if (failAt === 'root-unlock') throw new Error('injected root recovery crash');
        assert.equal(value.store.panicStatus().locked, true);
        return { success: true, persisted: true, quiesced: true };
      },
      async unlock() {
        order.push('cooperative-unlock');
        assert.equal(value.store.panicStatus().locked, true);
        if (failAt === 'cooperative-unlock') throw new Error('injected supervisor crash');
        return { success: true, persisted: true, quiesced: true };
      },
    },
  });
  await value.listening;
  assert.equal((await value.proxy.panic({ reason: 'barrier', source: 'test' })).payload.success, true);

  await assert.rejects(value.proxy.unlock(), {
    code: 'WORKER_PROVIDER_ROOT_UNLOCK_UNCONFIRMED',
  });
  assert.equal(value.store.panicStatus().locked, true);
  assert.deepEqual(order, ['root-unlock']);

  failAt = 'cooperative-unlock';
  await assert.rejects(value.proxy.unlock(), {
    code: 'WORKER_PROVIDER_UNLOCK_UNCONFIRMED',
  });
  assert.equal(value.store.panicStatus().locked, true);
  assert.deepEqual(order, [
    'root-unlock', 'root-unlock', 'cooperative-unlock', 'root-panic',
  ]);

  failAt = null;
  const unlocked = await value.proxy.unlock();
  assert.equal(unlocked.success, true);
  assert.equal(value.store.panicStatus().locked, false);
});
