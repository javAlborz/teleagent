'use strict';
const { installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {
  createVoiceControlRouter,
  isLoopbackAddress,
  loadVoiceControlAuthConfig,
  normalizeVoiceControlToken,
  requireLoopback,
} = require('../lib/voice-control-routes');

const VOICE_TOKEN = 'voice-control-test-token-0123456789abcdef';

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

test('loopback middleware rejects remote health requests before the handler', () => {
  let nextCalled = false;
  let statusCode = null;
  let payload = null;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  requireLoopback(
    { socket: { remoteAddress: '10.0.0.42' } },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.deepEqual(payload, { success: false, error: 'loopback_required' });
});

test('Asterisk receives a plain stop result while unlock remains authenticated', async (t) => {
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
  app.use('/api', createVoiceControlRouter({
    jobBroker,
    agentBridge,
    voiceControlAuth: { apiToken: VOICE_TOKEN },
  }));
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

  const legacyHeader = await fetch(`${baseUrl}/unlock`, {
    method: 'POST',
    headers: {
      'X-API-Key': VOICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(legacyHeader.status, 401);

  const statusWithoutBearer = await fetch(`${baseUrl}/status`);
  assert.equal(statusWithoutBearer.status, 401);
  const status = await fetch(`${baseUrl}/status`, {
    headers: { Authorization: `Bearer ${VOICE_TOKEN}` },
  });
  assert.equal(status.status, 200);

  const unlocked = await fetch(`${baseUrl}/unlock`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VOICE_TOKEN}`,
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

test('unlock never falls back to outbound, agent, or legacy bearer tokens', async (t) => {
  const original = {
    VOICE_CONTROL_TOKEN: process.env.VOICE_CONTROL_TOKEN,
    OUTBOUND_API_TOKEN: process.env.OUTBOUND_API_TOKEN,
    AGENT_API_TOKEN: process.env.AGENT_API_TOKEN,
    CLAUDE_API_TOKEN: process.env.CLAUDE_API_TOKEN,
  };
  process.env.VOICE_CONTROL_TOKEN = VOICE_TOKEN;
  process.env.OUTBOUND_API_TOKEN = 'outbound-fallback-token-0123456789abcdef';
  process.env.AGENT_API_TOKEN = 'agent-fallback-token-0123456789abcdef0123';
  process.env.CLAUDE_API_TOKEN = 'legacy-fallback-token-0123456789abcdef01';
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/api', createVoiceControlRouter({
    jobBroker: {},
    agentBridge: {},
    voiceControlAuth: { apiToken: VOICE_TOKEN },
  }));
  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();
  for (const token of [
    process.env.OUTBOUND_API_TOKEN,
    process.env.AGENT_API_TOKEN,
    process.env.CLAUDE_API_TOKEN,
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/voice-control/unlock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'unauthorized');
  }
});

test('voice-control token validation fails startup for weak, placeholder, or reused values', () => {
  for (const token of [
    '',
    'x',
    'replace-with-distinct-random-token-at-least-32-bytes',
    `valid-prefix-${'a'.repeat(24)}\n`,
    `contains whitespace ${'a'.repeat(32)}`,
  ]) {
    assert.equal(normalizeVoiceControlToken(token), '');
    assert.throws(
      () => loadVoiceControlAuthConfig({
        env: { VOICE_CONTROL_TOKEN: token, HTTP_HOST: '0.0.0.0' },
      }),
      /VOICE_CONTROL_TOKEN/
    );
  }

  for (const reusedName of [
    'AGENT_API_TOKEN',
    'CLAUDE_API_TOKEN',
    'EXECUTOR_API_TOKEN',
    'OUTBOUND_API_TOKEN',
  ]) {
    assert.throws(
      () => loadVoiceControlAuthConfig({
        env: {
          VOICE_CONTROL_TOKEN: VOICE_TOKEN,
          [reusedName]: VOICE_TOKEN,
        },
      }),
      new RegExp(reusedName)
    );
  }
  assert.equal(loadVoiceControlAuthConfig({
    env: {
      VOICE_CONTROL_TOKEN: VOICE_TOKEN,
      EXECUTOR_API_TOKEN: 'executor-distinct-token-0123456789abcdef',
      OUTBOUND_API_TOKEN: 'outbound-distinct-token-0123456789abcdef',
    },
  }).apiToken, VOICE_TOKEN);
});

test('voice-control validation runs before the voice process opens SIP', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const validation = source.indexOf('config.voice_control_auth = loadVoiceControlAuthConfig({');
  const processFence = source.indexOf('outboundRuntimeFence = new OutboundRuntimeFence');
  const sipConnect = source.indexOf('srf.connect({');
  assert.ok(validation > 0);
  assert.ok(processFence > validation);
  assert.ok(sipConnect > processFence);
});

test('unlock refuses an outbound recovery barrier before contacting the controller', async (t) => {
  let bridgeCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', createVoiceControlRouter({
    jobBroker: {
      getUnlockReadiness() {
        return {
          ready: false,
          error: 'outbound_recovery_required',
          outbound: {
            quiesced: false,
            recoveryRequired: true,
            recoveryCallIds: ['ambiguous-call-id'],
          },
        };
      },
    },
    agentBridge: {
      async unlockVoiceExecution() {
        bridgeCalls += 1;
        return { success: true, voiceExecution: { locked: false } };
      },
    },
    voiceControlAuth: { apiToken: VOICE_TOKEN },
  }));
  const server = await listen(app);
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/voice-control/unlock`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VOICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'operator_test' }),
    }
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'outbound_recovery_required');
  assert.deepEqual(body.local.outbound.recoveryCallIds, ['ambiguous-call-id']);
  assert.equal(bridgeCalls, 0);
});
