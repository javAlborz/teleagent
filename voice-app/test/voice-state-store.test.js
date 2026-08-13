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
