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
  agent: 'lifecycle-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  executor: 'lifecycle-executor-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  voice: 'lifecycle-voice-cccccccccccccccccccccccccccc',
  privileged: 'lifecycle-privileged-ddddddddddddddddddddddddd',
});

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

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for server lifecycle condition');
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

async function startServer(t, {
  fakeAgentSource = null,
  preRegistrationBarrier = false,
  environment = {},
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-server-lifecycle-'));
  const port = await reservePort();
  const dbPath = path.join(directory, 'state', 'executor.sqlite');
  const fakeAgentPath = path.join(directory, 'agent.js');
  const pidFile = path.join(directory, 'agent.pid');
  const barrierPath = path.join(directory, 'pre-registration');
  if (fakeAgentSource) fs.writeFileSync(fakeAgentPath, fakeAgentSource, { mode: 0o700 });

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
      AGENT_PROVIDERS: 'claude,codex',
      ...(fakeAgentSource ? {
        CLAUDE_COMMAND: fakeAgentPath,
        CODEX_COMMAND: fakeAgentPath,
        CLAUDE_WORKING_DIR: directory,
        CODEX_WORKING_DIR: directory,
        PHONE_CODEX_LUNA_WORKING_DIR: directory,
        LIFECYCLE_AGENT_PID_FILE: pidFile,
      } : {}),
      EXECUTOR_TASK_DB_PATH: dbPath,
      EXECUTOR_TASK_LEASE_MS: '1000',
      EXECUTOR_TASK_HEARTBEAT_MS: '250',
      EXECUTOR_TASK_POLL_MS: '20',
      VOICE_EXECUTION_LOCK_FILE: path.join(directory, 'voice.lock.json'),
      VOICE_APPROVAL_KEY_ID: '',
      VOICE_APPROVAL_PUBLIC_KEY_FILE: '',
      ...(preRegistrationBarrier ? {
        NODE_ENV: 'test',
        TELEAGENT_TEST_PRE_REGISTRATION_BARRIER: barrierPath,
      } : {}),
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    await waitForExit(child);
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10), 'SIGKILL');
      } catch {
        // Graceful dispatcher drain should already have stopped the fixture.
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`Lifecycle server exited during startup:\n${output}`);
    }
    try {
      return (await fetch(`${baseUrl}/health`)).ok;
    } catch {
      return false;
    }
  });
  return { baseUrl, child, dbPath, pidFile, barrierPath, output: () => output };
}

function post(baseUrl, route, token, body = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('voice unlock refuses until durable panic is actually quiesced', async (t) => {
  const server = await startServer(t);
  const fixtureStore = new ExecutorTaskStore({ dbPath: server.dbPath, defaultLeaseMs: 60000 });
  t.after(() => fixtureStore.close());

  const workerId = 'external-quiescence-fixture';
  const createAndClaim = fixtureStore.db.transaction(() => {
    const submitted = fixtureStore.submitTask({
      idempotencyKey: 'lifecycle_quiescence_fixture',
      taskType: 'managed_ask',
      callId: 'lifecycle-quiescence-call',
      voiceOrigin: true,
      request: { prompt: 'Hold this task for the quiescence fixture.' },
      actor: 'integration_test',
    });
    return {
      submitted,
      claim: fixtureStore.claimNext({ workerId, leaseMs: 60000 }),
    };
  });
  const fixture = createAndClaim.immediate();
  assert.equal(fixture.claim.task.id, fixture.submitted.task.id);

  const panic = await post(server.baseUrl, '/executor/panic', TOKENS.executor, {
    reason: 'lifecycle_quiescence_test',
    source: 'integration_test',
  });
  assert.equal(panic.status, 200, server.output());
  const panicBody = await panic.json();
  assert.equal(panicBody.executorTasks.accepted, true);
  assert.equal(panicBody.executorTasks.persisted, true);
  assert.equal(panicBody.executorTasks.quiesced, false);
  assert.deepEqual(panicBody.executorTasks.activeTaskIds, [fixture.submitted.task.id]);

  const notYetStopped = await fetch(
    `${server.baseUrl}/voice-control/stop?response=plain&source=asterisk_1001`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'lifecycle_quiescence_reassertion' }),
    }
  );
  assert.equal(notYetStopped.status, 503);
  assert.equal(await notYetStopped.text(), 'PARTIAL');

  const refused = await post(server.baseUrl, '/executor/panic/unlock', TOKENS.voice, {
    source: 'integration_test',
  });
  assert.equal(refused.status, 409);
  const refusedBody = await refused.json();
  assert.equal(refusedBody.code, 'VOICE_EXECUTION_NOT_QUIESCED');
  assert.equal(refusedBody.voiceExecution.locked, true);
  assert.equal(refusedBody.executor.panic.locked, true);
  assert.deepEqual(refusedBody.executor.panic.activeTaskIds, [fixture.submitted.task.id]);

  fixtureStore.acknowledgeCanceled({
    taskId: fixture.submitted.task.id,
    leaseToken: fixture.claim.leaseToken,
    workerId,
    result: { reason: 'quiescence_fixture_acknowledged' },
  });
  const fullyStopped = await fetch(
    `${server.baseUrl}/voice-control/stop?response=plain&source=asterisk_1001`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'lifecycle_quiescence_confirmed' }),
    }
  );
  assert.equal(fullyStopped.status, 200);
  assert.equal(await fullyStopped.text(), 'STOPPED');
  const unlocked = await post(server.baseUrl, '/executor/panic/unlock', TOKENS.voice, {
    source: 'integration_test',
  });
  assert.equal(unlocked.status, 200);
  const unlockedBody = await unlocked.json();
  assert.equal(unlockedBody.success, true);
  assert.equal(unlockedBody.voiceExecution.locked, false);
  assert.equal(unlockedBody.executor.panic.locked, false);
});

test('SIGTERM awaits dispatcher drain before closing the executor database', async (t) => {
  const fakeAgentSource = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.LIFECYCLE_AGENT_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
});
`;
  const server = await startServer(t, { fakeAgentSource });
  const submitted = await post(server.baseUrl, '/executor/tasks', TOKENS.executor, {
    idempotencyKey: 'lifecycle_shutdown_fixture',
    taskType: 'managed_ask',
    request: {
      prompt: 'Inspect the shutdown drain fixture.',
      sessionType: 'phone-codex-luna',
      callId: 'lifecycle-shutdown-call',
    },
  });
  assert.equal(submitted.status, 202, server.output());
  const taskId = (await submitted.json()).task.id;
  await waitFor(() => fs.existsSync(server.pidFile));
  const agentPid = Number.parseInt(fs.readFileSync(server.pidFile, 'utf8'), 10);
  await waitFor(async () => {
    const response = await fetch(`${server.baseUrl}/executor/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${TOKENS.executor}` },
    });
    const body = await response.json();
    return body.task?.state === 'running' && body.task?.execution?.pid === agentPid;
  });

  server.child.kill('SIGTERM');
  await waitForExit(server.child);
  assert.equal(server.child.exitCode, 0, server.output());

  const reopened = new ExecutorTaskStore({ dbPath: server.dbPath });
  t.after(() => reopened.close());
  const task = reopened.getTask(taskId);
  assert.equal(task.terminal, true);
  assert.equal(task.state, 'failed');
  assert.equal(task.errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(task.workerId, null);
  assert.equal(task.leaseExpiresAt, null);
  await waitFor(() => {
    try {
      process.kill(agentPid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  });
});

test('SIGTERM terminates and reaps a synchronous non-phone agent child', async (t) => {
  const fakeAgentSource = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.LIFECYCLE_AGENT_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
});
`;
  const server = await startServer(t, { fakeAgentSource });
  const pendingRequest = post(server.baseUrl, '/ask', TOKENS.agent, {
    prompt: 'Summarize the synchronous lifecycle fixture.',
    callId: 'legacy-shutdown-call',
    sessionType: 'default',
  }).catch(() => null);

  await waitFor(() => fs.existsSync(server.pidFile));
  const agentPid = Number.parseInt(fs.readFileSync(server.pidFile, 'utf8'), 10);
  process.kill(agentPid, 0);

  server.child.kill('SIGTERM');
  await waitForExit(server.child);
  await pendingRequest;
  assert.equal(server.child.exitCode, 0, server.output());
  await waitFor(() => {
    try {
      process.kill(agentPid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  });
  assert.match(server.output(), /Agent request drain complete: requested=1 forced=1/);
});

test('a request already past middleware cannot spawn after shutdown begins', async (t) => {
  const fakeAgentSource = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.env.LIFECYCLE_AGENT_PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
`;
  const server = await startServer(t, {
    fakeAgentSource,
    preRegistrationBarrier: true,
  });
  const pendingRequest = post(server.baseUrl, '/ask', TOKENS.agent, {
    prompt: 'Summarize the late-registration lifecycle fixture.',
    callId: 'late-registration-call',
    sessionType: 'default',
  });

  await waitFor(() => fs.existsSync(`${server.barrierPath}.waiting`));
  server.child.kill('SIGTERM');
  await waitFor(() => server.output().includes('shutting down gracefully'));
  fs.writeFileSync(`${server.barrierPath}.release`, 'release\n', { mode: 0o600 });

  const response = await pendingRequest;
  assert.equal(response.status, 503, server.output());
  assert.equal((await response.json()).code, 'CONTROLLER_SHUTTING_DOWN');
  await waitForExit(server.child);
  assert.equal(server.child.exitCode, 0, server.output());
  assert.equal(fs.existsSync(server.pidFile), false, 'late request spawned an agent child');
});
