import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GatewayStateStore } from '../src/gateway-state-store.js';

async function makeStore(t, clock = () => 1_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-state-store-'));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  const stateStore = new GatewayStateStore({ filePath, clock });
  await stateStore.init();
  if (t) t.after(() => stateStore.close());
  return { stateStore, filePath };
}

function metadata() {
  return {
    eventId: 'evt_test_1',
    eventType: 'realtime.call.incoming',
    callId: 'rtc_test_1',
  };
}

test('state store uses WAL and FULL synchronization with private database permissions', async (t) => {
  const { stateStore, filePath } = await makeStore(t);
  assert.deepEqual(stateStore.durability(), { journalMode: 'wal', synchronous: 2 });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal(stateStore.healthy, true);
});

test('verified webhook and accept intent survive restart before any remote action', async () => {
  const { stateStore, filePath } = await makeStore(null);
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  stateStore.reserveCall({
    webhookId: 'wh_test_1',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  await stateStore.close();

  const reloaded = new GatewayStateStore({ filePath, clock: () => 1_001 });
  await reloaded.init();
  assert.equal(reloaded.getWebhook('wh_test_1').state, 'processing');
  assert.equal(reloaded.getCall('rtc_test_1').state, 'accept_intent');
  assert.equal(reloaded.getCall('rtc_test_1').authenticatedPrincipal, 'hermes-test-pbx');
  await reloaded.close();
});

test('completed webhook dedupe and terminal call state survive restart', async () => {
  const { stateStore, filePath } = await makeStore(null);
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  stateStore.reserveCall({
    webhookId: 'wh_test_1',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'reject',
    reason: 'caller_not_allowed',
    statusCode: 403,
    maxActiveCalls: 1,
  });
  stateStore.updateCall('rtc_test_1', 'rejected');
  stateStore.completeWebhook('wh_test_1', 'rejected');
  await stateStore.close();

  const reloaded = new GatewayStateStore({ filePath });
  await reloaded.init();
  const duplicate = reloaded.recordVerifiedWebhook('wh_test_1', metadata());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.outcome, 'rejected');
  assert.equal(reloaded.getCall('rtc_test_1').state, 'rejected');
  await reloaded.close();
});

test('one transaction reserves durable capacity across different calls', async (t) => {
  const { stateStore } = await makeStore(t);
  stateStore.recordVerifiedWebhook('wh_first', metadata());
  const first = stateStore.reserveCall({
    webhookId: 'wh_first',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  stateStore.recordVerifiedWebhook('wh_second', {
    ...metadata(),
    eventId: 'evt_test_2',
    callId: 'rtc_test_2',
  });
  const second = stateStore.reserveCall({
    webhookId: 'wh_second',
    callId: 'rtc_test_2',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  assert.equal(first.record.state, 'accept_intent');
  assert.equal(second.record.state, 'reject_intent');
  assert.equal(second.record.decision, 'capacity_reached');
  assert.equal(stateStore.summary().active, 2, 'capacity rejection remains active until confirmed');
});

test('webhook identifier reuse with changed signed metadata fails closed', async (t) => {
  const { stateStore } = await makeStore(t);
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  assert.throws(() => stateStore.recordVerifiedWebhook('wh_test_1', {
    ...metadata(),
    callId: 'rtc_different',
  }), /reused with different verified metadata/u);
  assert.equal(stateStore.healthy, true);
});

test('database stores the authenticated principal but never receives the PBX secret', async () => {
  const { stateStore, filePath } = await makeStore(null);
  const secret = 'pbx-secret-must-never-be-persisted-123456';
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  stateStore.reserveCall({
    webhookId: 'wh_test_1',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  await stateStore.close();
  assert.equal((await readFile(filePath)).includes(Buffer.from(secret)), false);
  assert.equal((await readFile(filePath)).includes(Buffer.from('hermes-test-pbx')), true);
});
