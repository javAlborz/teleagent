'use strict';
const { installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setImmediate } = require('node:timers');
const test = require('node:test');
const express = require('express');
const {
  panicOutboundCalls,
  router,
  setupRoutes: setupRoutesRaw,
  shutdownOutboundCalls,
  unlockOutboundCalls,
} = require('../lib/outbound-routes');
const { VoiceStateStore } = require('../lib/voice-state-store');
const { OutboundRuntimeFence } = require('../lib/outbound-runtime-fence');
const { openVoiceRuntimeState } = require('../lib/voice-runtime-state');
const { createOutboundRoutingConfig } = require('../lib/outbound-routing-config');

const VALID_TOKEN = 'outbound-test-token-0123456789abcdef0123456789abcdef';
const HEALTHY_STATE_CAPACITY_GUARD = Object.freeze({
  check: () => ({ ok: true, code: null }),
});
const ROUTING_CONFIG = createOutboundRoutingConfig({
  host: '127.0.0.1',
  port: 5060,
  transport: 'udp',
  callbackAuth: {
    username: 'teleagent-voice',
    password: 'callback-0123456789abcdef0123456789abcdef',
  },
});

function createTestRuntimeFence() {
  return {
    held: true,
    assertHeld() {
      if (!this.held) throw new Error('test outbound runtime fence is not held');
      return true;
    },
    release() {
      this.held = false;
      return { changed: true };
    },
  };
}

function setupRoutes(deps) {
  return setupRoutesRaw({
    stateCapacityGuard: HEALTHY_STATE_CAPACITY_GUARD,
    ...deps,
  });
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function useOutboundToken(t) {
  const originalToken = process.env.OUTBOUND_API_TOKEN;
  const originalNonLoopback = process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED;
  process.env.OUTBOUND_API_TOKEN = VALID_TOKEN;
  delete process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED;
  t.after(() => {
    if (originalToken === undefined) delete process.env.OUTBOUND_API_TOKEN;
    else process.env.OUTBOUND_API_TOKEN = originalToken;
    if (originalNonLoopback === undefined) delete process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED;
    else process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED = originalNonLoopback;
  });
}

test('outbound API fails closed and exact retries return the durable call ID', async (t) => {
  const originalToken = process.env.OUTBOUND_API_TOKEN;
  const originalNonLoopback = process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED;
  t.after(() => {
    if (originalToken === undefined) delete process.env.OUTBOUND_API_TOKEN;
    else process.env.OUTBOUND_API_TOKEN = originalToken;
    if (originalNonLoopback === undefined) delete process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED;
    else process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED = originalNonLoopback;
  });

  assert.throws(
    () => setupRoutes({ httpHost: '127.0.0.1', outboundApiToken: '' }),
    /OUTBOUND_API_TOKEN/
  );
  assert.throws(
    () => setupRoutes({
      httpHost: '127.0.0.1',
      outboundApiToken: 'replace-with-random-token',
    }),
    /OUTBOUND_API_TOKEN/
  );
  delete process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED;
  assert.throws(
    () => setupRoutes({ httpHost: '0.0.0.0', outboundApiToken: VALID_TOKEN }),
    /NON_LOOPBACK_ENABLED/
  );
  assert.throws(
    () => setupRoutes({
      httpHost: '127.0.0.1',
      routingConfig: {
        host: '127.0.0.1:5060;transport=udp',
        port: 5060,
        transport: 'udp',
      },
    }),
    /server-side outbound SIP routing configuration/
  );

  const store = new VoiceStateStore({ dbPath: ':memory:' });
  const runtimeFence = createTestRuntimeFence();
  t.after(() => store.close());
  t.after(() => runtimeFence.release());
  setupRoutes({
    httpHost: '127.0.0.1',
    srf: {},
    mediaServer: {},
    voiceStateStore: store,
    runtimeFence,
    routingConfig: ROUTING_CONFIG,
  });
  const durableRequest = {
    to: '1001',
    message: 'Your durable task finished.',
    context: null,
    mode: 'announce',
    device: null,
    callerId: null,
    timeoutSeconds: 30,
    voiceThreadId: null,
  };
  const reservation = store.reserveOutboundCall({
    idempotencyKey: 'callback:job-route-durable',
    request: durableRequest,
    callId: 'stable-route-call-id',
  });
  store.claimOutboundCallIntent({
    idempotencyKey: reservation.idempotencyKey,
    callId: reservation.callId,
  });
  store.markOutboundCallTerminal({
    idempotencyKey: reservation.idempotencyKey,
    callId: reservation.callId,
    state: 'completed',
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(async () => {
    await shutdownOutboundCalls({ timeoutMs: 100 });
    await close(server);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/outbound-call`;
  const body = {
    to: durableRequest.to,
    message: durableRequest.message,
    idempotencyKey: reservation.idempotencyKey,
  };

  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(unauthorized.status, 401);

  const legacyApiKey = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': VALID_TOKEN,
    },
    body: JSON.stringify(body),
  });
  assert.equal(legacyApiKey.status, 401);

  const retry = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': reservation.idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    success: true,
    queued: true,
    callId: 'stable-route-call-id',
    status: 'completed',
    duplicate: true,
    message: 'Call durably queued',
    device: null,
  });

  const mismatch = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'callback:different-header',
    },
    body: JSON.stringify(body),
  });
  assert.equal(mismatch.status, 400);

  const conflict = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': reservation.idempotencyKey,
    },
    body: JSON.stringify({ ...body, message: 'A different callback.' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'idempotency_conflict');
  assert.equal(store.getOutboundCall(reservation.idempotencyKey).callId, 'stable-route-call-id');
});

test('outbound admission returns 503 before durable reservation when state capacity is exhausted', async (t) => {
  useOutboundToken(t);
  const store = new VoiceStateStore({ dbPath: ':memory:' });
  const runtimeFence = createTestRuntimeFence();
  let capacityAvailable = true;
  t.after(() => store.close());
  t.after(() => runtimeFence.release());
  setupRoutes({
    httpHost: '127.0.0.1',
    srf: {},
    mediaServer: {},
    voiceStateStore: store,
    runtimeFence,
    routingConfig: ROUTING_CONFIG,
    stateCapacityGuard: {
      check: () => capacityAvailable
        ? { ok: true, code: null }
        : { ok: false, code: 'VOICE_STATE_CAPACITY_EXHAUSTED' },
    },
  });
  capacityAvailable = false;

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(async () => {
    await shutdownOutboundCalls({ timeoutMs: 100 });
    await close(server);
  });
  const idempotencyKey = 'capacity:outbound-admission';
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/outbound-call`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        to: '1001',
        message: 'This must not be durably accepted.',
        idempotencyKey,
      }),
    },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'voice_state_capacity_unavailable');
  assert.equal(store.getOutboundCall(idempotencyKey), null);
});

test('client SIP routes are rejected and only dedicated trunk auth reaches the configured PBX', async (t) => {
  useOutboundToken(t);
  const store = new VoiceStateStore({ dbPath: ':memory:' });
  const runtimeFence = createTestRuntimeFence();
  const uacCalls = [];
  let endpointCreations = 0;
  setupRoutes({
    httpHost: '127.0.0.1',
    srf: {
      async createUAC(uri, options) {
        uacCalls.push({ uri, options });
        const error = new Error('busy');
        error.status = 486;
        throw error;
      },
    },
    mediaServer: {
      async createEndpoint() {
        endpointCreations += 1;
        return {
          local: { sdp: 'local-sdp' },
          async destroy() {},
        };
      },
    },
    deviceRegistry: {
      get(value) {
        if (value !== '1001') return null;
        return {
          extension: '1001',
          name: 'Secure Device',
          authId: 'device-auth-id',
          password: 'device-auth-secret',
        };
      },
    },
    voiceStateStore: store,
    runtimeFence,
    routingConfig: ROUTING_CONFIG,
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(async () => {
    await shutdownOutboundCalls({ timeoutMs: 100 });
    await close(server);
    store.close();
    runtimeFence.release();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/outbound-call`;
  const hostileRoutes = [
    'sip:1001@attacker.example:5060;transport=udp',
    'sip:1001@10.0.0.25:5060;transport=udp',
    'sip:1001@127.0.0.1:65000;transport=udp',
    'sip:1001@127.0.0.1:5060;transport=tcp',
    'sip:1001@127.0.0.1:5060;transport=udp;maddr=attacker.example',
  ];
  for (const [index, dialUri] of hostileRoutes.entries()) {
    const idempotencyKey = `hostile-route-${index}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        idempotencyKey,
        to: '1001',
        message: 'Do not dial this route.',
        device: '1001',
        dialUri,
      }),
    });
    assert.equal(response.status, 400, dialUri);
    assert.equal(store.getOutboundCall(idempotencyKey), null);
  }
  assert.equal(endpointCreations, 0);
  assert.equal(uacCalls.length, 0);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'server-owned-route',
    },
    body: JSON.stringify({
      idempotencyKey: 'server-owned-route',
      to: '1001',
      message: 'Use only the configured PBX.',
      device: '1001',
    }),
  });
  assert.equal(response.status, 200);
  for (let attempts = 0; attempts < 20 && uacCalls.length === 0; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(endpointCreations, 1);
  assert.equal(uacCalls.length, 1);
  assert.equal(uacCalls[0].uri, 'sip:1001@127.0.0.1:5060;transport=udp');
  assert.deepEqual(uacCalls[0].options.auth, {
    username: 'teleagent-voice',
    password: 'callback-0123456789abcdef0123456789abcdef',
  });
  assert.notEqual(uacCalls[0].options.auth.username, 'device-auth-id');
  assert.notEqual(uacCalls[0].options.auth.password, 'device-auth-secret');
});

test('queued cancellation is durable and status responses omit stored context', async (t) => {
  useOutboundToken(t);
  const store = new VoiceStateStore({ dbPath: ':memory:' });
  const runtimeFence = createTestRuntimeFence();
  t.after(() => runtimeFence.release());
  setupRoutes({
    httpHost: '127.0.0.1',
    srf: {},
    mediaServer: {},
    voiceStateStore: store,
    runtimeFence,
    routingConfig: ROUTING_CONFIG,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const reserved = store.reserveOutboundCall({
    idempotencyKey: 'queued-cancel-route',
    request: {
      to: '1001',
      message: 'Do not place this call.',
      context: { private: 'must-not-be-returned' },
      mode: 'announce',
      device: null,
      callerId: null,
      timeoutSeconds: 30,
      voiceThreadId: null,
    },
    callId: 'queued-cancel-route-call',
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(async () => {
    await shutdownOutboundCalls({ timeoutMs: 100 });
    await close(server);
    store.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const cancellation = await fetch(`${baseUrl}/call/${reserved.callId}/hangup`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason: 'operator_stop' }),
  });
  assert.equal(cancellation.status, 200);
  const cancellationBody = await cancellation.json();
  assert.equal(cancellationBody.persisted, true);
  assert.equal(cancellationBody.quiesced, true);
  assert.equal(cancellationBody.data.state, 'canceled');
  assert.equal(store.claimOutboundCallIntent({
    idempotencyKey: reserved.idempotencyKey,
    callId: reserved.callId,
  }).changed, false);

  const status = await fetch(`${baseUrl}/call/${reserved.callId}`, {
    headers: { Authorization: `Bearer ${VALID_TOKEN}` },
  });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.data.state, 'canceled');
  assert.equal(statusBody.data.to, '1001');
  assert.equal(Object.hasOwn(statusBody.data, 'request'), false);
  assert.equal(JSON.stringify(statusBody).includes('must-not-be-returned'), false);

  const canceledRetry = await fetch(`${baseUrl}/outbound-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': reserved.idempotencyKey,
    },
    body: JSON.stringify({
      idempotencyKey: reserved.idempotencyKey,
      to: '1001',
      message: 'Do not place this call.',
      context: { private: 'must-not-be-returned' },
    }),
  });
  assert.equal(canceledRetry.status, 409);
  const canceledRetryBody = await canceledRetry.json();
  assert.equal(canceledRetryBody.queued, false);
  assert.equal(canceledRetryBody.status, 'canceled');

  const rejectedWebhook = await fetch(`${baseUrl}/outbound-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'webhook-ssrf-rejected',
    },
    body: JSON.stringify({
      idempotencyKey: 'webhook-ssrf-rejected',
      to: '1001',
      message: 'Do not fetch the supplied URL.',
      webhookUrl: 'http://127.0.0.1:3000/api/voice-control/stop',
    }),
  });
  assert.equal(rejectedWebhook.status, 400);
  assert.match((await rejectedWebhook.json()).message, /not supported/i);
  assert.equal(store.getOutboundCall('webhook-ssrf-rejected'), null);
});

test('panic persists post-intent cancellation, tears down resources, and gates unlock', async (t) => {
  useOutboundToken(t);
  const store = new VoiceStateStore({ dbPath: ':memory:' });
  const runtimeFence = createTestRuntimeFence();
  t.after(() => runtimeFence.release());
  let resolveDialog;
  let signalInviteStarted;
  const inviteStarted = new Promise((resolve) => { signalInviteStarted = resolve; });
  let endpointDestroyCount = 0;
  let dialogDestroyCount = 0;
  const endpoint = {
    local: { sdp: 'local-sdp' },
    async modify() {},
    async destroy() { endpointDestroyCount += 1; },
  };
  const dialog = {
    remote: { sdp: 'remote-sdp' },
    destroyed: false,
    on() {},
    async destroy() {
      dialogDestroyCount += 1;
      this.destroyed = true;
    },
  };
  const srf = {
    createUAC() {
      signalInviteStarted();
      return new Promise((resolve) => { resolveDialog = () => resolve(dialog); });
    },
  };
  setupRoutes({
    httpHost: '127.0.0.1',
    srf,
    mediaServer: { async createEndpoint() { return endpoint; } },
    voiceStateStore: store,
    runtimeFence,
    routingConfig: ROUTING_CONFIG,
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(async () => {
    resolveDialog?.();
    await shutdownOutboundCalls({ timeoutMs: 500 });
    await close(server);
    store.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const submitted = await fetch(`${baseUrl}/outbound-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'panic-active-call',
    },
    body: JSON.stringify({
      idempotencyKey: 'panic-active-call',
      to: '1001',
      message: 'This must be interrupted before playback.',
    }),
  });
  assert.equal(submitted.status, 200);
  const { callId } = await submitted.json();
  await inviteStarted;

  const panicPromise = panicOutboundCalls({ reason: 'dial_9', timeoutMs: 1000 });
  resolveDialog();
  const panic = await panicPromise;
  assert.equal(panic.persisted, true);
  assert.equal(panic.quiesced, true);
  assert.equal(panic.success, true);
  assert.equal(store.getOutboundCallByCallId(callId).state, 'canceled');
  assert.equal(endpointDestroyCount, 1);
  assert.equal(dialogDestroyCount, 1);

  const blocked = await fetch(`${baseUrl}/outbound-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'panic-blocked-call',
    },
    body: JSON.stringify({
      idempotencyKey: 'panic-blocked-call',
      to: '1001',
      message: 'This must remain blocked.',
    }),
  });
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error, 'voice_execution_locked');
  assert.deepEqual(unlockOutboundCalls(), {
    success: true,
    locked: false,
    quiesced: true,
    activeIds: [],
  });
});

test('shutdown actively cancels an in-flight dial and reports bounded quiescence', async (t) => {
  useOutboundToken(t);
  const store = new VoiceStateStore({ dbPath: ':memory:' });
  const runtimeFence = createTestRuntimeFence();
  t.after(() => runtimeFence.release());
  let resolveDialog;
  let signalInviteStarted;
  const inviteStarted = new Promise((resolve) => { signalInviteStarted = resolve; });
  let endpointDestroyed = false;
  let dialogDestroyed = false;
  const endpoint = {
    local: { sdp: 'local-sdp' },
    async modify() {},
    async destroy() { endpointDestroyed = true; },
  };
  const dialog = {
    remote: { sdp: 'remote-sdp' },
    destroyed: false,
    on() {},
    async destroy() {
      dialogDestroyed = true;
      this.destroyed = true;
    },
  };
  setupRoutes({
    httpHost: '127.0.0.1',
    srf: {
      createUAC() {
        signalInviteStarted();
        return new Promise((resolve) => { resolveDialog = () => resolve(dialog); });
      },
    },
    mediaServer: { async createEndpoint() { return endpoint; } },
    voiceStateStore: store,
    runtimeFence,
    routingConfig: ROUTING_CONFIG,
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(async () => {
    resolveDialog?.();
    await close(server);
    store.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/outbound-call`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'shutdown-active-call',
      },
      body: JSON.stringify({
        idempotencyKey: 'shutdown-active-call',
        to: '1001',
        message: 'Shutdown must interrupt this call.',
      }),
    }
  );
  const { callId } = await response.json();
  await inviteStarted;

  const firstShutdown = await shutdownOutboundCalls({ timeoutMs: 10 });
  assert.equal(firstShutdown.drained, false);
  assert.equal(firstShutdown.safeToClose, false);
  assert.equal(firstShutdown.quiesced, false);
  assert.deepEqual(firstShutdown.activeIds, [callId]);

  const shutdownPromise = shutdownOutboundCalls({ timeoutMs: 1000 });
  resolveDialog();
  const shutdown = await shutdownPromise;
  assert.equal(shutdown.drained, true);
  assert.equal(shutdown.safeToClose, true);
  assert.equal(shutdown.quiesced, true);
  assert.equal(endpointDestroyed, true);
  assert.equal(dialogDestroyed, true);
  assert.equal(store.getOutboundCallByCallId(callId).state, 'canceled');
});

test('a scheduler setup exception after dial intent becomes durable outcome uncertainty', async (t) => {
  useOutboundToken(t);
  const store = new VoiceStateStore({ dbPath: ':memory:' });
  const runtimeFence = createTestRuntimeFence();
  t.after(() => {
    store.close();
    runtimeFence.release();
  });
  let deviceLookups = 0;
  let endpointCreations = 0;
  setupRoutes({
    httpHost: '127.0.0.1',
    srf: {},
    mediaServer: {
      async createEndpoint() {
        endpointCreations += 1;
        throw new Error('must not be reached');
      },
    },
    deviceRegistry: {
      get() {
        deviceLookups += 1;
        if (deviceLookups > 1) throw new Error('injected scheduler setup failure');
        return { name: 'Test Device', extension: '1001' };
      },
    },
    voiceStateStore: store,
    runtimeFence,
    routingConfig: ROUTING_CONFIG,
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(() => close(server));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/outbound-call`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'scheduler-setup-uncertain',
      },
      body: JSON.stringify({
        idempotencyKey: 'scheduler-setup-uncertain',
        to: '1001',
        message: 'This must never reach SIP.',
        device: 'Test Device',
      }),
    }
  );
  assert.equal(response.status, 200);
  const { callId } = await response.json();
  const deadline = Date.now() + 1000;
  let record = null;
  while (Date.now() < deadline) {
    record = store.getOutboundCallByCallId(callId);
    if (record?.state === 'outcome_unknown') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(record?.state, 'outcome_unknown');
  assert.equal(record.recoveryRequired, true);
  assert.equal(endpointCreations, 0);
  assert.equal(unlockOutboundCalls().success, false);
});

test('recovered post-intent ambiguity fences all new dialing and cannot be unlocked online', async (t) => {
  useOutboundToken(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-outbound-barrier-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let runtime = openVoiceRuntimeState({ dbPath });
  const ambiguous = runtime.stateStore.reserveOutboundCall({
    idempotencyKey: 'recovered-ambiguous-call',
    request: { to: '1001', message: 'Maybe already dialed.', mode: 'announce' },
    callId: 'recovered-ambiguous-call-id',
  });
  runtime.stateStore.claimOutboundCallIntent(ambiguous);
  const queued = runtime.stateStore.reserveOutboundCall({
    idempotencyKey: 'queued-behind-barrier',
    request: { to: '1002', message: 'Must remain queued.', mode: 'announce' },
    callId: 'queued-behind-barrier-id',
  });
  runtime.stateStore.close();
  runtime.runtimeFence.release();

  runtime = openVoiceRuntimeState({ dbPath });
  t.after(() => {
    runtime.stateStore.close();
    runtime.runtimeFence.release();
  });
  let createUacCount = 0;
  setupRoutes({
    httpHost: '127.0.0.1',
    srf: { async createUAC() { createUacCount += 1; } },
    mediaServer: { async createEndpoint() { throw new Error('must not create endpoint'); } },
    voiceStateStore: runtime.stateStore,
    runtimeFence: runtime.runtimeFence,
    routingConfig: ROUTING_CONFIG,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createUacCount, 0);
  assert.equal(runtime.stateStore.getOutboundCall(queued.idempotencyKey).state, 'queued');

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await listen(app);
  t.after(() => close(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const submitted = await fetch(`${baseUrl}/outbound-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'blocked-new-call',
    },
    body: JSON.stringify({
      idempotencyKey: 'blocked-new-call',
      to: '1003',
      message: 'Do not dial while ambiguity remains.',
    }),
  });
  assert.equal(submitted.status, 503);
  const submittedBody = await submitted.json();
  assert.equal(submittedBody.error, 'outbound_recovery_required');
  assert.deepEqual(submittedBody.recoveryCallIds, [ambiguous.callId]);

  const status = await fetch(`${baseUrl}/outbound-status`, {
    headers: { Authorization: `Bearer ${VALID_TOKEN}` },
  });
  assert.equal(status.status, 503);
  const statusBody = await status.json();
  assert.equal(statusBody.outbound.recoveryRequired, true);
  assert.deepEqual(statusBody.outbound.recoveryCallIds, [ambiguous.callId]);
  assert.equal(JSON.stringify(statusBody).includes('Maybe already dialed'), false);

  const unlocked = unlockOutboundCalls();
  assert.equal(unlocked.success, false);
  assert.equal(unlocked.recoveryRequired, true);
  const panic = await panicOutboundCalls({ reason: 'test recovery barrier', timeoutMs: 100 });
  assert.equal(panic.quiesced, false);
  assert.equal(panic.recoveryRequired, true);
  assert.ok(panic.activeIds.includes(ambiguous.callId));

  const drain = await shutdownOutboundCalls({ timeoutMs: 100 });
  assert.equal(drain.safeToClose, false);
  assert.equal(runtime.runtimeFence.assertHeld(), true);
  assert.throws(
    () => new OutboundRuntimeFence({ stateDbPath: dbPath }),
    (error) => error?.code === 'OUTBOUND_RUNTIME_ALREADY_ACTIVE'
  );
  assert.equal(createUacCount, 0);
});
