'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const { VoiceExecutionControl } = require('../../lib/voice-execution-control');
const {
  MemoryCapabilityReplayStore,
  createApprovalCapabilityIssuer,
  createApprovalCapabilityVerifier,
  generateApprovalCapabilityKeyPair,
  hashApprovalPlan,
} = require('../../lib/voice-approval-capability');
const {
  buildManagedAgentApprovalPlan,
  buildTargetSessionApprovalPlan,
  managedAgentTarget,
} = require('../../lib/voice-authorization-plan');

const approvalKeyPair = generateApprovalCapabilityKeyPair();

function createTestApprovalIssuer() {
  return createApprovalCapabilityIssuer({
    privateKey: approvalKeyPair.privateKey,
    keyId: 'test-controller-1',
  });
}

function createFixture(t, bridge = null, options = {}) {
  const stateStore = new VoiceStateStore({ dbPath: ':memory:' });
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
  const broker = new AgentJobBroker({
    stateStore,
    agentBridge,
    approvalCapabilityIssuer: Object.hasOwn(options, 'approvalCapabilityIssuer')
      ? options.approvalCapabilityIssuer
      : createTestApprovalIssuer(),
    callbackDispatcher: options.callbackDispatcher,
    executionControl: options.executionControl,
    privilegedActionBridge: options.privilegedActionBridge,
    outboundControl: options.outboundControl,
    reconciliationBaseDelayMs: options.reconciliationBaseDelayMs,
    reconciliationMaxDelayMs: options.reconciliationMaxDelayMs,
    reconciliationPollWindowMs: options.reconciliationPollWindowMs,
    callbackRetryBaseMs: options.callbackRetryBaseMs,
    callbackRetryMaxMs: options.callbackRetryMaxMs,
    callbackLeaseMs: options.callbackLeaseMs,
  });
  t.after(() => {
    broker.close();
    stateStore.close();
  });
  const thread = stateStore.createThread({ callerId: '1001', selectedProfile: 'codex-terra' });
  const realtime = stateStore.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-1',
    model: 'gpt-realtime-2.1',
  });
  return { broker, calls, realtime, stateStore, thread };
}

function armFocusedApproval(broker, stateStore, threadId) {
  const focused = stateStore.getFocusedJob(threadId);
  const realtime = stateStore.db.prepare(
    'SELECT call_id FROM realtime_sessions WHERE id = ?'
  ).get(focused?.realtime_session_id);
  const spokenPrompt = focused?.operation?.spokenApprovalPrompt;
  assert.ok(spokenPrompt, 'focused approval must retain its exact spoken prompt');
  const armed = broker.armFocusedApproval(threadId, {
    spokenPrompt,
    purpose: 'approval_prompt',
    responseId: `response-${focused.id}`,
    itemId: `item-${focused.id}`,
    playbackCompletedAt: new Date().toISOString(),
    playoutMarker: `marker-${focused.id}`,
    playoutBoundary: 'freeswitch_playout_marker',
    callId: realtime?.call_id,
    realtimeSessionId: focused.realtime_session_id,
  });
  assert.equal(armed.changed, true);
  return armed.job;
}

function approvalContext(stateStore, threadId) {
  const focused = stateStore.getFocusedJob(threadId);
  return {
    callId: focused?.approvalArmCallId,
    realtimeSessionId: focused?.approvalArmRealtimeSessionId,
  };
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
  assert.match(denied.message, /unavailable from production phone/);
  assert.doesNotMatch(denied.message, /send_agent_session_message/);
});

test('cross-agent handoff prompt stays inside the production read-only boundary', async (t) => {
  const { broker, calls, realtime, thread } = createFixture(t);
  const completion = once(broker, 'job.completed');
  const accepted = await broker.handoffAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'read-only-handoff',
    fromProfile: 'claude-haiku',
    toProfile: 'codex-terra',
    objective: 'Inspect the current repository status.',
    additionalContext: 'The prior profile reported a clean working tree.',
  });
  assert.equal(accepted.accepted, true);
  await completion;
  assert.equal(calls.length, 1);
  assert.match(calls[0].request, /return read-only findings only/);
  assert.doesNotMatch(calls[0].request, /before changing it|send_agent_session_message/);
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
  armFocusedApproval(broker, stateStore, thread.id);
  assert.equal(
    broker.approveNextJob(thread.id, approvalContext(stateStore, thread.id)).approved,
    true
  );
  const [completed] = await completion;
  assert.equal(completed.status, 'completed');
  assert.match(completed.voice_result, /Codex window phone in tmux main replied/);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].operationId, pending.job_id);
  assert.equal(sends[0].target, '%12');
  assert.equal(sends[0].sessionFingerprint, 'private-fingerprint');
  assert.equal(sends[0].authorization.method, 'dtmf-pound');
  assert.match(sends[0].authorization.capability, /^telecap1\./);
  const targetPlan = buildTargetSessionApprovalPlan({
    jobId: pending.job_id,
    target: '%12',
    message: 'What is the latest status?',
    sessionFingerprint: 'private-fingerprint',
    timeoutSeconds: 1800,
  });
  const targetVerifier = createApprovalCapabilityVerifier({
    publicKeys: { 'test-controller-1': approvalKeyPair.publicKey },
    replayStore: new MemoryCapabilityReplayStore(),
  });
  await targetVerifier.consume(sends[0].authorization.capability, {
    jobId: pending.job_id,
    requestHash: stateStore.getJob(pending.job_id).request_hash,
    planHash: hashApprovalPlan(targetPlan),
    target: '%12',
    provider: 'codex',
    profile: 'codex-terra',
  });
  const stored = stateStore.getJob(pending.job_id);
  assert.equal(stored.fullResult.response_verified, true);
  assert.doesNotMatch(JSON.stringify(stored.fullResult), /private-fingerprint/);
  assert.deepEqual(
    stateStore.listAuditEvents({ jobId: pending.job_id }).map((event) => event.action),
    [
      'target_session_approval_requested',
      'approval_prompt_armed',
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
  armFocusedApproval(broker, stateStore, thread.id);
  broker.approveNextJob(thread.id, approvalContext(stateStore, thread.id));
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
  armFocusedApproval(broker, stateStore, thread.id);
  broker.approveNextJob(thread.id, approvalContext(stateStore, thread.id));
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

test('read-only tasks persist Teleagent profile bindings but discard provider sessions', async (t) => {
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
  assert.equal(terra.provider_session_id, null);
  assert.equal(sonnet.provider_session_id, null);
  assert.equal(Object.hasOwn(calls[0].options, 'resumeSessionId'), false);
});

test('callback delivery remains pending until the receiver explicitly confirms durable queueing', async (t) => {
  const deliveries = [];
  const { broker, stateStore, realtime, thread } = createFixture(t, null, {
    callbackRetryBaseMs: 10,
    callbackRetryMaxMs: 10,
    callbackLeaseMs: 1000,
    callbackDispatcher: async (job, callbackThread, delivery) => {
      deliveries.push({ job, callbackThread, delivery });
      if (deliveries.length === 1) return { queued: false, reason: 'receiver_not_ready' };
      const reservation = stateStore.reserveOutboundCall({
        idempotencyKey: delivery.idempotencyKey,
        callId: 'callback-call-stable',
        request: {
          to: callbackThread.callback_target || '1001',
          message: job.voice_result,
          mode: 'announce',
        },
      });
      return { queued: true, callId: reservation.callId };
    },
  });
  const completion = once(broker, 'job.completed');
  const started = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'callback-durable-ack',
    profile: 'codex-luna',
    request: 'Inspect service health.',
    notificationMode: 'callback',
  });
  const [completed] = await completion;
  assert.equal(completed.id, started.job_id);

  const deadline = Date.now() + 1000;
  while (deliveries.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].delivery.idempotencyKey, `callback:${started.job_id}`);
  assert.equal(deliveries[1].delivery.idempotencyKey, deliveries[0].delivery.idempotencyKey);
  assert.equal(stateStore.getCallbackOutbox(started.job_id).state, 'awaiting_outbound');
  stateStore.claimOutboundCallIntent({
    idempotencyKey: deliveries[1].delivery.idempotencyKey,
    callId: 'callback-call-stable',
  });
  stateStore.markOutboundCallTerminal({
    idempotencyKey: deliveries[1].delivery.idempotencyKey,
    callId: 'callback-call-stable',
    state: 'completed',
  });
  assert.equal(stateStore.getCallbackOutbox(started.job_id).state, 'delivered');
  assert.equal(stateStore.getJob(started.job_id).notification_attempts, 2);
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

test('intentional identical requests with different tool calls create distinct jobs', async (t) => {
  const { broker, calls, realtime, thread } = createFixture(t);
  const completedEvent = once(broker, 'job.completed');
  const first = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'dedupe-first',
    profile: 'codex-luna',
    request: 'Inspect the current service health.',
  });
  await completedEvent;

  const secondCompletion = once(broker, 'job.completed');
  const duplicate = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'dedupe-second',
    profile: 'codex-luna',
    request: 'Inspect the current service health.',
  });
  assert.equal(duplicate.accepted, true);
  await secondCompletion;
  assert.equal(duplicate.duplicate, undefined);
  assert.notEqual(duplicate.job_id, first.job_id);
  assert.equal(calls.length, 2);
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
  armFocusedApproval(broker, broker.stateStore, thread.id);
  const approval = broker.approveNextJob(
    thread.id,
    approvalContext(broker.stateStore, thread.id)
  );
  assert.equal(approval.approved, true);
  const [job] = await completion;
  assert.equal(job.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.authorization.method, 'dtmf-pound');
  assert.match(calls[0].options.authorization.capability, /^telecap1\./);
  const managedPlan = buildManagedAgentApprovalPlan({
    jobId: pending.job_id,
    request: 'Deploy the updated phone service.',
    sessionKey: calls[0].options.sessionKey,
    sessionType: calls[0].options.sessionType,
    timeoutSeconds: calls[0].options.timeout,
  });
  const managedVerifier = createApprovalCapabilityVerifier({
    publicKeys: { 'test-controller-1': approvalKeyPair.publicKey },
    replayStore: new MemoryCapabilityReplayStore(),
  });
  await managedVerifier.consume(calls[0].options.authorization.capability, {
    jobId: pending.job_id,
    requestHash: broker.stateStore.getJob(pending.job_id).request_hash,
    planHash: hashApprovalPlan(managedPlan),
    target: managedAgentTarget(calls[0].options.sessionKey),
    provider: 'codex',
    profile: 'codex-sol',
  });

  const audit = broker.stateStore.listAuditEvents({ jobId: pending.job_id });
  assert.deepEqual(audit.map((event) => event.action), [
    'approval_requested',
    'approval_prompt_armed',
    'approval_granted',
    'job_started',
    'job_completed',
  ]);
});

test('mutating and targeted work fail closed when the controller has no signing issuer', async t => {
  const prepares = [];
  const bridge = {
    async queryDetailed() {
      throw new Error('Mutating work must not reach the bridge.');
    },
    async prepareAgentSessionMessage(target) {
      prepares.push(target);
      throw new Error('Target preparation must not run without a signing issuer.');
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge, {
    approvalCapabilityIssuer: null,
  });

  const mutating = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'unsigned-mutation',
    profile: 'codex-luna',
    request: 'Restart the phone service.',
  });
  assert.equal(mutating.accepted, false);
  assert.equal(mutating.code, 'APPROVAL_CAPABILITY_UNAVAILABLE');
  assert.match(mutating.message, /Production phone authority is read-only/);
  assert.doesNotMatch(mutating.message, /codex-sol|write|admin|press pound/i);
  assert.equal(stateStore.listJobs(thread.id).length, 0);

  const targeted = await broker.startTargetedSessionTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'unsigned-target',
    target: 'main:phone',
    message: 'Inspect status.',
  });
  assert.equal(targeted.accepted, false);
  assert.equal(targeted.code, 'APPROVAL_CAPABILITY_UNAVAILABLE');
  assert.deepEqual(prepares, []);

  const noPending = broker.approveNextJob(thread.id);
  assert.equal(noPending.code, 'NO_PENDING_APPROVAL');
});

test('a persisted approval cannot cross into execution after the signing issuer becomes unavailable', async t => {
  const { broker, calls, realtime, stateStore, thread } = createFixture(t);
  const pending = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'signer-lost-after-prompt',
    profile: 'codex-sol',
    request: 'Restart the phone service.',
  });
  assert.equal(pending.status, 'awaiting_approval');

  broker.approvalCapabilityIssuer = null;
  const approval = broker.approveNextJob(thread.id);
  assert.equal(approval.approved, false);
  assert.equal(approval.code, 'APPROVAL_CAPABILITY_UNAVAILABLE');
  assert.equal(stateStore.getJob(pending.job_id).status, 'awaiting_approval');
  assert.equal(calls.length, 0);
});

test('expired and explicitly withdrawn approvals are canceled before execution', async (t) => {
  const { broker, calls, realtime, stateStore, thread } = createFixture(t);
  const expiring = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'expiring-approval',
    profile: 'codex-sol',
    request: 'Restart the phone service.',
  });
  stateStore.db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(
    new Date(Date.now() - 10 * 60000).toISOString(),
    expiring.job_id
  );
  const expired = broker.approveNextJob(thread.id);
  assert.equal(expired.approved, false);
  assert.equal(expired.code, 'APPROVAL_EXPIRED');
  assert.equal(stateStore.getJob(expiring.job_id).status, 'canceled');
  assert.equal(calls.length, 0);
  assert.ok(stateStore.listAuditEvents({ jobId: expiring.job_id })
    .some((event) => event.action === 'approval_expired'));

  const withdrawable = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'withdrawn-approval',
    profile: 'codex-sol',
    request: 'Deploy the phone service.',
  });
  const withdrawn = broker.cancelPendingApprovals(
    thread.id,
    'Caller changed their mind',
    'voice_cancel'
  );
  assert.equal(withdrawn.canceled, true);
  assert.deepEqual(withdrawn.jobs.map((job) => job.job_id), [withdrawable.job_id]);
  assert.equal(stateStore.getJob(withdrawable.job_id).status, 'canceled');
  assert.equal(calls.length, 0);
});

test('all six profiles are visible and explicit underscoped profiles are rejected', async (t) => {
  const { broker, realtime, thread } = createFixture(t);
  assert.deepEqual(broker.listProfileDetails().map((entry) => [entry.profile, entry.capability]), [
    ['claude-haiku', 'read_only'],
    ['claude-sonnet', 'read_only'],
    ['claude-opus', 'read_only'],
    ['codex-luna', 'read_only'],
    ['codex-terra', 'read_only'],
    ['codex-sol', 'read_only'],
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

test('canceling a running task remains pending until terminal executor truth arrives', async (t) => {
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
  assert.equal(result.canceled, false);
  assert.equal(result.code, 'CANCEL_RECONCILIATION_PENDING');
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].callId, accepted.job_id);
  assert.equal(cancellations[0].options.idempotencyKey, accepted.job_id);
  assert.equal(stateStore.getJob(accepted.job_id).status, 'cancel_requested');

  const settled = once(broker, 'job.completed');
  resolveQuery({
    success: true,
    response: 'The task completed before cancellation reached terminal state.',
    sessionId: 'late-session',
  });
  await settled;
  assert.equal(stateStore.getJob(accepted.job_id).status, 'completed');
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

test('startup recovery schedules durable queued jobs exactly once', async (t) => {
  const { broker, calls, realtime, stateStore, thread } = createFixture(t);
  const queued = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'recovered-read-job',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect the repository after restart.',
  }).job;

  const completion = once(broker, 'job.completed');
  assert.equal(broker.recoverDurableJobs(), 1);
  assert.equal(broker.recoverDurableJobs(), 1);
  const [completed] = await completion;

  assert.equal(completed.id, queued.id);
  assert.equal(completed.status, 'completed');
  assert.equal(calls.length, 1);
});

test('startup without an issuer cancels a fresh legacy approval before it can be replayed', (t) => {
  const { broker, calls, realtime, stateStore, thread } = createFixture(t, null, {
    approvalCapabilityIssuer: null,
  });
  const pending = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'fresh-legacy-approval',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Restart the phone service.',
    requiresApproval: true,
    riskLevel: 'mutating',
    operation: {
      spokenApprovalPrompt: 'Approval needed. Restart the phone service. Press pound to approve or star to cancel.',
    },
    approvalPrompt: 'Approval needed. Restart the phone service. Press pound to approve or star to cancel.',
  }).job;

  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(broker.recoverDurableJobs(), 0);

  const canceled = stateStore.getJob(pending.id);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.notification_status, 'skipped');
  assert.match(canceled.error, /authority is disabled/);
  assert.equal(stateStore.getFocusedJob(thread.id), null);
  assert.equal(
    stateStore.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(pending.id).status,
    'rejected'
  );
  assert.equal(
    stateStore.db.prepare(`
      SELECT COUNT(*) AS count FROM operation_audit
      WHERE job_id = ? AND action = 'approval_authority_retired'
    `).get(pending.id).count,
    1
  );
  assert.equal(broker.approveNextJob(thread.id).code, 'NO_PENDING_APPROVAL');
  assert.equal(calls.length, 0);
});

test('startup recovery refuses to mint a new capability for an expired approval', async (t) => {
  const { broker, calls, realtime, stateStore, thread } = createFixture(t);
  const pending = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'recovered-stale-mutation',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Restart the phone service.',
    requiresApproval: true,
    riskLevel: 'mutating',
    operation: { spokenApprovalPrompt: 'Approval needed. Restart the phone service. Press pound to approve or star to cancel.' },
    approvalPrompt: 'Approval needed. Restart the phone service. Press pound to approve or star to cancel.',
  }).job;
  armFocusedApproval(broker, stateStore, thread.id);
  const approved = stateStore.approveNextJob(thread.id, {
    method: 'dtmf-pound',
    decidedBy: 'caller',
    ...approvalContext(stateStore, thread.id),
  });
  stateStore.db.prepare('UPDATE jobs SET approved_at = ? WHERE id = ?').run(
    new Date(Date.now() - 10 * 60000).toISOString(),
    approved.id
  );

  const completion = once(broker, 'job.completed');
  assert.equal(broker.recoverDurableJobs(), 1);
  const [failed] = await completion;

  assert.equal(failed.id, pending.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /expired/i);
  assert.equal(calls.length, 0);
});

test('startup recovery resumes an existing durable task without minting a fresh capability', async (t) => {
  let directQueries = 0;
  const bridge = {
    async getExecutorTaskByIdempotency(jobId) {
      return { id: 'xtask-existing', idempotencyKey: jobId, terminal: false };
    },
    async waitForExecutorTask(task) {
      assert.equal(task.id, 'xtask-existing');
      return {
        success: true,
        response: '🗣️ VOICE_RESPONSE: The existing durable task completed.',
        sessionId: 'reconciled-session',
        provider: 'codex',
        duration_ms: 42,
      };
    },
    async queryDetailed() {
      directQueries += 1;
      throw new Error('A reconciled task must never be submitted again.');
    },
  };
  const issuer = {
    issue() {
      throw new Error('An existing task must not receive a new capability.');
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge, {
    approvalCapabilityIssuer: issuer,
  });
  const pending = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'recovered-existing-mutation',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Restart the phone service.',
    requiresApproval: true,
    riskLevel: 'mutating',
    operation: { spokenApprovalPrompt: 'Approval needed. Restart the phone service. Press pound to approve or star to cancel.' },
    approvalPrompt: 'Approval needed. Restart the phone service. Press pound to approve or star to cancel.',
  }).job;
  armFocusedApproval(broker, stateStore, thread.id);
  const approved = stateStore.approveNextJob(
    thread.id,
    approvalContext(stateStore, thread.id)
  );
  stateStore.markJobRunning(approved.id);
  stateStore.db.prepare('UPDATE jobs SET approved_at = ? WHERE id = ?').run(
    new Date(Date.now() - 10 * 60000).toISOString(),
    approved.id
  );
  stateStore.recoverInterruptedJobs();

  const completion = once(broker, 'job.completed');
  assert.equal(broker.recoverDurableJobs(), 1);
  const [completed] = await completion;

  assert.equal(completed.id, pending.id);
  assert.equal(completed.status, 'completed');
  assert.equal(directQueries, 0);
});

test('startup lookup outage stays nonterminal and never resubmits interrupted work', async (t) => {
  let directQueries = 0;
  const bridge = {
    async getExecutorTaskByIdempotency() {
      throw new Error('executor unavailable');
    },
    async waitForExecutorTask() {
      throw new Error('must not wait without an identified task');
    },
    async queryDetailed() {
      directQueries += 1;
      throw new Error('must not resubmit an ambiguous interrupted task');
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const queued = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'recovered-ambiguous-read',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect the repository.',
  }).job;
  stateStore.markJobRunning(queued.id);
  stateStore.recoverInterruptedJobs();

  const reconciliation = once(broker, 'job.updated');
  assert.equal(broker.recoverDurableJobs(), 1);
  await reconciliation;
  const pending = stateStore.getJob(queued.id);

  assert.equal(pending.status, 'reconciling');
  assert.match(pending.error, /lookup is pending/i);
  assert.equal(directQueries, 0);
});

test('interrupted fresh-session work preserves its original bridge binding', async (t) => {
  const submissions = [];
  const bridge = {
    async getExecutorTaskByIdempotency() {
      return null;
    },
    async queryDetailed(request, options) {
      submissions.push({ request, options });
      return {
        success: true,
        response: '🗣️ VOICE_RESPONSE: Recovery used the original fresh session.',
        sessionId: 'provider-session-after-recovery',
        provider: 'codex',
      };
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  stateStore.upsertAgentSession({
    voiceThreadId: thread.id,
    profile: 'codex-luna',
    provider: 'codex',
    bridgeSessionKey: 'old-bridge-session',
    providerSessionId: 'old-provider-session',
  });
  const interrupted = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'fresh-session-before-crash',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect the repository in a fresh session.',
    freshSession: true,
  }).job;
  const binding = stateStore.bindJobAgentSession({
    jobId: interrupted.id,
    provider: 'codex',
    bridgeSessionKey: 'fresh-bridge-session-before-crash',
  });
  assert.equal(binding.job.bridge_session_key, 'fresh-bridge-session-before-crash');
  assert.equal(binding.job.resume_session_id, null);
  stateStore.markJobRunning(interrupted.id);
  stateStore.recoverInterruptedJobs();

  const completion = once(broker, 'job.completed');
  assert.equal(broker.recoverDurableJobs(), 1);
  const [completed] = await completion;

  assert.equal(completed.status, 'completed');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].options.sessionKey, 'fresh-bridge-session-before-crash');
  assert.equal(Object.hasOwn(submissions[0].options, 'resumeSessionId'), false);
  const persisted = stateStore.getJob(interrupted.id);
  assert.equal(persisted.bridge_session_key, 'fresh-bridge-session-before-crash');
  assert.equal(
    stateStore.getAgentSession(thread.id, 'codex-luna').provider_session_id,
    null
  );
});

test('interrupted target delivery with no executor record becomes outcome unknown and is never resent', async (t) => {
  let targetSubmissions = 0;
  const bridge = {
    async getExecutorTaskByIdempotency() {
      return null;
    },
    async sendAgentSessionMessage() {
      targetSubmissions += 1;
      throw new Error('Interrupted target work must never be submitted again.');
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const targetJob = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'target-before-crash',
    profile: 'codex-terra',
    provider: 'codex',
    request: 'Check the latest target status.',
    jobKind: 'tmux_agent_message',
    operation: {
      target: '%12',
      sessionFingerprint: 'private-target-fingerprint',
    },
    riskLevel: 'mutating',
  }).job;
  stateStore.markJobRunning(targetJob.id);
  stateStore.recoverInterruptedJobs();

  const completion = once(broker, 'job.completed');
  assert.equal(broker.recoverDurableJobs(), 1);
  const [unknown] = await completion;

  assert.equal(unknown.status, 'outcome_unknown');
  assert.match(unknown.error, /was not resent/i);
  assert.equal(targetSubmissions, 0);
});

test('executor-reported target delivery uncertainty remains an explicit terminal outcome', async (t) => {
  const bridge = {
    async getExecutorTaskByIdempotency() {
      return { id: 'target-task-unknown', terminal: true };
    },
    async waitForExecutorTask() {
      return {
        success: false,
        code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
        agentCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
        error: 'The target marker could not be reconciled.',
      };
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const targetJob = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'target-unknown-terminal',
    profile: 'codex-terra',
    provider: 'codex',
    request: 'Check target status.',
    jobKind: 'tmux_agent_message',
    operation: { target: '%12', sessionFingerprint: 'private-target-fingerprint' },
  }).job;
  stateStore.markJobRunning(targetJob.id);
  stateStore.recoverInterruptedJobs();

  const completion = once(broker, 'job.completed');
  broker.recoverDurableJobs();
  const [unknown] = await completion;

  assert.equal(unknown.status, 'outcome_unknown');
  assert.match(unknown.error, /marker could not be reconciled/i);
});

test('privileged completion ignores and never persists broker output previews', (t) => {
  const { broker, realtime, stateStore, thread } = createFixture(t);
  const created = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'privileged-output-boundary',
    profile: 'privileged-action',
    provider: 'root-broker',
    request: '{"adapter":"systemctl"}',
    jobKind: 'privileged_action',
    operation: {
      target: 'hermes:systemd:teleagent.service',
      actionPlan: {
        expected_result: { description: 'The approved service state was observed.' },
      },
    },
    riskLevel: 'high',
  }).job;
  stateStore.markJobRunning(created.id);
  const secret = 'sk-proj-NEVER_CROSS_THE_VOICE_BOUNDARY';

  const completed = broker._finalizePrivilegedAction(stateStore.getJob(created.id), {
    id: 'pact-output-boundary',
    state: 'completed',
    completedAt: new Date().toISOString(),
    result: {
      success: true,
      expected: secret,
      argv_sha256: 'a'.repeat(64),
      execution: {
        exit_code: 0,
        duration_ms: 8,
        stdout: {
          bytes: 40,
          captured_bytes: 40,
          truncated: false,
          redacted: false,
          sha256: 'b'.repeat(64),
          preview: secret,
        },
        stderr: { preview: secret },
      },
      observable: { stdout: { preview: secret } },
      preview: secret,
    },
  });

  assert.equal(completed.status, 'completed');
  assert.match(completed.voice_result, /approved service state was observed/i);
  assert.doesNotMatch(completed.voice_result, /NEVER_CROSS/);
  assert.doesNotMatch(JSON.stringify(completed.fullResult), /NEVER_CROSS/);
  assert.equal(completed.fullResult.result.execution.stdout.preview, undefined);
  assert.equal(completed.fullResult.result.execution.stdout.sha256, 'b'.repeat(64));
});

test('accepted privileged action stays reconciling when result polling returns 503', async (t) => {
  let submissions = 0;
  const privilegedActionBridge = {
    async submit({ idempotencyKey, jobId, callId, plan }) {
      submissions += 1;
      return {
        id: 'pact-accepted-wait-503', idempotencyKey, jobId, callId,
        target: plan.target, plan, state: 'queued', terminal: false,
      };
    },
    async wait() {
      throw Object.assign(new Error('root broker temporarily unavailable'), {
        response: { status: 503, data: { code: 'PRIVILEGED_BROKER_UNAVAILABLE' } },
      });
    },
    async getByIdempotencyKey() {
      throw new Error('lookup unavailable');
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, null, {
    privilegedActionBridge,
    reconciliationBaseDelayMs: 5000,
    reconciliationMaxDelayMs: 5000,
  });
  const pending = await broker.startPrivilegedAction({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'privileged-wait-503',
    action: { adapter: 'systemctl', action: 'status', unit: 'teleagent.service' },
  });
  assert.equal(pending.accepted, true, JSON.stringify(pending));
  armFocusedApproval(broker, stateStore, thread.id);
  const updated = once(broker, 'job.updated');
  assert.equal(
    broker.approveNextJob(thread.id, approvalContext(stateStore, thread.id)).approved,
    true
  );
  await updated;
  const deadline = Date.now() + 1000;
  while (stateStore.getJob(pending.job_id).status !== 'reconciling' && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const job = stateStore.getJob(pending.job_id);
  assert.equal(job.status, 'reconciling');
  assert.equal(job.executor_task_id, 'pact-accepted-wait-503');
  assert.match(job.error, /remains uncertain/i);
  assert.equal(submissions, 1);
});

test('privileged reconciliation defers when bridge configuration is temporarily absent', async (t) => {
  const { broker, realtime, stateStore, thread } = createFixture(t, null, {
    reconciliationBaseDelayMs: 5000,
    reconciliationMaxDelayMs: 5000,
  });
  const job = stateStore.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'privileged-reconcile-no-bridge',
    profile: 'privileged-action',
    provider: 'root-broker',
    request: '{"approved":true}',
    jobKind: 'privileged_action',
    operation: { target: 'hermes:root:exact-argv' },
  }).job;
  stateStore.markJobRunning(job.id);
  stateStore.recoverInterruptedJobs();

  const reconciled = await broker._reconcilePrivilegedJob(stateStore.getJob(job.id));
  assert.equal(reconciled.status, 'reconciling');
  assert.match(reconciled.error, /not configured/i);
  assert.equal(reconciled.completed_at, null);
});

test('panic reserves every privileged idempotency key and requires root quiescence', async (t) => {
  const calls = [];
  const bridge = {
    async panicStop() { return { success: true }; },
  };
  const privilegedActionBridge = {
    async cancelByIdempotencyKey(idempotencyKey, jobId) {
      calls.push({ type: 'tombstone', idempotencyKey, jobId });
      return { success: true, tombstoned: true };
    },
    async panic() {
      calls.push({ type: 'panic' });
      return { success: true, persisted: true, quiesced: true };
    },
    async getByIdempotencyKey() { return null; },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge, {
    privilegedActionBridge,
    reconciliationBaseDelayMs: 5000,
    reconciliationMaxDelayMs: 5000,
  });
  const pending = await broker.startPrivilegedAction({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'privileged-panic-pending',
    action: { adapter: 'systemctl', action: 'status', unit: 'teleagent.service' },
  });
  assert.equal(pending.accepted, true, JSON.stringify(pending));

  const stopped = await broker.panicStop('Dial nine', 'asterisk_1001');
  assert.equal(stopped.bridge.success, true);
  assert.equal(stopped.bridge.privileged.quiesced, true);
  assert.deepEqual(calls.map((entry) => entry.type).sort(), ['panic', 'tombstone']);
  assert.deepEqual(calls.find((entry) => entry.type === 'tombstone'), {
    type: 'tombstone', idempotencyKey: pending.job_id, jobId: pending.job_id,
  });
  assert.equal(stateStore.getJob(pending.job_id).status, 'cancel_requested');
});

test('panic truth and unlock include durable outbound-call quiescence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-outbound-panic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executionControl = new VoiceExecutionControl({
    lockFile: path.join(directory, 'voice.lock.json'),
  });
  let outboundPanicAttempts = 0;
  let outboundUnlocks = 0;
  const outboundControl = {
    async panicOutboundCalls() {
      outboundPanicAttempts += 1;
      if (outboundPanicAttempts === 1) {
        return {
          success: false,
          persisted: true,
          quiesced: false,
          activeCount: 1,
          activeIds: ['outbound-active-call'],
        };
      }
      return { success: true, persisted: true, quiesced: true, activeCount: 0, activeIds: [] };
    },
    unlockOutboundCalls() {
      outboundUnlocks += 1;
      return { success: true, quiesced: true, locked: false };
    },
  };
  const { broker } = createFixture(t, {
    async panicStop() { return { success: true, quiesced: true }; },
  }, {
    executionControl,
    outboundControl,
    reconciliationBaseDelayMs: 10,
    reconciliationMaxDelayMs: 20,
  });

  const stopped = await broker.panicStop('Dial nine', 'asterisk_1001');
  assert.equal(stopped.bridge.agent.success, true);
  assert.equal(stopped.bridge.outbound.quiesced, false);
  assert.equal(stopped.bridge.success, false);
  assert.equal(executionControl.getStatus().remotePanicPending, true);

  const refused = broker.unlockExecution('operator_test');
  assert.equal(refused.locked, true);
  assert.equal(outboundUnlocks, 0);

  const deadline = Date.now() + 1000;
  while (executionControl.getStatus().remotePanicPending && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(outboundPanicAttempts, 2);
  assert.equal(executionControl.getStatus().remotePanicPending, false);
  const unlocked = broker.unlockExecution('operator_test');
  assert.equal(unlocked.locked, false);
  assert.equal(outboundUnlocks, 1);
});

test('panic stop locks dispatch, cancels all jobs, and requires an explicit unlock', async (t) => {
  const bridgeStops = [];
  let resolveQuery;
  const bridge = {
    queryDetailed() {
      return new Promise((resolve) => { resolveQuery = resolve; });
    },
    async cancelSession() {
      return { success: true, canceledCount: 1 };
    },
    async panicStop(options) {
      bridgeStops.push(options);
      resolveQuery?.({
        success: false,
        code: 'CLAUDE_CANCELED',
        agentCode: 'AGENT_CANCELED',
        error: 'Emergency stop acknowledged',
      });
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
  assert.equal(stopped.canceledCount, 1);
  assert.equal(stopped.cancelRequestedCount, 1);
  assert.equal(stopped.runningCount, 1);
  assert.equal(stopped.bridge.success, true);
  assert.deepEqual(bridgeStops, [{ reason: 'Dial 9 emergency stop', source: 'asterisk_1001' }]);
  while (stateStore.getJob(active.job_id).status !== 'canceled') {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

test('failed bridge panic remains locked and nonterminal until a retry confirms remote panic', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-broker-panic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executionControl = new VoiceExecutionControl({
    lockFile: path.join(directory, 'voice.lock.json'),
  });
  let panicAttempts = 0;
  const bridge = {
    queryDetailed() {
      return new Promise(() => {});
    },
    async panicStop() {
      panicAttempts += 1;
      return panicAttempts === 1
        ? { success: false, error: 'executor temporarily unavailable' }
        : { success: true, canceledCount: 1 };
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge, {
    executionControl,
    reconciliationBaseDelayMs: 10,
    reconciliationMaxDelayMs: 25,
  });
  const running = once(broker, 'job.updated');
  const accepted = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'panic-retry-running',
    profile: 'codex-luna',
    request: 'Inspect every active service.',
  });
  await running;

  const stopped = await broker.panicStop('Emergency stop with bridge outage', 'asterisk_1001');
  assert.equal(stopped.bridge.success, false);
  assert.equal(stopped.persistentLock.remotePanicPending, true);
  assert.equal(executionControl.getStatus().remotePanicPending, true);
  assert.equal(stateStore.getJob(accepted.job_id).status, 'cancel_requested');

  const refused = broker.unlockExecution('operator_test');
  assert.equal(refused.locked, true);
  assert.equal(refused.error, 'remote_panic_unconfirmed');

  const deadline = Date.now() + 1000;
  while (executionControl.getStatus().remotePanicPending && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const confirmed = executionControl.getStatus();
  assert.equal(panicAttempts, 2);
  assert.equal(confirmed.locked, true);
  assert.equal(confirmed.remotePanicPending, false);
  assert.ok(confirmed.remotePanicConfirmedAt);
  assert.equal(stateStore.getJob(accepted.job_id).status, 'cancel_requested');
});

test('broker close cancels queued execution before the state store closes', async (t) => {
  const calls = [];
  const bridge = {
    async queryDetailed() {
      calls.push('submitted');
      return { success: true, response: 'Unexpected submission.' };
    },
  };
  const { broker, realtime, stateStore, thread } = createFixture(t, bridge);
  const accepted = await broker.startAgentTask({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'close-before-dispatch',
    profile: 'codex-luna',
    request: 'Inspect the README.',
  });
  assert.equal(accepted.status, 'queued');

  broker.close();
  stateStore.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
});
