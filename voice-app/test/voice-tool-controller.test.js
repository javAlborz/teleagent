'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VoiceStateStore } = require('../lib/voice-state-store');
const { VoiceToolController, getWeather } = require('../lib/voice-tool-controller');
const { READY_CAPABILITIES } = require('./controller-capabilities-fixture');

function createController(t) {
  const stateStore = new VoiceStateStore({ dbPath: ':memory:' });
  t.after(() => stateStore.close());
  const thread = stateStore.createThread({ callerId: '1001', selectedProfile: 'codex-terra' });
  const realtime = stateStore.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'controller-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const inspections = [];
  const targeted = [];
  const canceled = [];
  const jobBroker = {
    listProfileDetails: () => [{
      profile: 'codex-luna', provider: 'codex', capability: 'read_only', authority: 'read_only',
    }],
    listAgentSessions: () => ({ sessions: [] }),
    listAgentTasks: () => ({ jobs: [] }),
    getAgentTask: () => ({ found: false }),
    cancelAgentTask: async (...args) => {
      canceled.push(args);
      return { canceled: true };
    },
    startAgentTask: async (args) => ({ accepted: true, job_id: args.toolCallId }),
    startTargetedSessionTask: async (args) => {
      targeted.push(args);
      return { accepted: true, job_id: args.toolCallId, target: args.target };
    },
    handoffAgentTask: async () => ({ accepted: true }),
  };
  const agentBridge = {
    getRuntimeCapabilities: async () => READY_CAPABILITIES,
    async inspectOperator(action, args) {
      inspections.push({ action, args });
      return { success: true, result: { action, path: args.path || null } };
    },
  };
  const controller = new VoiceToolController({
    stateStore,
    jobBroker,
    agentBridge,
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    callerId: '1001',
  });
  return { canceled, controller, inspections, realtime, stateStore, targeted, thread };
}

test('the failed-call session request still returns local records without controller authentication', async (t) => {
  const { controller, inspections } = createController(t);
  delete controller.agentBridge.getRuntimeCapabilities;
  controller.jobBroker.listAgentSessions = () => ({ sessions: [{ profile: 'codex-terra', status: 'saved' }] });
  const runtime = await controller.handle('list_runtime_sessions', {});
  assert.equal(runtime.success, true);
  assert.equal(runtime.partial, true);
  assert.deepEqual(runtime.unavailable_sections, ['tmux']);
  assert.equal(runtime.managed.sessions.length, 1);
  assert.equal(runtime.managed.execution_available, false);
  assert.equal(runtime.tmux.available, false);
  assert.equal(Object.hasOwn(runtime.tmux, 'sessions'), false, 'unavailable must not look like an empty live list');
  assert.equal(runtime.tmux.scope, 'teleagent-worker');
  assert.equal(inspections.length, 0);
  const description = await controller.handle('describe_runtime', {});
  assert.equal(description.success, true);
  assert.equal(description.partial, true);
  assert.equal(description.emergency_controls.pound, 'no production authority');
});

test('a post-probe inspection failure preserves the local answer and scrubs private errors', async (t) => {
  const { controller } = createController(t);
  controller.agentBridge.inspectOperator = async () => ({
    success: false, code: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED', error: 'private-controller-secret',
  });
  const result = await controller.handle('list_runtime_sessions', {});
  assert.equal(result.success, true);
  assert.equal(result.partial, true);
  assert.ok(Array.isArray(result.managed.sessions));
  assert.doesNotMatch(JSON.stringify(result), /private-controller-secret/);
});

test('the directory call retains a specific unavailable result after a successful readiness probe', async (t) => {
  const { controller } = createController(t);
  controller.agentBridge.inspectOperator = async () => ({
    success: false, code: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
    error: 'private-controller-secret and upstream diagnostics',
  });
  const result = await controller.handle('list_directory', { path: '.' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_CONTROL_AUTH_NOT_CONFIGURED');
  assert.match(result.message, /Project tools are not connected/);
  assert.doesNotMatch(JSON.stringify(result), /private-controller-secret|upstream diagnostics/);
});

test('a rejected inspection promise produces a bounded error without leaking transport diagnostics', async (t) => {
  const { controller } = createController(t);
  controller.agentBridge.inspectOperator = async () => {
    throw new Error('private-controller-secret');
  };
  const result = await controller.handle('list_directory', { path: '.' });
  assert.equal(result.code, 'OPERATOR_INSPECTION_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /private-controller-secret/);
});

test('directory inspection stays unavailable before dispatch when controller authentication is absent', async (t) => {
  const { controller, inspections } = createController(t);
  delete controller.agentBridge.getRuntimeCapabilities;
  const result = await controller.handle('list_directory', { path: '.' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'CONTROLLER_CAPABILITIES_UNAVAILABLE');
  assert.equal(inspections.length, 0);
});

test('an asynchronous broker rejection preserves its truthful unknown-outcome code', async (t) => {
  const { controller } = createController(t);
  controller.jobBroker.startAgentTask = async () => {
    throw Object.assign(new Error('The executor outcome must be reconciled.'), {
      code: 'EXECUTION_OUTCOME_UNKNOWN',
    });
  };
  const result = await controller.handle('start_agent_task', { request: 'Inspect the workspace.' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'EXECUTION_OUTCOME_UNKNOWN');
});

test('remote work checks fresh readiness on every action; local tools do not depend on probes', async (t) => {
  const { controller, inspections } = createController(t);
  let probes = 0;
  let accepted = 0;
  controller.agentBridge.getRuntimeCapabilities = async () => {
    probes += 1;
    return probes === 1 ? READY_CAPABILITIES : {
      controllerAvailable: true, workerInspectionAvailable: false, managedExecutionAvailable: false,
      reasonCode: 'VOICE_EXECUTION_LOCKED',
    };
  };
  controller.jobBroker.startAgentTask = async () => { accepted += 1; return { accepted: true }; };
  const first = await controller.handle('send_agent_message', { request: 'Inspect the approved workspace.' });
  assert.equal(first.accepted, true);
  const second = await controller.handle('send_agent_message', { request: 'Inspect again.' });
  assert.equal(second.code, 'VOICE_EXECUTION_LOCKED');
  assert.equal(accepted, 1);
  assert.equal(probes, 2);
  const local = await controller.handle('list_agent_sessions', {});
  assert.ok(Array.isArray(local.sessions));
  assert.equal(probes, 2);
  assert.equal(inspections.length, 0);
});

test('context adoption passes the real worker output and stable pane into a bounded managed request', async (t) => {
  const { controller } = createController(t);
  const requests = [];
  controller.agentBridge.inspectOperator = async () => ({ success: true, result: {
    stable_target: '%12', target: 'worker:1.0', output: 'The exact captured worker context.',
  } });
  controller.jobBroker.startAgentTask = async (request) => { requests.push(request); return { accepted: true }; };
  const result = await controller.handle('adopt_tmux_context', {
    target: 'worker:1.0', objective: 'Explain this output read-only.', profile: 'codex-terra',
  }, { callId: 'adopt-context' });
  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].request, /Tmux target: %12/);
  assert.match(requests[0].request, /The exact captured worker context/);
  assert.match(requests[0].request, /untrusted reference data/);
  assert.doesNotMatch(requests[0].request, /undefined/);
  assert.equal(requests[0].toolCallId, 'adopt-context');
});

test('context adoption cannot create a job from missing or legacy-shaped capture evidence', async (t) => {
  const { controller } = createController(t);
  controller.jobBroker.startAgentTask = async () => assert.fail('missing context must not launch a job');
  for (const result of [{}, { content: 'legacy text', stable_target: '%12' }, { output: 'screen without stable identity' }]) {
    controller.agentBridge.inspectOperator = async () => ({ success: true, result });
    const response = await controller.handle('adopt_tmux_context', { target: 'worker:1.0', objective: 'Explain.' });
    assert.equal(response.code, 'WORKER_CONTEXT_UNAVAILABLE');
  }
});

test('unclassified and disabled actions cannot reach any broker even with forged tool arguments', async (t) => {
  const { controller, targeted, inspections } = createController(t);
  for (const name of ['start_privileged_action', 'send_agent_session_message', 'future_shell_tool', '__proto__']) {
    const result = await controller.handle(name, { capabilities: READY_CAPABILITIES, approved: true });
    assert.equal(result.code, 'PHONE_AUTHORITY_UNAVAILABLE');
  }
  assert.equal(targeted.length, 0);
  assert.equal(inspections.length, 0);
});

test('targeted delivery stays disabled while ready worker and saved session listings are separated', async (t) => {
  const { controller, inspections, targeted } = createController(t);
  const sent = await controller.handle('send_agent_session_message', {
    target: 'main:phone',
    message: 'Continue with the agreed fixes.',
    notify_when_complete: 'callback',
  }, { callId: 'targeted-tool-call' });
  assert.equal(sent.success, false);
  assert.equal(sent.code, 'PHONE_AUTHORITY_UNAVAILABLE');
  assert.equal(targeted.length, 0);

  const runtime = await controller.handle('list_runtime_sessions', { session: 'main' }, { callId: 'runtime-list' });
  assert.equal(runtime.success, true);
  assert.match(runtime.managed.meaning, /Teleagent-managed/);
  assert.match(runtime.tmux.meaning, /agent_running means process presence/i);
  assert.match(runtime.tmux.meaning, /get_agent_activity/i);
  assert.equal(runtime.managed.profiles[0].capability, 'read_only');
  assert.deepEqual(inspections.at(-1), {
    action: 'list_tmux_sessions',
    args: { session: 'main' },
  });

  const described = await controller.handle('describe_runtime', {}, { callId: 'runtime-description' });
  assert.equal(described.profiles[0].authority, 'read_only');
  assert.equal(described.emergency_controls.pound, 'no production authority');
});

test('current activity uses the dedicated provider-log inspector', async (t) => {
  const { controller, inspections } = createController(t);
  const activity = await controller.handle('get_agent_activity', {
    target: 'main:phone',
  }, { callId: 'activity-tool' });
  assert.equal(activity.success, true);
  assert.deepEqual(inspections.at(-1), {
    action: 'inspect_agent_activity',
    args: { target: 'main:phone' },
  });
});

test('tmux aliases are rebound for later reads but can never grant targeted delivery', async (t) => {
  const { controller, targeted } = createController(t);
  const calls = [];
  controller.agentBridge.inspectOperator = async (action, args) => {
    calls.push({ action, args });
    if (action === 'list_tmux_sessions') {
      return {
        success: true,
        result: {
          sessions: [{
            name: 'main',
            windows: [{
              name: 'phone',
              panes: [{
                target: 'main:5.1',
                stable_target: '%12',
                named_target: 'main:phone.1',
                conversation_name: '8player-tooling',
              }],
            }],
          }],
        },
      };
    }
    return {
      success: true,
      result: {
        target: 'main:5.1',
        stable_target: '%12',
        named_target: 'main:phone.1',
        provider: 'codex',
        messages: [],
        chunk: { has_more: false },
      },
    };
  };

  await controller.handle('list_runtime_sessions', { session: 'main' }, { callId: 'bind-target' });
  await controller.handle('inspect_tmux_pane', {
    target: 'main:5.1', lines: 10,
  }, { callId: 'read-stable' });
  await controller.handle('send_agent_session_message', {
    target: 'main:phone.1', message: 'Continue with the exact fix.',
  }, { callId: 'write-stable' });

  assert.equal(calls.at(-1).args.target, '%12');
  assert.equal(targeted.length, 0);
});

test('legacy role parsing preserves ownership language without exposing provider history', async (t) => {
  const { controller, stateStore, thread } = createController(t);
  const calls = [];
  controller.agentBridge.inspectOperator = async (action, args) => {
    calls.push({ action, args });
    return {
      success: true,
      result: {
        provider: 'codex',
        messages: [{ number: 7, role: args.role, text: 'Latest message.' }],
        chunk: { has_more: false, role: args.role },
      },
    };
  };
  stateStore.appendEvent({
    voiceThreadId: thread.id,
    role: 'user',
    kind: 'transcript',
    content: 'What was the last message I sent to Codex?',
  });

  const refused = await controller.handle('get_latest_agent_session_message', {
    target: 'main:phone', role: 'assistant',
  }, { callId: 'latest-user-message' });
  assert.equal(refused.code, 'WORKER_INSPECTION_UNSUPPORTED');
  assert.equal(controller._latestMessageRole('assistant'), 'user');

  stateStore.appendEvent({
    voiceThreadId: thread.id,
    role: 'user',
    kind: 'transcript',
    content: 'What did Codex reply?',
  });
  await controller.handle('get_latest_agent_session_message', {
    target: 'main:phone', role: 'user',
  }, { callId: 'latest-assistant-message' });
  assert.equal(controller._latestMessageRole('user'), 'assistant');
  assert.equal(calls.length, 0);
});

test('voice cancellation is fail-closed and directs the caller to DTMF star', async (t) => {
  const { canceled, controller } = createController(t);
  const result = await controller.handle('cancel_agent_task', {
    job_id: 'job_voice_cancel',
  }, { callId: 'voice-cancel' });
  assert.equal(result.canceled, false);
  assert.equal(result.code, 'DTMF_STAR_REQUIRED');
  assert.match(result.message, /press star/i);
  assert.equal(canceled.length, 0);
});

test('preferences require an explicit caller statement and are durable', async (t) => {
  const { controller, stateStore, thread } = createController(t);
  stateStore.appendEvent({
    voiceThreadId: thread.id,
    role: 'user',
    kind: 'transcript',
    content: 'Is prompt caching possible?',
  });
  const inferred = await controller.handle('remember_preference', {
    key: 'prompt caching', value: 'enabled',
  }, { callId: 'pref-1' });
  assert.equal(inferred.success, false);
  assert.equal(inferred.code, 'EXPLICIT_CONFIRMATION_REQUIRED');

  stateStore.appendEvent({
    voiceThreadId: thread.id,
    role: 'user',
    kind: 'transcript',
    content: 'I prefer succinct and minimal responses.',
  });
  const saved = await controller.handle('remember_preference', {
    key: 'Speech Style', value: 'succinct and minimal',
  }, { callId: 'pref-2' });
  assert.equal(saved.success, true);
  assert.equal(saved.key, 'speech_style');
  assert.equal(stateStore.listPreferences('1001')[0].value, 'succinct and minimal');
  assert.equal(stateStore.listAuditEvents({ threadId: thread.id }).at(-1).action, 'preference_saved');
});

test('history reads exact caller events and inspection actions stay bounded by the bridge API', async (t) => {
  const { controller, inspections, stateStore, thread } = createController(t);
  stateStore.appendEvent({ voiceThreadId: thread.id, role: 'user', kind: 'transcript', content: 'exact phrase one' });
  stateStore.appendEvent({ voiceThreadId: thread.id, role: 'assistant', kind: 'transcript', content: 'exact phrase two' });
  stateStore.appendEvent({ voiceThreadId: thread.id, role: 'user', kind: 'suppressed_transcript', content: 'Mm-hmm' });
  stateStore.appendEvent({ voiceThreadId: thread.id, role: 'user', kind: 'transcript', content: 'What were my last messages?' });

  const history = await controller.handle('get_voice_history', { limit: 10 }, { callId: 'history-1' });
  assert.deepEqual(history.events.map((event) => event.text), ['exact phrase one', 'exact phrase two']);
  assert.equal(history.exact_text, '1. user: exact phrase one\n2. assistant: exact phrase two');
  assert.equal(history.current_request_excluded, true);
  assert.equal(history.suppressed_audio_fragments_excluded, true);
  assert.equal(history.audio_recorded, false);

  const inspected = await controller.handle('read_text_file', { path: '/approved/README.md' }, { callId: 'inspect-1' });
  assert.equal(inspected.success, true);
  assert.deepEqual(inspections, [{
    action: 'read_text_file',
    args: { path: '/approved/README.md', max_bytes: 12000 },
  }]);

  const usage = await controller.handle('get_voice_usage', {}, { callId: 'usage-1' });
  assert.equal(usage.success, true);
  assert.equal(usage.usage.records, 0);
  assert.equal(usage.budget_remaining, null);
  assert.match(usage.budget_note, /dashboard/i);
});

test('legacy history continuation remains bounded but cannot bypass the worker inspection contract', async (t) => {
  const { controller } = createController(t);
  const calls = [];
  controller.agentBridge.inspectOperator = async (action, args) => {
    calls.push({ action, args });
    const first = args.position === 'latest';
    return {
      success: true,
      result: {
        provider: 'codex',
        messages: [{ number: first ? 289 : 288, role: first ? 'assistant' : 'user', text: first ? 'Latest answer' : 'Latest question' }],
        chunk: {
          start: first ? 289 : 288,
          end: first ? 289 : 288,
          position: first ? 'latest' : 'before',
          role: 'any',
          direction: 'backward',
          previous_cursor: first ? 289 : null,
          has_older: first,
          has_newer: !first,
          has_more: first,
          total_messages: 289,
        },
      },
    };
  };

  const first = await controller.agentBridge.inspectOperator('inspect_agent_session_history', {
    target: 'main:phone', limit: 1, cursor: 0, position: 'latest',
  });
  controller._rememberHistoryContinuation(first.result, 'main:phone', 1);
  assert.equal(first.result.messages[0].number, 289);
  const second = await controller.agentBridge.inspectOperator('inspect_agent_session_history',
    controller.agentHistoryContinuation);
  controller._rememberHistoryContinuation(second.result, 'main:phone', 1);
  assert.equal(second.result.messages[0].number, 288);
  assert.deepEqual(calls.map((call) => call.args.cursor), [0, 289]);
  assert.deepEqual(calls.map((call) => call.args.position), ['latest', 'before']);

  const exhausted = await controller.handle('continue_agent_session_history', {}, { callId: 'provider-history-3' });
  assert.equal(exhausted.success, false);
  assert.equal(exhausted.code, 'WORKER_INSPECTION_UNSUPPORTED');
  assert.equal(calls.length, 2, 'the production handler did not invoke the fixture inspector');
});

test('weather uses geocoding plus current conditions and end_call requests one farewell', async () => {
  const responses = [
    { results: [{ name: 'Toronto', admin1: 'Ontario', country: 'Canada', latitude: 43.7, longitude: -79.4 }] },
    {
      current: { time: '2026-08-13T12:00', temperature_2m: 22, apparent_temperature: 23, weather_code: 2, wind_speed_10m: 9 },
      current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
    },
  ];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => responses.shift() };
  };
  const weather = await getWeather('Toronto', fetchImpl);
  assert.equal(weather.location, 'Toronto, Ontario, Canada');
  assert.equal(weather.conditions, 'partly cloudy');
  assert.equal(weather.temperature, 22);
  assert.match(urls[0], /geocoding-api\.open-meteo\.com/);
  assert.match(urls[1], /api\.open-meteo\.com/);

  const controller = new VoiceToolController({
    stateStore: {}, jobBroker: {}, agentBridge: {},
    voiceThreadId: 'vt', realtimeSessionId: 'rts', callerId: '1001', fetchImpl,
  });
  const end = await controller.handle('end_call', {}, { callId: 'end-1' });
  assert.equal(end.end_call, true);
  assert.equal(end.response_behavior, 'farewell_then_hangup');
});
