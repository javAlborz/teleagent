'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { AgentJobBroker, needsApproval, normalizeProfile } = require('../lib/agent-job-broker');
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
