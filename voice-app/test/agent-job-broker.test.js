'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { setImmediate } = require('node:timers');
const {
  AgentJobBroker,
  needsApproval,
  normalizeProfile,
  profileCan,
  refersToTargetedSession,
  routedProfile,
} = require('../lib/agent-job-broker');
const { VoiceStateStore } = require('../lib/voice-state-store');

function createFixture(t, bridge = null) {
  const stateStore = new VoiceStateStore({ dbPath: ':memory:' });
  t.after(() => stateStore.close());
  const calls = [];
  const agentBridge = bridge || {
    async queryDetailed(request, options) {
      calls.push({ request, options });
      return {
        success: true,
        response: `🗣️ VOICE_RESPONSE: Finished ${request}`,
        sessionId: `provider-${options.sessionType}`,
        provider: options.sessionType.includes('codex') ? 'codex' : 'claude',
        duration_ms: 25,
      };
    },
    async cancelSession() {
      return { success: true, canceledCount: 1 };
    },
  };
  const broker = new AgentJobBroker({ stateStore, agentBridge });
  const thread = stateStore.createThread({ callerId: '1001', selectedProfile: 'codex-terra' });
  const realtime = stateStore.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-1',
    model: 'gpt-realtime-2.1',
  });
  return { broker, calls, realtime, stateStore, thread };
}

test('profile aliases normalize and mutating requests require confirmation', () => {
  assert.equal(normalizeProfile('Terra'), 'codex-terra');
  assert.equal(normalizeProfile('phone-opus'), 'claude-opus');
  assert.equal(normalizeProfile('unknown'), null);
  assert.equal(needsApproval('Inspect the working tree and report status.'), false);
  assert.equal(needsApproval('Deploy the service to production.'), true);
  assert.equal(profileCan('codex-luna', 'write'), false);
  assert.equal(profileCan('claude-opus', 'admin'), true);
  assert.equal(refersToTargetedSession('Send this message to the existing Codex session in tmux main:phone.'), true);
  assert.equal(refersToTargetedSession('Ask Codex Terra to inspect tmux status.'), false);
});

test('generic managed-session dispatch refuses to impersonate delivery to an existing tmux conversation', async (t) => {
  const { broker, realtime, thread } = createFixture(t);
  const denied = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'wrong-delivery-tool',
    profile: 'codex-terra',
    request: 'Send this message to the existing Codex session in tmux main:phone.',
  });
  assert.equal(denied.accepted, false);
  assert.equal(denied.code, 'TARGETED_SESSION_REQUIRED');
});

test('targeted tmux messages always require pound approval and complete only after provider verification', async (t) => {
  const sends = [];
  const bridge = {
    async prepareAgentSessionMessage(target) {
      assert.equal(target, 'main:phone');
      return {
        success: true,
        result: {
          target: 'main:5.1',
          stable_target: '%12',
          named_target: 'main:phone.1',
          provider: 'codex',
          conversation_name: 'phone',
          session_fingerprint: 'private-fingerprint',
          resolution: 'open_provider_log',
        },
      };
    },
    async sendAgentSessionMessage(options) {
      sends.push(options);
      return {
        success: true,
        result: {
          provider: 'codex',
          target: 'main:5.1',
          delivered: true,
          response_verified: true,
          response: 'I applied the requested follow-up.',
          duration_ms: 42,
        },
      };
    },
    async cancelSession() { return { success: true }; },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const pending = await broker.startTargetedSessionTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'target-message-1',
    target: 'main:phone',
    message: 'What is the latest status?',
  });
  assert.equal(pending.accepted, true);
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(pending.job_kind, 'tmux_agent_message');
  assert.equal(pending.target, 'main:phone.1');
  assert.equal(pending.stable_target, '%12');
  assert.equal(pending.risk, 'mutating');
  assert.match(pending.approval_summary, /Codex window phone in tmux main/);
  assert.match(pending.spoken_approval_prompt, /Press pound to approve or star to cancel/);
  assert.equal(sends.length, 0);
  assert.doesNotMatch(JSON.stringify(pending), /private-fingerprint/);

  const completion = once(broker, 'job.completed');
  assert.equal(broker.approveNextJob(thread.id).approved, true);
  const [completed] = await completion;
  assert.equal(completed.status, 'completed');
  assert.match(completed.voice_result, /Codex window phone in tmux main replied/);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].operationId, pending.job_id);
  assert.equal(sends[0].target, '%12');
  assert.equal(sends[0].sessionFingerprint, 'private-fingerprint');
  assert.equal(sends[0].authorization.method, 'dtmf-pound');
  assert.equal(sends[0].authorization.request_sha256.length, 64);
  const stored = stateStore.getJob(pending.job_id);
  assert.equal(stored.fullResult.response_verified, true);
  assert.doesNotMatch(JSON.stringify(stored.fullResult), /private-fingerprint/);
  assert.deepEqual(
    stateStore.listAuditEvents({ jobId: pending.job_id }).map((event) => event.action),
    [
      'target_session_approval_requested',
      'approval_granted',
      'target_session_message_started',
      'target_session_message_verified',
    ]
  );
});

test('targeted cancellation preserves a provider result that completed during reconciliation', async (t) => {
  let resolveSend;
  const bridge = {
    async prepareAgentSessionMessage() {
      return {
        success: true,
        result: {
          target: 'main:5.1',
          stable_target: '%12',
          named_target: 'main:phone.1',
          provider: 'codex',
          conversation_name: 'phone',
          session_fingerprint: 'private-fingerprint',
        },
      };
    },
    async sendAgentSessionMessage() {
      return new Promise((resolve) => { resolveSend = resolve; });
    },
    async cancelSession() {
      resolveSend({
        success: true,
        result: {
          provider: 'codex',
          target: 'main:5.1',
          delivered: true,
          response_verified: true,
          response: 'The requested check completed.',
          cancellation_arrived_after_completion: true,
        },
      });
      return { success: true };
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const pending = await broker.startTargetedSessionTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'target-cancel-race',
    target: 'main:phone',
    message: 'Run the requested check.',
  });
  broker.approveNextJob(thread.id);
  while (!resolveSend) await new Promise((resolve) => setImmediate(resolve));

  const result = await broker.cancelAgentTask(thread.id, pending.job_id, 'Canceled with DTMF star');
  assert.equal(result.canceled, false);
  assert.equal(result.code, 'JOB_ALREADY_COMPLETED');
  assert.match(result.message, /requested check completed/);
  const stored = stateStore.getJob(pending.job_id);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.fullResult.cancellation_arrived_after_completion, true);
  assert.equal(
    stateStore.listAuditEvents({ jobId: pending.job_id }).some((event) => event.action === 'job_canceled'),
    false
  );
});

test('delivery followed by cancellation is completed as a truthful partial side effect', async (t) => {
  const bridge = {
    async prepareAgentSessionMessage() {
      return {
        success: true,
        result: {
          target: 'main:5.1',
          stable_target: '%12',
          named_target: 'main:phone.1',
          provider: 'codex',
          conversation_name: 'phone',
          session_fingerprint: 'private-fingerprint',
        },
      };
    },
    async sendAgentSessionMessage() {
      return {
        success: true,
        result: {
          provider: 'codex',
          target: 'main:5.1',
          delivered: true,
          response_verified: false,
          canceled_after_delivery: true,
        },
      };
    },
    async cancelSession() { return { success: true }; },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const pending = await broker.startTargetedSessionTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'target-delivered-canceled',
    target: 'main:phone',
    message: 'Run the requested check.',
  });
  const completion = once(broker, 'job.completed');
  broker.approveNextJob(thread.id);
  const [completed] = await completion;

  assert.equal(completed.status, 'completed');
  assert.match(completed.voice_result, /received the message.*cancellation interrupted/i);
  assert.equal(completed.fullResult.canceled_after_delivery, true);
  assert.ok(stateStore.listAuditEvents({ jobId: pending.job_id })
    .some((event) => event.action === 'target_session_message_delivered_then_canceled'));
});

test('automatic routing preserves provider preference and selects capability tiers', () => {
  assert.equal(routedProfile({
    requestedProfile: 'auto', selectedProfile: 'codex-terra', request: 'Read status.', capability: 'read',
  }).profile, 'codex-luna');
  assert.equal(routedProfile({
    requestedProfile: 'auto', selectedProfile: 'claude-haiku', request: 'Implement this.', capability: 'write',
  }).profile, 'claude-sonnet');
  assert.equal(routedProfile({
    requestedProfile: 'auto', selectedProfile: 'codex-luna', request: 'Deploy this.', capability: 'admin',
  }).profile, 'codex-sol');
  assert.equal(routedProfile({
    requestedProfile: 'auto', selectedProfile: 'claude-sonnet', request: 'Do a deep architecture review.', capability: 'read',
  }).profile, 'claude-opus');
  assert.equal(routedProfile({
    requestedProfile: 'auto', selectedProfile: 'codex-terra', request: 'Ask Claude Sonnet to inspect it.', capability: 'read',
  }).profile, 'claude-sonnet');
});

test('read-only tasks execute asynchronously and persist provider sessions by profile', async (t) => {
  const { broker, calls, realtime, stateStore, thread } = createFixture(t);
  const completedEvent = once(broker, 'job.completed');
  const accepted = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'tool-1',
    profile: 'terra',
    request: 'Inspect repository status.',
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status, 'queued');
  const [completed] = await completedEvent;
  assert.equal(completed.status, 'completed');
  assert.match(completed.voice_result, /Finished Inspect repository status/);
  assert.equal(calls[0].options.callId, completed.id);
  assert.match(calls[0].options.sessionKey, new RegExp(`^${thread.id}:codex-terra:`));

  const secondCompletion = once(broker, 'job.completed');
  await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'tool-2',
    profile: 'sonnet',
    request: 'Inspect the tests.',
  });
  await secondCompletion;

  const terra = stateStore.getAgentSession(thread.id, 'codex-terra');
  const sonnet = stateStore.getAgentSession(thread.id, 'claude-sonnet');
  assert.equal(terra.provider, 'codex');
  assert.equal(sonnet.provider, 'claude');
  assert.notEqual(terra.bridge_session_key, sonnet.bridge_session_key);
});

test('tool-call retries are idempotent', async (t) => {
  const { broker, realtime, thread } = createFixture(t);
  const completedEvent = once(broker, 'job.completed');
  const request = {
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'same-call-id',
    profile: 'codex-luna',
    request: 'Read the README.',
  };
  const first = await broker.startAgentTask(request);
  const retry = await broker.startAgentTask(request);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.job_id, first.job_id);
  await completedEvent;
});

test('mutating tasks wait for DTMF approval before execution', async (t) => {
  const { broker, calls, realtime, thread } = createFixture(t);
  const pending = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'mutating-call',
    profile: 'codex-sol',
    request: 'Deploy the updated phone service.',
  });

  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(pending.requires_confirmation, true);
  assert.equal(calls.length, 0);

  const completion = once(broker, 'job.completed');
  const approval = broker.approveNextJob(thread.id);
  assert.equal(approval.approved, true);
  const [job] = await completion;
  assert.equal(job.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.authorization.job_id, pending.job_id);
  assert.equal(calls[0].options.authorization.method, 'dtmf-pound');
  assert.equal(calls[0].options.authorization.request_sha256.length, 64);

  const audit = broker.stateStore.listAuditEvents({ jobId: pending.job_id });
  assert.deepEqual(audit.map((event) => event.action), [
    'approval_requested',
    'approval_granted',
    'job_started',
    'job_completed',
  ]);
});

test('all six profiles are visible and explicit underscoped profiles are rejected', async (t) => {
  const { broker, realtime, thread } = createFixture(t);
  assert.deepEqual(broker.listProfileDetails().map((entry) => [entry.profile, entry.capability]), [
    ['claude-haiku', 'read'],
    ['claude-sonnet', 'write'],
    ['claude-opus', 'admin'],
    ['codex-luna', 'read'],
    ['codex-terra', 'write'],
    ['codex-sol', 'admin'],
  ]);

  const denied = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'underscoped',
    profile: 'codex-luna',
    request: 'Deploy the updated service.',
  });
  assert.equal(denied.accepted, false);
  assert.equal(denied.code, 'AGENT_PROFILE_CAPABILITY_REQUIRED');
  assert.equal(denied.suggested_profile, 'codex-sol');
});

test('only one mutating operation can hold the focused pound approval', async (t) => {
  const { broker, realtime, thread } = createFixture(t);
  const first = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'approval-one',
    profile: 'codex-sol',
    request: 'Deploy preview one.',
  });
  const second = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'approval-two',
    profile: 'claude-opus',
    request: 'Deploy preview two.',
  });
  assert.equal(first.status, 'awaiting_approval');
  assert.equal(second.accepted, false);
  assert.equal(second.code, 'APPROVAL_ALREADY_FOCUSED');
  assert.equal(second.active_job.job_id, first.job_id);
});

test('canceling a running task targets only its job call id', async (t) => {
  let resolveQuery;
  const cancellations = [];
  const bridge = {
    queryDetailed() {
      return new Promise((resolve) => { resolveQuery = resolve; });
    },
    async cancelSession(callId, options) {
      cancellations.push({ callId, options });
      return { success: true, canceledCount: 1 };
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const running = once(broker, 'job.updated');
  const accepted = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'cancel-call',
    profile: 'codex-luna',
    request: 'Inspect every service log.',
  });
  await running;

  const result = await broker.cancelAgentTask(thread.id, accepted.job_id, 'DTMF star');
  assert.equal(result.canceled, true);
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].callId, accepted.job_id);
  assert.equal(stateStore.getJob(accepted.job_id).status, 'canceled');

  const settled = once(broker, 'job.updated');
  resolveQuery({
    success: true,
    response: 'This late result must not overwrite cancellation.',
    sessionId: 'late-session',
  });
  await settled;
  assert.equal(stateStore.getJob(accepted.job_id).status, 'canceled');
  assert.equal(
    stateStore.getAgentSession(thread.id, 'codex-luna').provider_session_id,
    null
  );
});

test('listener failures cannot turn a completed job into a failed job', async (t) => {
  const { broker, realtime, stateStore, thread } = createFixture(t);
  broker.on('job.completed', () => { throw new Error('disconnected voice listener'); });
  const listenerError = once(broker, 'listener.error');

  const accepted = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'listener-call',
    profile: 'codex-terra',
    request: 'Inspect repository status.',
  });

  const [event] = await listenerError;
  assert.equal(event.eventName, 'job.completed');
  assert.match(event.error.message, /disconnected voice listener/);
  assert.equal(stateStore.getJob(accepted.job_id).status, 'completed');
});

test('panic stop locks dispatch, cancels all jobs, and requires an explicit unlock', async (t) => {
  const bridgeStops = [];
  const bridge = {
    queryDetailed() {
      return new Promise(() => {});
    },
    async cancelSession() {
      return { success: true, canceledCount: 1 };
    },
    async panicStop(options) {
      bridgeStops.push(options);
      return { success: true, canceledCount: 1 };
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const running = once(broker, 'job.updated');
  const active = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'panic-running',
    profile: 'codex-luna',
    request: 'Inspect every service log.',
  });
  await running;
  const pending = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'panic-pending',
    profile: 'codex-sol',
    request: 'Restart the service.',
  });

  const stopped = await broker.panicStop('Dial 9 emergency stop', 'asterisk_1001');
  assert.equal(stopped.locked, true);
  assert.equal(stopped.canceledCount, 2);
  assert.equal(stopped.runningCount, 1);
  assert.equal(stopped.bridge.success, true);
  assert.deepEqual(bridgeStops, [{ reason: 'Dial 9 emergency stop', source: 'asterisk_1001' }]);
  assert.equal(stateStore.getJob(active.job_id).status, 'canceled');
  assert.equal(stateStore.getJob(pending.job_id).status, 'canceled');

  const blocked = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'panic-blocked',
    profile: 'codex-luna',
    request: 'Inspect the README.',
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.code, 'VOICE_EXECUTION_LOCKED');

  broker.setExecutionLocked(false);
  broker.agentBridge.queryDetailed = async () => ({
    success: true,
    response: 'Done',
    sessionId: 'restored-session',
  });
  const completion = once(broker, 'job.completed');
  const restored = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'panic-restored',
    profile: 'codex-luna',
    request: 'Read the README.',
  });
  const [completed] = await completion;
  assert.equal(restored.accepted, true);
  assert.equal(completed.status, 'completed');
});
