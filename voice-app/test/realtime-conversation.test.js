'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { setImmediate } = require('node:timers');
const { runRealtimeConversation } = require('../lib/realtime-conversation');
const { VoiceStateStore } = require('../lib/voice-state-store');

class FakeRealtimeClient extends EventEmitter {
  constructor(options, dialog) {
    super();
    this.options = options;
    this.dialog = dialog;
    this.sessionId = 'openai-session-test';
    this.notices = [];
    this.closed = false;
  }

  async connect() {
    this.emit('session.created', { id: this.sessionId });
    return { id: this.sessionId };
  }

  appendAudio() {
    return true;
  }

  sendSystemNotice(content) {
    this.notices.push(content);
    if (this.notices.length === 1) {
      setImmediate(() => this.dialog.emit('destroy'));
    }
    return true;
  }

  truncatePlayback() {
    return true;
  }

  close() {
    this.closed = true;
  }
}

function createCallFixture(t) {
  const previousKey = process.env.OPENAI_REALTIME_API_KEY;
  process.env.OPENAI_REALTIME_API_KEY = 'test-realtime-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_REALTIME_API_KEY;
    else process.env.OPENAI_REALTIME_API_KEY = previousKey;
  });

  const stateStore = new VoiceStateStore({ dbPath: ':memory:' });
  t.after(() => stateStore.close());

  const dialog = new EventEmitter();
  const endpoint = new EventEmitter();
  endpoint.uuid = 'endpoint-uuid';
  endpoint.forkOptions = null;
  endpoint.forkStopped = false;
  endpoint.forkAudioStart = async (options) => { endpoint.forkOptions = options; };
  endpoint.forkAudioStop = async () => { endpoint.forkStopped = true; };
  endpoint.api = async () => ({ body: '+OK' });

  const audioSession = new EventEmitter();
  audioSession.setCaptureEnabled = () => {};
  audioSession.sendAudio = () => true;
  audioSession.stopPlayback = () => null;

  const audioForkServer = {
    expected: null,
    expectSession(callUuid, options) {
      this.expected = { callUuid, options };
      return Promise.resolve(audioSession);
    },
  };

  const jobBroker = new EventEmitter();
  jobBroker.listProfiles = () => ['claude-opus', 'codex-terra'];
  jobBroker.startAgentTask = async (args) => ({ accepted: true, job_id: args.toolCallId });
  jobBroker.getAgentTask = () => ({ found: false });
  jobBroker.cancelAgentTask = async () => ({ canceled: false });
  jobBroker.listAgentTasks = () => ({ jobs: [] });
  jobBroker.approveNextJob = () => ({ approved: false });

  let realtimeClient;
  const openaiClientFactory = (options) => {
    realtimeClient = new FakeRealtimeClient(options, dialog);
    return realtimeClient;
  };

  return {
    audioForkServer,
    dialog,
    endpoint,
    getRealtimeClient: () => realtimeClient,
    jobBroker,
    openaiClientFactory,
    stateStore,
  };
}

test('Realtime conversation streams 24 kHz full-duplex audio and closes durable state', async (t) => {
  const fixture = createCallFixture(t);
  const result = await runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-voice-1',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      defaultProfile: 'codex-terra',
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );

  assert.equal(result.resumed, false);
  assert.equal(fixture.audioForkServer.expected.options.sampleRate, 24000);
  assert.equal(fixture.audioForkServer.expected.options.bidirectionalStreaming, true);
  assert.equal(fixture.endpoint.forkOptions.sampling, '24k');
  assert.equal(fixture.endpoint.forkOptions.bidirectionalAudio.streaming, 'true');
  assert.equal(fixture.endpoint.forkStopped, true);
  assert.equal(fixture.getRealtimeClient().options.apiKey, 'test-realtime-key');
  assert.match(fixture.getRealtimeClient().options.safetyIdentifier, /^[a-f0-9]{64}$/);
  assert.notEqual(fixture.getRealtimeClient().options.safetyIdentifier, '1001');
  assert.deepEqual(fixture.getRealtimeClient().options.profiles, ['claude-opus', 'codex-terra']);
  assert.equal(fixture.stateStore.getThread(result.voiceThreadId).status, 'idle');

  const realtimeRows = fixture.stateStore.db
    .prepare('SELECT status, openai_session_id FROM realtime_sessions')
    .all();
  assert.deepEqual(realtimeRows, [{ status: 'closed', openai_session_id: 'openai-session-test' }]);
});

test('an explicit callback thread cannot cross caller identities', async (t) => {
  const fixture = createCallFixture(t);
  const otherCallerThread = fixture.stateStore.createThread({
    callerId: '2002',
    selectedProfile: 'claude-opus',
  });

  const result = await runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-voice-2',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      resume: true,
      voiceThreadId: otherCallerThread.id,
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );

  assert.notEqual(result.voiceThreadId, otherCallerThread.id);
  assert.equal(fixture.stateStore.getThread(result.voiceThreadId).caller_id, '1001');
});
