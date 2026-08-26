'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { requestHash } = require('../../lib/voice-operation-risk');
const {
  createApprovalCapabilityIssuer,
  generateApprovalCapabilityKeyPair,
  hashApprovalPlan,
} = require('../../lib/voice-approval-capability');
const {
  buildManagedAgentApprovalPlan,
  buildStructuredAgentApprovalContext,
  buildTargetSessionApprovalPlan,
  managedAgentTarget,
  profileForSessionType,
} = require('../../lib/voice-authorization-plan');
const {
  hardenedWorkerTestEnvironment,
} = require('./fixtures/hardened-worker-test-env');

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

test('agent bridge routes providers, sessions, errors, and privileged deploys', async t => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-bridge-test-'));
  const fakeAgentPath = path.join(tempDirectory, 'fake-agent.js');
  const invocationLog = path.join(tempDirectory, 'invocations.jsonl');
  const stubbornChildPidFile = path.join(tempDirectory, 'stubborn-child.pid');
  const stubbornChildReadyFile = path.join(tempDirectory, 'stubborn-child.ready');
  const structuredMutationSideEffectFile = path.join(tempDirectory, 'structured-mutation-side-effects.jsonl');
  const providerBusyStateFile = path.join(tempDirectory, 'provider-busy-state');
  const providerAcceptedFile = path.join(tempDirectory, 'provider-accepted.jsonl');
  const voiceLockFile = path.join(tempDirectory, 'voice-execution.lock.json');
  const executorTaskDb = path.join(tempDirectory, 'executor', 'tasks.sqlite');
  const agentApiToken = 'integration-agent-token-32-bytes-minimum';
  const executorApiToken = 'integration-executor-token-32-bytes-minimum';
  const voiceControlToken = 'integration-voice-token-32-bytes-minimum';
  const privilegedActionToken = 'integration-privileged-token-32-bytes-minimum';
  const approvalPublicKeyFile = path.join(tempDirectory, 'approval-public.pem');
  const approvalKeys = generateApprovalCapabilityKeyPair();
  fs.writeFileSync(approvalPublicKeyFile, approvalKeys.publicKey, { mode: 0o600 });
  const approvalIssuer = createApprovalCapabilityIssuer({
    privateKey: approvalKeys.privateKey,
    keyId: 'integration-approval-key',
  });
  const expiredApprovalIssuer = createApprovalCapabilityIssuer({
    privateKey: approvalKeys.privateKey,
    keyId: 'integration-approval-key',
    now: () => Date.now() - 10 * 60 * 1000,
  });
  function managedAuthorization({
    prompt,
    callId,
    sessionKey = callId,
    sessionType,
    timeoutSeconds = null,
    devicePrompt = null,
    executionContext = null,
    issuer = approvalIssuer,
  }) {
    const capabilityProfile = profileForSessionType(sessionType);
    assert.ok(capabilityProfile, `No capability profile for ${sessionType}`);
    const plan = buildManagedAgentApprovalPlan({
      jobId: callId,
      request: prompt,
      sessionKey,
      sessionType,
      timeoutSeconds,
      devicePrompt,
      executionContext,
    });
    return {
      capability: issuer.issue({
        jobId: callId,
        requestHash: requestHash(prompt),
        planHash: hashApprovalPlan(plan),
        target: managedAgentTarget(sessionKey),
        provider: capabilityProfile.startsWith('codex-') ? 'codex' : 'claude',
        profile: capabilityProfile,
      }),
    };
  }
  const fakeAgentSource = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', chunk => { input += chunk.toString(); });
process.stdin.on('end', () => {
  const isCodex = args.includes('exec');
  const prompt = input;
  const inheritedControllerSecrets = [
    'AGENT_API_TOKEN',
    'EXECUTOR_API_TOKEN',
    'VOICE_CONTROL_TOKEN',
    'PRIVILEGED_ACTION_API_TOKEN',
    'OPENAI_REALTIME_API_KEY',
    'OPENAI_SAFETY_IDENTIFIER_SALT',
    'VOICE_APPROVAL_PRIVATE_KEY_FILE',
  ].filter(name => process.env[name] !== undefined);
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({
    args,
    prompt,
    inheritedControllerSecrets,
  }) + '\\n');

  if (prompt.includes('PROVIDER_BUSY_TEST') && !fs.existsSync(process.env.FAKE_PROVIDER_BUSY_STATE_FILE)) {
    fs.writeFileSync(process.env.FAKE_PROVIDER_BUSY_STATE_FILE, 'occupied-once');
    fs.writeSync(3, JSON.stringify({
      version: 1, accepted: false, code: 'PROVIDER_SUPERVISOR_BUSY',
    }) + '\\n');
    process.exit(78);
  }
  const providerLaunchId = 'launch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  fs.writeSync(3, JSON.stringify({
    version: 1, accepted: true, launchId: providerLaunchId,
  }) + '\\n');
  let providerAck;
  try { providerAck = JSON.parse(fs.readFileSync(4, 'utf8').trim()); }
  catch { process.exit(78); }
  if (providerAck?.version !== 1 || providerAck?.statusPersisted !== true ||
      providerAck?.launchId !== providerLaunchId) process.exit(78);
  if (prompt.includes('PROVIDER_BUSY_TEST')) {
    fs.appendFileSync(process.env.FAKE_PROVIDER_ACCEPTED_FILE, JSON.stringify({ accepted: true }) + '\\n');
  }

  const respond = () => {
    if (prompt.includes('STRUCTURED_MUTATION_EXIT_AFTER_SIDE_EFFECT')) {
      fs.appendFileSync(process.env.FAKE_MUTATION_SIDE_EFFECT_FILE, JSON.stringify({ prompt }) + '\\n');
      process.stderr.write('provider exited after the simulated side effect\\n');
      process.exitCode = 1;
      return;
    }
    if (isCodex) {
      const response = prompt.includes('STRUCTURED_MUTATION_MALFORMED') ||
        prompt.includes('STRUCTURED_READ_ONLY_MALFORMED')
        ? 'not-json'
        : prompt.includes('STRUCTURED_MUTATION_SCHEMA_INVALID')
          ? '{"different":"missing-required-status"}'
        : prompt.includes('STRUCTURED_TEST')
          ? '{"status":"ok"}'
          : (args.includes('resume') ? 'resumed' : 'codex-ok');
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-123' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: response } }) + '\\n');
      return;
    }

    const sessionIndex = args.indexOf('--session-id');
    const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'claude-thread-123';
    const response = prompt.includes('STRUCTURED_MUTATION_MALFORMED') ||
      prompt.includes('STRUCTURED_READ_ONLY_MALFORMED')
      ? 'not-json'
      : prompt.includes('STRUCTURED_MUTATION_SCHEMA_INVALID')
        ? '{"different":"missing-required-status"}'
        : 'claude-ok';
    process.stdout.write(JSON.stringify({ type: 'result', result: response, session_id: sessionId }) + '\\n');
  };

  if (prompt.includes('STUBBORN_CHILD_TEST')) {
    const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.env.FAKE_CHILD_READY_FILE, 'ready'); setInterval(() => {}, 1000);"], {
      stdio: 'ignore',
      env: process.env,
    });
    fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
    setTimeout(respond, 5000);
  }
  else if (prompt.includes('STRUCTURED_MUTATION_TIMEOUT')) {
    fs.appendFileSync(process.env.FAKE_MUTATION_SIDE_EFFECT_FILE, JSON.stringify({ prompt }) + '\\n');
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
      ...hardenedWorkerTestEnvironment(),
      HOME: tempDirectory,
      PORT: String(port),
      AGENT_API_BIND_HOST: '127.0.0.1',
      AGENT_API_TOKEN: agentApiToken,
      EXECUTOR_API_TOKEN: executorApiToken,
      VOICE_CONTROL_TOKEN: voiceControlToken,
      PRIVILEGED_ACTION_API_TOKEN: privilegedActionToken,
      AGENT_PROVIDERS: 'claude,codex',
      CLAUDE_COMMAND: fakeAgentPath,
      CODEX_COMMAND: fakeAgentPath,
      CLAUDE_WORKING_DIR: tempDirectory,
      CODEX_WORKING_DIR: tempDirectory,
      PHONE_CODEX_LUNA_WORKING_DIR: tempDirectory,
      PHONE_CODEX_TERRA_WORKING_DIR: tempDirectory,
      PHONE_CODEX_SOL_WORKING_DIR: tempDirectory,
      PHONE_CODEX_DEPLOY_WORKING_DIR: tempDirectory,
      PHONE_SONNET_CLAUDE_TOOLS: '',
      PHONE_SONNET_CLAUDE_ALLOWED_TOOLS: '',
      PHONE_OPUS_CLAUDE_TOOLS: 'Read,Write,Edit,Glob,Grep,Bash',
      PHONE_OPUS_CLAUDE_ALLOWED_TOOLS: 'Read,Write,Edit,Glob,Grep,Bash',
      VOICE_INSPECTION_ROOTS: tempDirectory,
      VOICE_EXECUTION_LOCK_FILE: voiceLockFile,
      VOICE_APPROVAL_KEY_ID: 'integration-approval-key',
      VOICE_APPROVAL_PUBLIC_KEY_FILE: approvalPublicKeyFile,
      EXECUTOR_TASK_DB_PATH: executorTaskDb,
      EXECUTOR_TASK_LEASE_MS: '1000',
      EXECUTOR_TASK_HEARTBEAT_MS: '250',
      EXECUTOR_TASK_POLL_MS: '20',
      FAKE_AGENT_LOG: invocationLog,
      FAKE_CHILD_PID_FILE: stubbornChildPidFile,
      FAKE_CHILD_READY_FILE: stubbornChildReadyFile,
      FAKE_MUTATION_SIDE_EFFECT_FILE: structuredMutationSideEffectFile,
      FAKE_PROVIDER_BUSY_STATE_FILE: providerBusyStateFile,
      FAKE_PROVIDER_ACCEPTED_FILE: providerAcceptedFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', data => { serverOutput += data.toString(); });
  server.stderr.on('data', data => { serverOutput += data.toString(); });

  t.after(async () => {
    if (server.exitCode === null && !server.signalCode) server.kill('SIGTERM');
    if (fs.existsSync(stubbornChildPidFile)) {
      try {
        process.kill(Number.parseInt(fs.readFileSync(stubbornChildPidFile, 'utf8'), 10), 'SIGKILL');
      } catch {
        // The panic-stop escalation should already have removed it.
      }
    }
    await waitForExit(server);
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const tokenForRoute = (route) => {
    if (route === '/executor/panic/unlock') return voiceControlToken;
    if (route === '/executor' || route.startsWith('/executor/')) return executorApiToken;
    if (route === '/operator' || route.startsWith('/operator/') ||
        route === '/voice-control' || route.startsWith('/voice-control/')) {
      return voiceControlToken;
    }
    if (route === '/privileged-actions' || route.startsWith('/privileged-actions/')) {
      return privilegedActionToken;
    }
    return agentApiToken;
  };
  const headersForRoute = (route, authenticated, { json = false } = {}) => ({
    ...(authenticated ? { Authorization: `Bearer ${tokenForRoute(route)}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  const post = async (route, body, authenticated = true) => fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: headersForRoute(route, authenticated, { json: true }),
    body: JSON.stringify(body),
  });
  const get = async (route, authenticated = true) => fetch(`${baseUrl}${route}`, {
    headers: headersForRoute(route, authenticated),
  });

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/health`)).ok;
      } catch {
        return false;
      }
    });
  } catch (error) {
    throw new Error(`${error.message}\ncontroller output:\n${serverOutput}`);
  }

  await t.test('public health is minimal while operator health reports diagnostics', async () => {
    const publicHealth = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(
      Object.keys(publicHealth).sort(),
      ['ready', 'service', 'status', 'timestamp']
    );
    assert.equal(publicHealth.ready, true);

    let health;
    try { health = await (await get('/operator/health')).json(); }
    catch (error) {
      throw new Error(`${error.message}\ncontroller output:\n${serverOutput}`);
    }
    assert.deepEqual(health.providers, ['claude', 'codex']);
    assert.equal(health.approvalCapabilities.verifierConfigured, true);
    assert.deepEqual(health.agentWorker, {
      enabled: true,
      hardened: true,
      legacySameUidEnabled: false,
    });
    assert.equal(health.workerSessionBroker.enabled, true);
    assert.equal(health.workerSessionBroker.ready, true);

    const unauthorized = await post('/ask', { prompt: 'hello' }, false);
    assert.equal(unauthorized.status, 401);

    const unauthorizedExecutor = await post('/executor/tasks', {
      idempotencyKey: 'unauthorized-task',
      request: { prompt: 'Inspect the workspace', sessionType: 'phone-codex-luna' },
    }, false);
    assert.equal(unauthorizedExecutor.status, 401);

    const unauthorizedExecutorRead = await get('/executor/tasks/xtask_missing', false);
    assert.equal(unauthorizedExecutorRead.status, 401);

    const unauthorizedTarget = await post(
      '/operator/session-message/prepare',
      { target: 'main:phone' },
      false
    );
    assert.equal(unauthorizedTarget.status, 401);

    const invalidTarget = await post('/operator/session-message/prepare', { target: 'not a target' });
    assert.equal(invalidTarget.status, 400);
    assert.equal((await invalidTarget.json()).code, 'EXACT_TMUX_TARGET_REQUIRED');

    const missingTargetDelivery = await post('/operator/session-message', {
      operationId: 'job_integration123',
      target: '%999999999',
      message: 'Inspect status.',
      sessionFingerprint: 'untrusted',
      authorization: {
        approved: true,
        job_id: 'job_integration123',
        method: 'dtmf-pound',
        request_sha256: requestHash('Inspect status.'),
      },
    });
    assert.notEqual(missingTargetDelivery.status, 403);
    assert.notEqual((await missingTargetDelivery.json()).code, 'VOICE_APPROVAL_REQUIRED');

    const injectedMessage = 'Visible approval\u001b[201~\n/hidden-command';
    const injectedOperationId = 'job_ControlInjection123';
    const injectedPlan = buildTargetSessionApprovalPlan({
      jobId: injectedOperationId,
      target: '%12',
      message: injectedMessage,
      sessionFingerprint: 'a'.repeat(64),
      timeoutSeconds: 1800,
    });
    const injectedCapability = approvalIssuer.issue({
      jobId: injectedOperationId,
      requestHash: requestHash(injectedMessage),
      planHash: hashApprovalPlan(injectedPlan),
      target: '%12',
      provider: 'codex',
      profile: 'codex-sol',
    });
    const approvalDb = new Database(executorTaskDb, { readonly: true });
    const nonceCountBefore = approvalDb.prepare(
      'SELECT COUNT(*) AS count FROM voice_approval_capability_nonces'
    ).get().count;
    approvalDb.close();
    const injected = await post('/executor/tasks', {
      idempotencyKey: injectedOperationId,
      taskType: 'target_session_message',
      request: {
        operationId: injectedOperationId,
        target: '%12',
        message: injectedMessage,
        sessionFingerprint: 'a'.repeat(64),
        timeoutSeconds: 1800,
        authorization: { capability: injectedCapability },
      },
    });
    assert.equal(injected.status, 400);
    assert.equal((await injected.json()).code, 'INVALID_TARGET_MESSAGE');
    const approvalDbAfter = new Database(executorTaskDb, { readonly: true });
    assert.equal(approvalDbAfter.prepare(
      'SELECT COUNT(*) AS count FROM voice_approval_capability_nonces'
    ).get().count, nonceCountBefore);
    approvalDbAfter.close();

    const inspection = await post('/operator/inspect', {
      action: 'list_directory',
      args: { path: tempDirectory },
    });
    assert.equal(inspection.status, 200);
    const inspected = await inspection.json();
    assert.equal(inspected.success, true);
    assert.ok(inspected.result.entries.some((entry) => entry.name === 'fake-agent.js'));
  });

  await t.test('all Codex models remain selectable while read-only phone prompts force read-only execution', async () => {
    for (const sessionType of ['phone-codex-luna', 'phone-codex-terra', 'phone-codex-sol']) {
      const response = await post('/ask', { prompt: 'Inspect the workspace', sessionType });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).provider, 'codex');
    }

    const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(invocations[0].args.includes('gpt-5.6-luna'));
    assert.ok(invocations[0].args.includes('read-only'));
    assert.ok(invocations[1].args.includes('gpt-5.6-terra'));
    assert.ok(invocations[1].args.includes('read-only'));
    assert.ok(invocations[2].args.includes('gpt-5.6-sol'));
    assert.ok(invocations[2].args.includes('read-only'));
  });

  await t.test('Claude read-only phone prompts remove mutation-capable tools until scoped approval', async () => {
    const readPrompt = 'Inspect the phone repository.';
    const read = await post('/ask', { prompt: readPrompt, sessionType: 'phone-sonnet' });
    assert.equal(read.status, 200);
    const readInvocation = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .findLast(entry => entry.prompt.includes(readPrompt));
    assert.ok(readInvocation.args.includes('--tools'));
    assert.ok(readInvocation.args.includes('--allowedTools'));
    const readTools = readInvocation.args[readInvocation.args.indexOf('--tools') + 1];
    const readAllowedTools = readInvocation.args[readInvocation.args.indexOf('--allowedTools') + 1];
    assert.equal(readTools, 'Read,Glob,Grep');
    assert.equal(readAllowedTools, 'Read,Glob,Grep');
    assert.equal(
      readInvocation.args[readInvocation.args.indexOf('--permission-mode') + 1],
      'dontAsk'
    );
    assert.doesNotMatch(readTools, /Bash|Write|Edit|Task/);

    const writePrompt = 'Implement the approved phone change.';
    const writeCallId = 'job_claudewrite123';
    const writeSessionKey = 'integration:claude-opus';
    const writeTimeoutSeconds = 3600;
    const write = await post('/executor/tasks', {
      idempotencyKey: writeCallId,
      taskType: 'managed_ask',
      request: {
        prompt: writePrompt,
        callId: writeCallId,
        sessionKey: writeSessionKey,
        sessionType: 'phone-opus',
        timeoutSeconds: writeTimeoutSeconds,
        authorization: managedAuthorization({
          prompt: writePrompt,
          callId: writeCallId,
          sessionKey: writeSessionKey,
          sessionType: 'phone-opus',
          timeoutSeconds: writeTimeoutSeconds,
        }),
      },
    });
    assert.equal(write.status, 202);
    const writeTaskId = (await write.json()).task.id;
    await waitFor(async () => (
      (await (await get(`/executor/tasks/${writeTaskId}`)).json()).task?.terminal === true
    ));
    const writeInvocation = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .findLast(entry => entry.prompt.includes(writePrompt));
    const writeTools = writeInvocation.args[writeInvocation.args.indexOf('--tools') + 1];
    assert.match(writeTools, /Bash/);
    assert.match(writeTools, /Write/);
  });

  await t.test('every managed request starts fresh while Teleagent correlation survives provider switches', async () => {
    const first = await post('/ask', {
      prompt: 'Remember this',
      sessionType: 'phone-codex-luna',
      sessionKey: 'resume-key',
    });
    const firstBody = await first.json();
    assert.equal(firstBody.response, 'codex-ok');
    assert.equal(Object.hasOwn(firstBody, 'sessionId'), false);

    const resumed = await post('/ask', {
      prompt: 'Continue',
      sessionType: 'phone-codex-luna',
      sessionKey: 'resume-key',
    });
    const secondBody = await resumed.json();
    assert.equal(secondBody.response, 'codex-ok');
    assert.equal(Object.hasOwn(secondBody, 'sessionId'), false);

    const switched = await post('/ask', {
      prompt: 'Switch providers',
      sessionType: 'phone-sonnet',
      sessionKey: 'resume-key',
    });
    const switchedBody = await switched.json();
    assert.equal(switchedBody.provider, 'claude');
    assert.equal(switchedBody.response, 'claude-ok');
    assert.equal(Object.hasOwn(switchedBody, 'sessionId'), false);

    const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => ['Remember this', 'Continue', 'Switch providers']
        .some(prompt => entry.prompt.includes(prompt)));
    assert.equal(invocations.length, 3);
    assert.equal(invocations.some(entry => entry.args.includes('resume') || entry.args.includes('--resume')), false);
  });

  await t.test('provider session resume requests are rejected before any provider spawn', async () => {
    const before = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').filter(Boolean).length;
    const codex = await post('/ask', {
      prompt: 'Continue durable Codex work',
      sessionType: 'phone-codex-terra',
      sessionKey: 'new-codex-bridge-key',
      resumeSessionId: 'persisted-codex-thread',
    });
    assert.equal(codex.status, 409);
    assert.equal((await codex.json()).code, 'PROVIDER_SESSION_RESUME_DISABLED');

    const claude = await post('/ask', {
      prompt: 'Continue durable Claude work',
      sessionType: 'phone-sonnet',
      sessionKey: 'new-claude-bridge-key',
      resumeSessionId: 'persisted-claude-thread',
    });
    assert.equal(claude.status, 409);
    assert.equal((await claude.json()).code, 'PROVIDER_SESSION_RESUME_DISABLED');
    const after = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.equal(after, before);
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

    const mutationPrompt = 'STRUCTURED_TEST edit the approved test file.';
    const mutationRequest = {
      prompt: mutationPrompt,
      callId: 'job_structured123',
      sessionKey: 'integration:structured',
      sessionType: 'phone-codex-terra',
      timeoutSeconds: 1800,
      schema: { requiredFields: ['status'] },
    };
    const nonceDbBefore = new Database(executorTaskDb, { readonly: true });
    const nonceCountBefore = nonceDbBefore.prepare(
      'SELECT COUNT(*) AS count FROM voice_approval_capability_nonces'
    ).get().count;
    nonceDbBefore.close();
    const invocationCountBefore = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.prompt.includes(mutationPrompt)).length;
    const unsignedMutation = await post('/ask-structured', mutationRequest);
    assert.equal(unsignedMutation.status, 409);
    assert.equal(
      (await unsignedMutation.json()).code,
      'STRUCTURED_MUTATION_REQUIRES_DURABLE_EXECUTOR'
    );
    const signedAuthorization = managedAuthorization({
      ...mutationRequest,
      executionContext: buildStructuredAgentApprovalContext({
        schema: mutationRequest.schema,
      }),
    });
    const signedMutation = await post('/ask-structured', {
      ...mutationRequest,
      authorization: signedAuthorization,
    });
    assert.equal(signedMutation.status, 409);
    const signedBody = await signedMutation.json();
    assert.equal(signedBody.code, 'STRUCTURED_MUTATION_REQUIRES_DURABLE_EXECUTOR');
    assert.equal(signedBody.durable_executor_required, true);
    assert.equal(signedBody.retry_safe, false);
    const nonceDbAfter = new Database(executorTaskDb, { readonly: true });
    assert.equal(nonceDbAfter.prepare(
      'SELECT COUNT(*) AS count FROM voice_approval_capability_nonces'
    ).get().count, nonceCountBefore, 'direct structured rejection must not consume the capability');
    nonceDbAfter.close();
    const invocationCountAfter = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.prompt.includes(mutationPrompt)).length;
    assert.equal(invocationCountAfter, invocationCountBefore, 'direct structured mutation must not spawn a provider');
    assert.equal(
      fs.existsSync(structuredMutationSideEffectFile),
      false,
      'direct structured mutation must not execute a side effect'
    );
  });

  await t.test('read-only structured formatting repair remains capped at one retry', async () => {
    const marker = 'STRUCTURED_READ_ONLY_MALFORMED inspect status only';
    const before = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.prompt.includes(marker)).length;
    const response = await post('/ask-structured', {
      prompt: marker,
      sessionType: 'phone-codex-luna',
      schema: { requiredFields: ['status'] },
      maxRetries: 99,
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.attempts, 2);
    assert.equal(body.outcome_unknown, undefined);
    assert.equal(body.retry_safe, undefined);
    const after = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.prompt.includes(marker)).length;
    assert.equal(after - before, 2);
  });

  await t.test('non-phone structured mutations also require the durable executor without spawning', async () => {
    const marker = 'general-structured-mutation-once';
    const before = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.prompt.includes(marker)).length;
    const response = await post('/ask-structured', {
      prompt: `STRUCTURED_MUTATION_MALFORMED edit the approved test file ${marker}.`,
      schema: { requiredFields: ['status'] },
      maxRetries: 99,
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, 'STRUCTURED_MUTATION_REQUIRES_DURABLE_EXECUTOR');
    assert.equal(body.retry_safe, false);
    const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.prompt.includes(marker));
    assert.equal(invocations.length, before);
  });

  await t.test('deploy jobs fail before approval consumption or provider spawn', async () => {
    const before = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length;
    const denied = await post('/ask', {
      prompt: 'Deploy the app-platform preview',
      sessionType: 'phone-codex-luna',
    });
    assert.equal(denied.status, 503);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.agentCode, 'DEPLOY_UNAVAILABLE_UNTIL_TOOL_BROKER');
    const after = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length;
    assert.equal(after, before);

    const deployPrompt = 'Deploy the app-platform preview';
    const deployCallId = 'job_soldeploy123';
    const deploySessionKey = 'integration:codex-sol-deploy';
    const deployTimeoutSeconds = 3600;
    const authorization = managedAuthorization({
      prompt: deployPrompt,
      callId: deployCallId,
      sessionKey: deploySessionKey,
      sessionType: 'phone-codex-sol',
      timeoutSeconds: deployTimeoutSeconds,
    });
    const nonceDbBefore = new Database(executorTaskDb, { readonly: true });
    const nonceCountBefore = nonceDbBefore.prepare(
      'SELECT COUNT(*) AS count FROM voice_approval_capability_nonces'
    ).get().count;
    nonceDbBefore.close();
    const direct = await post('/ask', {
      prompt: deployPrompt,
      callId: deployCallId,
      sessionKey: deploySessionKey,
      sessionType: 'phone-codex-sol',
      timeoutSeconds: deployTimeoutSeconds,
      authorization,
    });
    assert.equal(direct.status, 503);
    assert.equal((await direct.json()).code, 'DEPLOY_UNAVAILABLE_UNTIL_TOOL_BROKER');
    const durable = await post('/executor/tasks', {
      idempotencyKey: deployCallId,
      taskType: 'managed_ask',
      request: {
        prompt: deployPrompt,
        callId: deployCallId,
        sessionKey: deploySessionKey,
        sessionType: 'phone-codex-sol',
        timeoutSeconds: deployTimeoutSeconds,
        authorization,
      },
    });
    assert.equal(durable.status, 503);
    assert.equal((await durable.json()).code, 'DEPLOY_UNAVAILABLE_UNTIL_TOOL_BROKER');
    const nonceDbAfter = new Database(executorTaskDb, { readonly: true });
    assert.equal(nonceDbAfter.prepare(
      'SELECT COUNT(*) AS count FROM voice_approval_capability_nonces'
    ).get().count, nonceCountBefore);
    nonceDbAfter.close();
    assert.equal(fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length, before);
  });

  await t.test('phone mutations require a fresh request-bound pound authorization', async () => {
    const prompt = 'Restart the voice service.';
    const callId = 'job_mutation123';
    const sessionKey = 'integration:mutation';
    const sessionType = 'phone-codex-sol';
    const timeoutSeconds = 3600;
    const baseRequest = { prompt, callId, sessionKey, sessionType, timeoutSeconds };
    const missing = await post('/ask', baseRequest);
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).agentCode, 'MUTATION_REQUIRES_DURABLE_EXECUTOR');

    const submit = (suffix, request) => post('/executor/tasks', {
      idempotencyKey: `job_mutation_${suffix}`,
      taskType: 'managed_ask',
      request,
    });

    const legacyUnsigned = await submit('legacy_unsigned', {
      ...baseRequest,
      authorization: {
        approved: true,
        job_id: callId,
        method: 'dtmf-pound',
        request_sha256: requestHash(prompt),
      },
    });
    assert.equal(legacyUnsigned.status, 403);

    const differentPrompt = 'Restart a different service.';
    const mismatched = await submit('mismatched', {
      ...baseRequest,
      authorization: managedAuthorization({
        prompt: differentPrompt,
        callId,
        sessionKey,
        sessionType,
        timeoutSeconds,
      }),
    });
    assert.equal(mismatched.status, 403);
    assert.equal((await mismatched.json()).agentCode, 'VOICE_APPROVAL_REQUIRED');

    const expired = await submit('expired', {
      ...baseRequest,
      authorization: managedAuthorization({
        ...baseRequest,
        issuer: expiredApprovalIssuer,
      }),
    });
    assert.equal(expired.status, 403);

    const authorization = managedAuthorization(baseRequest);
    const directWithCapability = await post('/ask', {
      ...baseRequest,
      authorization,
    });
    assert.equal(directWithCapability.status, 409);
    const allowed = await submit('allowed', { ...baseRequest, authorization });
    assert.equal(allowed.status, 202);
    const allowedTaskId = (await allowed.json()).task.id;
    let allowedTask;
    await waitFor(async () => {
      allowedTask = (await (await get(`/executor/tasks/${allowedTaskId}`)).json()).task;
      return allowedTask?.terminal === true;
    });
    assert.equal(allowedTask.state, 'completed');
    assert.equal(allowedTask.result.payload.provider, 'codex');
    const replayed = await submit('replayed', { ...baseRequest, authorization });
    assert.equal(replayed.status, 403);
    assert.equal((await replayed.json()).agentCode, 'VOICE_APPROVAL_REQUIRED');
    const mutationInvocation = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
      .findLast(entry => entry.prompt.includes(prompt));
    assert.ok(mutationInvocation.args.includes('danger-full-access'));
  });

  await t.test('durable managed asks are idempotent, recoverable, and persist no approval bearer', async () => {
    await waitFor(async () => {
      const health = await (await get('/operator/health')).json();
      return health.executor?.dispatcher?.running === true;
    });

    const bulkListing = await get('/executor/tasks');
    assert.equal(bulkListing.status, 400);
    assert.equal((await bulkListing.json()).code, 'IDEMPOTENCY_KEY_REQUIRED');

    const idempotencyKey = 'job_durable_read_123';
    const secretBearer = 'SIGNED-CAPABILITY-MUST-NOT-PERSIST';
    const secretMetadata = 'METADATA-TOKEN-MUST-NOT-PERSIST';
    const request = {
      prompt: 'Inspect the durable executor workspace.',
      sessionType: 'phone-codex-terra',
      callId: 'durable-call',
      authorization: {
        capability: secretBearer,
        signature: 'signature-must-not-persist',
      },
    };
    const submitted = await post('/executor/tasks', {
      idempotencyKey,
      request,
      metadata: {
        source: 'voice_controller',
        controllerJobId: idempotencyKey,
        token: secretMetadata,
      },
    });
    assert.equal(submitted.status, 202);
    const submittedBody = await submitted.json();
    assert.equal(submittedBody.created, true);
    assert.doesNotMatch(JSON.stringify(submittedBody), new RegExp(secretBearer));
    assert.doesNotMatch(JSON.stringify(submittedBody), new RegExp(secretMetadata));
    assert.equal(submittedBody.task.request.ask.authorization, undefined);

    const taskId = submittedBody.task.id;
    let completed;
    await waitFor(async () => {
      const response = await get(`/executor/tasks/${taskId}?events=1`);
      const body = await response.json();
      if (body.task?.terminal) completed = body;
      return Boolean(completed);
    });
    assert.equal(completed.task.state, 'completed');
    assert.equal(completed.task.result.httpStatus, 200);
    assert.equal(completed.task.result.payload.provider, 'codex');
    assert.ok(completed.events.some((event) => event.eventType === 'lease_heartbeat'));
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(secretBearer));
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(secretMetadata));

    const retried = await post('/executor/tasks', {
      idempotencyKey,
      request: { ...request, authorization: { capability: 'different-retry-bearer' } },
      metadata: { source: 'retry', token: 'different-metadata-token' },
    });
    assert.equal(retried.status, 200);
    const retriedBody = await retried.json();
    assert.equal(retriedBody.created, false);
    assert.equal(retriedBody.task.id, taskId);

    const recovered = await get(`/executor/tasks/by-idempotency/${idempotencyKey}`);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).task.id, taskId);
    const recoveredByQuery = await get(`/executor/tasks?idempotencyKey=${idempotencyKey}`);
    assert.equal((await recoveredByQuery.json()).task.id, taskId);

    const conflict = await post('/executor/tasks', {
      idempotencyKey,
      request: {
        prompt: 'Inspect a materially different target.',
        sessionType: 'phone-codex-terra',
        callId: 'durable-call',
      },
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');

    const mutationPrompt = 'Restart the approved durable test service.';
    const mutationRequest = {
      prompt: mutationPrompt,
      sessionType: 'phone-codex-sol',
      callId: 'job_durablemutation123',
      sessionKey: 'integration:durable-mutation',
      timeoutSeconds: 3600,
    };
    const mutationAuthorization = managedAuthorization(mutationRequest);
    const mutationBearer = mutationAuthorization.capability;
    const mutation = await post('/executor/tasks', {
      idempotencyKey: 'job_durable_mutation_123',
      request: {
        ...mutationRequest,
        authorization: {
          ...mutationAuthorization,
          signature: 'mutation-signature-must-not-persist',
        },
      },
    });
    assert.equal(mutation.status, 202);
    const mutationBody = await mutation.json();
    assert.equal(
      mutationBody.task.request.voiceAuthorization.authorization.request_sha256,
      requestHash(mutationPrompt)
    );
    assert.equal(
      mutationBody.task.request.voiceAuthorization.authorization.plan_sha256,
      hashApprovalPlan(buildManagedAgentApprovalPlan({
        jobId: mutationRequest.callId,
        request: mutationPrompt,
        sessionKey: mutationRequest.sessionKey,
        sessionType: mutationRequest.sessionType,
        timeoutSeconds: mutationRequest.timeoutSeconds,
      }))
    );
    assert.equal(
      Object.hasOwn(mutationBody.task.request.voiceAuthorization.authorization, 'capability'),
      false
    );
    assert.doesNotMatch(JSON.stringify(mutationBody), new RegExp(mutationBearer));
    const mutationTaskId = mutationBody.task.id;
    await waitFor(async () => {
      const task = (await (await get(`/executor/tasks/${mutationTaskId}`)).json()).task;
      return task?.terminal;
    });

    const db = new Database(executorTaskDb, { readonly: true });
    try {
      const row = db.prepare(`
        SELECT request_json, metadata_json FROM executor_tasks WHERE id = ?
      `).get(taskId);
      const events = db.prepare(`
        SELECT details_json FROM executor_events WHERE task_id = ?
      `).all(taskId);
      const mutationRow = db.prepare(`
        SELECT request_json, metadata_json FROM executor_tasks WHERE id = ?
      `).get(mutationTaskId);
      const durableText = JSON.stringify({ row, events, mutationRow });
      assert.doesNotMatch(durableText, new RegExp(secretBearer));
      assert.doesNotMatch(durableText, new RegExp(secretMetadata));
      assert.doesNotMatch(durableText, /signature-must-not-persist/);
      assert.doesNotMatch(durableText, new RegExp(mutationBearer));
      assert.doesNotMatch(durableText, /mutation-signature-must-not-persist/);
    } finally {
      db.close();
    }
  });

  await t.test('approved managed work defers on proven pre-provider BUSY and executes once after capacity', async () => {
    const idempotencyKey = 'job_ProviderBusyCapacity123';
    const request = {
      prompt: 'PROVIDER_BUSY_TEST Restart the bounded test service.',
      sessionType: 'phone-codex-sol',
      callId: idempotencyKey,
      sessionKey: 'integration:provider-busy',
      timeoutSeconds: 3600,
    };
    const authorization = managedAuthorization(request);
    const submitted = await post('/executor/tasks', {
      idempotencyKey,
      taskType: 'managed_ask',
      request: { ...request, authorization },
    });
    assert.equal(submitted.status, 202);
    const taskId = (await submitted.json()).task.id;
    let deferredObserved = false;
    let terminal;
    await waitFor(async () => {
      const task = (await (await get(`/executor/tasks/${taskId}`)).json()).task;
      if (task?.state === 'queued' && task?.attempt === 1) deferredObserved = true;
      if (task?.terminal) terminal = task;
      return Boolean(terminal);
    }, 8000);
    assert.equal(deferredObserved, true);
    assert.equal(terminal.state, 'completed');
    assert.equal(terminal.attempt, 2);
    assert.equal(fs.readFileSync(providerAcceptedFile, 'utf8').trim().split('\n').length, 1);
    const db = new Database(executorTaskDb, { readonly: true });
    try {
      assert.equal(db.prepare(
        'SELECT COUNT(*) AS count FROM voice_approval_capability_nonces WHERE job_id = ?'
      ).get(idempotencyKey).count, 1);
    } finally {
      db.close();
    }
  });

  await t.test('durable managed execution rejects absent, non-phone, and unknown profiles before authorization', async () => {
    const invocationCount = () => fs.readFileSync(invocationLog, 'utf8')
      .trim().split('\n').filter(Boolean).length;
    const before = invocationCount();
    const invalidProfiles = [
      { label: 'absent', request: {} },
      { label: 'non-phone', request: { sessionType: 'default' } },
      { label: 'unknown', request: { sessionType: 'phone-unknown' } },
    ];
    for (const invalid of invalidProfiles) {
      const idempotencyKey = `job_invalid_durable_profile_${invalid.label}`;
      const response = await post('/executor/tasks', {
        idempotencyKey,
        taskType: 'managed_ask',
        request: {
          prompt: 'Inspect the durable profile boundary.',
          callId: idempotencyKey,
          ...invalid.request,
        },
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'EXECUTOR_PHONE_PROFILE_REQUIRED');
      assert.equal((await get(`/executor/tasks/by-idempotency/${idempotencyKey}`)).status, 404);
    }
    assert.equal(invocationCount(), before);

    const approvedRequest = {
      prompt: 'Restart the phone-only executor boundary fixture.',
      callId: 'job_phoneonly123',
      sessionKey: 'integration:phone-only-executor',
      sessionType: 'phone-codex-sol',
      timeoutSeconds: 3600,
    };
    const authorization = managedAuthorization(approvedRequest);
    const rejected = await post('/executor/tasks', {
      idempotencyKey: 'job_invalid_phoneonly_capability',
      taskType: 'managed_ask',
      request: {
        ...approvedRequest,
        sessionType: 'default',
        authorization,
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'EXECUTOR_PHONE_PROFILE_REQUIRED');

    const accepted = await post('/executor/tasks', {
      idempotencyKey: 'job_valid_phoneonly_capability',
      taskType: 'managed_ask',
      request: { ...approvedRequest, authorization },
    });
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 202, JSON.stringify(acceptedBody));
    const taskId = acceptedBody.task.id;
    await waitFor(async () => {
      const task = (await (await get(`/executor/tasks/${taskId}`)).json()).task;
      return task?.terminal;
    });
    assert.equal(invocationCount(), before + 1);
  });

  await t.test('durable task cancellation interrupts the managed ask process', async () => {
    const submitted = await post('/executor/tasks', {
      idempotencyKey: 'job_durable_cancel_123',
      request: {
        prompt: 'SLOW_TEST inspect until canceled',
        sessionType: 'phone-codex-luna',
        callId: 'durable-cancel-call',
        timeoutSeconds: 10,
      },
    });
    assert.equal(submitted.status, 202);
    const taskId = (await submitted.json()).task.id;
    await waitFor(async () => {
      const task = (await (await get(`/executor/tasks/${taskId}`)).json()).task;
      return task?.state === 'running';
    });

    const canceled = await post(`/executor/tasks/${taskId}/cancel`, {
      reason: 'caller_pressed_star',
      source: 'dtmf',
    });
    assert.equal(canceled.status, 200);
    assert.equal((await canceled.json()).task.state, 'cancel_requested');
    let terminal;
    await waitFor(async () => {
      const task = (await (await get(`/executor/tasks/${taskId}`)).json()).task;
      if (task?.terminal) terminal = task;
      return Boolean(terminal);
    });
    assert.equal(terminal.state, 'canceled');
    assert.equal(terminal.cancelReason, 'caller_pressed_star');
  });

  await t.test('cancel-before-submit reserves the exact job key without consuming authorization', async () => {
    const idempotencyKey = 'job_CancelBeforeSubmit123';
    const request = {
      prompt: 'Restart the cancel reservation integration service.',
      sessionType: 'phone-codex-sol',
      callId: idempotencyKey,
      sessionKey: 'integration:cancel-reservation',
      timeoutSeconds: 3600,
    };
    const authorization = managedAuthorization(request);
    const capability = authorization.capability;

    const canceled = await post('/cancel-session', {
      callId: idempotencyKey,
      sessionKey: request.sessionKey,
      idempotencyKey,
      reason: 'caller_canceled_before_submit',
    });
    assert.equal(canceled.status, 200);
    const canceledBody = await canceled.json();
    assert.equal(canceledBody.executorTasks.reservation.idempotencyKey, idempotencyKey);
    assert.deepEqual(canceledBody.executorTasks.taskIds, []);

    const blockedSubmission = await post('/executor/tasks', {
      idempotencyKey,
      taskType: 'managed_ask',
      request: { ...request, authorization },
    });
    assert.equal(blockedSubmission.status, 202);
    const blockedBody = await blockedSubmission.json();
    assert.equal(blockedBody.task.state, 'canceled');
    assert.equal(blockedBody.task.attempt, 0);
    assert.equal(blockedBody.task.cancelReason, 'caller_canceled_before_submit');
    assert.equal(blockedBody.task.request.canceledBeforeAuthorization, true);
    assert.equal(blockedBody.task.request.voiceAuthorization, undefined);
    assert.doesNotMatch(JSON.stringify(blockedBody), new RegExp(capability));

    // The canceled submission did not consume the one-time capability. A
    // distinct controller request can still spend it exactly once.
    const allowed = await post('/executor/tasks', {
      idempotencyKey: 'job_cancel_before_submit_capability_probe',
      taskType: 'managed_ask',
      request: { ...request, authorization },
    });
    const allowedBody = await allowed.json();
    assert.equal(allowed.status, 202, JSON.stringify(allowedBody));
    assert.notEqual(allowedBody.task.state, 'canceled');

    const db = new Database(executorTaskDb, { readonly: true });
    try {
      const durableText = JSON.stringify({
        task: db.prepare(`
          SELECT request_json, metadata_json FROM executor_tasks WHERE id = ?
        `).get(blockedBody.task.id),
        events: db.prepare(`
          SELECT details_json FROM executor_events WHERE task_id = ?
        `).all(blockedBody.task.id),
      });
      assert.doesNotMatch(durableText, new RegExp(capability));
    } finally {
      db.close();
    }
  });

  await t.test('authenticated durable panic locks queue submission until explicit unlock', async () => {
    const unauthorized = await post('/executor/panic', {}, false);
    assert.equal(unauthorized.status, 401);

    const stopped = await post('/executor/panic', {
      reason: 'integration_panic',
      source: 'integration_test',
    });
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json();
    assert.equal(stoppedBody.executorTasks.panic.locked, true);

    const blocked = await post('/executor/tasks', {
      idempotencyKey: 'job_blocked_by_durable_panic',
      request: {
        prompt: 'Inspect while panic is active.',
        sessionType: 'phone-codex-luna',
      },
    });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, 'WORKER_SESSION_PANIC_LOCKED');

    const unlocked = await post('/executor/panic/unlock', { source: 'integration_test' });
    assert.equal(unlocked.status, 200);
    assert.equal((await unlocked.json()).executor.panic.locked, false);
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

  await t.test('panic stop kills voice work and keeps every provider boundary locked until explicit unlock', async () => {
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
    assert.equal(stoppedBody.clearedSessionCount, 0);
    assert.equal(stoppedBody.voiceExecution.locked, true);
    assert.equal(fs.existsSync(voiceLockFile), true);
    const lockedHealth = await get('/health');
    assert.equal(lockedHealth.status, 503);
    assert.equal((await lockedHealth.json()).ready, false);

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
      prompt: 'Ordinary API work stays fenced with the shared provider boundary',
      sessionType: 'default',
    });
    assert.equal(ordinaryApi.status, 503);
    assert.equal((await ordinaryApi.json()).code, 'WORKER_SESSION_PANIC_LOCKED');

    const unauthorizedUnlock = await post('/voice-control/unlock', {}, false);
    assert.equal(unauthorizedUnlock.status, 401);
    const unlocked = await post('/voice-control/unlock', { source: 'integration_test' });
    assert.equal(unlocked.status, 200);
    const unlockedBody = await unlocked.json();
    assert.equal(unlockedBody.voiceExecution.locked, false);
    assert.equal(unlockedBody.workerSessions.quiesced, true);
    const unlockedHealth = await get('/health');
    assert.equal(unlockedHealth.status, 200);
    assert.equal((await unlockedHealth.json()).ready, true);

    const restored = await post('/ask', {
      prompt: 'Inspect after operator unlock',
      sessionType: 'phone-codex-luna',
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).success, true);
  });

  assert.equal(server.exitCode, null, serverOutput);
});
