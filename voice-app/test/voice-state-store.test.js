'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { VoiceStateStore } = require('../lib/voice-state-store');

function withStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-state-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  const store = new VoiceStateStore({ dbPath });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, dbPath };
}

test('voice threads resume durably with isolated per-profile sessions', (t) => {
  const { store, dbPath } = withStore(t);
  assert.equal(fs.statSync(path.dirname(dbPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  const fresh = store.resolveThread({
    callerId: '1001',
    selectedProfile: 'codex-terra',
    callbackTarget: '1001',
  });

  assert.equal(fresh.resumed, false);
  assert.match(fresh.thread.id, /^vt_[a-f0-9]{32}$/);

  store.upsertAgentSession({
    voiceThreadId: fresh.thread.id,
    profile: 'codex-terra',
    provider: 'codex',
    bridgeSessionKey: `${fresh.thread.id}:codex-terra:a`,
    providerSessionId: 'codex-thread-a',
  });
  store.upsertAgentSession({
    voiceThreadId: fresh.thread.id,
    profile: 'claude-sonnet',
    provider: 'claude',
    bridgeSessionKey: `${fresh.thread.id}:claude-sonnet:b`,
    providerSessionId: 'claude-session-b',
  });

  const resumed = store.resolveThread({
    callerId: '1001',
    resume: true,
    resumeTtlSeconds: 600,
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.thread.id, fresh.thread.id);
  assert.equal(
    store.getAgentSession(fresh.thread.id, 'codex-terra').provider_session_id,
    'codex-thread-a'
  );
  assert.equal(
    store.getAgentSession(fresh.thread.id, 'claude-sonnet').provider_session_id,
    'claude-session-b'
  );
});

test('job creation is idempotent and serializes one active job per profile', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-1',
    model: 'gpt-realtime-2.1',
  });
  const input = {
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'tool-1',
    profile: 'codex-terra',
    provider: 'codex',
    request: 'Inspect the repository status.',
  };

  const created = store.createJob(input);
  assert.equal(created.created, true);
  assert.equal(created.job.status, 'queued');

  const duplicate = store.createJob(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, created.job.id);

  const busy = store.createJob({ ...input, toolCallId: 'tool-2' });
  assert.equal(busy.busy, true);
  assert.equal(busy.job.id, created.job.id);

  assert.equal(store.markJobRunning(created.job.id).status, 'running');
  assert.equal(
    store.markJobCompleted(created.job.id, { voiceResult: 'Repository is clean.' }).status,
    'completed'
  );

  const next = store.createJob({ ...input, toolCallId: 'tool-2' });
  assert.equal(next.created, true);
  assert.notEqual(next.job.id, created.job.id);
});

test('panic cancellation atomically stops every active job and rejects pending approvals', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'panic-call',
    model: 'gpt-realtime-2.1',
  });

  const queued = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'queued-tool',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect services.',
  }).job;
  const running = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'running-tool',
    profile: 'codex-terra',
    provider: 'codex',
    request: 'Inspect all services.',
  }).job;
  store.markJobRunning(running.id);
  const pending = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'pending-tool',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Restart a service.',
    requiresApproval: true,
  }).job;

  assert.equal(store.listAllActiveJobs().length, 3);
  const canceled = store.cancelAllActiveJobs('Dial 9 emergency stop');
  assert.deepEqual(canceled.map((job) => job.id), [queued.id, running.id, pending.id]);
  assert.ok(canceled.every((job) => job.status === 'canceled'));
  assert.ok(canceled.every((job) => job.error === 'Dial 9 emergency stop'));
  assert.equal(store.listAllActiveJobs().length, 0);
  assert.equal(
    store.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(pending.id).status,
    'rejected'
  );
});

test('approvals transition jobs from pending to queued and survive reopen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-state-reopen-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = new VoiceStateStore({ dbPath });
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-2',
    model: 'gpt-realtime-2.1',
  });
  const pending = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'tool-mutating',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Deploy the service.',
    requiresApproval: true,
  });
  assert.equal(pending.job.status, 'awaiting_approval');

  const approved = store.approveNextJob(thread.id);
  assert.equal(approved.status, 'queued');
  assert.equal(store.markJobRunning(approved.id).status, 'running');
  store.close();

  store = new VoiceStateStore({ dbPath });
  t.after(() => store.close());
  const recovered = store.getJob(approved.id);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error, /restarted/i);
});

test('rolling text context is retained without raw audio', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  store.appendEvent({
    voiceThreadId: thread.id,
    role: 'user',
    kind: 'transcript',
    content: 'Please inspect the phone repository.',
  });
  store.appendEvent({
    voiceThreadId: thread.id,
    role: 'assistant',
    kind: 'transcript',
    content: 'I started a Terra task.',
  });

  const context = store.getResumeContext(thread.id);
  assert.match(context.thread.summary, /phone repository/);
  assert.equal(context.events.length, 2);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%audio%'").get().count,
    0
  );
});

test('exact transcript history and operation audit remain append-only beyond the prompt window', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  for (let index = 1; index <= 137; index += 1) {
    store.appendEvent({
      voiceThreadId: thread.id,
      role: index % 2 ? 'user' : 'assistant',
      kind: 'transcript',
      content: `exact turn ${index}`,
    });
  }
  store.appendAuditEvent({
    voiceThreadId: thread.id,
    callerId: '1001',
    action: 'history_test',
    riskLevel: 'read_only',
    scopeText: 'append-only verification',
  });

  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM voice_events').get().count, 137);
  const recent = store.listRecentEvents(thread.id, 500);
  assert.equal(recent[0].content, 'exact turn 1');
  assert.equal(recent.at(-1).content, 'exact turn 137');
  assert.throws(
    () => store.db.prepare('UPDATE voice_events SET content = ? WHERE id = ?').run('changed', recent[0].id),
    /append-only/
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM operation_audit').run(),
    /append-only/
  );
});

test('one focused approval is bound to pound and records the decision metadata', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'approval-focus-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const first = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'first-approval',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Deploy preview one.',
    requiresApproval: true,
    riskLevel: 'high',
    requestHash: 'hash-one',
    approvalSummary: 'Deploy preview one.',
  });
  const second = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'second-approval',
    profile: 'claude-opus',
    provider: 'claude',
    request: 'Deploy preview two.',
    requiresApproval: true,
    riskLevel: 'high',
  });
  assert.equal(first.job.status, 'awaiting_approval');
  assert.equal(second.approvalBusy, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(store.getThread(thread.id).focused_approval_job_id, first.job.id);

  const approved = store.approveFocusedJob(thread.id, {
    method: 'dtmf-pound',
    decidedBy: 'caller',
    metadata: { source: 'sip_dtmf' },
  });
  assert.equal(approved.id, first.job.id);
  assert.equal(approved.status, 'queued');
  assert.equal(approved.approval_method, 'dtmf-pound');
  assert.ok(approved.approved_at);
  assert.equal(store.getThread(thread.id).focused_approval_job_id, null);
  const decision = store.db.prepare('SELECT * FROM approvals WHERE job_id = ?').get(first.job.id);
  assert.equal(decision.status, 'approved');
  assert.equal(decision.method, 'dtmf-pound');
  assert.equal(decision.decided_by, 'caller');
  assert.deepEqual(JSON.parse(decision.decision_metadata_json), { source: 'sip_dtmf' });
});

test('caller preferences are durable, normalized, and included in resume context', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  store.setPreference({
    callerId: '1001',
    key: 'Speech Style',
    value: 'succinct and minimal',
    sourceText: 'I prefer succinct responses.',
  });
  assert.equal(store.getPreference('1001', 'Speech Style').preference_key, 'speech_style');
  assert.equal(store.getResumeContext(thread.id).preferences[0].value, 'succinct and minimal');
  assert.equal(store.deletePreference('1001', 'Speech Style'), true);
  assert.deepEqual(store.listPreferences('1001'), []);
});

test('Realtime usage is deduplicated and summarized without claiming a budget balance', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'usage-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const record = {
    eventKey: 'response:one',
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    kind: 'response',
    model: 'gpt-realtime-2.1-mini',
    usage: {
      total_tokens: 40,
      input_tokens: 30,
      output_tokens: 10,
      input_token_details: {
        text_tokens: 12,
        audio_tokens: 18,
        cached_tokens: 9,
        cached_tokens_details: { text_tokens: 7, audio_tokens: 2 },
      },
      output_token_details: { text_tokens: 4, audio_tokens: 6 },
    },
  };
  assert.equal(store.recordRealtimeUsage(record), true);
  assert.equal(store.recordRealtimeUsage(record), false);
  store.recordRealtimeUsage({
    ...record,
    eventKey: 'transcription:one',
    kind: 'transcription',
    model: 'gpt-live-transcribe',
    usage: { total_tokens: 6, input_tokens: 4, output_tokens: 2 },
  });
  assert.deepEqual(store.getRealtimeUsageSummary({ threadId: thread.id }), {
    records: 2,
    response_count: 1,
    transcription_count: 1,
    total_tokens: 46,
    input_tokens: 34,
    output_tokens: 12,
    input_text_tokens: 12,
    input_audio_tokens: 18,
    cached_input_tokens: 9,
    cached_text_tokens: 7,
    cached_audio_tokens: 2,
    output_text_tokens: 4,
    output_audio_tokens: 6,
    models: ['gpt-realtime-2.1-mini', 'gpt-live-transcribe'],
  });
});

test('stale Realtime sessions and their threads are recovered after a voice-service restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-realtime-recovery-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = new VoiceStateStore({ dbPath });
  const thread = store.createThread({ callerId: '1001' });
  const session = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'stale-call',
    model: 'gpt-realtime-2.1-mini',
  });
  store.markRealtimeSessionConnected(session.id, 'openai-stale-session');
  store.close();

  store = new VoiceStateStore({ dbPath });
  t.after(() => store.close());
  const recovered = store.getRealtimeSession(session.id);
  assert.equal(recovered.status, 'failed');
  assert.ok(recovered.closed_at);
  assert.match(recovered.error, /restarted/i);
  assert.equal(store.getThread(thread.id).status, 'idle');
  assert.ok(
    store.listAuditEvents({ threadId: thread.id }).some((event) => (
      event.action === 'realtime_session_recovered'
    ))
  );
});
