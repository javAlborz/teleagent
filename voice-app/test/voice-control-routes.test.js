'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const {
  createVoiceControlRouter,
  isLoopbackAddress,
} = require('../lib/voice-control-routes');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('loopback address detection accepts only local socket forms', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('100.122.162.71'), false);
  assert.equal(isLoopbackAddress('77.42.23.239'), false);
});

test('Asterisk receives a plain stop result while unlock remains authenticated', async (t) => {
  const previousToken = process.env.VOICE_CONTROL_TOKEN;
  process.env.VOICE_CONTROL_TOKEN = 'voice-control-test-token';
  t.after(() => {
    if (previousToken === undefined) delete process.env.VOICE_CONTROL_TOKEN;
    else process.env.VOICE_CONTROL_TOKEN = previousToken;
  });

  const calls = [];
  const jobBroker = {
    async panicStop(reason, source) {
      calls.push({ type: 'stop', reason, source });
      return {
        locked: true,
        persistent: true,
        canceledCount: 3,
        runningCount: 2,
        bridge: { success: true },
      };
    },
    getExecutionLock() {
      return { locked: true, reason: 'voice_panic_stop', persistent: true };
    },
    unlockExecution(source) {
      calls.push({ type: 'local-unlock', source });
      return { locked: false, wasLocked: true };
    },
  };
  const agentBridge = {
    async unlockVoiceExecution(source) {
      calls.push({ type: 'bridge-unlock', source });
      return { success: true, voiceExecution: { locked: false } };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createVoiceControlRouter({ jobBroker, agentBridge }));
  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/voice-control`;

  const stop = await fetch(`${baseUrl}/stop?response=plain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'source=asterisk_1001',
  });
  assert.equal(stop.status, 200);
  assert.equal(await stop.text(), 'STOPPED');
  assert.deepEqual(calls[0], {
    type: 'stop',
    reason: 'voice_panic_stop',
    source: 'asterisk_1001',
  });

  const unauthorized = await fetch(`${baseUrl}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);

  const unlocked = await fetch(`${baseUrl}/unlock`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer voice-control-test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source: 'operator_test' }),
  });
  assert.equal(unlocked.status, 200);
  assert.equal((await unlocked.json()).success, true);
  assert.deepEqual(calls.slice(1), [
    { type: 'bridge-unlock', source: 'operator_test' },
    { type: 'local-unlock', source: 'operator_test' },
  ]);
});
