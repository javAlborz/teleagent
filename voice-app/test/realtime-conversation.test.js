'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setImmediate } = require('node:timers');
const {
  isBackchannelOnly,
  isCutoffReport,
  isDefinitiveGoodbye,
  isLikelyUnclearTranscript,
  isQuietWaitRequest,
  isVoiceCancelRequest,
  runRealtimeConversation,
} = require('../lib/realtime-conversation');
const { VoiceStateStore } = require('../lib/voice-state-store');

class FakeRealtimeClient extends EventEmitter {
  constructor(options, dialog, { autoDestroyGreeting = true } = {}) {
    super();
    this.options = options;
    this.dialog = dialog;
    this.sessionId = 'openai-session-test';
    this.notices = [];
    this.closed = false;
    this.autoDestroyGreeting = autoDestroyGreeting;
    this.queuedResponses = [];
    this.discardedResponses = 0;
    this.canceledResponses = 0;
    this.truncations = [];
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
    if (this.autoDestroyGreeting && this.notices.length === 1) {
      setImmediate(() => this.dialog.destroy());
    }
    return true;
  }

  queueUserResponse(options) {
    this.queuedResponses.push(options);
    return true;
  }

  discardPendingUserResponse() {
    this.discardedResponses += 1;
  }

  cancelResponse() {
    this.canceledResponses += 1;
    return true;
  }

  truncatePlayback(playback) {
    this.truncations.push(playback);
    return true;
  }

  close() {
    this.closed = true;
  }
}

function createCallFixture(t, {
  autoDestroyGreeting = true,
  activeJobs = [],
  dialogDestroyEmits = true,
  dialogDestroyRejects = false,
} = {}) {
  const previousKey = process.env.OPENAI_REALTIME_API_KEY;
  process.env.OPENAI_REALTIME_API_KEY = 'test-realtime-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_REALTIME_API_KEY;
    else process.env.OPENAI_REALTIME_API_KEY = previousKey;
  });

  const stateStore = new VoiceStateStore({ dbPath: ':memory:' });
  t.after(() => stateStore.close());

  const dialog = new EventEmitter();
  dialog.destroyed = false;
  dialog.destroyCalls = 0;
  dialog.destroy = () => {
    dialog.destroyCalls += 1;
    dialog.destroyed = true;
    if (dialogDestroyEmits) {
      dialog.emit('destroy');
    }
    return dialogDestroyRejects
      ? Promise.reject(new Error('simulated SIP BYE transport failure'))
      : Promise.resolve();
  };
  const endpoint = new EventEmitter();
  endpoint.uuid = 'endpoint-uuid';
  endpoint.forkOptions = null;
  endpoint.forkStopped = false;
  endpoint.destroyed = false;
  endpoint.forkAudioStart = async (options) => { endpoint.forkOptions = options; };
  endpoint.forkAudioStop = async () => { endpoint.forkStopped = true; };
  endpoint.destroy = async () => { endpoint.destroyed = true; };
  endpoint.api = async () => ({ body: '+OK' });
  endpoint.played = [];
  endpoint.play = async (url) => { endpoint.played.push(url); };

  const audioSession = new EventEmitter();
  audioSession.setCaptureEnabled = () => {};
  audioSession.sendAudio = () => true;
  audioSession.stopPlaybackCalls = 0;
  audioSession.stopPlayback = () => {
    audioSession.stopPlaybackCalls += 1;
    const playback = audioSession.nextPlayback || null;
    audioSession.nextPlayback = null;
    return playback;
  };
  audioSession.playbackComplete = [];
  audioSession.markPlaybackComplete = (itemId) => {
    audioSession.playbackComplete.push(itemId);
    return true;
  };
  audioSession.closed = false;
  audioSession.close = () => { audioSession.closed = true; };

  const audioForkServer = {
    expected: null,
    expectSession(callUuid, options) {
      this.expected = { callUuid, options };
      return Promise.resolve(audioSession);
    },
  };

  const jobBroker = new EventEmitter();
  const cancelCalls = [];
  jobBroker.agentBridge = { inspectOperator: async () => ({ success: true, result: {} }) };
  jobBroker.listProfiles = () => ['claude-opus', 'codex-terra'];
  jobBroker.listProfileDetails = () => [
    { profile: 'claude-opus', provider: 'claude', capability: 'admin' },
    { profile: 'codex-terra', provider: 'codex', capability: 'write' },
  ];
  jobBroker.startAgentTask = async (args) => ({ accepted: true, job_id: args.toolCallId });
  jobBroker.getAgentTask = () => ({ found: false });
  jobBroker.cancelAgentTask = async (...args) => {
    cancelCalls.push(args);
    return { canceled: false };
  };
  jobBroker.listAgentTasks = () => ({ jobs: activeJobs });
  jobBroker.approveNextJob = () => ({ approved: false });

  let realtimeClient;
  const openaiClientFactory = (options) => {
    realtimeClient = new FakeRealtimeClient(options, dialog, { autoDestroyGreeting });
    return realtimeClient;
  };

  return {
    audioForkServer,
    audioSession,
    cancelCalls,
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
  assert.equal(fixture.endpoint.forkOptions.sampling, '24000');
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

test('observed call regression phrases select quiet-wait and definitive hangup deterministically', () => {
  const fixtures = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'realtime-call-regressions.json'),
    'utf8'
  ));
  for (const fixture of fixtures) {
    assert.equal(isQuietWaitRequest(fixture.utterance), fixture.quiet_wait, fixture.id);
    assert.equal(isDefinitiveGoodbye(fixture.utterance), fixture.goodbye, fixture.id);
  }
});

test('standalone backchannels and unsafe transcript fragments are classified without swallowing commands', () => {
  assert.equal(isBackchannelOnly('Mm-hmm.'), true);
  assert.equal(isBackchannelOnly('Okay, cancel that job.'), false);
  assert.equal(isBackchannelOnly('Yes'), false);
  assert.equal(isLikelyUnclearTranscript('[inaudible]'), true);
  assert.equal(isLikelyUnclearTranscript('the'), true);
  assert.equal(isLikelyUnclearTranscript('the phone session'), false);
  assert.equal(isLikelyUnclearTranscript('stop'), false);
  assert.equal(isCutoffReport('Your answer cut off before it finished.'), true);
  assert.equal(isCutoffReport('Cut off the old deployment.'), false);
  assert.equal(isVoiceCancelRequest('Cancel it.'), true);
  assert.equal(isVoiceCancelRequest('Cancel it after the tests finish.'), false);
});

test('runtime transcription vocabulary includes live tmux conversation names', async (t) => {
  const fixture = createCallFixture(t);
  fixture.jobBroker.agentBridge.inspectOperator = async () => ({
    success: true,
    result: {
      sessions: [{
        name: 'freestio',
        windows: [{
          name: 'phone',
          panes: [{ conversation_name: '8player-tooling' }],
        }],
      }],
    },
  });

  await runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-vocabulary',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );

  const options = fixture.getRealtimeClient().options;
  assert.ok(options.transcriptionKeywords.includes('freestio'));
  assert.ok(options.transcriptionKeywords.includes('8player-tooling'));
  assert.match(options.transcriptionPrompt, /8player-tooling/);
});

test('speech-start and backchannels preserve playout while substantive turns interrupt it', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-selective-barge-in',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      responseDebounceMs: 5,
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));

  fixture.audioSession.nextPlayback = { itemId: 'item-playing', audioEndMs: 640 };
  realtime.emit('speech_started');
  assert.equal(fixture.audioSession.stopPlaybackCalls, 0);
  assert.equal(realtime.canceledResponses, 0);

  realtime.emit('user_transcript', 'Mm-hmm.');
  assert.equal(fixture.audioSession.stopPlaybackCalls, 0);
  assert.equal(realtime.canceledResponses, 0);

  realtime.emit('user_transcript', 'Show me the latest provider reply.');
  assert.equal(fixture.audioSession.stopPlaybackCalls, 1);
  assert.equal(realtime.canceledResponses, 1);
  assert.deepEqual(realtime.truncations, [{ itemId: 'item-playing', audioEndMs: 640 }]);

  await fixture.dialog.destroy();
  await call;
});

test('voice cancellation requires star and completion notices are announced once', async (t) => {
  const fixture = createCallFixture(t, {
    autoDestroyGreeting: false,
    activeJobs: [{ job_id: 'job-running', status: 'running' }],
  });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-safe-cancel',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));

  realtime.emit('user_transcript', 'Cancel it.');
  assert.equal(fixture.cancelCalls.length, 0);
  assert.match(realtime.notices.at(-1), /press star/i);

  const threadId = fixture.stateStore.db.prepare('SELECT id FROM voice_threads LIMIT 1').get().id;
  const completed = {
    id: 'job-once',
    voice_thread_id: threadId,
    profile: 'codex-terra',
    status: 'completed',
    voice_result: 'The check passed.',
  };
  fixture.jobBroker.emit('job.completed', completed);
  fixture.jobBroker.emit('job.completed', completed);
  assert.equal(realtime.notices.filter((notice) => notice.includes('job-once')).length, 1);

  fixture.endpoint.emit('dtmf', { digit: '*' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.cancelCalls.length, 1);

  await fixture.dialog.destroy();
  await call;
});

test('a cutoff report requests one bounded restatement instead of a generic apology', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-cutoff-report',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));

  realtime.emit('user_transcript', 'Your previous answer was cut off.');
  assert.match(realtime.notices.at(-1), /restate the complete previous answer once/i);
  assert.doesNotMatch(realtime.notices.at(-1), /apologize/i);
  assert.equal(realtime.queuedResponses.length, 0);

  await fixture.dialog.destroy();
  await call;
});

test('user response debounce coalesces transcript tails and suppresses backchannels', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-debounce',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      responseDebounceMs: 15,
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));

  realtime.emit('user_transcript', 'Show me the runtime sessions.');
  realtime.emit('user_transcript', 'Include the main tmux session.');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(realtime.queuedResponses.length, 1);

  realtime.emit('user_transcript', 'Mm-hmm.');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(realtime.queuedResponses.length, 1);
  assert.equal(realtime.discardedResponses, 1);
  assert.ok(fixture.stateStore.listAuditEvents({ limit: 20 })
    .some((event) => event.action === 'backchannel_suppressed'));

  realtime.emit('user_transcript', 'the');
  assert.match(realtime.notices.at(-1), /fragmentary/);
  assert.equal(realtime.queuedResponses.length, 1);
  await fixture.dialog.destroy();
  await call;
});

test('quiet-wait requests acknowledge with a tone and do not create a spoken response', async (t) => {
  const fixture = createCallFixture(t, {
    autoDestroyGreeting: false,
    activeJobs: [{ job_id: 'job-waiting', status: 'running' }],
  });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-quiet-wait',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));
  realtime.emit('user_transcript', 'Stay quiet until the result is done.');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(realtime.discardedResponses, 1);
  assert.equal(realtime.queuedResponses.length, 0);
  assert.equal(fixture.endpoint.played.length, 1);
  await fixture.dialog.destroy();
  await call;
});

test('an explicit goodbye produces one farewell lifecycle and destroys the SIP dialog', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-goodbye',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      hangupDelayMs: 0,
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));
  realtime.emit('user_transcript', "That's all, goodbye.");
  assert.match(realtime.notices.at(-1), /explicitly ended the call/);
  realtime.emit('response.done', {}, { purpose: 'notice:hangup' });
  await call;
  assert.equal(fixture.dialog.destroyed, true);
  assert.equal(realtime.discardedResponses, 1);
});

test('local hangup always resolves cleanup when SIP destroy rejects without emitting destroy', async (t) => {
  const fixture = createCallFixture(t, {
    autoDestroyGreeting: false,
    dialogDestroyEmits: false,
    dialogDestroyRejects: true,
  });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-goodbye-bye-failure',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      hangupDelayMs: 0,
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));

  realtime.emit('user_transcript', 'Goodbye, hang up.');
  realtime.emit('user_transcript', 'Are you still there?');
  realtime.emit('response.done', {}, { purpose: 'notice:hangup' });
  await call;

  assert.equal(fixture.dialog.destroyCalls, 1);
  assert.equal(fixture.endpoint.destroyed, true);
  assert.equal(fixture.endpoint.forkStopped, true);
  assert.equal(fixture.audioSession.closed, true);
  assert.equal(realtime.closed, true);
  assert.equal(realtime.queuedResponses.length, 0);
  assert.equal(
    fixture.stateStore.db.prepare('SELECT status FROM realtime_sessions').get().status,
    'closed'
  );
});

test('assistant transcript deduplication is item-scoped and tool/limit events are audited', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-observability',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  await new Promise((resolve) => setImmediate(resolve));

  realtime.emit('assistant_transcript', 'I can hear you.', { item_id: 'item-one' });
  realtime.emit('assistant_transcript', 'I can hear you.', { item_id: 'item-one' });
  realtime.emit('assistant_transcript', 'I can hear you.', { item_id: 'item-two' });
  realtime.emit('tool.completed', {
    call: {
      name: 'inspect_tmux_pane',
      call_id: 'tool-audit-1',
      arguments: JSON.stringify({ target: 'main:phone', lines: 40 }),
    },
    args: { target: 'main:phone', lines: 40 },
    output: { success: true, content: 'sensitive pane text that must not be audited' },
    durationMs: 12,
  });
  realtime.emit('response.clipped', {
    itemId: 'item-limited',
    responseId: 'response-limited',
    wordCount: 51,
    softLimit: 45,
    hardLimit: 90,
    mode: 'sentence_boundary',
  });
  assert.equal(fixture.audioSession.stopPlaybackCalls, 0);
  realtime.emit('transcription.empty', { item_id: 'empty-audio', content_index: 0 });
  realtime.emit('context.truncated', { item_id: 'old-context', content_index: 0, audio_end_ms: 500 });
  realtime.emit('context.item_deleted', { item_id: 'expired-context' });
  realtime.emit('response.output_suppressed', {
    responseId: 'response-tool-preamble',
    reason: 'tool_selection',
    audioBytes: 3200,
    transcriptCount: 1,
    toolCalls: 1,
  });

  const transcriptRows = fixture.stateStore.db.prepare(`
    SELECT content FROM voice_events
    WHERE role = 'assistant' AND content = 'I can hear you.'
  `).all();
  assert.equal(transcriptRows.length, 2);
  const auditRows = fixture.stateStore.listAuditEvents({ limit: 20 });
  assert.ok(auditRows.some((event) => event.action === 'voice_tool_completed'));
  assert.ok(auditRows.some((event) => event.action === 'spoken_output_limited'));
  assert.ok(auditRows.some((event) => event.action === 'empty_transcription_observed'));
  assert.ok(auditRows.some((event) => event.action === 'realtime_context_truncated'));
  assert.ok(auditRows.some((event) => event.action === 'realtime_context_item_deleted'));
  assert.ok(auditRows.some((event) => event.action === 'realtime_output_suppressed'));
  assert.doesNotMatch(JSON.stringify(auditRows), /sensitive pane text/);

  await fixture.dialog.destroy();
  await call;
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
