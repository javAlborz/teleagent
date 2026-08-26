'use strict';
const { TEST_RUNTIME_SECRETS, installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setImmediate } = require('node:timers');
const {
  buildConductorInstructions,
  isBackchannelOnly,
  isCutoffReport,
  isDefinitiveGoodbye,
  isLikelyUnclearTranscript,
  isLikelyPlaybackEcho,
  isQuietWaitRequest,
  isVoiceCancelRequest,
  refreshRuntimeTranscriptionVocabulary,
  runRealtimeConversation,
} = require('../lib/realtime-conversation');
const { VoiceStateStore } = require('../lib/voice-state-store');

test('production conductor instructions expose read-only managed authority only', () => {
  const instructions = buildConductorInstructions({
    thread: { id: 'vt_read_only', selected_profile: 'codex-sol' },
    resumeContext: null,
    startupAnnouncement: null,
  });
  assert.match(instructions, /every production phone job is forced read-only/);
  assert.match(instructions, /Pound does not grant production authority/);
  assert.doesNotMatch(instructions, /send_agent_session_message|start_privileged_action/);
  assert.doesNotMatch(instructions, /Sonnet \(write\)|Opus \(admin\)|Terra \(write\)|Sol \(admin\)/);
});

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
    this.requestedResponses = [];
    this.discardedResponses = 0;
    this.deletedItems = [];
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

  requestResponse(response, meta) {
    this.requestedResponses.push({ response, meta });
    return true;
  }

  discardPendingUserResponse() {
    this.discardedResponses += 1;
  }

  deleteConversationItem(itemId) {
    if (!itemId) return false;
    this.deletedItems.push(itemId);
    return true;
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
  audioSession.isPlaybackActive = () => Boolean(audioSession.nextPlayback);
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
  audioSession.playbackMarkers = [];
  audioSession.sendPlaybackMarker = (name, { itemId } = {}) => {
    audioSession.playbackMarkers.push({ name, itemId });
    return true;
  };
  audioSession.clearPlaybackMarkers = (reason) => {
    const markers = audioSession.playbackMarkers.splice(0);
    if (markers.length > 0) {
      audioSession.emit('playout_markers_cleared', { reason, markers });
    }
    return markers.length;
  };
  audioSession.playbackStatus = null;
  audioSession.getPlaybackStatus = () => audioSession.playbackStatus;
  audioSession.hasPlaybackCompleted = (itemId) => Boolean(
    audioSession.playbackStatus?.completed && audioSession.playbackStatus.itemId === itemId
  );
  audioSession.closed = false;
  audioSession.close = () => { audioSession.closed = true; };

  const audioForkServer = {
    expected: null,
    expectSession(callUuid, options) {
      this.expected = { callUuid, options };
      const expectation = { session: Promise.resolve(audioSession) };
      Object.defineProperty(expectation, 'connectionUrl', {
        value: `ws://127.0.0.1:3001/v1/audio/${encodeURIComponent(callUuid)}/` +
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        enumerable: false,
      });
      return expectation;
    },
  };

  const jobBroker = new EventEmitter();
  const cancelCalls = [];
  const approvalCancelCalls = [];
  const approvalArmCalls = [];
  const approvalFailureCalls = [];
  let approvalOutstanding = activeJobs.some((job) => job.status === 'awaiting_approval');
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
  jobBroker.approveNextJob = (threadId, context = {}) => {
    let approval;
    try {
      approval = stateStore.approveFocusedJobCas(threadId, {
        method: 'dtmf-pound', decidedBy: 'caller', metadata: { source: 'sip_dtmf' },
        callId: context.callId,
        realtimeSessionId: context.realtimeSessionId,
      });
    } catch (error) {
      throw new Error(`Approval test decision failed: ${error.message}`, { cause: error });
    }
    if (approval.changed) {
      return { approved: true, job: { job_id: approval.job.id } };
    }
    return {
      approved: false,
      code: ['approval_not_armed', 'approval_session_mismatch'].includes(approval.reason)
        ? 'APPROVAL_PROMPT_NOT_HEARD'
        : 'NO_PENDING_APPROVAL',
      message: 'The exact approval prompt has not finished playing.',
    };
  };
  jobBroker.armFocusedApproval = (threadId, details) => {
    approvalArmCalls.push({ threadId, details });
    try {
      return stateStore.armFocusedApproval(threadId, details);
    } catch (error) {
      throw new Error(`Approval test arming failed: ${error.message}`, { cause: error });
    }
  };
  jobBroker.recordApprovalPromptFailure = (threadId, details) => {
    approvalFailureCalls.push({ threadId, details });
    try {
      return stateStore.noteApprovalPromptFailure(threadId, { maxAttempts: 3 });
    } catch (error) {
      throw new Error(`Approval test replay tracking failed: ${error.message}`, { cause: error });
    }
  };
  jobBroker.cancelPendingApprovals = (...args) => {
    approvalCancelCalls.push(args);
    const canceled = approvalOutstanding;
    approvalOutstanding = false;
    return { canceled, jobs: canceled ? activeJobs.filter((job) => job.status === 'awaiting_approval') : [] };
  };

  let realtimeClient;
  const openaiClientFactory = (options) => {
    realtimeClient = new FakeRealtimeClient(options, dialog, { autoDestroyGreeting });
    return realtimeClient;
  };

  return {
    audioForkServer,
    audioSession,
    approvalArmCalls,
    approvalCancelCalls,
    approvalFailureCalls,
    cancelCalls,
    dialog,
    endpoint,
    getRealtimeClient: () => realtimeClient,
    jobBroker,
    openaiClientFactory,
    stateStore,
  };
}

function createPendingApproval(fixture, {
  prompt = 'Approval needed. Restart teleagent.service. Press pound to approve or star to cancel.',
  threadId = null,
  realtimeSessionId = null,
  toolCallId = `approval-${Date.now()}`,
} = {}) {
  const thread = threadId
    ? fixture.stateStore.getThread(threadId)
    : fixture.stateStore.db.prepare('SELECT * FROM voice_threads ORDER BY created_at DESC LIMIT 1').get();
  const realtime = realtimeSessionId
    ? fixture.stateStore.getRealtimeSession(realtimeSessionId)
    : fixture.stateStore.db.prepare('SELECT * FROM realtime_sessions ORDER BY opened_at DESC LIMIT 1').get();
  assert.ok(thread);
  assert.ok(realtime);
  try {
    return fixture.stateStore.createJob({
      voiceThreadId: thread.id,
      realtimeSessionId: realtime.id,
      toolCallId,
      profile: 'codex-sol',
      provider: 'codex',
      request: 'Restart teleagent.service.',
      requiresApproval: true,
      riskLevel: 'high',
      operation: { spokenApprovalPrompt: prompt },
      approvalPrompt: prompt,
    }).job;
  } catch (error) {
    throw new Error(`Failed to create approval test fixture: ${error.message}`, { cause: error });
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function emitFixtureEvent(emitter, label, ...args) {
  try {
    emitter.emit(...args);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
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
  assert.equal(fixture.endpoint.forkOptions.mixType, 'mono');
  assert.equal(fixture.endpoint.forkOptions.bidirectionalAudio.streaming, 'true');
  assert.match(
    fixture.endpoint.forkOptions.wsUrl,
    /^ws:\/\/127\.0\.0\.1:3001\/v1\/audio\/call-voice-1\/[A-Za-z0-9_-]{43}$/
  );
  assert.equal(fixture.endpoint.forkStopped, true);
  assert.equal(
    fixture.getRealtimeClient().options.apiKey,
    TEST_RUNTIME_SECRETS.openaiRealtimeApiKey
  );
  assert.equal(fixture.getRealtimeClient().options.noiseReductionType, 'near_field');
  assert.match(fixture.getRealtimeClient().options.safetyIdentifier, /^[a-f0-9]{64}$/);
  assert.notEqual(fixture.getRealtimeClient().options.safetyIdentifier, '1001');
  assert.deepEqual(fixture.getRealtimeClient().options.profiles, ['claude-opus', 'codex-terra']);
  assert.deepEqual(
    fixture.getRealtimeClient().options.responseValidator({
      purpose: 'user_turn',
      transcript: 'The approval is still waiting.',
    }),
    { allowed: false, reason: 'stale_approval_status' }
  );
  assert.equal(fixture.stateStore.getThread(result.voiceThreadId).status, 'idle');

  const realtimeRows = fixture.stateStore.db
    .prepare('SELECT status, openai_session_id FROM realtime_sessions')
    .all();
  assert.deepEqual(realtimeRows, [{ status: 'closed', openai_session_id: 'openai-session-test' }]);
});

test('an AudioFork start failure never logs or persists its one-time attach credential', async (t) => {
  const fixture = createCallFixture(t);
  let rawAttachToken = null;
  fixture.endpoint.forkAudioStart = async (options) => {
    fixture.endpoint.forkOptions = options;
    rawAttachToken = new URL(options.wsUrl).pathname.split('/').at(-1);
    throw new Error(`simulated failure for ${options.wsUrl}`);
  };

  await assert.rejects(
    runRealtimeConversation(
      fixture.endpoint,
      fixture.dialog,
      'call-audio-fork-secret',
      {
        audioForkServer: fixture.audioForkServer,
        stateStore: fixture.stateStore,
        jobBroker: fixture.jobBroker,
        callerId: '1001',
        openaiClientFactory: fixture.openaiClientFactory,
      }
    ),
    (error) => {
      assert.match(error.message, /\[redacted-credential\]/);
      assert.doesNotMatch(error.message, new RegExp(rawAttachToken));
      assert.doesNotMatch(error.stack, new RegExp(rawAttachToken));
      return true;
    }
  );
  const persisted = fixture.stateStore.db.prepare(
    'SELECT error FROM realtime_sessions WHERE call_id = ?'
  ).get('call-audio-fork-secret');
  assert.match(persisted.error, /\[redacted-credential\]/);
  assert.doesNotMatch(persisted.error, new RegExp(rawAttachToken));
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
  assert.equal(isBackchannelOnly('Mm'), true);
  assert.equal(isBackchannelOnly('Mm-hmm.'), true);
  assert.equal(isBackchannelOnly('Okay, cancel that job.'), false);
  assert.equal(isBackchannelOnly('Yes'), true);
  assert.equal(isBackchannelOnly('Yes', { assistantAskedQuestion: true }), false);
  assert.equal(isBackchannelOnly('Yeah', { duringAssistantPlayback: true, assistantAskedQuestion: true }), true);
  assert.equal(isBackchannelOnly('I appreciate it.'), true);
  assert.equal(isLikelyUnclearTranscript('[inaudible]'), true);
  assert.equal(isLikelyUnclearTranscript('the'), true);
  assert.equal(isLikelyUnclearTranscript('the phone session'), false);
  assert.equal(isLikelyUnclearTranscript('stop'), false);
  assert.equal(isCutoffReport('Your answer cut off before it finished.'), true);
  assert.equal(isCutoffReport("I didn't hear the ending part."), true);
  assert.equal(isCutoffReport('Cut off the old deployment.'), false);
  assert.equal(isLikelyPlaybackEcho('The task completed', 'Good news. The task completed successfully.'), true);
  assert.equal(isLikelyPlaybackEcho('Show the tmux sessions', 'The task completed successfully.'), false);
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
  await refreshRuntimeTranscriptionVocabulary(fixture.jobBroker.agentBridge, { force: true });

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

test('Realtime call setup never waits for dynamic tmux vocabulary refresh', async (t) => {
  const fixture = createCallFixture(t);
  let releaseInspection;
  fixture.jobBroker.agentBridge.inspectOperator = () => new Promise((resolve) => {
    releaseInspection = () => resolve({ success: true, result: { sessions: [] } });
  });

  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-nonblocking-vocabulary',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );

  while (!releaseInspection) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fixture.getRealtimeClient(), 'Realtime client should be created before inspection resolves');
  assert.ok(fixture.getRealtimeClient().options.transcriptionKeywords.includes('freestio'));
  releaseInspection();
  await call;
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

  realtime.emit('user_transcript', 'Mm-hmm.', { item_id: 'backchannel-item' });
  assert.equal(fixture.audioSession.stopPlaybackCalls, 0);
  assert.equal(realtime.canceledResponses, 0);

  realtime.emit('user_transcript', 'Show me the latest provider reply.');
  assert.equal(fixture.audioSession.stopPlaybackCalls, 1);
  assert.equal(realtime.canceledResponses, 1);
  assert.deepEqual(realtime.truncations, [{ itemId: 'item-playing', audioEndMs: 640 }]);

  realtime.emit('assistant_transcript', 'The task completed successfully.', { item_id: 'assistant-echo' });
  fixture.audioSession.nextPlayback = { itemId: 'assistant-echo', audioEndMs: 200 };
  realtime.emit('speech_started');
  realtime.emit('user_transcript', 'Task completed successfully.');
  assert.equal(fixture.audioSession.stopPlaybackCalls, 1);
  assert.equal(realtime.canceledResponses, 1);
  assert.ok(fixture.stateStore.listAuditEvents({ limit: 20 })
    .some((event) => event.action === 'playback_echo_suppressed'));

  await fixture.dialog.destroy();
  await call;
});

test('raw sustained VAD never destroys playout before a substantive transcript', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-sustained-barge-in',
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

  fixture.audioSession.nextPlayback = { itemId: 'item-sustained', audioEndMs: 880 };
  realtime.emit('speech_started');
  await new Promise((resolve) => setTimeout(resolve, 540));
  assert.equal(fixture.audioSession.stopPlaybackCalls, 0);
  assert.equal(realtime.canceledResponses, 0);

  realtime.emit('user_transcript', 'Stop speaking and show the current sessions.');
  assert.equal(fixture.audioSession.stopPlaybackCalls, 1);
  assert.equal(realtime.canceledResponses, 1);
  assert.deepEqual(realtime.truncations, [{ itemId: 'item-sustained', audioEndMs: 880 }]);

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

test('natural cancellation withdraws a pending approval without a duplicate hangup cancellation', async (t) => {
  const fixture = createCallFixture(t, {
    autoDestroyGreeting: false,
    activeJobs: [{ job_id: 'job-awaiting', status: 'awaiting_approval' }],
  });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-withdraw-approval',
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

  realtime.emit('user_transcript', 'Never mind, cancel that.');
  assert.equal(fixture.approvalCancelCalls.length, 1);
  assert.equal(fixture.approvalCancelCalls[0][2], 'voice_cancel');
  assert.match(realtime.notices.at(-1), /Canceled before execution/i);
  assert.doesNotMatch(realtime.notices.at(-1), /press star/i);

  await fixture.dialog.destroy();
  await call;
  assert.equal(fixture.approvalCancelCalls.length, 1);
  assert.equal(fixture.approvalCancelCalls.at(-1)[2], 'voice_cancel');
});

test('pound stays inert until the exact response item receives a downstream playout marker', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-exact-approval-arm',
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
  await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  const job = createPendingApproval(fixture, { toolCallId: 'approval-arm-success' });
  const prompt = job.operation.spokenApprovalPrompt;

  const noticesBeforeEarlyPound = realtime.notices.length;
  emitFixtureEvent(fixture.endpoint, 'early pound failed', 'dtmf', { digit: '#' });
  assert.equal(fixture.stateStore.getJob(job.id).status, 'awaiting_approval');
  assert.equal(realtime.notices.length, noticesBeforeEarlyPound);

  fixture.audioSession.playbackStatus = {
    itemId: 'approval-item-current', completed: true, sourceComplete: true,
    interrupted: false, remainingMs: 0,
  };
  emitFixtureEvent(realtime, 'response.created failed', 'response.created', { id: 'approval-response-current' }, {
    purpose: 'approval_prompt',
  });
  emitFixtureEvent(realtime, 'assistant transcript failed', 'assistant_transcript', prompt, {
    response_id: 'approval-response-current', item_id: 'approval-item-current',
  });
  emitFixtureEvent(realtime, 'audio done failed', 'audio.done', {
    response_id: 'approval-response-current', item_id: 'approval-item-current',
  });
  emitFixtureEvent(realtime, 'response.done failed', 'response.done', { id: 'approval-response-current', status: 'completed' }, {
    purpose: 'approval_prompt',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.stateStore.getJob(job.id).approval_armed_at, null);
  const marker = fixture.audioSession.playbackMarkers[0];
  assert.equal(marker.itemId, 'approval-item-current');
  emitFixtureEvent(fixture.audioSession, 'playout marker failed', 'playout_marker', {
    ...marker,
    acknowledgedAt: new Date().toISOString(),
  });
  assert.equal(await waitFor(
    () => Boolean(fixture.stateStore.getJob(job.id).approval_armed_at)
  ), true);
  assert.equal(fixture.approvalArmCalls.length, 1);
  assert.equal(
    fixture.stateStore.getJob(job.id).approvalArmMetadata.response_id,
    'approval-response-current'
  );
  assert.equal(
    fixture.stateStore.getJob(job.id).approvalArmMetadata.boundary,
    'freeswitch_playout_marker'
  );
  assert.equal(fixture.stateStore.getJob(job.id).approvalArmCallId, 'call-exact-approval-arm');
  assert.equal(
    fixture.stateStore.getJob(job.id).approvalArmRealtimeSessionId,
    fixture.stateStore.db.prepare(
      'SELECT id FROM realtime_sessions WHERE call_id = ?'
    ).get('call-exact-approval-arm').id
  );

  emitFixtureEvent(fixture.endpoint, 'approved pound failed', 'dtmf', { digit: '#' });
  assert.equal(fixture.stateStore.getJob(job.id).status, 'queued');
  assert.ok(fixture.endpoint.played.length > 0);
  await fixture.dialog.destroy();
  await call;
});

test('a spoofed or cleared downstream marker never arms approval and forces exact replay', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-marker-clear-approval',
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
  await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  const job = createPendingApproval(fixture, { toolCallId: 'approval-marker-cleared' });
  const prompt = job.operation.spokenApprovalPrompt;
  realtime.emit('response.created', { id: 'approval-response-cleared' }, {
    purpose: 'approval_prompt',
  });
  realtime.emit('assistant_transcript', prompt, {
    response_id: 'approval-response-cleared', item_id: 'approval-item-cleared',
  });
  realtime.emit('audio.done', {
    response_id: 'approval-response-cleared', item_id: 'approval-item-cleared',
  });
  realtime.emit('response.done', { id: 'approval-response-cleared', status: 'completed' }, {
    purpose: 'approval_prompt',
  });
  const marker = fixture.audioSession.playbackMarkers[0];
  fixture.audioSession.emit('playout_marker', {
    name: 'approval:spoofed-marker',
    itemId: marker.itemId,
    acknowledgedAt: new Date().toISOString(),
  });
  assert.equal(fixture.stateStore.getJob(job.id).approval_armed_at, null);
  fixture.audioSession.emit('playout_markers_cleared', {
    reason: 'module_cleared',
    markers: [marker],
  });
  assert.equal(fixture.stateStore.getJob(job.id).approval_armed_at, null);
  assert.equal(fixture.approvalArmCalls.length, 0);
  assert.equal(fixture.approvalFailureCalls.length, 1);
  assert.equal(realtime.requestedResponses.at(-1).meta.purpose, 'approval_prompt');

  await fixture.dialog.destroy();
  await call;
});

test('clipped approval audio remains unarmed and triggers bounded exact replay', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-clipped-approval',
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
  await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  const job = createPendingApproval(fixture, { toolCallId: 'approval-clipped' });
  const prompt = job.operation.spokenApprovalPrompt;
  fixture.audioSession.playbackStatus = {
    itemId: 'approval-item-clipped', completed: false, sourceComplete: true,
    interrupted: true, remainingMs: 0,
  };
  realtime.emit('response.created', { id: 'approval-response-clipped' }, {
    purpose: 'approval_prompt',
  });
  realtime.emit('assistant_transcript', prompt, {
    response_id: 'approval-response-clipped', item_id: 'approval-item-clipped',
  });
  realtime.emit('response.clipped', { responseId: 'approval-response-clipped' });
  realtime.emit('response.done', { id: 'approval-response-clipped', status: 'completed' }, {
    purpose: 'approval_prompt',
  });
  assert.equal(fixture.stateStore.getJob(job.id).approval_armed_at, null);
  assert.equal(fixture.approvalArmCalls.length, 0);
  assert.equal(fixture.approvalFailureCalls.length, 1);
  assert.equal(realtime.requestedResponses.at(-1).meta.purpose, 'approval_prompt');
  assert.match(realtime.requestedResponses.at(-1).response.instructions, /Say exactly/);
  await fixture.dialog.destroy();
  await call;
});

test('late transcript and done events from an old approval response cannot arm a new one', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-stale-approval-response',
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
  await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  const job = createPendingApproval(fixture, { toolCallId: 'approval-old-response' });
  const prompt = job.operation.spokenApprovalPrompt;
  fixture.audioSession.playbackStatus = {
    itemId: 'approval-item-old', completed: true, sourceComplete: true,
    interrupted: false, remainingMs: 0,
  };
  realtime.emit('response.created', { id: 'approval-response-old' }, { purpose: 'approval_prompt' });
  realtime.emit('assistant_transcript', prompt, {
    response_id: 'approval-response-old', item_id: 'approval-item-old',
  });
  realtime.emit('response.created', { id: 'approval-response-new' }, { purpose: 'approval_prompt' });
  realtime.emit('response.done', { id: 'approval-response-old', status: 'completed' }, {
    purpose: 'approval_prompt',
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(fixture.stateStore.getJob(job.id).approval_armed_at, null);
  assert.equal(fixture.approvalArmCalls.length, 0);
  assert.equal(fixture.approvalFailureCalls.length, 0);
  await fixture.dialog.destroy();
  await call;
});

test('an unarmed approval survives disconnect and is replayed exactly on resume', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const thread = fixture.stateStore.createThread({
    callerId: '1001', selectedProfile: 'codex-sol',
  });
  const previousRealtime = fixture.stateStore.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-before-disconnect',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = createPendingApproval(fixture, {
    threadId: thread.id,
    realtimeSessionId: previousRealtime.id,
    toolCallId: 'approval-resume-replay',
  });
  fixture.stateStore.markRealtimeSessionClosed(previousRealtime.id, { error: 'transport_lost' });

  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-after-disconnect',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      voiceThreadId: thread.id,
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const replay = fixture.getRealtimeClient().requestedResponses[0];
  assert.equal(replay.meta.purpose, 'approval_prompt');
  assert.match(replay.response.instructions, new RegExp(
    job.operation.spokenApprovalPrompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ));
  assert.equal(fixture.getRealtimeClient().notices.length, 0);

  await fixture.dialog.destroy();
  await call;
  assert.equal(fixture.stateStore.getJob(job.id).status, 'awaiting_approval');
  assert.equal(fixture.stateStore.getJob(job.id).approval_armed_at, null);
});

test('an arm from a prior call is invalidated, replayed, rebound, and cleared on teardown', async (t) => {
  const fixture = createCallFixture(t, { autoDestroyGreeting: false });
  const thread = fixture.stateStore.createThread({
    callerId: '1001', selectedProfile: 'codex-sol',
  });
  const previousRealtime = fixture.stateStore.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-before-reconnect',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = createPendingApproval(fixture, {
    threadId: thread.id,
    realtimeSessionId: previousRealtime.id,
    toolCallId: 'approval-cross-call-binding',
  });
  const prompt = job.operation.spokenApprovalPrompt;
  const priorArm = fixture.stateStore.armFocusedApproval(thread.id, {
    spokenPrompt: prompt,
    purpose: 'approval_prompt',
    responseId: 'approval-response-before-reconnect',
    itemId: 'approval-item-before-reconnect',
    playbackCompletedAt: new Date().toISOString(),
    playoutMarker: 'approval:before-reconnect',
    playoutBoundary: 'freeswitch_playout_marker',
    callId: 'call-before-reconnect',
    realtimeSessionId: previousRealtime.id,
  });
  assert.equal(priorArm.changed, true);
  assert.equal(priorArm.job.approvalArmCallId, 'call-before-reconnect');
  fixture.stateStore.markRealtimeSessionClosed(previousRealtime.id, { error: 'transport_lost' });

  const call = runRealtimeConversation(
    fixture.endpoint,
    fixture.dialog,
    'call-after-reconnect',
    {
      audioForkServer: fixture.audioForkServer,
      wsPort: 3001,
      stateStore: fixture.stateStore,
      jobBroker: fixture.jobBroker,
      callerId: '1001',
      voiceThreadId: thread.id,
      openaiClientFactory: fixture.openaiClientFactory,
    }
  );
  while (!fixture.getRealtimeClient()) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const realtime = fixture.getRealtimeClient();
  const resumedJob = fixture.stateStore.getJob(job.id);
  assert.equal(resumedJob.status, 'awaiting_approval');
  assert.equal(resumedJob.approval_armed_at, null);
  assert.equal(resumedJob.approvalArmCallId, null);
  assert.equal(resumedJob.approvalArmRealtimeSessionId, null);
  assert.equal(realtime.requestedResponses[0].meta.purpose, 'approval_prompt');
  assert.match(realtime.requestedResponses[0].response.instructions, new RegExp(
    prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ));

  const noticesBeforeEarlyPound = realtime.notices.length;
  emitFixtureEvent(fixture.endpoint, 'cross-call early pound failed', 'dtmf', { digit: '#' });
  assert.equal(fixture.stateStore.getJob(job.id).status, 'awaiting_approval');
  assert.equal(realtime.notices.length, noticesBeforeEarlyPound);

  fixture.audioSession.playbackStatus = {
    itemId: 'approval-item-after-reconnect', completed: true, sourceComplete: true,
    interrupted: false, remainingMs: 0,
  };
  emitFixtureEvent(realtime, 'cross-call response.created failed', 'response.created', {
    id: 'approval-response-after-reconnect',
  }, { purpose: 'approval_prompt' });
  emitFixtureEvent(realtime, 'cross-call transcript failed', 'assistant_transcript', prompt, {
    response_id: 'approval-response-after-reconnect',
    item_id: 'approval-item-after-reconnect',
  });
  emitFixtureEvent(realtime, 'cross-call audio.done failed', 'audio.done', {
    response_id: 'approval-response-after-reconnect',
    item_id: 'approval-item-after-reconnect',
  });
  emitFixtureEvent(realtime, 'cross-call response.done failed', 'response.done', {
    id: 'approval-response-after-reconnect', status: 'completed',
  }, { purpose: 'approval_prompt' });
  const reboundMarker = fixture.audioSession.playbackMarkers[0];
  assert.equal(reboundMarker.itemId, 'approval-item-after-reconnect');
  emitFixtureEvent(fixture.audioSession, 'cross-call playout marker failed', 'playout_marker', {
    ...reboundMarker,
    acknowledgedAt: new Date().toISOString(),
  });
  assert.equal(await waitFor(
    () => Boolean(fixture.stateStore.getJob(job.id).approval_armed_at)
  ), true);
  const reboundJob = fixture.stateStore.getJob(job.id);
  const currentRealtime = fixture.stateStore.db.prepare(
    'SELECT id FROM realtime_sessions WHERE call_id = ?'
  ).get('call-after-reconnect');
  assert.equal(reboundJob.approvalArmCallId, 'call-after-reconnect');
  assert.equal(reboundJob.approvalArmRealtimeSessionId, currentRealtime.id);

  await fixture.dialog.destroy();
  await call;
  const afterTeardown = fixture.stateStore.getJob(job.id);
  assert.equal(afterTeardown.status, 'awaiting_approval');
  assert.equal(afterTeardown.approval_armed_at, null);
  assert.equal(afterTeardown.approvalArmCallId, null);
  assert.equal(afterTeardown.approvalArmRealtimeSessionId, null);
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

  realtime.emit('user_transcript', 'Mm-hmm.', { item_id: 'backchannel-item' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(realtime.queuedResponses.length, 1);
  assert.equal(realtime.discardedResponses, 1);
  assert.deepEqual(realtime.deletedItems, ['backchannel-item']);
  assert.ok(fixture.stateStore.listAuditEvents({ limit: 20 })
    .some((event) => event.action === 'backchannel_suppressed'));

  realtime.emit('user_transcript', 'the', { item_id: 'unclear-item' });
  assert.equal(realtime.notices.length, 1);
  assert.equal(realtime.queuedResponses.length, 1);
  assert.deepEqual(realtime.deletedItems, ['backchannel-item', 'unclear-item']);
  assert.ok(fixture.stateStore.listAuditEvents({ limit: 20 })
    .some((event) => event.action === 'unclear_fragment_suppressed'));

  realtime.emit('speech_started');
  realtime.emit('speech_stopped');
  realtime.emit('transcription.empty', { item_id: 'noise-only', content_index: 0 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(realtime.notices.length, 1);
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
