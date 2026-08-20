'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VoiceStateStore } = require('../lib/voice-state-store');
const { VoiceToolController, getWeather } = require('../lib/voice-tool-controller');

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
    listProfileDetails: () => [{ profile: 'codex-luna', provider: 'codex', capability: 'read' }],
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

test('targeted session messages and ambiguous session listings use their dedicated control paths', async (t) => {
  const { controller, inspections, targeted } = createController(t);
  const sent = await controller.handle('send_agent_session_message', {
    target: 'main:phone',
    message: 'Continue with the agreed fixes.',
    notify_when_complete: 'callback',
  }, { callId: 'targeted-tool-call' });
  assert.equal(sent.accepted, true);
  assert.equal(sent.target, 'main:phone');
  assert.equal(targeted.length, 1);
  assert.equal(targeted[0].toolCallId, 'targeted-tool-call');
  assert.equal(targeted[0].notificationMode, 'callback');

  const runtime = await controller.handle('list_runtime_sessions', { session: 'main' }, { callId: 'runtime-list' });
  assert.equal(runtime.success, true);
  assert.match(runtime.managed.meaning, /Teleagent-managed/);
  assert.match(runtime.tmux.meaning, /process mapping is authoritative/i);
  assert.deepEqual(inspections.at(-1), {
    action: 'list_tmux_sessions',
    args: { session: 'main' },
  });
});

test('tmux aliases are rebound to the stable pane identity for later reads and writes', async (t) => {
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
  await controller.handle('inspect_agent_session_history', {
    target: 'main:5.1', limit: 1,
  }, { callId: 'read-stable' });
  await controller.handle('send_agent_session_message', {
    target: 'main:phone.1', message: 'Continue with the exact fix.',
  }, { callId: 'write-stable' });

  assert.equal(calls.at(-1).args.target, '%12');
  assert.equal(targeted[0].target, '%12');
});

test('latest-message role follows caller ownership language instead of model defaults', async (t) => {
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

  await controller.handle('get_latest_agent_session_message', {
    target: 'main:phone', role: 'assistant',
  }, { callId: 'latest-user-message' });
  assert.equal(calls.at(-1).args.role, 'user');

  stateStore.appendEvent({
    voiceThreadId: thread.id,
    role: 'user',
    kind: 'transcript',
    content: 'What did Codex reply?',
  });
  await controller.handle('get_latest_agent_session_message', {
    target: 'main:phone', role: 'user',
  }, { callId: 'latest-assistant-message' });
  assert.equal(calls.at(-1).args.role, 'assistant');
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

  const history = await controller.handle('get_voice_history', { limit: 10 }, { callId: 'history-1' });
  assert.deepEqual(history.events.map((event) => event.text), ['exact phrase one', 'exact phrase two']);
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

test('provider history uses an app-owned continuation cursor without repeating chunks', async (t) => {
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

  const first = await controller.handle('inspect_agent_session_history', {
    target: 'main:phone', limit: 1,
  }, { callId: 'provider-history-1' });
  assert.equal(first.messages[0].number, 289);
  const second = await controller.handle('continue_agent_session_history', {}, { callId: 'provider-history-2' });
  assert.equal(second.messages[0].number, 288);
  assert.deepEqual(calls.map((call) => call.args.cursor), [0, 289]);
  assert.deepEqual(calls.map((call) => call.args.position), ['latest', 'before']);

  const exhausted = await controller.handle('continue_agent_session_history', {}, { callId: 'provider-history-3' });
  assert.equal(exhausted.success, false);
  assert.equal(exhausted.code, 'NO_HISTORY_CONTINUATION');
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
