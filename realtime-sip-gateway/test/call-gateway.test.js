import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CallGateway } from '../src/call-gateway.js';
import {
  incomingEvent,
  makeConfig,
  makeRegistry,
  recordIncomingWebhook,
  silentLogger,
} from './helpers.js';

class FakeSideband extends EventEmitter {
  responseRequests = 0;
  closed = false;

  get state() {
    return this.closed ? 'closed' : 'open';
  }

  async connect() {
    this.emit('raw_event', { type: 'session.created' });
  }

  requestResponse() {
    this.responseRequests += 1;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code: 1001, previousState: 'open' });
  }
}

function simulatedCrash(point) {
  const error = new Error(`simulated crash at ${point}`);
  error.simulatedCrash = true;
  return error;
}

test('gateway durably binds the authenticated PBX principal before accepting and attaches sideband', async (t) => {
  const calls = [];
  const { stateStore, registry } = await makeRegistry(t);
  const callService = {
    async accept(callId) {
      assert.equal(stateStore.getWebhook('wh_test_1').state, 'processing');
      assert.equal(stateStore.getCall(callId).state, 'accept_intent');
      assert.equal(stateStore.getCall(callId).authenticatedPrincipal, 'hermes-test-pbx');
      calls.push(['accept', callId]);
    },
    async reject(callId, status) { calls.push(['reject', callId, status]); },
    async hangup(callId) { calls.push(['hangup', callId]); },
  };
  const sideband = new FakeSideband();
  const gateway = new CallGateway({
    config: makeConfig(),
    callService,
    logger: silentLogger,
    registry,
    sidebandFactory: () => sideband,
  });
  const event = incomingEvent();
  const webhookId = recordIncomingWebhook(stateStore, event);
  const result = await gateway.handleIncoming(event, { webhookId });
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(calls, [['accept', 'rtc_test_1']]);
  assert.equal(registry.get('rtc_test_1').state, 'attached');
  assert.equal(registry.get('rtc_test_1').authenticatedPrincipal, 'hermes-test-pbx');
  assert.equal(sideband.responseRequests, 1);

  const dtmfPromise = once(gateway, 'dtmf');
  sideband.emit('dtmf', { digit: '#', receivedAt: 1, rawEvent: {} });
  const [dtmf] = await dtmfPromise;
  assert.equal(dtmf.callId, 'rtc_test_1');
  assert.equal(dtmf.digit, '#');
});

test('gateway rejects a spoofed From value without the private PBX credential', async (t) => {
  const calls = [];
  const { stateStore, registry } = await makeRegistry(t);
  const gateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { calls.push('accept'); },
      async reject(callId, status) { calls.push(['reject', callId, status]); },
      async hangup() {},
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => { throw new Error('must not attach'); },
  });
  const event = incomingEvent();
  event.data.sip_headers = event.data.sip_headers.filter(
    (header) => header.name.toLowerCase() !== 'x-teleagent-pbx-auth',
  );
  const webhookId = recordIncomingWebhook(stateStore, event);
  const result = await gateway.handleIncoming(event, { webhookId });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(calls, [['reject', 'rtc_test_1', 403]]);
  assert.equal(registry.get('rtc_test_1').authenticatedPrincipal, null);
});

test('gateway reject mode calls the Realtime reject endpoint and never attaches sideband', async (t) => {
  const calls = [];
  const { stateStore, registry } = await makeRegistry(t);
  const gateway = new CallGateway({
    config: makeConfig({ mode: 'reject', pbxAuthSecret: null }),
    callService: {
      async accept() { calls.push('accept'); },
      async reject(callId, status) { calls.push(['reject', callId, status]); },
      async hangup() {},
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => { throw new Error('must not attach'); },
  });
  const event = incomingEvent();
  const webhookId = recordIncomingWebhook(stateStore, event);
  const result = await gateway.handleIncoming(event, { webhookId });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(calls, [['reject', 'rtc_test_1', 486]]);
});

test('gateway confirms a fail-safe hangup if sideband attachment fails', async (t) => {
  const hungUp = [];
  const { stateStore, registry } = await makeRegistry(t);
  const sideband = new FakeSideband();
  sideband.connect = async () => { throw new Error('connect failed'); };
  const gateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() {},
      async reject() {},
      async hangup(callId) { hungUp.push(callId); },
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => sideband,
  });
  const event = incomingEvent();
  const result = await gateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(stateStore, event),
  });
  assert.equal(result.outcome, 'closed_fail_safe');
  assert.deepEqual(hungUp, ['rtc_test_1']);
  assert.equal(registry.get('rtc_test_1').state, 'closed');
  assert.equal(registry.get('rtc_test_1').hangupConfirmed, true);
});

test('durable capacity survives restart and rejects a second call', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-capacity-restart-'));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  const firstState = await makeRegistry(null, { filePath });
  const firstService = { async accept() {}, async reject() {}, async hangup() {} };
  const firstGateway = new CallGateway({
    config: makeConfig({ maxActiveCalls: 1 }),
    callService: firstService,
    logger: silentLogger,
    registry: firstState.registry,
    sidebandFactory: () => new FakeSideband(),
  });
  const firstEvent = incomingEvent();
  await firstGateway.handleIncoming(firstEvent, {
    webhookId: recordIncomingWebhook(firstState.stateStore, firstEvent, 'wh_first'),
  });
  await firstState.stateStore.close();

  const restarted = await makeRegistry(t, { filePath });
  const calls = [];
  const restartedGateway = new CallGateway({
    config: makeConfig({ maxActiveCalls: 1 }),
    callService: {
      async accept(callId) { calls.push(['accept', callId]); },
      async reject(callId, status) { calls.push(['reject', callId, status]); },
      async hangup(callId) { calls.push(['hangup', callId]); },
    },
    logger: silentLogger,
    registry: restarted.registry,
    sidebandFactory: () => new FakeSideband(),
  });
  await restartedGateway.recover();
  const secondEvent = incomingEvent({ id: 'evt_test_2' });
  secondEvent.data = { ...secondEvent.data, call_id: 'rtc_test_2' };
  const result = await restartedGateway.handleIncoming(secondEvent, {
    webhookId: recordIncomingWebhook(restarted.stateStore, secondEvent, 'wh_second'),
  });
  assert.equal(result.outcome, 'capacity_rejected');
  assert.deepEqual(calls, [['reject', 'rtc_test_2', 486]]);
  assert.equal(restarted.registry.summary().active, 1);
});

test('crash after remote accept never re-accepts and restart fails closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-accept-crash-'));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  const firstState = await makeRegistry(null, { filePath });
  let accepts = 0;
  const firstGateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { accepts += 1; },
      async reject() {},
      async hangup() {},
    },
    logger: silentLogger,
    registry: firstState.registry,
    sidebandFactory: () => new FakeSideband(),
    crashInjector(point) {
      if (point === 'after_remote_accept') throw simulatedCrash(point);
    },
  });
  const event = incomingEvent();
  await assert.rejects(firstGateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(firstState.stateStore, event),
  }), /simulated crash/u);
  assert.equal(firstState.registry.get('rtc_test_1').state, 'accept_intent');
  await firstState.stateStore.close();

  const restarted = await makeRegistry(t, { filePath });
  const hangups = [];
  const recoveryGateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { accepts += 1; },
      async reject() {},
      async hangup(callId) { hangups.push(callId); },
    },
    logger: silentLogger,
    registry: restarted.registry,
    sidebandFactory: () => new FakeSideband(),
  });
  await recoveryGateway.recover();
  assert.equal(accepts, 1, 'restart must never blindly repeat accept');
  assert.deepEqual(hangups, ['rtc_test_1']);
  assert.equal(restarted.registry.get('rtc_test_1').state, 'closed');
  assert.equal(restarted.registry.get('rtc_test_1').recoveryReason, 'accept_intent_startup_recovery');
});

test('restart adopts an already accepted call by exact call ID without re-accepting', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-sideband-adopt-'));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  const firstState = await makeRegistry(null, { filePath });
  let accepts = 0;
  const firstGateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { accepts += 1; },
      async reject() {},
      async hangup() {},
    },
    logger: silentLogger,
    registry: firstState.registry,
    sidebandFactory: () => new FakeSideband(),
    crashInjector(point) {
      if (point === 'after_accepted') throw simulatedCrash(point);
    },
  });
  const event = incomingEvent();
  await assert.rejects(firstGateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(firstState.stateStore, event),
  }), /simulated crash/u);
  assert.equal(firstState.registry.get('rtc_test_1').state, 'accepted');
  await firstState.stateStore.close();

  const restarted = await makeRegistry(t, { filePath });
  const adopted = [];
  const recoveryGateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { accepts += 1; },
      async reject() {},
      async hangup() {},
    },
    logger: silentLogger,
    registry: restarted.registry,
    sidebandFactory: ({ callId }) => {
      adopted.push(callId);
      return new FakeSideband();
    },
  });
  await recoveryGateway.recover();
  assert.equal(accepts, 1);
  assert.deepEqual(adopted, ['rtc_test_1']);
  assert.equal(restarted.registry.get('rtc_test_1').state, 'attached');
});

for (const crashPoint of ['after_sideband_attaching', 'after_sideband_connected', 'after_attached']) {
  test(`restart safely adopts the exact call after ${crashPoint}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `sip-${crashPoint}-`));
    const filePath = path.join(directory, 'gateway-state.sqlite3');
    const firstState = await makeRegistry(null, { filePath });
    let accepts = 0;
    const firstGateway = new CallGateway({
      config: makeConfig(),
      callService: {
        async accept() { accepts += 1; },
        async reject() {},
        async hangup() {},
      },
      logger: silentLogger,
      registry: firstState.registry,
      sidebandFactory: () => new FakeSideband(),
      crashInjector(point) {
        if (point === crashPoint) throw simulatedCrash(point);
      },
    });
    const event = incomingEvent();
    await assert.rejects(firstGateway.handleIncoming(event, {
      webhookId: recordIncomingWebhook(firstState.stateStore, event),
    }), /simulated crash/u);
    assert.equal(
      firstState.registry.get('rtc_test_1').state,
      crashPoint === 'after_attached' ? 'attached' : 'sideband_attaching',
    );
    await firstState.stateStore.close();

    const restarted = await makeRegistry(t, { filePath });
    const adopted = [];
    const recoveryGateway = new CallGateway({
      config: makeConfig(),
      callService: {
        async accept() { accepts += 1; },
        async reject() {},
        async hangup() {},
      },
      logger: silentLogger,
      registry: restarted.registry,
      sidebandFactory: ({ callId }) => {
        adopted.push(callId);
        return new FakeSideband();
      },
    });
    await recoveryGateway.recover();
    assert.equal(accepts, 1);
    assert.deepEqual(adopted, ['rtc_test_1']);
    assert.equal(restarted.registry.get('rtc_test_1').state, 'attached');
  });
}

test('failed exact-call-ID adoption hangs up or remains durable outcome_unknown', async (t) => {
  const { stateStore, registry } = await makeRegistry(t);
  const event = incomingEvent();
  const webhookId = recordIncomingWebhook(stateStore, event);
  stateStore.reserveCall({
    webhookId,
    callId: event.data.call_id,
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  stateStore.updateCall(event.data.call_id, 'accepted');
  let acceptCalled = false;
  const sideband = new FakeSideband();
  sideband.connect = async () => { throw new Error('call is not adoptable'); };
  const gateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { acceptCalled = true; },
      async reject() {},
      async hangup() { throw new Error('hangup outcome unavailable'); },
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => sideband,
  });
  await gateway.recover();
  assert.equal(acceptCalled, false);
  assert.equal(registry.get(event.data.call_id).state, 'outcome_unknown');
  assert.equal(registry.get(event.data.call_id).recoveryReason, 'sideband_adoption_failed');
  assert.equal(registry.summary().active, 1);
});

test('an uncertain hangup remains durable and continues consuming capacity', async (t) => {
  const { stateStore, registry } = await makeRegistry(t);
  let accepts = 0;
  const gateway = new CallGateway({
    config: makeConfig({ maxActiveCalls: 1 }),
    callService: {
      async accept() {
        accepts += 1;
        throw new Error('ambiguous accept failure');
      },
      async reject() {},
      async hangup() { throw new Error('ambiguous hangup failure'); },
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => new FakeSideband(),
  });
  const event = incomingEvent();
  const first = await gateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(stateStore, event, 'wh_uncertain'),
  });
  assert.equal(first.outcome, 'outcome_unknown');
  assert.equal(registry.get('rtc_test_1').state, 'outcome_unknown');
  assert.equal(registry.summary().active, 1);

  const duplicateEvent = incomingEvent({ id: 'evt_duplicate_call' });
  const second = await gateway.handleIncoming(duplicateEvent, {
    webhookId: recordIncomingWebhook(stateStore, duplicateEvent, 'wh_duplicate_call'),
  });
  assert.equal(second.outcome, 'outcome_unknown');
  assert.equal(accepts, 1);
});

test('a 404 hangup confirms the call is already absent and releases durable capacity', async (t) => {
  const { stateStore, registry } = await makeRegistry(t);
  const gateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { throw new Error('ambiguous accept failure'); },
      async reject() {},
      async hangup() {
        const error = new Error('call not found');
        error.status = 404;
        throw error;
      },
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => new FakeSideband(),
  });
  const event = incomingEvent();
  const result = await gateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(stateStore, event, 'wh_absent'),
  });
  assert.equal(result.outcome, 'closed_fail_safe');
  assert.equal(registry.get('rtc_test_1').state, 'closed');
  assert.equal(registry.get('rtc_test_1').hangupConfirmed, true);
  assert.equal(registry.summary().active, 0);
});

test('a crash after remote hangup preserves hangup_intent for conservative restart recovery', async (t) => {
  const { stateStore, registry } = await makeRegistry(t);
  const gateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() { throw new Error('ambiguous accept failure'); },
      async reject() {},
      async hangup() {},
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => new FakeSideband(),
    crashInjector(point) {
      if (point === 'after_remote_hangup') throw simulatedCrash(point);
    },
  });
  const event = incomingEvent();
  await assert.rejects(gateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(stateStore, event, 'wh_hangup_crash'),
  }), /simulated crash/u);
  assert.equal(registry.get('rtc_test_1').state, 'hangup_intent');
  assert.equal(registry.get('rtc_test_1').hangupConfirmed, false);
  assert.equal(registry.summary().active, 1);
});

test('gateway close stays retryable until every durable call hangup is confirmed', async (t) => {
  const { stateStore, registry } = await makeRegistry(t);
  let hangupAllowed = false;
  let hangupCalls = 0;
  const sideband = new FakeSideband();
  const gateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() {},
      async reject() {},
      async hangup() {
        hangupCalls += 1;
        if (!hangupAllowed) throw new Error('remote hangup is ambiguous');
      },
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => sideband,
  });
  const event = incomingEvent();
  await gateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(stateStore, event, 'wh_close_retry'),
  });

  await assert.rejects(() => gateway.close(), {
    code: 'SIP_GATEWAY_NOT_QUIESCED',
  });
  assert.equal(sideband.closed, true);
  assert.equal(registry.get(event.data.call_id).state, 'outcome_unknown');
  assert.equal(registry.summary().active, 1);

  hangupAllowed = true;
  const result = await gateway.close();
  assert.equal(result.quiesced, true);
  assert.equal(result.activeCount, 0);
  assert.equal(hangupCalls, 2);
  assert.equal(registry.get(event.data.call_id).state, 'closed');
  assert.equal(registry.summary().active, 0);
});

test('gateway close cannot claim quiescence before the exact sideband closes', async (t) => {
  class StickySideband extends FakeSideband {
    get state() {
      return 'open';
    }

    close() {
      // Simulates a WebSocket that accepted close but did not complete its
      // close handshake before the gateway deadline.
    }
  }

  const { stateStore, registry } = await makeRegistry(t);
  const sideband = new StickySideband();
  const gateway = new CallGateway({
    config: makeConfig(),
    callService: {
      async accept() {},
      async reject() {},
      async hangup() {},
    },
    logger: silentLogger,
    registry,
    sidebandFactory: () => sideband,
    sidebandCloseTimeoutMs: 20,
  });
  const event = incomingEvent();
  await gateway.handleIncoming(event, {
    webhookId: recordIncomingWebhook(stateStore, event, 'wh_sideband_close_retry'),
  });

  await assert.rejects(() => gateway.close(), {
    code: 'SIP_GATEWAY_NOT_QUIESCED',
  });
  assert.equal(registry.get(event.data.call_id).state, 'closed');

  sideband.emit('close', { code: 1001, previousState: 'open' });
  const result = await gateway.close();
  assert.equal(result.quiesced, true);
  assert.equal(result.unconfirmedSessionCount, 0);
});
