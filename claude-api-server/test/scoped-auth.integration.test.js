'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { ExecutorTaskStore } = require('../executor-task-store');
const {
  hardenedWorkerTestEnvironment,
} = require('./fixtures/hardened-worker-test-env');

const TOKENS = Object.freeze({
  agent: 'agent-scope-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  executor: 'executor-scope-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  voice: 'voice-scope-cccccccccccccccccccccccccccccccc',
  privileged: 'privileged-scope-dddddddddddddddddddddddddddddddd',
  legacy: 'legacy-scope-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
});
const PLACEHOLDER_TOKEN = 'replace-with-distinct-random-token-at-least-32-bytes';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for scoped-auth server');
}

function waitForExit(child, timeoutMs = 8000) {
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

async function startServer(t, tokenOverrides = {}, prepareStore = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-scoped-auth-'));
  const dbPath = path.join(directory, 'executor.sqlite');
  const prepared = prepareStore ? prepareStore(dbPath) : null;
  const port = await reservePort();
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ...hardenedWorkerTestEnvironment(),
      HOME: directory,
      PORT: String(port),
      AGENT_API_BIND_HOST: '127.0.0.1',
      AGENT_API_TOKEN: TOKENS.agent,
      EXECUTOR_API_TOKEN: TOKENS.executor,
      VOICE_CONTROL_TOKEN: TOKENS.voice,
      PRIVILEGED_ACTION_API_TOKEN: TOKENS.privileged,
      CLAUDE_API_TOKEN: TOKENS.legacy,
      PRIVILEGED_ACTION_PROXY_ENABLED: 'true',
      PRIVILEGED_ACTION_PROXY_SOCKET_PATH: '/run/teleagent-privileged-action/broker.sock',
      EXECUTOR_TASK_DB_PATH: dbPath,
      VOICE_EXECUTION_LOCK_FILE: path.join(directory, 'voice.lock.json'),
      VOICE_APPROVAL_KEY_ID: '',
      VOICE_APPROVAL_PUBLIC_KEY_FILE: '',
      ...tokenOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    await waitForExit(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`Scoped-auth server exited during startup:\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      return response.status === 200 || response.status === 503;
    } catch {
      return false;
    }
  });
  return { baseUrl, output: () => output, prepared };
}

async function assertStartupFails(t, environmentOverrides, expectedError) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-scoped-startup-'));
  const port = await reservePort();
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ...hardenedWorkerTestEnvironment(),
      HOME: directory,
      PORT: String(port),
      AGENT_API_BIND_HOST: '127.0.0.1',
      AGENT_API_TOKEN: TOKENS.agent,
      EXECUTOR_API_TOKEN: TOKENS.executor,
      VOICE_CONTROL_TOKEN: TOKENS.voice,
      PRIVILEGED_ACTION_API_TOKEN: TOKENS.privileged,
      PRIVILEGED_ACTION_PROXY_ENABLED: 'true',
      PRIVILEGED_ACTION_PROXY_SOCKET_PATH: '/run/teleagent-privileged-action/broker.sock',
      EXECUTOR_TASK_DB_PATH: path.join(directory, 'executor.sqlite'),
      VOICE_EXECUTION_LOCK_FILE: path.join(directory, 'voice.lock.json'),
      VOICE_APPROVAL_KEY_ID: '',
      VOICE_APPROVAL_PUBLIC_KEY_FILE: '',
      ...environmentOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    await waitForExit(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForExit(child);
  assert.notEqual(child.exitCode, 0, output);
  assert.match(output, expectedError);
}

function headers(token = null) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
  };
}

const SCOPES = Object.freeze([
  {
    name: 'agent',
    token: TOKENS.agent,
    method: 'POST',
    path: '/end-session',
    body: { callId: 'scope-test-call' },
    missingCode: 'AGENT_AUTH_NOT_CONFIGURED',
    unauthorizedCode: 'AGENT_UNAUTHORIZED',
  },
  {
    name: 'executor',
    token: TOKENS.executor,
    method: 'GET',
    path: '/executor/tasks',
    missingCode: 'EXECUTOR_AUTH_NOT_CONFIGURED',
    unauthorizedCode: 'EXECUTOR_UNAUTHORIZED',
  },
  {
    name: 'voice',
    token: TOKENS.voice,
    method: 'GET',
    path: '/voice-control/status',
    missingCode: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
    unauthorizedCode: 'VOICE_CONTROL_UNAUTHORIZED',
  },
  {
    name: 'voice session lifecycle',
    token: TOKENS.voice,
    method: 'POST',
    path: '/voice-control/session/cancel',
    body: {
      callId: 'job_ScopedVoiceCancel1',
      sessionKey: 'voice-thread-scope',
      idempotencyKey: 'job_ScopedVoiceCancel1',
      reason: 'scoped_auth_test',
    },
    missingCode: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
    unauthorizedCode: 'VOICE_CONTROL_UNAUTHORIZED',
  },
  {
    name: 'executor unlock compatibility route',
    token: TOKENS.voice,
    method: 'POST',
    path: '/executor/panic/unlock',
    body: { source: 'scoped_auth_test' },
    missingCode: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
    unauthorizedCode: 'VOICE_CONTROL_UNAUTHORIZED',
  },
  {
    name: 'operator',
    token: TOKENS.voice,
    method: 'POST',
    path: '/operator/session-message/prepare',
    body: { target: 'invalid-target-after-auth' },
    missingCode: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
    unauthorizedCode: 'VOICE_CONTROL_UNAUTHORIZED',
  },
  {
    name: 'privileged',
    token: TOKENS.privileged,
    method: 'GET',
    path: '/privileged-actions/missing-action',
    missingCode: 'PRIVILEGED_ACTION_AUTH_NOT_CONFIGURED',
    unauthorizedCode: 'PRIVILEGED_ACTION_UNAUTHORIZED',
  },
]);

async function request(baseUrl, scope, token) {
  return fetch(`${baseUrl}${scope.path}`, {
    method: scope.method,
    headers: headers(token),
    ...(scope.body ? { body: JSON.stringify(scope.body) } : {}),
  });
}

test('HTTP task cancellation stays on the exact turn and rejects widening input before effects', async (t) => {
  const server = await startServer(t, {}, (dbPath) => {
    const store = new ExecutorTaskStore({ dbPath, defaultLeaseMs: 60000 });
    try {
      const previous = store.submitTask({
        idempotencyKey: 'previous-turn', callId: 'fixture-call', request: { prompt: 'previous' },
      }).task;
      const firstClaim = store.claimNext({ workerId: 'fixture-only' });
      store.completeTask({
        taskId: previous.id, workerId: 'fixture-only', leaseToken: firstClaim.leaseToken,
        result: { success: true },
      });
      const next = store.submitTask({
        idempotencyKey: 'next-turn', callId: 'fixture-call', request: { prompt: 'next' },
      }).task;
      // A live fixture-owned lease prevents server dispatch. No provider is
      // ever launched and there is no actual process associated with this row.
      store.claimNext({ workerId: 'fixture-only' });
      return { previous, next };
    } finally { store.close(); }
  });
  const readTask = async (id) => {
    const response = await fetch(`${server.baseUrl}/executor/tasks/${id}`, { headers: headers(TOKENS.executor) });
    assert.equal(response.status, 200);
    return (await response.json()).task;
  };
  const cancel = (body) => fetch(`${server.baseUrl}/voice-control/session/cancel`, {
    method: 'POST', headers: headers(TOKENS.voice), body: JSON.stringify(body),
  });
  assert.equal((await readTask(server.prepared.next.id)).state, 'running');
  for (const input of [
    { scope: 'task' },
    { scope: 'task', idempotencyKey: '' },
    { scope: 'task', idempotencyKey: ' next-turn' },
    { scope: 'task', idempotencyKey: 'next-turn', resetSession: true },
    { scope: 'task', idempotencyKey: 'next-turn', resetSession: 'false' },
    { scope: 'everything', idempotencyKey: 'next-turn' },
  ]) {
    const response = await cancel({ callId: 'fixture-call', ...input });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_CANCELLATION_SCOPE');
    assert.equal((await readTask(server.prepared.next.id)).state, 'running');
  }
  const stale = await cancel({
    callId: 'fixture-call', idempotencyKey: 'previous-turn', scope: 'task',
  });
  assert.equal(stale.status, 200);
  const staleResult = await stale.json();
  assert.equal(staleResult.scope, 'task');
  assert.deepEqual(staleResult.executorTasks.taskIds, []);
  assert.deepEqual(staleResult.requestIds, []);
  assert.equal((await readTask(server.prepared.previous.id)).state, 'completed');
  assert.equal((await readTask(server.prepared.next.id)).state, 'running');
  const exact = await cancel({ callId: 'fixture-call', idempotencyKey: 'next-turn', scope: 'task' });
  assert.equal(exact.status, 200);
  assert.deepEqual((await exact.json()).executorTasks.taskIds, [server.prepared.next.id]);
  assert.equal((await readTask(server.prepared.next.id)).state, 'cancel_requested');
});

test('each private route family accepts only its dedicated bearer', async (t) => {
  const server = await startServer(t);
  const allTokens = [
    TOKENS.agent,
    TOKENS.executor,
    TOKENS.voice,
    TOKENS.privileged,
    TOKENS.legacy,
    PLACEHOLDER_TOKEN,
  ];

  assert.equal((await fetch(`${server.baseUrl}/`)).status, 200);
  assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);

  for (const scope of SCOPES) {
    for (const wrongToken of allTokens.filter((token) => token !== scope.token)) {
      const response = await request(server.baseUrl, scope, wrongToken);
      assert.equal(response.status, 401, `${scope.name} accepted a cross-scope token`);
      assert.equal((await response.json()).code, scope.unauthorizedCode);
    }
    const missing = await request(server.baseUrl, scope, null);
    assert.equal(missing.status, 401, `${scope.name} accepted no bearer`);
    assert.equal((await missing.json()).code, scope.unauthorizedCode);

    const legacyHeader = await fetch(`${server.baseUrl}${scope.path}`, {
      method: scope.method,
      headers: {
        'X-API-Key': scope.token,
        'Content-Type': 'application/json',
      },
      ...(scope.body ? { body: JSON.stringify(scope.body) } : {}),
    });
    assert.equal(legacyHeader.status, 401, `${scope.name} accepted X-API-Key compatibility auth`);
    assert.equal((await legacyHeader.json()).code, scope.unauthorizedCode);

    const authorized = await request(server.baseUrl, scope, scope.token);
    assert.notEqual(authorized.status, 401, `${scope.name} rejected its own bearer`);
    if (authorized.status === 503) {
      const payload = await authorized.json();
      assert.notEqual(
        payload.code,
        scope.missingCode,
        `${scope.name} treated its own bearer as unconfigured`,
      );
    }
  }

  const emergency = await fetch(`${server.baseUrl}/voice-control/stop`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ source: 'loopback_auth_test', reason: 'test_stop' }),
  });
  // This fixture intentionally has no root broker listening. The controller
  // still persists both local locks, but must return PARTIAL/503 instead of
  // claiming the privileged plane is quiescent.
  assert.equal(emergency.status, 503, server.output());
  const emergencyBody = await emergency.json();
  assert.equal(emergencyBody.success, false);
  assert.equal(emergencyBody.voiceExecution.locked, true);
  assert.equal(emergencyBody.executorTasks.persisted, true);
  assert.equal(emergencyBody.privilegedActions.configured, true);
  assert.equal(emergencyBody.privilegedActions.quiesced, false);
});

for (const [label, invalidToken] of [
  ['missing', ''],
  ['malformed', 'short'],
  ['a committed placeholder', PLACEHOLDER_TOKEN],
]) {
  test(`agent, executor, and voice routes fail closed when their bearer is ${label}`, async (t) => {
    const server = await startServer(t, {
      AGENT_API_TOKEN: invalidToken,
      EXECUTOR_API_TOKEN: invalidToken,
      VOICE_CONTROL_TOKEN: invalidToken,
    });

    for (const scope of SCOPES.filter((entry) => entry.name !== 'privileged')) {
      const response = await request(server.baseUrl, scope, scope.token);
      assert.equal(response.status, 503, `${scope.name} did not fail closed`);
      assert.equal((await response.json()).code, scope.missingCode);
    }
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 503);
    const healthBody = await health.json();
    assert.equal(healthBody.ready, false);
    assert.equal(Object.hasOwn(healthBody, 'authentication'), false);
  });

  test(`enabled privileged proxy refuses startup when its bearer is ${label}`, async (t) => {
    await assertStartupFails(
      t,
      { PRIVILEGED_ACTION_API_TOKEN: invalidToken },
      /requires PRIVILEGED_ACTION_API_TOKEN/
    );
  });
}

test('disabled privileged proxy does not require or report a privileged bearer', async (t) => {
  const server = await startServer(t, {
    PRIVILEGED_ACTION_API_TOKEN: '',
    PRIVILEGED_ACTION_PROXY_ENABLED: 'false',
    PRIVILEGED_ACTION_PROXY_SOCKET_PATH: '',
  });
  assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200, server.output());
  const response = await fetch(`${server.baseUrl}/operator/health`, {
    headers: { Authorization: `Bearer ${TOKENS.voice}` },
  });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.authentication.privilegedActionConfigured, false);
  assert.equal(health.authentication.privilegedActionRequired, false);
  assert.equal(health.authentication.allActiveScopesConfiguredAndDistinct, true);
  assert.deepEqual(health.phoneAuthority, {
    mode: 'read_only',
    status: 'disabled_pending_independent_pbx_attester',
  });
  assert.deepEqual(health.privilegedActions, {
    enabled: false,
    proxyConfigured: false,
    authConfigured: false,
  });
  const executorHealthResponse = await fetch(`${server.baseUrl}/executor/health`, {
    headers: { Authorization: `Bearer ${TOKENS.executor}` },
  });
  assert.equal(executorHealthResponse.status, 200);
  assert.deepEqual(await executorHealthResponse.json(), {
    ready: true,
    service: 'claude-api-server',
    scope: 'executor',
    status: 'ready',
  });
  const wrongScope = await fetch(`${server.baseUrl}/executor/health`, {
    headers: { Authorization: `Bearer ${TOKENS.voice}` },
  });
  assert.equal(wrongScope.status, 401);
  assert.match(server.output(), /Privileged action proxy auth: not required \(proxy disabled\)/u);
});

test('server refuses startup when scoped capabilities reuse one token', async (t) => {
  await assertStartupFails(
    t,
    { EXECUTOR_API_TOKEN: TOKENS.agent },
    /Scoped API tokens must be pairwise distinct: AGENT_API_TOKEN and EXECUTOR_API_TOKEN/
  );
});

test('server defaults to a loopback bind when no bind host is configured', async (t) => {
  const server = await startServer(t, {
    AGENT_API_BIND_HOST: '',
    CLAUDE_API_BIND_HOST: '',
    AGENT_API_NON_LOOPBACK_ENABLED: '',
  });
  await waitFor(() => server.output().includes('Listening on: http://127.0.0.1:'));
  assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
});

test('server refuses a non-loopback bind without the explicit opt-in', async (t) => {
  await assertStartupFails(
    t,
    {
      AGENT_API_BIND_HOST: '0.0.0.0',
      AGENT_API_NON_LOOPBACK_ENABLED: '',
    },
    /Non-loopback agent API binding requires AGENT_API_NON_LOOPBACK_ENABLED=true/
  );
});

test('reviewed split-host deployments can explicitly opt into a non-loopback bind', async (t) => {
  const server = await startServer(t, {
    AGENT_API_BIND_HOST: '0.0.0.0',
    AGENT_API_NON_LOOPBACK_ENABLED: 'true',
  });
  assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
});
