import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAIWebhookHandler } from '../src/webhook-handler.js';
import { incomingEvent, makeRegistry, silentLogger } from './helpers.js';

test('handler verifies exact raw bytes before durable dedupe and dispatches once', async (t) => {
  const { stateStore } = await makeRegistry(t);
  const event = incomingEvent();
  const verifications = [];
  const dispatches = [];
  const handler = new OpenAIWebhookHandler({
    callService: {
      async verifyWebhook(body, headers) {
        verifications.push({ body, headers });
        return event;
      },
    },
    callGateway: {
      async handleIncoming(value, context) {
        dispatches.push({ value, context });
        return { outcome: 'accepted' };
      },
    },
    stateStore,
    logger: silentLogger,
  });
  const rawBody = Buffer.from('{ "preserve" : "spacing" }');
  const request = { headers: { 'webhook-id': 'wh_test_1' }, rawBody };
  assert.equal((await handler.handle(request)).statusCode, 200);
  assert.equal((await handler.handle(request)).statusCode, 200);
  assert.equal(verifications[0].body, '{ "preserve" : "spacing" }');
  assert.equal(verifications.length, 2, 'every delivery is authenticated before dedupe lookup');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].context.webhookId, 'wh_test_1');
  assert.equal(stateStore.getWebhook('wh_test_1').outcome, 'accepted');
});

test('concurrent duplicate deliveries share one in-process dispatch', async (t) => {
  const { stateStore } = await makeRegistry(t);
  let dispatches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = new OpenAIWebhookHandler({
    callService: { async verifyWebhook() { return incomingEvent(); } },
    callGateway: {
      async handleIncoming() {
        dispatches += 1;
        await gate;
        return { outcome: 'accepted' };
      },
    },
    stateStore,
    logger: silentLogger,
  });
  const request = { headers: { 'webhook-id': 'wh_concurrent' }, rawBody: Buffer.from('{}') };
  const first = handler.handle(request);
  const second = handler.handle(request);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
  assert.equal(dispatches, 1);
});

test('handler rejects a verification failure without durable recording or dispatch', async (t) => {
  const { stateStore } = await makeRegistry(t);
  let dispatched = false;
  const handler = new OpenAIWebhookHandler({
    callService: { async verifyWebhook() { throw new Error('bad signature'); } },
    callGateway: { async handleIncoming() { dispatched = true; } },
    stateStore,
    logger: silentLogger,
  });
  const result = await handler.handle({
    headers: { 'webhook-id': 'wh_bad' },
    rawBody: Buffer.from('{}'),
  });
  assert.equal(result.statusCode, 400);
  assert.equal(dispatched, false);
  assert.equal(stateStore.getWebhook('wh_bad'), null);
});

test('handler durably acknowledges unrelated signed events', async (t) => {
  const { stateStore } = await makeRegistry(t);
  const handler = new OpenAIWebhookHandler({
    callService: {
      async verifyWebhook() { return { id: 'evt_other', type: 'response.completed' }; },
    },
    callGateway: { async handleIncoming() { throw new Error('must not dispatch'); } },
    stateStore,
    logger: silentLogger,
  });
  const result = await handler.handle({
    headers: { 'webhook-id': 'wh_other' },
    rawBody: Buffer.from('{}'),
  });
  assert.equal(result.statusCode, 204);
  assert.equal(stateStore.getWebhook('wh_other').outcome, 'ignored');
});

test('a crash-like dispatch failure leaves verified processing state for safe gateway recovery', async (t) => {
  const { stateStore } = await makeRegistry(t);
  let attempts = 0;
  const handler = new OpenAIWebhookHandler({
    callService: { async verifyWebhook() { return incomingEvent(); } },
    callGateway: {
      async handleIncoming() {
        attempts += 1;
        throw new Error('simulated process interruption');
      },
    },
    stateStore,
    logger: silentLogger,
  });
  const request = { headers: { 'webhook-id': 'wh_retry' }, rawBody: Buffer.from('{}') };
  assert.equal((await handler.handle(request)).statusCode, 500);
  assert.equal(stateStore.getWebhook('wh_retry').state, 'verified');
  assert.equal((await handler.handle(request)).statusCode, 500);
  assert.equal(attempts, 2);
});

test('handler rejects a signed incoming event with a malformed call ID', async (t) => {
  const { stateStore } = await makeRegistry(t);
  const event = incomingEvent();
  event.data.call_id = '../not-a-call';
  const handler = new OpenAIWebhookHandler({
    callService: { async verifyWebhook() { return event; } },
    callGateway: { async handleIncoming() { throw new Error('must not dispatch'); } },
    stateStore,
    logger: silentLogger,
  });
  const result = await handler.handle({
    headers: { 'webhook-id': 'wh_malformed' },
    rawBody: Buffer.from('{}'),
  });
  assert.equal(result.statusCode, 400);
  assert.equal(stateStore.getWebhook('wh_malformed'), null);
});
