'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const TOKENS = Object.freeze({
  agent: 'worker-boundary-agent-aaaaaaaaaaaaaaaaaaaaaaaa',
  executor: 'worker-boundary-executor-bbbbbbbbbbbbbbbbbbbb',
  voice: 'worker-boundary-voice-cccccccccccccccccccccc',
  privileged: 'worker-boundary-privileged-ddddddddddddddddddd',
});

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`Controller exited unexpectedly:\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 503) return;
    } catch {
      // Listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Controller did not begin serving diagnostics:\n${output()}`);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

test('controller serves diagnostics but cannot launch or submit without the hardened worker', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-worker-required-'));
  const port = await reservePort();
  const sentinel = path.join(directory, 'provider-ran');
  const fakeAgent = path.join(directory, 'fake-agent.js');
  fs.writeFileSync(fakeAgent, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe');\n`, {
    mode: 0o700,
  });
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      HOME: directory,
      PORT: String(port),
      AGENT_API_BIND_HOST: '127.0.0.1',
      AGENT_API_TOKEN: TOKENS.agent,
      EXECUTOR_API_TOKEN: TOKENS.executor,
      VOICE_CONTROL_TOKEN: TOKENS.voice,
      PRIVILEGED_ACTION_API_TOKEN: TOKENS.privileged,
      PRIVILEGED_ACTION_PROXY_ENABLED: 'true',
      PRIVILEGED_ACTION_PROXY_SOCKET_PATH: '/run/teleagent-privileged-action/broker.sock',
      CLAUDE_COMMAND: fakeAgent,
      CODEX_COMMAND: fakeAgent,
      CLAUDE_WORKING_DIR: directory,
      CODEX_WORKING_DIR: directory,
      EXECUTOR_TASK_DB_PATH: path.join(directory, 'executor.sqlite'),
      VOICE_EXECUTION_LOCK_FILE: path.join(directory, 'voice.lock.json'),
      VOICE_APPROVAL_KEY_ID: '',
      VOICE_APPROVAL_PUBLIC_KEY_FILE: '',
      AGENT_WORKER_USER: '',
      AGENT_CLAUDE_WORKER_USER: '',
      AGENT_CODEX_WORKER_USER: '',
      AGENT_WORKER_LEGACY_SAME_UID_ENABLED: 'false',
      WORKER_SESSION_BROKER_ENABLED: 'false',
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
  await waitForServer(baseUrl, child, () => output);
  const health = await (await fetch(`${baseUrl}/operator/health`, {
    headers: { Authorization: `Bearer ${TOKENS.voice}` },
  })).json();
  assert.equal(health.ready, false);
  assert.equal(health.agentWorker.enabled, false);
  assert.equal(health.workerSessionBroker.ready, false);
  assert.equal(health.workerSessionBroker.code, 'AGENT_PROVIDER_WORKERS_REQUIRED');

  for (const request of [
    { route: '/ask', token: TOKENS.agent, body: { prompt: 'Explain the controller architecture.' } },
    {
      route: '/ask', token: TOKENS.agent,
      body: { prompt: 'Inspect the workspace.', sessionType: 'phone-codex-luna' },
    },
    {
      route: '/executor/tasks', token: TOKENS.executor,
      body: {
        idempotencyKey: 'job_workerrequired1',
        taskType: 'managed_ask',
        request: {
          prompt: 'Inspect the workspace.',
          sessionType: 'phone-codex-luna',
          callId: 'job_workerrequired1',
        },
      },
    },
    {
      route: '/privileged-actions', token: TOKENS.privileged,
      headers: { 'Idempotency-Key': 'job_workerrequired2' },
      body: { idempotencyKey: 'job_workerrequired2', jobId: 'job_workerrequired2' },
    },
  ]) {
    const response = await fetch(`${baseUrl}${request.route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.token}`,
        'Content-Type': 'application/json',
        ...(request.headers || {}),
      },
      body: JSON.stringify(request.body),
    });
    assert.equal(response.status, 503, `${request.route}: ${output}`);
    assert.equal((await response.json()).code, 'AGENT_PROVIDER_WORKERS_REQUIRED');
  }
  assert.equal(fs.existsSync(sentinel), false);
});
