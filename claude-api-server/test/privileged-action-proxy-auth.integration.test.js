'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  hardenedWorkerTestEnvironment,
} = require('./fixtures/hardened-worker-test-env');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for controller startup.');
}

function waitForExit(child, timeoutMs = 12000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('controller-style proxy env uses a dedicated token and the fixed private socket', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-privileged-proxy-'));
  const port = await reservePort();
  const serverPath = path.join(__dirname, '..', 'server.js');
  const privilegedToken = 'privileged-controller-token-32-bytes-minimum';
  const agentToken = 'ordinary-agent-token-32-bytes-minimum';
  const executorToken = 'executor-controller-token-32-bytes-minimum';
  const voiceControlToken = 'voice-controller-token-32-bytes-minimum';
  const server = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ...hardenedWorkerTestEnvironment(),
      HOME: directory,
      PORT: String(port),
      AGENT_API_BIND_HOST: '127.0.0.1',
      AGENT_API_TOKEN: agentToken,
      EXECUTOR_API_TOKEN: executorToken,
      VOICE_CONTROL_TOKEN: voiceControlToken,
      PRIVILEGED_ACTION_API_TOKEN: privilegedToken,
      PRIVILEGED_ACTION_PROXY_ENABLED: 'true',
      PRIVILEGED_ACTION_PROXY_SOCKET_PATH: '/run/teleagent-privileged-action/broker.sock',
      PRIVILEGED_ACTION_SOCKET_PATH: '/wrong/legacy-name-must-be-ignored.sock',
      EXECUTOR_TASK_DB_PATH: path.join(directory, 'executor.sqlite'),
      VOICE_EXECUTION_LOCK_FILE: path.join(directory, 'voice-execution.lock.json'),
      VOICE_APPROVAL_KEY_ID: '',
      VOICE_APPROVAL_PUBLIC_KEY_FILE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (server.exitCode === null && !server.signalCode) server.kill('SIGTERM');
    await waitForExit(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${baseUrl}/health`)).ok;
    } catch {
      return false;
    }
  });
  const publicHealth = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(Object.hasOwn(publicHealth, 'privilegedActions'), false);
  const health = await (await fetch(`${baseUrl}/operator/health`, {
    headers: { Authorization: `Bearer ${voiceControlToken}` },
  })).json();
  assert.deepEqual(health.privilegedActions, {
    enabled: true,
    proxyConfigured: true,
    authConfigured: true,
  });

  for (const token of [agentToken, 'another-unrelated-token-32-bytes-minimum']) {
    const denied = await fetch(`${baseUrl}/privileged-actions/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(denied.status, 401, output);
    assert.equal((await denied.json()).code, 'PRIVILEGED_ACTION_UNAUTHORIZED');
  }

  const scoped = await fetch(`${baseUrl}/privileged-actions/health`, {
    headers: { Authorization: `Bearer ${privilegedToken}` },
  });
  assert.equal(scoped.status, 503, output);
  assert.equal((await scoped.json()).code, 'PRIVILEGED_BROKER_UNAVAILABLE');

  const panic = await fetch(`${baseUrl}/voice-control/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'cross_plane_test', source: 'loopback_test' }),
  });
  assert.equal(panic.status, 503, output);
  const panicBody = await panic.json();
  assert.equal(panicBody.success, false);
  assert.equal(panicBody.voiceExecution.locked, true);
  assert.equal(panicBody.privilegedActions.configured, true);
  assert.equal(panicBody.privilegedActions.accepted, false);
  assert.equal(panicBody.privilegedActions.quiesced, false);

  // The controller lock is checked before forwarding. If a POST had already
  // crossed this check, performVoicePanic's root-broker panic fences it at the
  // atomic root store boundary; later POSTs cannot reach that race at all.
  const lockedSubmit = await fetch(`${baseUrl}/privileged-actions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${privilegedToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'job_cross_plane_locked',
    },
    body: JSON.stringify({
      idempotencyKey: 'job_cross_plane_locked',
      jobId: 'job_cross_plane_locked',
    }),
  });
  assert.equal(lockedSubmit.status, 423, output);
  const lockedBody = await lockedSubmit.json();
  assert.equal(lockedBody.code, 'VOICE_EXECUTION_LOCKED');
  assert.equal(lockedBody.voiceExecution.locked, true);
  assert.equal(lockedBody.executor.locked, true);
});
