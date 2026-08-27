'use strict';
const { TEST_RUNTIME_SECRETS, installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const bridge = require('../lib/claude-bridge');

function executorTask(overrides = {}) {
  return {
    id: 'xtask_123',
    idempotencyKey: 'job_voice123',
    taskType: 'managed_ask',
    state: 'queued',
    terminal: false,
    cancelReason: null,
    result: null,
    ...overrides,
  };
}

function restoreEnv(t, key) {
  const original = process.env[key];
  t.after(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });
}

test('durable executor defaults on only for phone sessions', (t) => {
  restoreEnv(t, 'AGENT_DURABLE_EXECUTOR_ENABLED');
  delete process.env.AGENT_DURABLE_EXECUTOR_ENABLED;
  assert.equal(bridge.durableExecutorEnabled({ sessionType: 'phone-codex-sol' }), true);
  assert.equal(bridge.durableExecutorEnabled({ sessionType: 'default' }), false);
  assert.equal(bridge.durableExecutorEnabled({ sessionType: 'phone-opus', durableExecutor: false }), false);
  process.env.AGENT_DURABLE_EXECUTOR_ENABLED = 'false';
  assert.equal(bridge.durableExecutorEnabled({ sessionType: 'phone-codex-sol' }), false);
});

test('durable idempotency uses a voice job id and request-bound legacy fallback', () => {
  assert.equal(
    bridge.buildDurableIdempotencyKey('Inspect Hermes', {
      callId: 'job_voice123',
      sessionType: 'phone-codex-terra',
    }),
    'job_voice123'
  );
  const first = bridge.buildDurableIdempotencyKey('Inspect Hermes', {
    callId: 'call-123',
    sessionKey: 'thread-123',
    sessionType: 'phone-codex-terra',
  });
  const retry = bridge.buildDurableIdempotencyKey('Inspect Hermes', {
    callId: 'call-123',
    sessionKey: 'thread-123',
    sessionType: 'phone-codex-terra',
  });
  const differentTurn = bridge.buildDurableIdempotencyKey('Inspect Atlas', {
    callId: 'call-123',
    sessionKey: 'thread-123',
    sessionType: 'phone-codex-terra',
  });
  assert.match(first, /^voice_[a-f0-9]{64}$/);
  assert.equal(retry, first);
  assert.notEqual(differentTurn, first);
});

test('phone query submits once, polls the durable task, and discards provider session IDs', async (t) => {
  restoreEnv(t, 'AGENT_DURABLE_EXECUTOR_ENABLED');
  restoreEnv(t, 'EXECUTOR_API_TOKEN');
  delete process.env.AGENT_DURABLE_EXECUTOR_ENABLED;
  process.env.EXECUTOR_API_TOKEN = 'dedicated-executor-token';
  const posts = [];
  const gets = [];
  t.mock.method(axios, 'post', async (url, body, config) => {
    posts.push({ url, body, config });
    return { data: { success: true, created: true, task: executorTask() } };
  });
  t.mock.method(axios, 'get', async (url) => {
    gets.push(url);
    return {
      data: {
        success: true,
        task: executorTask({
          state: 'completed',
          terminal: true,
          result: {
            httpStatus: 200,
            payload: {
              success: true,
              response: 'Hermes is healthy.',
              sessionId: 'codex-thread-1',
              provider: 'codex',
              duration_ms: 42,
            },
          },
        }),
      },
    };
  });

  const result = await bridge.queryDetailed('Inspect Hermes', {
    callId: 'job_voice123',
    sessionKey: 'thread-123',
    sessionType: 'phone-codex-terra',
    timeout: 10,
    durablePollIntervalMs: 10,
  });
  assert.deepEqual(result, {
    success: true,
    response: 'Hermes is healthy.',
    provider: 'codex',
    duration_ms: 42,
    executorTaskId: 'xtask_123',
    idempotencyKey: 'job_voice123',
  });
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/executor\/tasks$/);
  assert.equal(posts[0].body.idempotencyKey, 'job_voice123');
  assert.equal(posts[0].body.taskType, 'managed_ask');
  assert.equal(Object.hasOwn(posts[0].body.request, 'resumeSessionId'), false);
  assert.equal(Object.hasOwn(result, 'sessionId'), false);
  assert.equal(posts[0].config.headers['Idempotency-Key'], 'job_voice123');
  assert.equal(
    posts[0].config.headers.Authorization,
    `Bearer ${TEST_RUNTIME_SECRETS.executorApiToken}`,
  );
  assert.equal(gets.length, 1);
  assert.match(gets[0], /\/executor\/tasks\/xtask_123$/);
});

test('ambiguous submit recovers by idempotency without resending signed authorization or logging it', async (t) => {
  restoreEnv(t, 'AGENT_DURABLE_EXECUTOR_ENABLED');
  delete process.env.AGENT_DURABLE_EXECUTOR_ENABLED;
  const bearer = 'SIGNED-APPROVAL-BEARER-SECRET';
  const logs = [];
  let postCount = 0;
  const getUrls = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  t.mock.method(axios, 'post', async () => {
    postCount += 1;
    const error = new Error('socket closed after request write');
    error.code = 'ECONNRESET';
    throw error;
  });
  t.mock.method(axios, 'get', async (url) => {
    getUrls.push(url);
    if (url.includes('/by-idempotency/')) {
      return { data: { task: executorTask({ state: 'running' }) } };
    }
    return {
      data: {
        task: executorTask({
          state: 'completed',
          terminal: true,
          result: {
            httpStatus: 200,
            payload: { success: true, response: 'Restarted.', provider: 'codex' },
          },
        }),
      },
    };
  });

  const result = await bridge.queryDetailed('Restart the approved service.', {
    callId: 'job_voice123',
    sessionKey: 'thread-123',
    sessionType: 'phone-codex-sol',
    timeout: 10,
    durablePollIntervalMs: 10,
    authorization: {
      capability: bearer,
      signature: 'signature-secret',
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.response, 'Restarted.');
  assert.equal(postCount, 1);
  assert.match(getUrls[0], /\/executor\/tasks\/by-idempotency\/job_voice123$/);
  assert.match(getUrls[1], /\/executor\/tasks\/xtask_123$/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(bearer));
  assert.doesNotMatch(logs.join('\n'), /signature-secret/);
});

test('non-phone and durable-disabled requests fail closed without calling general /ask', async (t) => {
  restoreEnv(t, 'AGENT_DURABLE_EXECUTOR_ENABLED');
  restoreEnv(t, 'AGENT_API_TOKEN');
  restoreEnv(t, 'EXECUTOR_API_TOKEN');
  process.env.AGENT_DURABLE_EXECUTOR_ENABLED = 'true';
  process.env.AGENT_API_TOKEN = 'general-agent-token-that-must-never-be-used';
  process.env.EXECUTOR_API_TOKEN = 'dedicated-executor-token';
  const requests = [];
  t.mock.method(axios, 'post', async (url, _body, config) => {
    requests.push({ url, config });
    throw new Error('voice bridge must not make this request');
  });

  const nonPhone = await bridge.queryDetailed('ordinary', { sessionType: 'default' });
  assert.equal(nonPhone.success, false);
  assert.equal(nonPhone.code, 'VOICE_PHONE_SESSION_REQUIRED');
  process.env.AGENT_DURABLE_EXECUTOR_ENABLED = 'false';
  const disabled = await bridge.queryDetailed('phone direct', {
    callId: 'call-1',
    sessionType: 'phone-sonnet',
  });
  assert.equal(disabled.success, false);
  assert.equal(disabled.code, 'VOICE_DURABLE_EXECUTOR_REQUIRED');
  assert.equal(requests.length, 0);
});

test('lookup returns null on 404 and wait maps existing failed and canceled tasks', async (t) => {
  t.mock.method(axios, 'get', async () => {
    const error = new Error('not found');
    error.response = { status: 404 };
    throw error;
  });
  assert.equal(await bridge.getExecutorTaskByIdempotency('missing-job'), null);

  const failed = await bridge.waitForExecutorTask(executorTask({
    state: 'failed',
    terminal: true,
    errorCode: 'AGENT_CLI_FAILED',
    errorMessage: 'CLI exited 1',
    result: {
      httpStatus: 200,
      payload: {
        success: false,
        code: 'AGENT_CLI_FAILED',
        agentCode: 'AGENT_CLI_FAILED',
        error: 'CLI exited 1',
      },
    },
  }));
  assert.equal(failed.success, false);
  assert.equal(failed.agentCode, 'AGENT_CLI_FAILED');
  assert.equal(failed.executorTaskId, 'xtask_123');

  const canceled = await bridge.waitForExecutorTask(executorTask({
    state: 'canceled',
    terminal: true,
    cancelReason: 'caller_pressed_star',
  }));
  assert.equal(canceled.agentCode, 'AGENT_CANCELED');
  assert.equal(canceled.reason, 'caller_pressed_star');
});

test('generic target-session executor task payload maps without managed-ask coercion', () => {
  const mapped = bridge.mapExecutorTaskResult(executorTask({
    taskType: 'target_session_message',
    state: 'completed',
    terminal: true,
    result: {
      httpStatus: 200,
      payload: { success: true, result: { delivered: true, response: 'done' } },
    },
  }));
  assert.deepEqual(mapped, {
    success: true,
    result: { delivered: true, response: 'done' },
    executorTaskId: 'xtask_123',
    idempotencyKey: 'job_voice123',
  });
});

test('target-session message submits durably by exact operation id and waits for completion', async (t) => {
  restoreEnv(t, 'EXECUTOR_API_TOKEN');
  process.env.EXECUTOR_API_TOKEN = 'dedicated-executor-token';
  const operationId = 'job_TargetBridge1';
  const posts = [];
  const gets = [];
  t.mock.method(axios, 'post', async (url, body, config) => {
    posts.push({ url, body, config });
    return {
      data: {
        task: executorTask({
          id: 'xtask_target1',
          idempotencyKey: operationId,
          taskType: 'target_session_message',
        }),
      },
    };
  });
  t.mock.method(axios, 'get', async (url) => {
    gets.push(url);
    return {
      data: {
        task: executorTask({
          id: 'xtask_target1',
          idempotencyKey: operationId,
          taskType: 'target_session_message',
          state: 'completed',
          terminal: true,
          result: {
            httpStatus: 200,
            payload: { success: true, result: { delivered: true, response: 'Target done.' } },
          },
        }),
      },
    };
  });

  const result = await bridge.sendAgentSessionMessage({
    operationId,
    target: '%12',
    message: 'Run the target check.',
    sessionFingerprint: 'session-fingerprint',
    timeoutSeconds: 30,
    authorization: { capability: 'signed-one-time-capability' },
    durablePollIntervalMs: 10,
  });

  assert.equal(result.success, true);
  assert.equal(result.result.response, 'Target done.');
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/executor\/tasks$/);
  assert.equal(posts[0].body.taskType, 'target_session_message');
  assert.equal(posts[0].body.idempotencyKey, operationId);
  assert.equal(posts[0].body.request.operationId, operationId);
  assert.equal(posts[0].body.request.target, '%12');
  assert.equal(posts[0].config.headers['Idempotency-Key'], operationId);
  assert.equal(
    posts[0].config.headers.Authorization,
    `Bearer ${TEST_RUNTIME_SECRETS.executorApiToken}`,
  );
  assert.equal(gets.length, 1);
  assert.match(gets[0], /\/executor\/tasks\/xtask_target1$/);
});

test('ambiguous durable target submit performs GET recovery only and never resends capability', async (t) => {
  const operationId = 'job_TargetAmbiguous1';
  const bearer = 'TARGET-SIGNED-ONE-TIME-CAPABILITY';
  const logs = [];
  let postCount = 0;
  const getUrls = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  t.mock.method(axios, 'post', async () => {
    postCount += 1;
    const error = new Error('connection closed after target submit');
    error.code = 'ECONNRESET';
    throw error;
  });
  t.mock.method(axios, 'get', async (url) => {
    getUrls.push(url);
    if (url.includes('/by-idempotency/')) {
      return {
        data: {
          task: executorTask({
            id: 'xtask_target_ambiguous',
            idempotencyKey: operationId,
            taskType: 'target_session_message',
            state: 'running',
          }),
        },
      };
    }
    return {
      data: {
        task: executorTask({
          id: 'xtask_target_ambiguous',
          idempotencyKey: operationId,
          taskType: 'target_session_message',
          state: 'completed',
          terminal: true,
          result: {
            httpStatus: 200,
            payload: { success: true, result: { delivered: true, response: 'Recovered.' } },
          },
        }),
      },
    };
  });

  const result = await bridge.sendAgentSessionMessage({
    operationId,
    target: '%12',
    message: 'Run the target check.',
    sessionFingerprint: 'session-fingerprint',
    timeoutSeconds: 30,
    authorization: { capability: bearer },
    durablePollIntervalMs: 10,
  });

  assert.equal(result.success, true);
  assert.equal(result.result.response, 'Recovered.');
  assert.equal(postCount, 1);
  assert.match(getUrls[0], new RegExp(`/by-idempotency/${operationId}$`));
  assert.match(getUrls[1], /\/executor\/tasks\/xtask_target_ambiguous$/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(bearer));
});

test('canceled target executor preserves a verified or partial delivery result', () => {
  const mapped = bridge.mapExecutorTaskResult(executorTask({
    taskType: 'target_session_message',
    state: 'canceled',
    terminal: true,
    result: {
      httpStatus: 200,
      payload: {
        success: true,
        result: { delivered: true, response_verified: false, canceled_after_delivery: true },
      },
    },
  }));
  assert.equal(mapped.success, true);
  assert.equal(mapped.result.delivered, true);
  assert.equal(mapped.result.canceled_after_delivery, true);
  assert.equal(mapped.executorTaskId, 'xtask_123');
});

test('managed executor mapping preserves verified cancel-race success and restart uncertainty', () => {
  const verified = bridge.mapExecutorTaskResult(executorTask({
    taskType: 'managed_ask',
    state: 'canceled',
    terminal: true,
    cancelReason: 'caller_pressed_star',
    result: {
      httpStatus: 200,
      payload: {
        success: true,
        response: 'The requested restart completed.',
        provider: 'codex',
        sessionId: 'session-after-cancel-race',
        duration_ms: 91,
      },
    },
  }));
  assert.equal(verified.success, true);
  assert.equal(verified.response, 'The requested restart completed.');
  assert.equal(Object.hasOwn(verified, 'sessionId'), false);
  assert.equal(verified.executorTaskId, 'xtask_123');

  const uncertain = bridge.mapExecutorTaskResult(executorTask({
    taskType: 'managed_ask',
    state: 'failed',
    terminal: true,
    errorCode: 'EXECUTION_OUTCOME_UNKNOWN',
    errorMessage: 'response channel was lost',
    result: {
      httpStatus: 409,
      payload: {
        success: false,
        code: 'EXECUTION_OUTCOME_UNKNOWN',
        agentCode: 'EXECUTION_OUTCOME_UNKNOWN',
        error: 'The operation may have completed.',
        provider: 'claude',
        sessionId: 'persisted-session-after-restart',
        response: 'Unverified partial response',
        recovered: true,
        execution_outcome_unknown: true,
        reconciliation_required: true,
        processExit: 'process_not_found',
      },
    },
  }));
  assert.equal(uncertain.success, false);
  assert.equal(uncertain.code, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(uncertain.agentCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(Object.hasOwn(uncertain, 'sessionId'), false);
  assert.equal(uncertain.response, 'Unverified partial response');
  assert.equal(uncertain.execution_outcome_unknown, true);
  assert.equal(uncertain.reconciliation_required, true);
  assert.equal(uncertain.recovered, true);
  assert.equal(uncertain.processExit, 'process_not_found');
  assert.match(uncertain.userMessage, /may have completed/i);
});

test('cancelSession reserves the exact durable idempotency key', async (t) => {
  restoreEnv(t, 'VOICE_CONTROL_TOKEN');
  process.env.VOICE_CONTROL_TOKEN = 'dedicated-voice-control-token';
  let request = null;
  t.mock.method(axios, 'post', async (url, body, config) => {
    request = { url, body, config };
    return {
      data: {
        success: true,
        executorTasks: {
          taskIds: [],
          reservation: { idempotencyKey: body.idempotencyKey },
        },
      },
    };
  });

  const result = await bridge.cancelSession('job_CancelReservation1', {
    idempotencyKey: 'job_CancelReservation1',
    sessionKey: 'thread:codex-sol:one',
    reason: 'caller_pressed_star',
  });
  assert.equal(result.success, true);
  assert.match(request.url, /\/voice-control\/session\/cancel$/);
  assert.equal(
    request.config.headers.Authorization,
    `Bearer ${TEST_RUNTIME_SECRETS.voiceControlToken}`
  );
  assert.deepEqual(request.body, {
    callId: 'job_CancelReservation1',
    sessionKey: 'thread:codex-sol:one',
    idempotencyKey: 'job_CancelReservation1',
    resetSession: false,
    reason: 'caller_pressed_star',
  });
});

test('voice-control and operator clients never reuse the general agent bearer', async (t) => {
  restoreEnv(t, 'AGENT_API_TOKEN');
  restoreEnv(t, 'VOICE_CONTROL_TOKEN');
  process.env.AGENT_API_TOKEN = 'general-agent-token';
  process.env.VOICE_CONTROL_TOKEN = 'dedicated-voice-control-token';
  const requests = [];
  t.mock.method(axios, 'get', async (url, config) => {
    requests.push({ url, config });
    return { data: { success: true } };
  });
  t.mock.method(axios, 'post', async (url, body, config) => {
    requests.push({ url, body, config });
    return { data: { success: true, result: {} } };
  });

  await bridge.getVoiceExecutionStatus();
  await bridge.unlockVoiceExecution('test');
  await bridge.inspectOperator('tmux_sessions', {});
  await bridge.prepareAgentSessionMessage('%12');
  await bridge.cancelSession('job_VoiceScopedCancel1', {
    idempotencyKey: 'job_VoiceScopedCancel1',
  });
  await bridge.endSession('call-voice-scope', { sessionKey: 'voice-thread-scope' });
  await bridge.sendAgentSessionMessage({
    operationId: 'job_DirectVoiceControl1',
    target: '%12',
    message: 'direct fallback',
    sessionFingerprint: 'fingerprint',
    durableExecutor: false,
  });
  await bridge.panicStop({ reason: 'local_panic_test' });

  const protectedRequests = requests.filter(({ url }) =>
    /\/voice-control\/(?:status|unlock|session\/(?:cancel|end))$|\/operator\//.test(url));
  assert.equal(protectedRequests.length, 7);
  assert.ok(protectedRequests.every(({ config }) =>
    config.headers.Authorization === `Bearer ${TEST_RUNTIME_SECRETS.voiceControlToken}`));
  assert.ok(protectedRequests.every(({ config }) =>
    config.headers.Authorization !== 'Bearer general-agent-token'));

  const [panic] = requests.filter(({ url }) => url.endsWith('/voice-control/stop'));
  assert.equal(panic.config.headers.Authorization, undefined);
});
