'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
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

async function assertExecutorFailsClosed(t, executorToken) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-executor-auth-'));
  const port = await reservePort();
  const serverPath = path.join(__dirname, '..', 'server.js');
  const server = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      HOME: directory,
      PORT: String(port),
      AGENT_API_BIND_HOST: '127.0.0.1',
      AGENT_API_TOKEN: 'agent-auth-token-aaaaaaaaaaaaaaaaaaaaaaaa',
      EXECUTOR_API_TOKEN: executorToken,
      VOICE_CONTROL_TOKEN: 'voice-auth-token-bbbbbbbbbbbbbbbbbbbbbbbb',
      PRIVILEGED_ACTION_API_TOKEN: 'privileged-auth-token-cccccccccccccccccccc',
      CLAUDE_API_TOKEN: 'legacy-token-must-not-authorize-executor',
      EXECUTOR_TASK_DB_PATH: path.join(directory, 'executor.sqlite'),
      VOICE_EXECUTION_LOCK_FILE: path.join(directory, 'voice-execution.lock.json'),
      VOICE_APPROVAL_KEY_ID: '',
      VOICE_APPROVAL_PUBLIC_KEY_FILE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  t.after(async () => {
    if (server.exitCode === null && !server.signalCode) server.kill('SIGTERM');
    await waitForExit(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      const response = await fetch(`${baseUrl}/health`);
      return response.status === 200 || response.status === 503;
    } catch {
      return false;
    }
  });

  for (const headers of [
    { Authorization: 'Bearer legacy-token-must-not-authorize-executor' },
    {},
  ]) {
    const response = await fetch(`${baseUrl}/executor/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'executor-auth-test',
        taskType: 'managed_ask',
        request: { prompt: 'Inspect status', sessionType: 'phone-codex-luna' },
      }),
    });
    assert.equal(response.status, 503, output);
    assert.equal((await response.json()).code, 'EXECUTOR_AUTH_NOT_CONFIGURED');
  }
}

test('executor routes fail closed without the dedicated EXECUTOR_API_TOKEN', async t => {
  await assertExecutorFailsClosed(t, '');
});

test('executor routes fail closed with a structurally invalid EXECUTOR_API_TOKEN', async t => {
  await assertExecutorFailsClosed(t, 'short-token');
});
