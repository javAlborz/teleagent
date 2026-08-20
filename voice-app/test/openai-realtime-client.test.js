'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { setImmediate } = require('node:timers');
const {
  OpenAIRealtimeClient,
  buildRealtimeTools,
  getRealtimeApiKey,
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

test('Realtime session uses 24 kHz PCM, manual semantic VAD, tuned transcription, and bounded tools', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const update = client.ws.sentEvents().find((event) => event.type === 'session.update');

  assert.equal(update.session.model, 'gpt-realtime-2.1-mini');
  assert.equal(update.session.audio.input.format.rate, 24000);
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
  assert.deepEqual(toolNames.slice(0, 6), [
    'send_agent_message',
    'send_agent_session_message',
    'handoff_agent_session',
    'get_agent_task',
    'list_agent_tasks',
    'list_agent_sessions',
  ]);
  assert.equal(toolNames.includes('cancel_agent_task'), false);
  assert.ok(toolNames.includes('get_voice_history'));
  assert.ok(toolNames.includes('read_text_file'));
  assert.ok(toolNames.includes('inspect_tmux_pane'));
  assert.ok(toolNames.includes('inspect_agent_session_history'));
  assert.ok(toolNames.includes('get_latest_agent_session_message'));
  assert.ok(toolNames.includes('list_runtime_sessions'));
  assert.ok(toolNames.includes('continue_agent_session_history'));
  assert.ok(toolNames.includes('get_weather'));
  assert.ok(toolNames.includes('end_call'));
  assert.equal(
    update.session.tools.find((tool) => tool.name === 'get_voice_history').parameters.properties.limit.maximum,
    50
  );
  assert.ok(
    update.session.tools.find((tool) => tool.name === 'list_tmux_sessions').parameters.properties.session
  );
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
});

test('tool-capable user responses buffer audio until the response is known to be speech-only', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const audio = [];
  const transcripts = [];
  client.on('audio', (event) => audio.push(event));
  client.on('assistant_transcript', (text) => transcripts.push(text));

  client.queueUserResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-buffered' } });
  client.ws.serverSend({
    type: 'response.output_audio.delta',
    response_id: 'response-buffered',
    item_id: 'item-buffered',
    delta: Buffer.from([1, 2, 3]).toString('base64'),
  });
  client.ws.serverSend({
    type: 'response.output_audio_transcript.done',
    response_id: 'response-buffered',
    item_id: 'item-buffered',
    transcript: 'Direct answer.',
  });
  assert.equal(audio.length, 0);
  assert.equal(transcripts.length, 0);

  client.ws.serverSend({
    type: 'response.done',
    response: { id: 'response-buffered', status: 'completed', output: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(audio.map((event) => [...event.audio]), [[1, 2, 3]]);
  assert.deepEqual(transcripts, ['Direct answer.']);
});

test('spoken preambles attached to tool selection are suppressed before phone playout', async (t) => {
  const client = await createConnectedClient({ toolHandler: async () => ({ success: true }) });
  t.after(() => client.close());
  const audio = [];
  const transcripts = [];
  client.on('audio', (event) => audio.push(event));
  client.on('assistant_transcript', (text) => transcripts.push(text));
  const suppressed = once(client, 'response.output_suppressed');

  client.queueUserResponse();
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
  const client = await createConnectedClient({ maxSpokenWords: 10, hardMaxSpokenWords: 20 });
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
    delta: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one.',
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
  assert.deepEqual(
    tools[0].parameters.properties.profile.enum,
    ['auto', 'claude-opus', 'codex-sol']
  );
  assert.deepEqual(
    tools.find((tool) => tool.name === 'remember_preference').parameters.properties.value,
    { type: 'string' }
  );
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

test('spoken output waits for a sentence boundary after the hard limit', async (t) => {
  const client = await createConnectedClient({ maxSpokenWords: 10, hardMaxSpokenWords: 20 });
  t.after(() => client.close());
  client.requestResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-long' } });
  const clipped = once(client, 'response.clipped');
  client.ws.serverSend({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response-long',
    item_id: 'item-long',
    delta: 'one two three four five six seven eight nine ten eleven',
  });
  assert.equal(client.ws.sentEvents().some((entry) => entry.type === 'response.cancel'), false);
  client.ws.serverSend({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response-long',
    item_id: 'item-long',
    delta: ' twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one.',
  });
  const [event] = await clipped;
  assert.equal(event.softLimit, 10);
  assert.equal(event.hardLimit, 20);
  assert.equal(event.mode, 'hard_sentence_boundary');
  assert.ok(client.ws.sentEvents().some((entry) => entry.type === 'response.cancel'));
});

test('spoken output retains a higher hard safety limit for punctuation-free runaway output', async (t) => {
  const client = await createConnectedClient({ maxSpokenWords: 10, hardMaxSpokenWords: 14 });
  t.after(() => client.close());
  client.requestResponse();
  client.ws.serverSend({ type: 'response.created', response: { id: 'response-runaway' } });
  const clipped = once(client, 'response.clipped');
  client.ws.serverSend({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response-runaway',
    item_id: 'item-runaway',
    delta: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine',
  });
  const [event] = await clipped;
  assert.equal(event.mode, 'absolute_hard_limit');
  assert.ok(client.ws.sentEvents().some((entry) => entry.type === 'response.cancel'));
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
  assert.equal(getRealtimeApiKey({
    OPENAI_REALTIME_API_KEY: ' voice-key ',
    OPENAI_API_KEY: 'codex-key',
  }), 'voice-key');
  assert.equal(getRealtimeApiKey({ OPENAI_API_KEY: 'codex-key' }), '');
});
