'use strict';
require('./helpers/voice-egress-fixture').installEgressFixture();

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { setImmediate } = require('node:timers');
const {
  OpenAIRealtimeClient,
  buildRealtimeRouterTool,
  buildRealtimeTools,
  getRealtimeApiKey,
  ownerReadRoute,
} = require('../lib/openai-realtime-client');

class FakeWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    setImmediate(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    });
  }

  send(data) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    setImmediate(() => this.emit('close', code, Buffer.from(reason)));
  }

  serverSend(event) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  sentEvents() {
    return this.sent
      .filter((item) => typeof item === 'string')
      .map((item) => JSON.parse(item));
  }
}

FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSED = 3;

async function createConnectedClient(overrides = {}) {
  const client = new OpenAIRealtimeClient({
    apiKey: 'test-key',
    instructions: 'Be concise.',
    profiles: ['codex-terra'],
    capabilities: require('./controller-capabilities-fixture').READY_CAPABILITIES,
    WebSocketImpl: FakeWebSocket,
    ...overrides,
  });
  const connected = client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  client.ws.serverSend({ type: 'session.created', session: { id: 'openai-session-1' } });
  client.ws.serverSend({ type: 'session.updated', session: { id: 'openai-session-1' } });
  await connected;
  return client;
}

function spokenWords(count, { period = false } = {}) {
  const text = Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ');
  return period ? `${text}.` : text;
}

test('a single named-session route resolves and reads native history before speech', async (t) => {
  const { VoiceToolController } = require('../lib/voice-tool-controller');
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const calls = [];
  const controller = new VoiceToolController({
    agentBridge: {
      getRuntimeCapabilities: async () => capabilities,
      ownerSessionAction: async (action, body) => {
        calls.push({ action, body });
        return { success: true, result: action === 'list'
          ? { sessions: [{ id: 'os_test', label: 'teletest' }] }
          : { history: { messages: [{ role: 'assistant', text: 'Native test answer.' }] } } };
      },
    },
  });
  const client = await createConnectedClient({ capabilities,
    toolHandler: (name, args, context) => controller.handle(name, args, context) });
  t.after(() => client.close());
  client.queueUserResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'named-route' } });
  client.ws.serverSend({ type: 'response.done', response: {
    id: 'named-route', status: 'completed', output: [{ type: 'function_call', name: 'route_turn',
      call_id: 'named-history', arguments: JSON.stringify({ action: 'inspect_owner_session',
        arguments_json: JSON.stringify({ session_label: 'Tele Test', history: true }) }) }],
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ action: 'list', body: {} },
    { action: 'inspect', body: { id: 'os_test', history: true } }]);
  const speech = client.ws.sentEvents().at(-1).response;
  assert.equal(speech.tool_choice, 'none');
  assert.match(JSON.stringify(speech), /Native test answer/);
});

test('pending owner approval starts no competing model speech and other states get precise status', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  for (const [state, expected] of [
    ['pending_approval', null], ['accepted', /accepted your instruction.*not confirmed/],
    ['dispatching', /being sent.*not confirmed/], ['submitted_unconfirmed', /acceptance is not confirmed/],
    ['outcome_unknown', /Delivery is uncertain/], ['refused', /was not sent/],
  ]) {
    const client = await createConnectedClient({ capabilities,
      toolHandler: async () => ({ success: true, result: { state },
        ...(state === 'pending_approval' ? { response_behavior: 'earcon_then_quiet' } : {}) }) });
    t.after(() => client.close());
    const before = client.ws.sentEvents().filter((event) => event.type === 'response.create').length;
    await client._handleResponseDone({ output: [{ type: 'function_call', name: 'route_turn',
      call_id: 'owner-request', arguments: JSON.stringify({ action: 'request_owner_instruction',
        arguments_json: JSON.stringify({ session_label: 'teletest', message: 'Review' }) }) }] });
    const responses = client.ws.sentEvents().filter((event) => event.type === 'response.create');
    if (expected === null) assert.equal(responses.length, before);
    else {
      assert.equal(responses.length, before + 1);
      assert.match(responses.at(-1).response.instructions, expected);
      assert.equal(responses.at(-1).response.tool_choice, 'none');
      assert.doesNotMatch(responses.at(-1).response.instructions, /read.only|Be concise/);
    }
  }
});

test('incorrect owner delivery audio is suppressed and speech retry never resends the instruction', async (t) => {
  let deliveries = 0;
  const client = await createConnectedClient({
    capabilities: { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true },
    toolHandler: async () => { deliveries += 1; return { success: true, result: { state: 'dispatching' } }; },
  });
  t.after(() => client.close());
  const played = [];
  client.on('audio', () => played.push('audio'));
  client.on('audio.done', () => played.push('done'));
  client.on('assistant_transcript', (text) => played.push(text));
  const rejected = [];
  client.on('response.output_rejected', (event) => rejected.push(event.reason));
  await client._handleResponseDone({ output: [{ type: 'function_call', name: 'route_turn',
    call_id: 'owner-request', arguments: JSON.stringify({ action: 'request_owner_instruction',
      arguments_json: JSON.stringify({ session_label: 'teletest', message: 'ok' }) }) }] });
  const finishSpeech = async (id, transcript) => {
    await client._handleEvent({ type: 'response.created', response: { id } });
    await client._handleEvent({ type: 'response.output_audio.delta', response_id: id, item_id: `item-${id}`, delta: 'AAAA' });
    await client._handleEvent({ type: 'response.output_audio.done', response_id: id });
    await client._handleEvent({ type: 'response.output_audio_transcript.done', response_id: id, transcript });
    assert.deepEqual(played, [], 'no unverified audio, completion mark or transcript is released');
    await client._handleEvent({ type: 'response.done', response: { id, status: 'completed', output: [] } });
  };
  await finishSpeech('wrong-status', 'I can’t send that message in the TeleTest session right now. Sorry about that!');
  assert.deepEqual(played, []);
  assert.deepEqual(rejected, ['owner_status_speech_mismatch']);
  assert.ok(client.ws.sentEvents().some((event) => event.type === 'conversation.item.delete' &&
    event.item_id === 'item-wrong-status'));
  const retry = client.ws.sentEvents().filter((event) => event.type === 'response.create').at(-1).response;
  assert.equal(retry.tool_choice, 'none');
  assert.match(retry.instructions, /being sent.*not confirmed/);
  const expected = 'Your instruction is being sent. Delivery is not confirmed yet.';
  await finishSpeech('correct-status', expected);
  assert.deepEqual(played, ['audio', 'done', expected]);
  assert.equal(deliveries, 1);
});

test('owner status retries are bounded and missing transcripts or unexpected tools never leak audio or execute', async (t) => {
  for (const output of [[], [{ type: 'function_call', name: 'request_owner_instruction', call_id: 'bad-call', arguments: '{}' }]]) {
    let tools = 0;
    const client = await createConnectedClient({ toolHandler: async () => { tools += 1; } });
    t.after(() => client.close());
    const played = [];
    client.on('audio', (event) => played.push(event));
    client._requestOwnerStatusSpeech('This instruction was not sent.');
    for (const id of ['first', 'retry']) {
      await client._handleEvent({ type: 'response.created', response: { id } });
      await client._handleEvent({ type: 'response.output_audio.delta', response_id: id, delta: 'AAAA' });
      await client._handleEvent({ type: 'response.done', response: { id, status: 'completed', output } });
    }
    assert.equal(client.ws.sentEvents().filter((event) => event.type === 'response.create').length, 2);
    assert.equal(client.responseActive, false);
    assert.deepEqual(played, []);
    assert.equal(tools, 0);
  }
});

test('interrupted owner status is discarded without a speech retry', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const played = [];
  client.on('audio', (event) => played.push(event));
  client._requestOwnerStatusSpeech('This instruction was not sent.');
  await client._handleEvent({ type: 'response.created', response: { id: 'interrupted' } });
  await client._handleEvent({ type: 'response.output_audio.delta', response_id: 'interrupted', delta: 'AAAA' });
  await client._handleEvent({ type: 'response.done', response: { id: 'interrupted', status: 'cancelled', output: [] } });
  assert.equal(client.ws.sentEvents().filter((event) => event.type === 'response.create').length, 1);
  assert.deepEqual(played, []);
});

test('native readback identifies a missing new reply without treating the old answer as completion', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const client = await createConnectedClient({ capabilities, toolHandler: async () => ({ success: true,
    result: { history: { messages: [{ role: 'assistant', text: 'Old test complete.' }],
      latestTurn: { status: 'inProgress', reply: null } } } }) });
  t.after(() => client.close());
  await client._handleResponseDone({ output: [{ type: 'function_call', name: 'route_turn', call_id: 'read-latest',
    arguments: JSON.stringify({ action: 'inspect_owner_session',
      arguments_json: JSON.stringify({ session_label: 'teletest', history: true }) }) }] });
  const speech = client.ws.sentEvents().at(-1).response;
  assert.equal(speech.tool_choice, 'none');
  assert.match(speech.instructions, /latestTurn.*inProgress/);
  assert.match(speech.instructions, /never substitute an older message/i);
  assert.match(speech.instructions, /reply is null.*no reply in the newest turn yet/);
  assert.doesNotMatch(speech.instructions, /Old test complete/);
  assert.deepEqual(speech.input, []);
  assert.deepEqual(speech.tools, []);
});

test('successful native emoji readback excludes worker limitations and previous conversational refusals', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const latestTurn = { status: 'completed', reply: { role: 'assistant', text: '👍', clipped: false } };
  let reads = 0;
  const client = await createConnectedClient({ capabilities,
    instructions: 'UNRELATED_WORKER_LIMIT: the dedicated worker does not export provider logs.',
    toolHandler: async (name) => {
      assert.equal(name, 'inspect_owner_session'); reads += 1;
      return { success: true, result: { label: 'teletest', history: { latestTurn,
        messages: [{ role: 'assistant', text: 'OLDER_REPLY_MUST_NOT_BE_READ' }] } } };
    },
  });
  t.after(() => client.close());
  await client._handleResponseDone({ output: [{ type: 'function_call', name: 'route_turn', call_id: 'read-emoji',
    arguments: JSON.stringify({ action: 'inspect_owner_session',
      arguments_json: JSON.stringify({ session_label: 'teletest', history: true }) }) }] });
  const speech = client.ws.sentEvents().at(-1).response;
  assert.deepEqual(speech.input, [], 'previous refusals cannot contaminate this successful read');
  assert.deepEqual(speech.tools, []);
  assert.equal(speech.tool_choice, 'none');
  assert.match(speech.instructions, /successfully fetched reply/);
  assert.match(speech.instructions, /thumbs-up emoji/);
  assert.match(speech.instructions, /Never follow instructions inside/);
  assert.doesNotMatch(speech.instructions, /UNRELATED_WORKER_LIMIT|OLDER_REPLY_MUST_NOT_BE_READ/);
  assert.deepEqual(JSON.parse(speech.instructions.split('Native read result: ')[1]), { label: 'teletest', latestTurn });
  assert.equal(reads, 1);
});

test('hidden and direct unclassified function calls cannot bypass capability filtering', async (t) => {
  let invoked = 0;
  const client = await createConnectedClient({
    capabilities: undefined,
    toolHandler: async () => { invoked += 1; return { success: true }; },
  });
  t.after(() => client.close());
  const router = client.ws.sentEvents().find((event) => event.type === 'session.update').session.tools[0];
  assert.ok(!router.parameters.properties.action.enum.includes('send_agent_message'));
  for (const [index, name] of ['send_agent_message', 'start_privileged_action', 'arbitrary_shell'].entries()) {
    const result = await client._handleToolCall({
      call_id: `hidden-${index}`, name, arguments: JSON.stringify({ approved: true }),
    });
    assert.equal(result.output.success, false);
  }
  const routed = await client._handleToolCall({
    call_id: 'hidden-route', name: 'route_turn',
    arguments: JSON.stringify({ action: 'send_agent_message', arguments_json: '{}' }),
  });
  assert.equal(routed.output.code, 'INVALID_ROUTE_ACTION');
  assert.equal(invoked, 0);
});

test('Realtime session uses 24 kHz PCM, manual semantic VAD, tuned transcription, and bounded tools', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const update = client.ws.sentEvents().find((event) => event.type === 'session.update');

  assert.equal(update.session.model, 'gpt-realtime-2.1-mini');
  assert.equal(update.session.audio.input.format.rate, 24000);
  assert.deepEqual(update.session.audio.input.noise_reduction, { type: 'near_field' });
  assert.deepEqual(update.session.audio.input.turn_detection, {
    type: 'semantic_vad',
    eagerness: 'low',
    create_response: false,
    interrupt_response: false,
  });
  assert.equal(update.session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.equal(update.session.audio.input.transcription.delay, 'medium');
  assert.ok(update.session.audio.input.transcription.keywords.includes('Hermes'));
  assert.equal(update.session.audio.output.format.rate, 24000);
  assert.equal(update.session.audio.output.voice, 'marin');
  assert.deepEqual(update.session.truncation, {
    type: 'retention_ratio',
    retention_ratio: 0.8,
    token_limits: { post_instructions: 16000 },
  });
  const toolNames = update.session.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, ['route_turn']);
  assert.equal(update.session.tool_choice, 'none');
  const actions = update.session.tools[0].parameters.properties.action.enum;
  assert.ok(actions.includes('respond'));
  assert.ok(actions.includes('send_agent_message'));
  assert.equal(actions.includes('send_agent_session_message'), false);
  assert.equal(actions.includes('start_privileged_action'), false);
  assert.ok(actions.includes('get_voice_history'));
  assert.ok(actions.includes('get_agent_activity'));
  assert.ok(actions.includes('end_call'));
  assert.equal(actions.includes('cancel_agent_task'), false);
  assert.equal(update.session.tools.some((tool) => tool.name.includes('shell')), false);
  assert.equal(client.ws.options.headers.Authorization, 'Bearer test-key');
});

test('audio input and output use base64 Realtime events', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const input = Buffer.from([1, 2, 3, 4]);
  assert.equal(client.appendAudio(input), true);
  const append = client.ws.sentEvents().find((event) => event.type === 'input_audio_buffer.append');
  assert.deepEqual(Buffer.from(append.audio, 'base64'), input);

  const audioEvent = once(client, 'audio');
  client.ws.serverSend({
    type: 'response.output_audio.delta',
    delta: input.toString('base64'),
    item_id: 'item-1',
    response_id: 'response-1',
  });
  const [output] = await audioEvent;
  assert.deepEqual(output.audio, input);
  assert.equal(output.itemId, 'item-1');

  const audioDone = once(client, 'audio.done');
  client.ws.serverSend({
    type: 'response.output_audio.done',
    item_id: 'item-1',
    response_id: 'response-1',
  });
  const [done] = await audioDone;
  assert.equal(done.item_id, 'item-1');
  assert.equal(done.response_id, 'response-1');
});

test('caller turns route silently out of band before a speech-only response streams', async (t) => {
  const calls = [];
  const client = await createConnectedClient({
    toolHandler: async (name, args) => {
      calls.push({ name, args });
      return { success: true };
    },
  });
  t.after(() => client.close());
  const audio = [];
  const transcripts = [];
  client.on('audio', (event) => audio.push(event));
  client.on('assistant_transcript', (text) => transcripts.push(text));

  client.queueUserResponse();
  const routeCreate = client.ws.sentEvents().at(-1);
  assert.equal(routeCreate.type, 'response.create');
  assert.equal(routeCreate.response.conversation, 'none');
  assert.deepEqual(routeCreate.response.output_modalities, ['text']);
  assert.deepEqual(routeCreate.response.tool_choice, { type: 'function', name: 'route_turn' });

  client.ws.serverSend({ type: 'response.created', response: { id: 'response-route' } });
  client.ws.serverSend({
    type: 'response.done',
    response: {
      id: 'response-route',
      status: 'completed',
      output: [{
        type: 'function_call',
        name: 'route_turn',
        call_id: 'route-call-1',
        arguments: JSON.stringify({
          action: 'respond',
          response_instruction: 'Answer the caller directly.',
        }),
      }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(
    client.ws.sentEvents().some((event) => event.item?.call_id === 'route-call-1'),
    false
  );
  const speechCreate = client.ws.sentEvents().at(-1);
  assert.equal(speechCreate.response.tool_choice, 'none');
  assert.deepEqual(speechCreate.response.output_modalities, ['audio']);

  client.ws.serverSend({ type: 'response.created', response: { id: 'response-spoken' } });
  client.ws.serverSend({
    type: 'response.output_audio.delta',
    response_id: 'response-spoken',
    item_id: 'item-spoken',
    delta: Buffer.from([1, 2, 3]).toString('base64'),
  });
  assert.deepEqual(audio.map((event) => [...event.audio]), [[1, 2, 3]]);
  client.ws.serverSend({
    type: 'response.output_audio_transcript.done',
    response_id: 'response-spoken',
    item_id: 'item-spoken',
    transcript: 'Direct answer.',
  });
  assert.deepEqual(transcripts, ['Direct answer.']);
});

test('routing and both speech stages retain the saved session context when overriding instructions', async (t) => {
  const saved = 'Saved phone context: assistant answered 437. Use saved transcripts for recall.';
  for (const action of ['respond', 'get_voice_history']) {
    const client = await createConnectedClient({
      instructions: saved,
      toolHandler: async () => ({ success: true, events: [{ role: 'assistant', text: '437' }] }),
    });
    t.after(() => client.close());
    client.requestRoutedResponse();
    const route = client.ws.sentEvents().at(-1).response;
    assert.ok(route.instructions.startsWith(saved), 'response.create instructions replace session instructions');
    assert.match(route.instructions, /Call route_turn exactly once/);
    client.responseActive = false;
    await client._handleResponseDone({ output: [{
      type: 'function_call', name: 'route_turn', call_id: `recall-${action}`,
      arguments: JSON.stringify({ action, arguments_json: '{"role":"assistant"}', response_instruction: 'Recall the saved assistant answer.' }),
    }] });
    const speech = client.ws.sentEvents().at(-1).response;
    assert.ok(speech.instructions.startsWith(saved), 'speech must retain context available to routing');
    assert.equal(speech.tool_choice, 'none');
    assert.deepEqual(speech.output_modalities, ['audio']);
  }
});

test('managed routing uses the typed profile and cannot execute invented or disabled choices', async (t) => {
  const calls = [];
  const client = await createConnectedClient({
    toolHandler: async (name, args) => {
      calls.push({ name, args });
      return { accepted: true, job_id: 'job-1' };
    },
  });
  t.after(() => client.close());
  const route = (id, profile, nestedProfile) => client._handleToolCall({
    name: 'route_turn', call_id: id,
    arguments: JSON.stringify({
      action: 'send_agent_message', agent_profile: profile,
      arguments_json: JSON.stringify({ profile: nestedProfile, request: 'Calculate 17 times 32 using Codex.' }),
    }),
  });
  await route('automatic', undefined, 'codex-auto-codex');
  assert.equal(calls[0].args.profile, 'auto');
  await route('named', 'codex-terra', 'codex-auto');
  assert.equal(calls[1].args.profile, 'codex-terra');
  for (const profile of ['codex-auto', 'codex-auto-codex', 'claude-haiku', '', null, {}]) {
    const result = await route(`invalid-${JSON.stringify(profile)}`, profile, 'codex-terra');
    assert.equal(result.output.success, false);
    assert.equal(result.output.accepted, false);
    assert.equal(result.output.code, 'UNKNOWN_AGENT_PROFILE');
  }
  assert.equal(calls.length, 2);
});

test('rejected jobs remain failures in tool results, audit events, and subsequent speech instructions', async (t) => {
  const client = await createConnectedClient({
    toolHandler: async () => ({ accepted: false, code: 'AGENT_PROVIDER_DISABLED', message: 'Provider unavailable.' }),
  });
  t.after(() => client.close());
  const audited = once(client, 'tool.completed');
  await client._handleResponseDone({ output: [{
    type: 'function_call', name: 'route_turn', call_id: 'refused-job',
    arguments: JSON.stringify({ action: 'send_agent_message', agent_profile: 'auto', arguments_json: '{"request":"Calculate 17 times 32."}' }),
  }] });
  const [audit] = await audited;
  assert.equal(audit.output.accepted, false);
  assert.equal(audit.output.success, false);
  const speech = client.ws.sentEvents().at(-1).response;
  assert.equal(speech.tool_choice, 'none');
  assert.match(speech.instructions, /"success":false/);
  assert.match(speech.instructions, /rejected agent submission started no new job; do not supply your own answer/);
});

test('spoken preambles attached to tool selection are suppressed before phone playout', async (t) => {
  const client = await createConnectedClient({ toolHandler: async () => ({ success: true }) });
  t.after(() => client.close());
  const audio = [];
  const transcripts = [];
  client.on('audio', (event) => audio.push(event));
  client.on('assistant_transcript', (text) => transcripts.push(text));
  const suppressed = once(client, 'response.output_suppressed');

  client.requestResponse(undefined, { purpose: 'legacy_tool_turn' });
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-tool-preamble' } });
  client.ws.serverSend({
    type: 'response.output_audio.delta',
    response_id: 'response-tool-preamble',
    item_id: 'item-preamble',
    delta: Buffer.from([4, 5, 6]).toString('base64'),
  });
  client.ws.serverSend({
    type: 'response.output_audio_transcript.done',
    response_id: 'response-tool-preamble',
    item_id: 'item-preamble',
    transcript: 'Let me check that.',
  });
  client.ws.serverSend({
    type: 'response.done',
    response: {
      id: 'response-tool-preamble',
      status: 'completed',
      output: [{
        type: 'function_call', name: 'list_tmux_sessions', call_id: 'call-preamble', arguments: '{}',
      }],
    },
  });
  const [event] = await suppressed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.reason, 'tool_selection');
  assert.equal(event.toolCalls, 1);
  assert.deepEqual(audio, []);
  assert.deepEqual(transcripts, []);
});

test('a limiter-cancelled response releases already-generated audio instead of discarding playout', async (t) => {
  const client = await createConnectedClient({ maxSpokenWords: 35, hardMaxSpokenWords: 120 });
  t.after(() => client.close());
  const audio = [];
  client.on('audio', (event) => audio.push(event));

  client.queueUserResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-limiter-drain' } });
  client.ws.serverSend({
    type: 'response.output_audio.delta',
    response_id: 'response-limiter-drain',
    item_id: 'item-limiter-drain',
    delta: Buffer.from([7, 8, 9]).toString('base64'),
  });
  client.ws.serverSend({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response-limiter-drain',
    item_id: 'item-limiter-drain',
    delta: spokenWords(121, { period: true }),
  });
  client.ws.serverSend({
    type: 'response.output_audio_transcript.done',
    response_id: 'response-limiter-drain',
    item_id: 'item-limiter-drain',
  });
  assert.equal(audio.length, 0);
  client.ws.serverSend({
    type: 'response.done',
    response: { id: 'response-limiter-drain', status: 'cancelled', output: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(audio.map((event) => [...event.audio]), [[7, 8, 9]]);
});

test('function calls execute app-owned tools and return matching call IDs', async (t) => {
  const calls = [];
  const client = await createConnectedClient({
    toolHandler: async (name, args, context) => {
      calls.push({ name, args, context });
      return { accepted: true, job_id: 'job-1' };
    },
  });
  t.after(() => client.close());

  client.ws.serverSend({
    type: 'response.done',
    response: {
      id: 'response-tools',
      output: [{
        id: 'item-tool',
        type: 'function_call',
        name: 'start_agent_task',
        call_id: 'call-tool-1',
        arguments: JSON.stringify({ profile: 'codex-terra', request: 'Inspect status.' }),
      }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'start_agent_task');
  assert.equal(calls[0].context.callId, 'call-tool-1');
  const events = client.ws.sentEvents();
  const output = events.find((event) => event.item?.type === 'function_call_output');
  assert.equal(output.item.call_id, 'call-tool-1');
  assert.deepEqual(JSON.parse(output.item.output), { accepted: true, job_id: 'job-1' });
  assert.equal(events.at(-1).type, 'response.create');

  client.ws.serverSend({
    type: 'response.done',
    response: {
      output: [{
        type: 'function_call',
        name: 'start_agent_task',
        call_id: 'call-tool-1',
        arguments: '{}',
      }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test('speech boundary events track caller state and support client-side playout truncation', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const speechStarted = once(client, 'speech_started');
  client.ws.serverSend({ type: 'input_audio_buffer.speech_started', audio_start_ms: 120 });
  await speechStarted;
  assert.equal(client.userSpeaking, true);

  client.truncatePlayback({ itemId: 'item-audio', audioEndMs: 812.9 });
  const truncate = client.ws.sentEvents().find((event) => event.type === 'conversation.item.truncate');
  assert.equal(truncate.item_id, 'item-audio');
  assert.equal(truncate.audio_end_ms, 812);

  assert.equal(client.deleteConversationItem('item-noise'), true);
  const deleted = client.ws.sentEvents().find((event) => event.type === 'conversation.item.delete');
  assert.equal(deleted.item_id, 'item-noise');

  const speechStopped = once(client, 'speech_stopped');
  client.ws.serverSend({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 920 });
  await speechStopped;
  assert.equal(client.userSpeaking, false);
});

test('empty transcription and context-truncation lifecycle events are observable', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const empty = once(client, 'transcription.empty');
  client.ws.serverSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-empty',
    content_index: 0,
    transcript: '',
  });
  const [emptyEvent] = await empty;
  assert.equal(emptyEvent.item_id, 'item-empty');

  const truncated = once(client, 'context.truncated');
  client.ws.serverSend({
    type: 'conversation.item.truncated',
    item_id: 'item-context',
    content_index: 0,
    audio_end_ms: 750,
  });
  const [truncatedEvent] = await truncated;
  assert.equal(truncatedEvent.audio_end_ms, 750);

  const deleted = once(client, 'context.item_deleted');
  client.ws.serverSend({ type: 'conversation.item.deleted', item_id: 'item-old-context' });
  const [deletedEvent] = await deleted;
  assert.equal(deletedEvent.item_id, 'item-old-context');
});

test('tool schema exposes only the supplied profile enum', () => {
  const tools = buildRealtimeTools(['claude-opus', 'codex-sol']);
  assert.equal(tools.some((tool) => tool.name === 'send_agent_session_message'), false);
  assert.equal(tools.some((tool) => tool.name === 'start_privileged_action'), false);
  assert.deepEqual(
    tools.find((tool) => tool.name === 'send_agent_message').parameters.properties.profile.enum,
    ['auto', 'claude-opus', 'codex-sol']
  );
  assert.deepEqual(
    tools.find((tool) => tool.name === 'remember_preference').parameters.properties.value,
    { type: 'string' }
  );
  const router = buildRealtimeRouterTool(['claude-opus', 'codex-sol'],
    require('./controller-capabilities-fixture').READY_CAPABILITIES);
  assert.ok(router.parameters.properties.action.enum.includes('respond'));
  assert.ok(router.parameters.properties.action.enum.includes('codex-sol') === false);
  assert.ok(router.parameters.properties.action.enum.includes('send_agent_message'));
});

test('accepted asynchronous jobs return tool output without a duplicate spoken response', async (t) => {
  const client = await createConnectedClient({
    toolHandler: async () => ({
      accepted: true,
      job_id: 'job-quiet',
      response_behavior: 'earcon_then_quiet',
    }),
  });
  t.after(() => client.close());
  const silent = once(client, 'tools.silent');
  const responseCreatesBefore = client.ws.sentEvents().filter((event) => event.type === 'response.create').length;

  client.ws.serverSend({
    type: 'response.done',
    response: {
      id: 'response-quiet',
      output: [{
        id: 'tool-quiet',
        type: 'function_call',
        name: 'send_agent_message',
        call_id: 'call-quiet',
        arguments: JSON.stringify({ request: 'Inspect status.' }),
      }],
    },
  });
  await silent;

  const events = client.ws.sentEvents();
  assert.ok(events.some((event) => event.item?.call_id === 'call-quiet'));
  assert.equal(
    events.filter((event) => event.type === 'response.create').length,
    responseCreatesBefore
  );
});

test('manual turn control coalesces caller turns while a response is active', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());

  assert.equal(client.queueUserResponse(), true);
  assert.equal(client.queueUserResponse(), false);
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-first' } });
  client.ws.serverSend({ type: 'response.done', response: { id: 'response-first', output: [] } });
  await new Promise((resolve) => setImmediate(resolve));

  const creates = client.ws.sentEvents().filter((event) => event.type === 'response.create');
  assert.equal(creates.length, 2);
  assert.equal(client.pendingUserResponse, false);
});

test('keyed notices replace stale status and flush after the active response', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  client.requestResponse(undefined, { purpose: 'job_status' });
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-status' } });

  client.sendSystemNotice('Job is still running.', { key: 'job:1', priority: 10 });
  client.sendSystemNotice('Job completed.', { key: 'job:1', priority: 20 });
  assert.equal(client.pendingNotices.length, 1);
  client.ws.serverSend({ type: 'response.done', response: { id: 'response-status', output: [] } });
  await new Promise((resolve) => setImmediate(resolve));

  const notices = client.ws.sentEvents().filter((event) => (
    event.type === 'response.create' && event.response?.instructions?.includes('One-time voice instruction')
  ));
  assert.match(notices.at(-1).response.instructions, /Job completed\./);
  assert.doesNotMatch(notices.at(-1).response.instructions, /still running/);
  assert.equal(
    client.ws.sentEvents().some((event) => event.type === 'conversation.item.create'),
    false
  );
});

test('a queued goodbye cannot inherit the previous history result or repeat its answer', async (t) => {
  const client = await createConnectedClient({ instructions: 'Saved assistant answer: 437.' });
  t.after(() => client.close());
  client.requestResponse({ instructions: 'The previous answer was 437.' }, { purpose: 'tool_result' });
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-history' } });
  client.sendSystemNotice('Say one short goodbye now.', { key: 'hangup', priority: 1000 });
  client.ws.serverSend({ type: 'response.done', response: { id: 'response-history', output: [] } });
  await new Promise((resolve) => setImmediate(resolve));

  const farewell = client.ws.sentEvents().filter((event) => event.type === 'response.create').at(-1).response;
  assert.equal(farewell.conversation, 'none');
  assert.deepEqual(farewell.input, []);
  assert.deepEqual(farewell.tools, []);
  assert.deepEqual(farewell.output_modalities, ['audio']);
  assert.equal(farewell.tool_choice, 'none');
  assert.match(farewell.instructions, /short goodbye/);
  assert.doesNotMatch(farewell.instructions, /437/);
});

test('ordinary long sentences are not clipped until the absolute safety limit', async (t) => {
  const client = await createConnectedClient({ maxSpokenWords: 35, hardMaxSpokenWords: 120 });
  t.after(() => client.close());
  client.requestResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-long' } });
  const clipped = once(client, 'response.clipped');
  client.ws.serverSend({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response-long',
    item_id: 'item-long',
    delta: spokenWords(100, { period: true }),
  });
  assert.equal(client.ws.sentEvents().some((entry) => entry.type === 'response.cancel'), false);
  client.ws.serverSend({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response-long',
    item_id: 'item-long',
    delta: ` ${spokenWords(21, { period: true })}`,
  });
  const [event] = await clipped;
  assert.equal(event.softLimit, 35);
  assert.equal(event.hardLimit, 120);
  assert.equal(event.mode, 'absolute_hard_limit');
  assert.ok(client.ws.sentEvents().some((entry) => entry.type === 'response.cancel'));
});

test('spoken output retains a higher hard safety limit for punctuation-free runaway output', async (t) => {
  const client = await createConnectedClient({ maxSpokenWords: 35, hardMaxSpokenWords: 120 });
  t.after(() => client.close());
  client.requestResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-runaway' } });
  const clipped = once(client, 'response.clipped');
  client.ws.serverSend({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response-runaway',
    item_id: 'item-runaway',
    delta: spokenWords(121),
  });
  const [event] = await clipped;
  assert.equal(event.mode, 'absolute_hard_limit');
  assert.ok(client.ws.sentEvents().some((entry) => entry.type === 'response.cancel'));
});

test('cancelled completion notices are retried and acknowledged only after delivery', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const failed = once(client, 'notice.delivery_failed');
  const delivered = once(client, 'notice.delivered');

  client.sendSystemNotice('Luna completed the inspection.', { key: 'job:42', priority: 20 });
  client.ws.serverSend({ type: 'response.created', response: { id: 'notice-first' } });
  client.ws.serverSend({
    type: 'response.done',
    response: { id: 'notice-first', status: 'cancelled', output: [] },
  });
  const [failedNotice] = await failed;
  assert.equal(failedNotice.key, 'job:42');

  const noticeCreates = client.ws.sentEvents().filter((event) => (
    event.type === 'response.create' && event.response?.instructions?.includes('Luna completed')
  ));
  assert.equal(noticeCreates.length, 2);
  client.ws.serverSend({ type: 'response.created', response: { id: 'notice-retry' } });
  client.ws.serverSend({
    type: 'response.done',
    response: { id: 'notice-retry', status: 'completed', output: [] },
  });
  const [deliveredNotice] = await delivered;
  assert.equal(deliveredNotice.key, 'job:42');
  assert.equal(client.pendingNotices.length, 0);
});

test('invalid approval narration is suppressed and retried through the tool path', async (t) => {
  const client = await createConnectedClient({
    responseValidator: ({ transcript }) => ({
      allowed: !/press pound/i.test(transcript),
      reason: 'unbacked_approval_prompt',
      retryInstructions: 'Call the required tool before discussing approval.',
      retryPurpose: 'approval_validation_retry',
    }),
  });
  t.after(() => client.close());
  const rejected = once(client, 'response.output_rejected');
  const audio = [];
  client.on('audio', (event) => audio.push(event));

  client.queueUserResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'approval-hallucination' } });
  client.ws.serverSend({
    type: 'response.output_audio.delta',
    response_id: 'approval-hallucination',
    item_id: 'approval-audio',
    delta: Buffer.from([1, 2, 3]).toString('base64'),
  });
  client.ws.serverSend({
    type: 'response.output_audio_transcript.done',
    response_id: 'approval-hallucination',
    item_id: 'approval-audio',
    transcript: 'Approval needed. Press pound to approve.',
  });
  client.ws.serverSend({
    type: 'response.done',
    response: { id: 'approval-hallucination', status: 'completed', output: [] },
  });
  const [event] = await rejected;
  assert.equal(event.reason, 'unbacked_approval_prompt');
  assert.deepEqual(audio, []);
  assert.ok(client.ws.sentEvents().some((entry) => (
    entry.type === 'response.create' && entry.response?.instructions?.includes('required tool')
  )));
});

test('a late cancel race is classified as benign instead of an API failure', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  client.requestResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-race' } });
  client.cancelResponse();
  const race = once(client, 'cancel_race');
  client.ws.serverSend({
    type: 'error',
    error: {
      code: 'response_cancel_not_active',
      message: 'Cancellation failed: no active response found',
    },
  });
  const [event] = await race;
  assert.equal(event.code, 'response_cancel_not_active');
  assert.equal(client.cancelPending, false);
});

test('Realtime billing usage events expose cached, audio, and text token details to the local ledger', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const usageEvent = once(client, 'usage');
  client.ws.serverSend({
    type: 'response.done',
    event_id: 'event-usage',
    response: {
      id: 'response-usage',
      output: [],
      usage: {
        total_tokens: 25,
        input_tokens: 20,
        output_tokens: 5,
        input_token_details: { text_tokens: 8, audio_tokens: 12, cached_tokens: 6 },
        output_token_details: { text_tokens: 2, audio_tokens: 3 },
      },
    },
  });
  const [record] = await usageEvent;
  assert.equal(record.eventKey, 'response:response-usage');
  assert.equal(record.model, 'gpt-realtime-2.1-mini');
  assert.equal(record.usage.input_token_details.cached_tokens, 6);
});

test('Realtime uses a dedicated key rather than the Codex CLI key', () => {
  const voiceKey = 'sk-proj-realtime-fixture-0123456789abcdef';
  assert.equal(getRealtimeApiKey({
    OPENAI_REALTIME_API_KEY: voiceKey,
    OPENAI_API_KEY: 'codex-key',
  }), voiceKey);
  assert.equal(getRealtimeApiKey({ OPENAI_API_KEY: 'codex-key' }), '');
  for (const rejected of [
    'short-key',
    ` ${voiceKey}`,
    `${voiceKey}\n`,
    'replace-with-openai-realtime-api-key-1234567890',
  ]) {
    assert.equal(getRealtimeApiKey({ OPENAI_REALTIME_API_KEY: rejected }), '');
  }
});


test('voice owner action contracts require labels and never ask the model to manufacture IDs', () => {
  for (const name of ['inspect_owner_session', 'request_owner_instruction']) {
    const tool = buildRealtimeTools(['codex-sol']).find(t => t.name === name);
    assert.ok(tool.parameters.required.includes('session_label'));
    assert.equal(Object.hasOwn(tool.parameters.properties, 'id'), false);
  }
});

test('unknown owner names can ask a clarification in the speech stage without another action', async (t) => {
  let calls = 0;
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const client = await createConnectedClient({ capabilities, toolHandler: async () => {
    calls += 1;
    return { success: false, code: 'OWNER_SESSION_NOT_ENROLLED', clarification_required: true,
      available_session_labels: ['teletest'] };
  } });
  t.after(() => client.close());
  client.queueUserResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'clarify-route' } });
  client.ws.serverSend({ type: 'response.done', response: { id: 'clarify-route', status: 'completed',
    output: [{ type: 'function_call', name: 'route_turn', call_id: 'clarify-tool', arguments: JSON.stringify({
      action: 'inspect_owner_session', arguments_json: JSON.stringify({ session_label: 'Telefest', history: true }),
    }) }] } });
  await new Promise(resolve => setImmediate(resolve));
  const speech = client.ws.sentEvents().at(-1).response;
  assert.equal(calls, 1);
  assert.equal(speech.tool_choice, 'none');
  assert.match(speech.instructions, /ask one short question using available_session_labels/);
  assert.match(speech.instructions, /teletest/);
});


test('named enrollment speech is verified and excludes earlier false refusals', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const client = await createConnectedClient({ capabilities, toolHandler: async () => ({ success: true,
    result: { query_label: 'phone A', sessions: [{ label: 'phoneA', provider: 'codex' }] } }) });
  t.after(() => client.close());
  client.queueUserResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'membership-route' } });
  client.ws.serverSend({ type: 'response.done', response: { id: 'membership-route', status: 'completed',
    output: [{ type: 'function_call', name: 'route_turn', call_id: 'membership-tool', arguments: JSON.stringify({
      action: 'list_owner_sessions', arguments_json: JSON.stringify({ session_label: 'phone A' }),
    }) }] } });
  await new Promise(resolve => setImmediate(resolve));
  const speech = client.ws.sentEvents().at(-1).response;
  assert.deepEqual(speech.input, []);
  assert.deepEqual(speech.tools, []);
  assert.match(speech.instructions, /Yes, phoneA is an enrolled personal session/);
  assert.equal(client.nextVerifiedSpeech.text, 'Yes, phoneA is an enrolled personal session.');
  client.ws.serverSend({ type: 'response.created', response: { id: 'membership-speech' } });
  const audio = []; client.on('audio', e => audio.push(e));
  client.ws.serverSend({ type: 'response.output_audio.delta', response_id: 'membership-speech', item_id: 'membership-audio', delta: Buffer.from([1, 2]).toString('base64') });
  client.ws.serverSend({ type: 'response.output_audio_transcript.done', response_id: 'membership-speech', item_id: 'membership-audio', transcript: 'I cannot confirm that from here.' });
  client.ws.serverSend({ type: 'response.done', response: { id: 'membership-speech', status: 'completed', output: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audio.length, 0);
  assert.equal(client.nextVerifiedSpeech.attempt, 1);
});

test('delivery references survive routed tools, distinguish first from latest, and never contain message text', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const calls = [];
  const client = await createConnectedClient({ capabilities, toolHandler: async (name, args) => {
    calls.push({ name, args });
    return name === 'request_owner_instruction' ? { success: true, operation_id: 'job_' + (args.session_label === 'drizzy' ? '1' : '2').repeat(64), result: { state: 'dispatching' } }
      : { success: true, result: { state: 'accepted' } };
  } });
  t.after(() => client.close());
  for (const label of ['drizzy', 'phoneA']) await client._handleToolCall({ name: 'route_turn', call_id: label,
    arguments: JSON.stringify({ action: 'request_owner_instruction', arguments_json: JSON.stringify({ session_label: label, message: 'PRIVATE MESSAGE' }) }) }, { sendOutput: false });
  assert.equal(client.ownerInstructionReferences.length, 2);
  client.requestRoutedResponse();
  const route = client.ws.sentEvents().at(-1).response;
  assert.match(route.instructions, /get_owner_instruction/);
  assert.match(route.instructions, /send_number 1, not the latest/);
  assert.ok(route.instructions.includes('job_' + '1'.repeat(64)));
  assert.ok(route.instructions.includes('job_' + '2'.repeat(64)));
  assert.doesNotMatch(route.instructions, /PRIVATE MESSAGE/);
  const read = await client._handleToolCall({ name: 'get_owner_instruction', call_id: 'first-status', arguments: JSON.stringify({ operation_id: client.ownerInstructionReferences[0].operation_id }) });
  assert.equal(read.output.result.state, 'accepted');
  assert.deepEqual(calls.map(c => c.name), ['request_owner_instruction', 'request_owner_instruction', 'get_owner_instruction']);
  const other = await createConnectedClient({ capabilities });t.after(() => other.close());
  assert.deepEqual(other.ownerInstructionReferences, []);
});

test('instruction routing memory is bounded and does not renumber dropped references', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const client = await createConnectedClient({ capabilities, toolHandler: async (name, args) => ({ success: true,
    operation_id: 'job_' + args.message.padStart(64, '0'), result: { state: 'outcome_unknown' } }) });
  t.after(() => client.close());
  for (let i = 1; i <= 33; i++) await client._handleToolCall({ name: 'request_owner_instruction', call_id: 'ref-' + i,
    arguments: JSON.stringify({ session_label: 'drizzy', message: i.toString(16) }) }, { sendOutput: false });
  assert.equal(client.ownerInstructionReferences.length, 32);
  assert.equal(client.ownerInstructionReferences[0].send_number, 2);
  assert.equal(client.ownerInstructionReferences.at(-1).send_number, 33);
});


test('explicit follow-up reads are scoped, ordinal-stable and never reinterpret sends or ambiguous references', () => {
  const first = 'job_' + '1'.repeat(64), last = 'job_' + '2'.repeat(64);
  const refs = [{ send_number: 1, session_label: 'drizzy', operation_id: first }, { send_number: 2, session_label: 'phoneA', operation_id: last }];
  assert.deepEqual(ownerReadRoute('Is there also a session called phone A?', refs), { action: 'list_owner_sessions', args: { session_label: 'phone A' } });
  for (const text of ['Is there any status on the first message you sent?', 'Did the message to drizzy arrive?'])
    assert.deepEqual(ownerReadRoute(text, refs), { action: 'get_owner_instruction', args: { operation_id: first } });
  assert.equal(ownerReadRoute('What is the status of the latest message?', refs).args.operation_id, last);
  assert.equal(ownerReadRoute('What about now?', refs, 'get_owner_instruction', first).args.operation_id, first);
  for (const text of ['Do not check the first message.', 'Send drizzy: Is there a session called phone A?', 'What about now?', 'Is there any status on the third message?', 'Is there a session called phone A and send it hello?'])
    assert.equal(ownerReadRoute(text, refs), null);
  assert.equal(ownerReadRoute('Is there any status on the first message?', refs.slice(1)), null);
  assert.equal(ownerReadRoute('Did the message to drizzy arrive?', [...refs, { ...refs[1], session_label: 'drizzy' }]), null);
});

test('a completed explicit read turn overrides a mistaken respond route without sending another instruction', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const calls = [], operation = 'job_' + '1'.repeat(64);
  const client = await createConnectedClient({ capabilities, toolHandler: async (name, args) => {
    calls.push({ name, args });return { success: true, result: { state: 'accepted' } };
  } });t.after(() => client.close());
  client.ownerInstructionReferences = [{ send_number: 1, session_label: 'drizzy', operation_id: operation }];
  client.ws.serverSend({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Is there any status on the first message you sent?' });
  client.requestRoutedResponse();
  const result = await client._handleToolCall({ name: 'route_turn', call_id: 'wrong-route', arguments: JSON.stringify({ action: 'respond', response_instruction: 'Say you cannot check.' }) }, { sendOutput: false });
  assert.equal(result.action, 'get_owner_instruction');
  assert.deepEqual(calls, [{ name: 'get_owner_instruction', args: { operation_id: operation } }]);
  assert.equal(client.pendingOwnerReadRoute, null);
  assert.equal(client.focusedOwnerOperation, operation);
});


test('reply follow-ups select the focused native session and keep delivery queries separate', () => {
  const operation = 'job_' + '1'.repeat(64);
  const refs = [{ send_number: 1, session_label: 'drizzy', operation_id: operation }];
  for (const text of ['Did it reply?', 'Has it replied yet?', 'I sure did it reply?',
    "So there's no output still. Could you recheck?", 'Any output?', 'Read its latest reply.',
    'Has it answered yet?', 'Can you see whether it has written an answer yet?']) {
    assert.deepEqual(ownerReadRoute(text, refs, 'get_owner_instruction', operation),
      { action: 'inspect_owner_session', args: { session_label: 'drizzy', history: true } });
  }
  assert.equal(ownerReadRoute('Did it arrive?', refs, 'get_owner_instruction', operation).action, 'get_owner_instruction');
  for (const text of ['What about now?', 'Could you recheck?', 'Recheck.']) {
    assert.deepEqual(ownerReadRoute(text, refs, 'inspect_owner_session', null, 'phoneA'),
      { action: 'inspect_owner_session', args: { session_label: 'phoneA', history: true } });
  }
  for (const text of ['Do not read its reply.', 'Send drizzy: did it reply?', 'Did it reply and send it hello?',
    'Did another session reply?', 'Read its reply then deploy.'])
    assert.equal(ownerReadRoute(text, refs, 'get_owner_instruction', operation), null);
  assert.equal(ownerReadRoute('Did it reply?', refs), null, 'must not guess the last reference');
  assert.equal(ownerReadRoute('Did it reply?', refs, null, operation, 'drizzy'), null, 'unrelated turns clear focus');
});

test('attended reply follow-ups override stale receipt routes and re-read only the newest native turn', async (t) => {
  const capabilities = { ...require('./controller-capabilities-fixture').READY_CAPABILITIES, ownerSessionsAvailable: true };
  const calls = [], operation = 'job_' + '1'.repeat(64);
  let latestTurn = { status: 'inProgress', reply: null };
  const client = await createConnectedClient({ capabilities, toolHandler: async (name, args) => {
    calls.push({ name, args });
    assert.equal(name, 'inspect_owner_session');
    return { success: true, result: { label: 'drizzy', history: { latestTurn,
      messages: [{ role: 'assistant', text: 'STALE ANSWER' }] } } };
  } });t.after(() => client.close());
  client.ownerInstructionReferences = [{ send_number: 1, session_label: 'drizzy', operation_id: operation }];
  client.lastOwnerAction = 'get_owner_instruction';client.focusedOwnerOperation = operation;
  for (const [index, transcript] of ['I sure did it reply?', "So there's no output still. Could you recheck?", 'What about now?'].entries()) {
    client.latestUserTranscript = transcript;
    client.requestRoutedResponse();
    await client._handleEvent({ type: 'response.created', response: { id: 'reply-route-' + index } });
    await client._handleEvent({ type: 'response.done', response: { id: 'reply-route-' + index, status: 'completed',
      output: [{ type: 'function_call', name: 'route_turn', call_id: 'reply-' + index,
        arguments: JSON.stringify({ action: 'get_owner_instruction', arguments_json: JSON.stringify({ operation_id: operation }) }) }] } });
    const speech = client.ws.sentEvents().at(-1).response;
    assert.deepEqual(speech.input, []);assert.deepEqual(speech.tools, []);assert.equal(speech.tool_choice, 'none');
    assert.deepEqual(JSON.parse(speech.instructions.split('Native read result: ')[1]), { label: 'drizzy', latestTurn });
    assert.doesNotMatch(speech.instructions, /STALE ANSWER/);
    assert.equal(client.focusedOwnerSession, 'drizzy');assert.equal(client.lastOwnerAction, 'inspect_owner_session');
    // Complete the synthetic speech response before the next caller turn.
    client.responseActive = false;
    latestTurn = { status: 'completed', reply: { role: 'assistant', text: 'v61 ready', clipped: false } };
  }
  assert.deepEqual(calls, Array(3).fill({ name: 'inspect_owner_session', args: { session_label: 'drizzy', history: true } }));
  await client._handleToolCall({ name: 'respond', call_id: 'unrelated', arguments: '{}' }, { sendOutput: false });
  assert.equal(client.focusedOwnerSession, null);
});
