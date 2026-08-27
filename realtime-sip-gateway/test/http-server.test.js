import assert from 'node:assert/strict';
import test from 'node:test';

import { createHttpServer } from '../src/http-server.js';
import { makeConfig, silentLogger } from './helpers.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('HTTP server exposes a secret-free health endpoint and preserves webhook bytes', async (t) => {
  const rawBodies = [];
  const server = createHttpServer({
    config: makeConfig(),
    webhookHandler: {
      async handle(request) {
        rawBodies.push(request.rawBody);
        return { statusCode: 200, body: '' };
      },
    },
    callGateway: { registry: { summary: () => ({ active: 0, tracked: 0, states: {} }) } },
    stateStore: { healthy: true, capacityAvailable: true },
    logger: silentLogger,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = await listen(server);
  assert.equal(server.maxConnections, 32);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.deepEqual(healthBody, {
    status: 'ok',
    mode: 'accept',
    activeCalls: 0,
    trackedCalls: 0,
    durableState: 'ok',
    durableStateAdmission: 'admitted',
    uncertainCalls: 0,
  });
  assert.equal(JSON.stringify(healthBody).includes('sk-test'), false);

  const body = '{ "raw" : true }';
  const webhook = await fetch(`${baseUrl}/webhooks/openai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(webhook.status, 200);
  assert.equal(rawBodies[0].toString('utf8'), body);
});

test('HTTP server rejects incorrect content type before webhook processing', async (t) => {
  let handled = false;
  const server = createHttpServer({
    config: makeConfig(),
    webhookHandler: { async handle() { handled = true; } },
    callGateway: { registry: { summary: () => ({ active: 0, tracked: 0, states: {} }) } },
    stateStore: { healthy: true, capacityAvailable: true },
    logger: silentLogger,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/webhooks/openai`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(response.status, 415);
  assert.equal(handled, false);
});

test('health fails closed while a durable call outcome is unknown', async (t) => {
  const server = createHttpServer({
    config: makeConfig(),
    webhookHandler: { async handle() { throw new Error('must not dispatch'); } },
    callGateway: {
      registry: {
        summary: () => ({ active: 1, tracked: 1, states: { outcome_unknown: 1 } }),
      },
    },
    stateStore: { healthy: true, capacityAvailable: true },
    logger: silentLogger,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.uncertainCalls, 1);
  assert.equal(body.activeCalls, 1);
});

test('health fails closed when the durable-state admission reserve is exhausted', async (t) => {
  const server = createHttpServer({
    config: makeConfig(),
    webhookHandler: { async handle() { throw new Error('must not dispatch'); } },
    callGateway: {
      registry: { summary: () => ({ active: 0, tracked: 4, states: { closed: 4 } }) },
    },
    stateStore: { healthy: true, capacityAvailable: false },
    logger: silentLogger,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${await listen(server)}/healthz`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).durableStateAdmission, 'exhausted');
});
