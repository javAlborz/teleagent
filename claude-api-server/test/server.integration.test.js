'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function reservePort() {
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

test('agent bridge routes providers, sessions, errors, and privileged deploys', async t => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-bridge-test-'));
  const fakeAgentPath = path.join(tempDirectory, 'fake-agent.js');
  const invocationLog = path.join(tempDirectory, 'invocations.jsonl');
  const stubbornChildPidFile = path.join(tempDirectory, 'stubborn-child.pid');
  const stubbornChildReadyFile = path.join(tempDirectory, 'stubborn-child.ready');
  const voiceLockFile = path.join(tempDirectory, 'voice-execution.lock.json');
  const fakeAgentSource = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', chunk => { input += chunk.toString(); });
process.stdin.on('end', () => {
  const isCodex = args.includes('exec');
  const promptIndex = args.indexOf('-p');
  const prompt = isCodex ? input : (promptIndex >= 0 ? args[promptIndex + 1] : '');
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ args, prompt }) + '\\n');

  const respond = () => {
    if (isCodex) {
      const response = prompt.includes('STRUCTURED_TEST')
        ? '{"status":"ok"}'
        : (args.includes('resume') ? 'resumed' : 'codex-ok');
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-123' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: response } }) + '\\n');
      return;
    }

    const sessionIndex = args.indexOf('--session-id');
    const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'claude-thread-123';
    process.stdout.write(JSON.stringify({ type: 'result', result: 'claude-ok', session_id: sessionId }) + '\\n');
  };

  if (prompt.includes('STUBBORN_CHILD_TEST')) {
    const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.env.FAKE_CHILD_READY_FILE, 'ready'); setInterval(() => {}, 1000);"], {
      stdio: 'ignore',
      env: process.env,
    });
    fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
    setTimeout(respond, 5000);
  }
  else if (prompt.includes('SLOW_TEST')) setTimeout(respond, 5000);
  else respond();
});
`;
  fs.writeFileSync(fakeAgentPath, fakeAgentSource, { mode: 0o700 });

  const port = await reservePort();
  const serverPath = path.join(__dirname, '..', 'server.js');
  const server = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      HOME: tempDirectory,
      PORT: String(port),
      AGENT_API_BIND_HOST: '127.0.0.1',
      AGENT_API_TOKEN: 'integration-token',
      AGENT_PROVIDERS: 'claude,codex',
      CLAUDE_COMMAND: fakeAgentPath,
      CODEX_COMMAND: fakeAgentPath,
      CLAUDE_WORKING_DIR: tempDirectory,
      CODEX_WORKING_DIR: tempDirectory,
      PHONE_CODEX_LUNA_WORKING_DIR: tempDirectory,
      PHONE_CODEX_TERRA_WORKING_DIR: tempDirectory,
      PHONE_CODEX_SOL_WORKING_DIR: tempDirectory,
      PHONE_CODEX_DEPLOY_WORKING_DIR: tempDirectory,
      VOICE_EXECUTION_LOCK_FILE: voiceLockFile,
      FAKE_AGENT_LOG: invocationLog,
      FAKE_CHILD_PID_FILE: stubbornChildPidFile,
      FAKE_CHILD_READY_FILE: stubbornChildReadyFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', data => { serverOutput += data.toString(); });
  server.stderr.on('data', data => { serverOutput += data.toString(); });

  t.after(() => {
    if (!server.killed) server.kill('SIGTERM');
    if (fs.existsSync(stubbornChildPidFile)) {
      try {
        process.kill(Number.parseInt(fs.readFileSync(stubbornChildPidFile, 'utf8'), 10), 'SIGKILL');
      } catch {
        // The panic-stop escalation should already have removed it.
      }
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: 'Bearer integration-token',
    'Content-Type': 'application/json',
  };
  const post = async (route, body, authenticated = true) => fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: authenticated ? headers : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  await waitFor(async () => {
    try {
      return (await fetch(`${baseUrl}/health`)).ok;
    } catch {
      return false;
    }
  });

  await t.test('health reports both enabled providers and auth protects work routes', async () => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health.providers, ['claude', 'codex']);

    const unauthorized = await post('/ask', { prompt: 'hello' }, false);
    assert.equal(unauthorized.status, 401);
  });

  await t.test('Luna, Terra, and Sol use their configured model boundaries', async () => {
    for (const sessionType of ['phone-codex-luna', 'phone-codex-terra', 'phone-codex-sol']) {
      const response = await post('/ask', { prompt: 'Inspect the workspace', sessionType });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).provider, 'codex');
    }

    const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(invocations[0].args.includes('gpt-5.6-luna'));
    assert.ok(invocations[0].args.includes('read-only'));
    assert.ok(invocations[1].args.includes('gpt-5.6-terra'));
    assert.ok(invocations[1].args.includes('workspace-write'));
    assert.ok(invocations[2].args.includes('gpt-5.6-sol'));
    assert.ok(invocations[2].args.includes('danger-full-access'));
  });

  await t.test('Codex sessions resume and provider switches start a fresh provider session', async () => {
    const first = await post('/ask', {
      prompt: 'Remember this',
      sessionType: 'phone-codex-luna',
      sessionKey: 'resume-key',
    });
    assert.equal((await first.json()).sessionId, 'codex-thread-123');

    const resumed = await post('/ask', {
      prompt: 'Continue',
      sessionType: 'phone-codex-luna',
      sessionKey: 'resume-key',
    });
    assert.equal((await resumed.json()).response, 'resumed');

    const switched = await post('/ask', {
      prompt: 'Switch providers',
      sessionType: 'phone-sonnet',
      sessionKey: 'resume-key',
    });
    const switchedBody = await switched.json();
    assert.equal(switchedBody.provider, 'claude');
    assert.equal(switchedBody.response, 'claude-ok');
  });

  await t.test('durable provider session IDs restore after an in-memory bridge miss', async () => {
    const codex = await post('/ask', {
      prompt: 'Continue durable Codex work',
      sessionType: 'phone-codex-terra',
      sessionKey: 'new-codex-bridge-key',
      resumeSessionId: 'persisted-codex-thread',
    });
    assert.equal((await codex.json()).response, 'resumed');

    const claude = await post('/ask', {
      prompt: 'Continue durable Claude work',
      sessionType: 'phone-sonnet',
      sessionKey: 'new-claude-bridge-key',
      resumeSessionId: 'persisted-claude-thread',
    });
    assert.equal((await claude.json()).provider, 'claude');

    const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse);
    const codexInvocation = invocations.find(entry => entry.prompt.includes('Continue durable Codex work'));
    assert.ok(codexInvocation.args.includes('resume'));
    assert.ok(codexInvocation.args.includes('persisted-codex-thread'));
    const claudeInvocation = invocations.find(entry => entry.prompt.includes('Continue durable Claude work'));
    assert.ok(claudeInvocation.args.includes('--resume'));
    assert.ok(claudeInvocation.args.includes('persisted-claude-thread'));
  });

  await t.test('structured Codex responses are validated', async () => {
    const response = await post('/ask-structured', {
      prompt: 'STRUCTURED_TEST',
      sessionType: 'phone-codex-terra',
      schema: { requiredFields: ['status'] },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, 'codex');
    assert.deepEqual(body.data, { status: 'ok' });
  });

  await t.test('Luna deployment is denied while Sol remains Codex deploy-capable', async () => {
    const before = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length;
    const denied = await post('/ask', {
      prompt: 'Deploy the app-platform preview',
      sessionType: 'phone-codex-luna',
    });
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.agentCode, 'AGENT_PRIVILEGED_PROFILE_REQUIRED');
    assert.match(deniedBody.userMessage, /dial extension 6/i);
    const after = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length;
    assert.equal(after, before);

    const allowed = await post('/ask', {
      prompt: 'Deploy the app-platform preview',
      sessionType: 'phone-codex-sol',
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).provider, 'codex');
  });

  await t.test('timeouts and explicit cancellation expose neutral and legacy codes', async () => {
    const timeoutResponse = await post('/ask', {
      prompt: 'SLOW_TEST timeout',
      sessionType: 'phone-codex-luna',
      timeoutSeconds: 1,
      callId: 'timeout-call',
    });
    const timeoutBody = await timeoutResponse.json();
    assert.equal(timeoutBody.code, 'CLAUDE_TIMEOUT');
    assert.equal(timeoutBody.agentCode, 'AGENT_TIMEOUT');

    const slowRequest = post('/ask', {
      prompt: 'SLOW_TEST cancel',
      sessionType: 'phone-codex-luna',
      timeoutSeconds: 10,
      callId: 'cancel-call',
    });
    await waitFor(() => fs.existsSync(invocationLog) && fs.readFileSync(invocationLog, 'utf8').includes('SLOW_TEST cancel'));
    const cancelResponse = await post('/cancel-session', { callId: 'cancel-call' });
    assert.equal((await cancelResponse.json()).canceledCount, 1);

    const canceledBody = await (await slowRequest).json();
    assert.equal(canceledBody.code, 'CLAUDE_CANCELED');
    assert.equal(canceledBody.agentCode, 'AGENT_CANCELED');
  });

  await t.test('panic stop kills all voice requests, persists the lock, and preserves non-phone API work', async () => {
    const firstVoiceRequest = post('/ask', {
      prompt: 'SLOW_TEST voice panic one',
      sessionType: 'phone-codex-sol',
      timeoutSeconds: 10,
      callId: 'panic-call-one',
      sessionKey: 'panic-session-one',
    });
    const secondVoiceRequest = post('/ask', {
      prompt: 'SLOW_TEST voice panic two',
      sessionType: 'phone-sonnet',
      timeoutSeconds: 10,
      sessionKey: 'panic-session-two',
    });
    const stubbornVoiceRequest = post('/ask', {
      prompt: 'STUBBORN_CHILD_TEST voice panic child',
      sessionType: 'phone-codex-sol',
      timeoutSeconds: 10,
      callId: 'panic-call-child',
      sessionKey: 'panic-session-child',
    });
    await waitFor(() => {
      if (!fs.existsSync(invocationLog)) return false;
      const log = fs.readFileSync(invocationLog, 'utf8');
      return log.includes('voice panic one') &&
        log.includes('voice panic two') &&
        log.includes('voice panic child') &&
        fs.existsSync(stubbornChildPidFile) &&
        fs.existsSync(stubbornChildReadyFile);
    });

    const stopped = await post(
      '/voice-control/stop?source=asterisk_1001&reason=voice_panic_stop',
      {},
      false
    );
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json();
    assert.equal(stoppedBody.success, true);
    assert.equal(stoppedBody.canceledCount, 3);
    assert.ok(stoppedBody.clearedSessionCount >= 3);
    assert.equal(stoppedBody.voiceExecution.locked, true);
    assert.equal(fs.existsSync(voiceLockFile), true);

    for (const pending of [firstVoiceRequest, secondVoiceRequest, stubbornVoiceRequest]) {
      const body = await (await pending).json();
      assert.equal(body.agentCode, 'AGENT_CANCELED');
      assert.equal(body.reason, 'voice_panic_stop');
    }

    const stubbornChildPid = Number.parseInt(fs.readFileSync(stubbornChildPidFile, 'utf8'), 10);
    await waitFor(() => {
      try {
        process.kill(stubbornChildPid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    }, 5000);

    const blocked = await post('/ask', {
      prompt: 'Inspect after panic stop',
      sessionType: 'phone-codex-luna',
    });
    assert.equal(blocked.status, 423);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.agentCode, 'AGENT_VOICE_EXECUTION_LOCKED');

    const ordinaryApi = await post('/ask', {
      prompt: 'Ordinary API work remains available',
      sessionType: 'default',
    });
    assert.equal(ordinaryApi.status, 200);
    assert.equal((await ordinaryApi.json()).success, true);

    const unauthorizedUnlock = await post('/voice-control/unlock', {}, false);
    assert.equal(unauthorizedUnlock.status, 401);
    const unlocked = await post('/voice-control/unlock', { source: 'integration_test' });
    assert.equal(unlocked.status, 200);
    assert.equal((await unlocked.json()).voiceExecution.locked, false);

    const restored = await post('/ask', {
      prompt: 'Inspect after operator unlock',
      sessionType: 'phone-codex-luna',
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).success, true);
  });

  assert.equal(server.exitCode, null, serverOutput);
});
