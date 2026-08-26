'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const {
  hardenedWorkerTestEnvironment,
} = require('./fixtures/hardened-worker-test-env');

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

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for bridge restart condition');
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

test('production dispatcher adopts a live managed ask after bridge restart without duplicate execution', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('verified process start-time reconciliation currently requires Linux /proc');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-executor-restart-'));
  const fakeAgent = path.join(directory, 'long-agent.js');
  const childPidFile = path.join(directory, 'agent-pids.log');
  const dbPath = path.join(directory, 'state', 'executor.sqlite');
  const lockPath = path.join(directory, 'state', 'voice.lock.json');
  fs.writeFileSync(fakeAgent, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.RESTART_AGENT_PID_FILE, String(process.pid) + '\\n');
  setInterval(() => {}, 1000);
});
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o700 });

  const serverPath = path.join(__dirname, '..', 'server.js');
  const children = [];
  const startServer = async () => {
    const port = await reservePort();
    const child = spawn(process.execPath, [serverPath], {
      cwd: path.dirname(serverPath),
      env: {
        ...process.env,
        ...hardenedWorkerTestEnvironment(),
        HOME: directory,
        PORT: String(port),
        AGENT_API_BIND_HOST: '127.0.0.1',
        AGENT_API_TOKEN: 'restart-agent-token-32-bytes-minimum',
        EXECUTOR_API_TOKEN: 'restart-executor-token-32-bytes-minimum',
        VOICE_CONTROL_TOKEN: 'restart-voice-token-32-bytes-minimum',
        PRIVILEGED_ACTION_API_TOKEN: 'restart-privileged-token-32-bytes-minimum',
        AGENT_PROVIDERS: 'claude,codex',
        CLAUDE_COMMAND: fakeAgent,
        CODEX_COMMAND: fakeAgent,
        CLAUDE_WORKING_DIR: directory,
        CODEX_WORKING_DIR: directory,
        PHONE_CODEX_LUNA_WORKING_DIR: directory,
        EXECUTOR_TASK_DB_PATH: dbPath,
        EXECUTOR_TASK_LEASE_MS: '1000',
        EXECUTOR_TASK_HEARTBEAT_MS: '250',
        EXECUTOR_TASK_POLL_MS: '20',
        VOICE_EXECUTION_LOCK_FILE: lockPath,
        RESTART_AGENT_PID_FILE: childPidFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      try {
        const response = await fetch(`${baseUrl}/operator/health`, {
          headers: { Authorization: 'Bearer restart-voice-token-32-bytes-minimum' },
        });
        const health = await response.json();
        return response.ok && health.executor?.dispatcher?.running;
      } catch {
        return false;
      }
    });
    return { child, baseUrl, output: () => output };
  };

  let agentPid = null;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    }
    await Promise.all(children.map(waitForExit));
    if (agentPid) {
      try {
        process.kill(-agentPid, 'SIGKILL');
      } catch {
        try {
          process.kill(agentPid, 'SIGKILL');
        } catch {
          // Recovered-task cancellation should already have removed it.
        }
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const headers = {
    Authorization: 'Bearer restart-executor-token-32-bytes-minimum',
    'Content-Type': 'application/json',
  };
  const first = await startServer();
  const submitted = await fetch(`${first.baseUrl}/executor/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotencyKey: 'job_restart_adoption_123',
      request: {
        prompt: 'Inspect the long-running restart fixture.',
        sessionType: 'phone-codex-luna',
        callId: 'restart-call',
      },
    }),
  });
  assert.equal(submitted.status, 202, first.output());
  const taskId = (await submitted.json()).task.id;
  await waitFor(() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, 'utf8').trim());
  agentPid = Number.parseInt(fs.readFileSync(childPidFile, 'utf8').trim(), 10);
  await waitFor(async () => {
    const body = await (await fetch(`${first.baseUrl}/executor/tasks/${taskId}`, { headers })).json();
    return body.task?.state === 'running' && body.task?.execution?.pid === agentPid;
  });

  first.child.kill('SIGKILL');
  await waitForExit(first.child);
  assert.doesNotThrow(() => process.kill(agentPid, 0));

  const second = await startServer();
  let adopted;
  await waitFor(async () => {
    const response = await fetch(`${second.baseUrl}/executor/tasks/${taskId}?events=1`, { headers });
    const body = await response.json();
    if (body.task?.state === 'running' &&
        body.events?.some((event) => event.eventType === 'lease_adopted')) {
      adopted = body;
      return true;
    }
    return false;
  });
  assert.equal(adopted.task.attempt, 1);
  assert.equal(fs.readFileSync(childPidFile, 'utf8').trim().split('\n').length, 1);

  const canceled = await fetch(`${second.baseUrl}/executor/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'restart_test_cleanup', source: 'integration_test' }),
  });
  assert.equal(canceled.status, 200, second.output());
  let terminal;
  await waitFor(async () => {
    const body = await (await fetch(`${second.baseUrl}/executor/tasks/${taskId}`, { headers })).json();
    if (body.task?.terminal) terminal = body.task;
    return body.task?.terminal;
  });
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(terminal.result.payload.execution_outcome_unknown, true);
  await waitFor(() => {
    try {
      process.kill(agentPid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  });
});
