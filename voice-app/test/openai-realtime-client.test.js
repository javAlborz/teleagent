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

test('Realtime session uses 24 kHz PCM, semantic VAD, voice, and bounded tools', async (t) => {
  const client = await createConnectedClient();
  t.after(() => client.close());
  const update = client.ws.sentEvents().find((event) => event.type === 'session.update');

  assert.equal(update.session.model, 'gpt-realtime-2.1');
  assert.equal(update.session.audio.input.format.rate, 24000);
  assert.equal(update.session.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(update.session.audio.output.voice, 'marin');
  assert.deepEqual(
    update.session.tools.map((tool) => tool.name),
    ['start_agent_task', 'get_agent_task', 'cancel_agent_task', 'list_agent_tasks']
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

test('speech-start events support client-side playout truncation', async (t) => {
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
});

test('tool schema exposes only the supplied profile enum', () => {
  const tools = buildRealtimeTools(['claude-opus', 'codex-sol']);
  assert.deepEqual(
    tools[0].parameters.properties.profile.enum,
    ['claude-opus', 'codex-sol']
  );
});

test('Realtime uses a dedicated key rather than the Codex CLI key', () => {
  assert.equal(getRealtimeApiKey({
    OPENAI_REALTIME_API_KEY: ' voice-key ',
    OPENAI_API_KEY: 'codex-key',
  }), 'voice-key');
  assert.equal(getRealtimeApiKey({ OPENAI_API_KEY: 'codex-key' }), '');
});
