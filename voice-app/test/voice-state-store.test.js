'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
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

function approvalFields(spokenPrompt) {
  return {
    operation: { spokenApprovalPrompt: spokenPrompt },
    approvalPrompt: spokenPrompt,
  };
}

function armApproval(store, threadId, spokenPrompt) {
  const focused = store.getFocusedJob(threadId);
  const realtime = store.db.prepare(
    'SELECT call_id FROM realtime_sessions WHERE id = ?'
  ).get(focused?.realtime_session_id);
  const result = store.armFocusedApproval(threadId, {
    spokenPrompt,
    purpose: 'approval_prompt',
    responseId: `response-${threadId}`,
    itemId: `item-${threadId}`,
    playbackCompletedAt: new Date().toISOString(),
    playoutMarker: `marker-${threadId}`,
    playoutBoundary: 'freeswitch_playout_marker',
    callId: realtime?.call_id,
    realtimeSessionId: focused?.realtime_session_id,
  });
  assert.equal(result.changed, true);
  return result.job;
}

function approvalContext(store, threadId) {
  const focused = store.getFocusedJob(threadId);
  return {
    callId: focused?.approvalArmCallId,
    realtimeSessionId: focused?.approvalArmRealtimeSessionId,
  };
}

test('file-backed voice state uses WAL with fully durable commits', (t) => {
  const { store } = withStore(t);

  assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(store.db.pragma('synchronous', { simple: true }), 2);
  assert.deepEqual(store.health(), { ok: true, durable: true });
  assert.equal(Object.hasOwn(store.health(), 'path'), false);
});

test('voice threads resume durably with Teleagent keys and no provider sessions', (t) => {
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
  });
  store.upsertAgentSession({
    voiceThreadId: fresh.thread.id,
    profile: 'claude-sonnet',
    provider: 'claude',
    bridgeSessionKey: `${fresh.thread.id}:claude-sonnet:b`,
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
    null
  );
  assert.equal(
    store.getAgentSession(fresh.thread.id, 'claude-sonnet').provider_session_id,
    null
  );
});

test('migration erases legacy provider session identifiers from state and results', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-route-b-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  let store = new VoiceStateStore({ dbPath });
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'legacy-route-b-call',
    model: 'gpt-realtime-2.1-mini',
  });
  store.upsertAgentSession({
    voiceThreadId: thread.id,
    profile: 'codex-terra',
    provider: 'codex',
    bridgeSessionKey: 'teleagent-bridge-key',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'legacy-route-b-tool',
    profile: 'codex-terra',
    provider: 'codex',
    request: 'Inspect state.',
  }).job;
  store.db.prepare(`
    UPDATE agent_sessions SET provider_session_id = ?
    WHERE voice_thread_id = ? AND profile = ?
  `).run('legacy-provider-session', thread.id, 'codex-terra');
  store.db.prepare(`
    UPDATE jobs SET resume_session_id = ?, result_json = ? WHERE id = ?
  `).run(
    'legacy-provider-session',
    JSON.stringify({ response: 'done', session_id: 'legacy-provider-session' }),
    job.id
  );
  store.close();
  store = new VoiceStateStore({ dbPath });

  assert.equal(store.getAgentSession(thread.id, 'codex-terra').provider_session_id, null);
  assert.equal(store.getJob(job.id).resume_session_id, null);
  assert.deepEqual(store.getJob(job.id).fullResult, { response: 'done' });
  assert.equal(
    store.db.prepare('SELECT provider_session_id FROM agent_sessions').get().provider_session_id,
    null
  );
  assert.equal(store.db.prepare('SELECT resume_session_id FROM jobs').get().resume_session_id, null);
  assert.equal(store.db.prepare('SELECT result_json FROM jobs').get().result_json.includes('session'), false);
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

test('panic cancellation terminalizes only work that cannot have reached the executor', (t) => {
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
    ...approvalFields('Approval needed. Restart a service. Press pound to approve or star to cancel.'),
  }).job;

  assert.equal(store.listAllActiveJobs().length, 3);
  const cancellations = store.requestAllJobCancellations('Dial 9 emergency stop');
  assert.deepEqual(cancellations.map((entry) => entry.job.id), [queued.id, running.id, pending.id]);
  assert.equal(store.getJob(queued.id).status, 'canceled');
  assert.equal(store.getJob(pending.id).status, 'canceled');
  assert.equal(store.getJob(running.id).status, 'cancel_requested');
  assert.ok(cancellations.every((entry) => entry.job.error === 'Dial 9 emergency stop'));
  assert.deepEqual(store.listAllActiveJobs().map((job) => job.id), [running.id]);
  assert.equal(
    store.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(pending.id).status,
    'rejected'
  );
});

test('terminal job transitions are compare-and-swap so only one outcome wins', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'terminal-cas-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const first = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'terminal-cas-complete-first',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect status.',
  }).job;
  store.markJobRunning(first.id);
  assert.equal(store.completeJobCas(first.id, { voiceResult: 'Finished.' }).changed, true);
  assert.equal(store.cancelJobCas(first.id, 'Late cancellation').changed, false);
  assert.equal(store.getJob(first.id).status, 'completed');

  const second = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'terminal-cas-cancel-first',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect another status.',
  }).job;
  store.markJobRunning(second.id);
  assert.equal(store.cancelJobCas(second.id, 'Cancellation won').changed, true);
  assert.equal(store.completeJobCas(second.id, { voiceResult: 'Late completion.' }).changed, false);
  assert.equal(store.getJob(second.id).status, 'canceled');
});

test('queued and running jobs survive reopen for durable executor reconciliation', (t) => {
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
    ...approvalFields('Approval needed. Deploy the service. Press pound to approve or star to cancel.'),
  });
  assert.equal(pending.job.status, 'awaiting_approval');

  armApproval(
    store,
    thread.id,
    'Approval needed. Deploy the service. Press pound to approve or star to cancel.'
  );
  const approved = store.approveNextJob(thread.id, approvalContext(store, thread.id));
  assert.equal(approved.status, 'queued');
  assert.equal(store.markJobRunning(approved.id).status, 'running');
  store.close();

  store = new VoiceStateStore({ dbPath });
  t.after(() => store.close());
  store.recoverInterruptedJobs();
  const recovered = store.getJob(approved.id);
  assert.equal(recovered.status, 'reconciling');
  assert.ok(recovered.started_at);
  assert.match(recovered.error, /reconciliation is pending/i);
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
    ...approvalFields('Approval needed. Deploy preview one. Press pound to approve or star to cancel.'),
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
    ...approvalFields('Approval needed. Deploy preview two. Press pound to approve or star to cancel.'),
  });
  assert.equal(first.job.status, 'awaiting_approval');
  assert.equal(second.approvalBusy, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(store.getThread(thread.id).focused_approval_job_id, first.job.id);

  armApproval(
    store,
    thread.id,
    'Approval needed. Deploy preview one. Press pound to approve or star to cancel.'
  );
  const approved = store.approveFocusedJob(thread.id, {
    method: 'dtmf-pound',
    decidedBy: 'caller',
    metadata: { source: 'sip_dtmf' },
    ...approvalContext(store, thread.id),
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

test('approval compare-and-swap refuses a stale or withdrawn approval row', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'approval-cas-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const pending = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'approval-cas-tool',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Restart the protected service.',
    requiresApproval: true,
    riskLevel: 'high',
    ...approvalFields('Approval needed. Restart the protected service. Press pound to approve or star to cancel.'),
  }).job;
  store.db.prepare(`
    UPDATE approvals SET status = 'rejected', decided_at = ? WHERE job_id = ?
  `).run(new Date().toISOString(), pending.id);

  const stale = store.approveFocusedJobCas(thread.id, {
    method: 'dtmf-pound',
    decidedBy: 'caller',
  });
  assert.equal(stale.changed, false);
  assert.equal(stale.job.status, 'awaiting_approval');
  assert.equal(store.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(pending.id).status, 'rejected');
});

test('pending approvals expire or cancel without ever entering the execution queue', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'approval-lifecycle-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const pending = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'approval-lifecycle-tool',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Restart the protected service.',
    requiresApproval: true,
    riskLevel: 'high',
    ...approvalFields('Approval needed. Restart the protected service. Press pound to approve or star to cancel.'),
  }).job;
  store.db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(
    new Date(Date.now() - 10 * 60000).toISOString(),
    pending.id
  );

  const expired = store.expireAwaitingApprovals({ threadId: thread.id, maxAgeMs: 5 * 60000 });
  assert.deepEqual(expired.map((job) => job.id), [pending.id]);
  assert.equal(store.getJob(pending.id).status, 'canceled');
  assert.equal(store.getJob(pending.id).notification_status, 'skipped');
  assert.equal(store.getThread(thread.id).focused_approval_job_id, null);
  assert.equal(
    store.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(pending.id).status,
    'rejected'
  );
  assert.equal(store.approveFocusedJob(thread.id), null);
});

test('retiring approval authority cancels fresh pending approvals across every thread', (t) => {
  const { store } = withStore(t);
  const threads = ['1001', '1002'].map((callerId, index) => {
    const thread = store.createThread({ callerId });
    const realtime = store.createRealtimeSession({
      voiceThreadId: thread.id,
      callId: `authority-retired-call-${index}`,
      model: 'gpt-realtime-2.1-mini',
    });
    const job = store.createJob({
      voiceThreadId: thread.id,
      realtimeSessionId: realtime.id,
      toolCallId: `authority-retired-tool-${index}`,
      profile: 'codex-sol',
      provider: 'codex',
      request: 'Restart the protected service.',
      requiresApproval: true,
      riskLevel: 'high',
      ...approvalFields(
        'Approval needed. Restart the protected service. Press pound to approve or star to cancel.'
      ),
    }).job;
    return { thread, job };
  });

  const canceled = store.cancelAllAwaitingApprovals(
    'Production phone approval authority is disabled.',
    {
      auditAction: 'approval_authority_retired',
      auditMetadata: { source: 'startup_recovery' },
    }
  );

  assert.deepEqual(
    new Set(canceled.map((job) => job.id)),
    new Set(threads.map(({ job }) => job.id))
  );
  for (const { thread, job } of threads) {
    assert.equal(store.getJob(job.id).status, 'canceled');
    assert.equal(store.getJob(job.id).notification_status, 'skipped');
    assert.equal(store.getThread(thread.id).focused_approval_job_id, null);
    assert.equal(
      store.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(job.id).status,
      'rejected'
    );
  }
  const audit = store.db.prepare(`
    SELECT action, metadata_json FROM operation_audit
    WHERE action = 'approval_authority_retired'
    ORDER BY id ASC
  `).all();
  assert.equal(audit.length, 2);
  assert.deepEqual(
    audit.map((row) => JSON.parse(row.metadata_json).source),
    ['startup_recovery', 'startup_recovery']
  );
});

test('completion notifications stay durable until the phone confirms delivery', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'notification-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'notification-tool',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect service health.',
    notificationMode: 'resume',
  }).job;
  store.markJobRunning(job.id);
  store.markJobCompleted(job.id, { voiceResult: 'All services are healthy.' });

  assert.deepEqual(store.listPendingJobNotifications(thread.id).map((entry) => entry.id), [job.id]);
  assert.equal(store.markJobNotificationAttempt(job.id).notification_attempts, 1);
  assert.equal(store.getJob(job.id).notification_status, 'attempted');
  assert.deepEqual(store.listPendingJobNotifications(thread.id).map((entry) => entry.id), [job.id]);
  const delivered = store.markJobNotificationDelivered(job.id);
  assert.equal(delivered.notification_status, 'delivered');
  assert.ok(delivered.notification_delivered_at);
  assert.deepEqual(store.listPendingJobNotifications(thread.id), []);
});

test('terminal state, session binding, audit, event, and callback intent commit atomically', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'atomic-terminal-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'atomic-terminal-tool',
    profile: 'codex-terra',
    provider: 'codex',
    request: 'Inspect durable callback state.',
    notificationMode: 'callback',
  }).job;
  store.markJobRunning(job.id);

  store.db.exec(`
    CREATE TRIGGER reject_atomic_callback_insert
    BEFORE INSERT ON job_callback_outbox
    BEGIN
      SELECT RAISE(ABORT, 'callback insert rejected');
    END;
  `);
  assert.throws(() => store.completeJobCas(job.id, {
    voiceResult: 'Finished.',
    fullResult: { response: 'Finished.' },
    agentSession: {
      provider: 'codex',
      bridgeSessionKey: 'bridge-atomic',
    },
    event: { kind: 'agent_result', content: 'atomic completion event' },
  }), /callback insert rejected/);
  assert.equal(store.getJob(job.id).status, 'running');
  assert.equal(store.getAgentSession(thread.id, 'codex-terra'), null);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM operation_audit WHERE job_id = ? AND action = 'job_completed'")
      .get(job.id).count,
    0
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM voice_events WHERE content = 'atomic completion event'")
      .get().count,
    0
  );

  store.db.exec('DROP TRIGGER reject_atomic_callback_insert');
  const completed = store.completeJobCas(job.id, {
    voiceResult: 'Finished.',
    fullResult: { response: 'Finished.' },
    agentSession: {
      provider: 'codex',
      bridgeSessionKey: 'bridge-atomic',
    },
    event: { kind: 'agent_result', content: 'atomic completion event' },
  });
  assert.equal(completed.changed, true);
  assert.equal(store.getAgentSession(thread.id, 'codex-terra').provider_session_id, null);
  assert.equal(store.getCallbackOutbox(job.id).state, 'pending');
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM operation_audit WHERE job_id = ? AND action = 'job_completed'")
      .get(job.id).count,
    1
  );
  assert.equal(store.failJobCas(job.id, 'late failure').changed, false);
  assert.equal(store.getCallbackOutbox(job.id).state, 'pending');
});

test('fresh session binding replaces the global session only after terminal CAS wins', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'fresh-binding-call',
    model: 'gpt-realtime-2.1-mini',
  });
  store.upsertAgentSession({
    voiceThreadId: thread.id,
    profile: 'codex-terra',
    provider: 'codex',
    bridgeSessionKey: 'old-bridge',
    providerSessionId: 'old-provider-session',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'fresh-binding-tool',
    profile: 'codex-terra',
    provider: 'codex',
    request: 'Start with a fresh provider context.',
    freshSession: true,
  }).job;
  const binding = store.bindJobAgentSession({
    jobId: job.id,
    provider: 'codex',
    bridgeSessionKey: 'new-bridge',
  });
  assert.equal(binding.job.bridge_session_key, 'new-bridge');
  assert.equal(store.getAgentSession(thread.id, 'codex-terra').bridge_session_key, 'old-bridge');
  store.markJobRunning(job.id);
  const completed = store.completeJobCas(job.id, {
    voiceResult: 'Fresh task completed.',
    agentSession: {
      provider: 'codex',
      bridgeSessionKey: 'new-bridge',
      providerSessionId: null,
    },
  });
  assert.equal(completed.changed, true);
  const current = store.getAgentSession(thread.id, 'codex-terra');
  assert.equal(current.bridge_session_key, 'new-bridge');
  assert.equal(current.provider_session_id, null);
});

test('callback outbox leases fence stale workers and survives retry until explicit ACK', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'callback-lease-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'callback-lease-tool',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect callback delivery.',
    notificationMode: 'callback',
  }).job;
  store.markJobRunning(job.id);
  store.completeJobCas(job.id, { voiceResult: 'Ready.' });

  const first = store.claimCallbackOutbox({ jobId: job.id, leaseMs: 1000 });
  assert.ok(first);
  assert.equal(first.idempotencyKey, `callback:${job.id}`);
  assert.equal(store.claimCallbackOutbox({ jobId: job.id }), null);
  assert.equal(store.retryCallbackOutbox({
    idempotencyKey: first.idempotencyKey,
    leaseToken: first.leaseToken,
    error: 'receiver did not queue',
    backoffMs: 10,
  }).changed, true);
  store.db.prepare(`
    UPDATE job_callback_outbox SET available_at = ? WHERE job_id = ?
  `).run('1970-01-01T00:00:00.000Z', job.id);
  const second = store.claimCallbackOutbox({ jobId: job.id, leaseMs: 1000 });
  assert.ok(second);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(store.acknowledgeCallbackOutbox({
    idempotencyKey: first.idempotencyKey,
    leaseToken: first.leaseToken,
  }).changed, false);
  const prematureAck = store.acknowledgeCallbackOutbox({
    idempotencyKey: second.idempotencyKey,
    leaseToken: second.leaseToken,
  });
  assert.equal(prematureAck.changed, false);
  assert.equal(prematureAck.reason, 'outbound_terminal_truth_required');
  const reservation = store.reserveOutboundCall({
    idempotencyKey: second.idempotencyKey,
    callId: 'callback-lease-terminal-call',
    request: { to: '1001', message: 'Ready.', mode: 'announce' },
  });
  store.claimOutboundCallIntent(reservation);
  store.markOutboundCallTerminal({ ...reservation, state: 'completed' });
  assert.equal(store.getCallbackOutbox(job.id).state, 'delivered');
  assert.equal(store.getJob(job.id).notification_status, 'delivered');
});

test('callback handoff is atomically correlated and delivery follows outbound terminal truth', (t) => {
  const { store } = withStore(t);
  const thread = store.createThread({ callerId: '1001', callbackTarget: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'callback-terminal-call',
    model: 'gpt-realtime-2.1-mini',
  });

  function reserveCallback(suffix) {
    const job = store.createJob({
      voiceThreadId: thread.id,
      realtimeSessionId: realtime.id,
      toolCallId: `callback-terminal-${suffix}`,
      profile: 'codex-luna',
      provider: 'codex',
      request: `Inspect callback ${suffix}.`,
      notificationMode: 'callback',
    }).job;
    store.markJobRunning(job.id);
    store.completeJobCas(job.id, { voiceResult: `Callback ${suffix} is ready.` });
    const delivery = store.claimCallbackOutbox({ jobId: job.id });
    const request = {
      to: '1001',
      message: `Callback ${suffix} is ready.`,
      mode: 'announce',
    };
    const reservation = store.reserveOutboundCall({
      idempotencyKey: delivery.idempotencyKey,
      request,
      callId: `outbound-${suffix}`,
    });
    const outbox = store.getCallbackOutbox(job.id);
    assert.equal(outbox.state, 'awaiting_outbound');
    assert.equal(outbox.outboundCallId, reservation.callId);
    assert.equal(outbox.lease_token, null);
    return { delivery, job, request, reservation };
  }

  const completed = reserveCallback('completed');
  store.claimOutboundCallIntent(completed.reservation);
  store.markOutboundCallTerminal({ ...completed.reservation, state: 'completed' });
  assert.equal(store.getCallbackOutbox(completed.job.id).state, 'delivered');
  assert.equal(store.getJob(completed.job.id).notification_status, 'delivered');

  const failed = reserveCallback('busy');
  store.claimOutboundCallIntent(failed.reservation);
  store.markOutboundCallTerminal({
    ...failed.reservation,
    state: 'failed',
    error: 'busy',
  });
  assert.equal(store.getCallbackOutbox(failed.job.id).state, 'failed');
  assert.equal(store.getJob(failed.job.id).notification_status, 'failed');

  const canceled = reserveCallback('canceled');
  store.requestOutboundCallCancellation({
    callId: canceled.reservation.callId,
    reason: 'operator canceled before dial intent',
  });
  assert.equal(store.getCallbackOutbox(canceled.job.id).state, 'failed');
  assert.equal(store.getJob(canceled.job.id).notification_status, 'failed');

  const unknown = reserveCallback('unknown');
  store.claimOutboundCallIntent(unknown.reservation);
  store.markOutboundCallTerminal({
    ...unknown.reservation,
    state: 'outcome_unknown',
    error: 'PBX cleanup could not be verified',
  });
  assert.equal(store.getCallbackOutbox(unknown.job.id).state, 'outcome_unknown');
  assert.equal(store.getJob(unknown.job.id).notification_status, 'outcome_unknown');
  assert.deepEqual(store.listDueCallbackJobs().map((job) => job.id), []);
});

test('callback reservation survives a pre-response crash without redial or pending retry', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-callback-crash-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = new VoiceStateStore({ dbPath });
  const thread = store.createThread({ callerId: '1001', callbackTarget: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'callback-crash-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'callback-crash-job',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect crash recovery.',
    notificationMode: 'callback',
  }).job;
  store.markJobRunning(job.id);
  store.completeJobCas(job.id, { voiceResult: 'Crash-safe result.' });
  const delivery = store.claimCallbackOutbox({ jobId: job.id });
  const request = { to: '1001', message: 'Crash-safe result.', mode: 'announce' };
  const reserved = store.reserveOutboundCall({
    idempotencyKey: delivery.idempotencyKey,
    request,
    callId: 'callback-crash-outbound',
  });
  // Simulate process death after the durable receiver transaction commits but
  // before the broker sees the HTTP response.
  assert.equal(store.getCallbackOutbox(job.id).state, 'awaiting_outbound');
  store.claimOutboundCallIntent(reserved);
  store.close();

  store = new VoiceStateStore({ dbPath });
  t.after(() => store.close());
  store.recoverInterruptedOutboundCalls();
  const outbox = store.getCallbackOutbox(job.id);
  assert.equal(outbox.state, 'outcome_unknown');
  assert.equal(outbox.outboundCallId, reserved.callId);
  assert.equal(store.getJob(job.id).notification_status, 'outcome_unknown');
  assert.deepEqual(store.listDueCallbackJobs(), []);
  assert.equal(store.listOutboundRecoveryBarriers().length, 1);

  const exactRetry = store.reserveOutboundCall({
    idempotencyKey: delivery.idempotencyKey,
    request,
    callId: 'must-not-replace-crash-call',
  });
  assert.equal(exactRetry.created, false);
  assert.equal(exactRetry.conflict, false);
  assert.equal(exactRetry.callId, reserved.callId);
  assert.equal(exactRetry.state, 'outcome_unknown');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM outbound_call_inbox WHERE idempotency_key = ?')
      .get(delivery.idempotencyKey).count,
    1
  );
});

test('outbound inbox retries queued work but never redials an interrupted dial intent', (t) => {
  const { store: initialStore, dbPath } = withStore(t);
  const request = {
    to: '1001',
    message: 'Your durable task finished.',
    mode: 'realtime',
    voiceThreadId: null,
  };
  const reserved = initialStore.reserveOutboundCall({
    idempotencyKey: 'callback:job-durable-outbound',
    request,
    callId: 'outbound-call-stable',
  });
  assert.equal(reserved.created, true);
  assert.equal(reserved.state, 'queued');
  initialStore.close();

  const resumedStore = new VoiceStateStore({ dbPath });
  t.after(() => resumedStore.close());
  assert.deepEqual(
    resumedStore.listQueuedOutboundCalls().map((record) => record.callId),
    ['outbound-call-stable']
  );
  const claimed = resumedStore.claimOutboundCallIntent({
    idempotencyKey: reserved.idempotencyKey,
    callId: reserved.callId,
  });
  assert.equal(claimed.changed, true);
  assert.deepEqual(claimed.record.request, request);
  resumedStore.close();

  const reconciledStore = new VoiceStateStore({ dbPath });
  t.after(() => reconciledStore.close());
  reconciledStore.recoverInterruptedOutboundCalls();
  const reconciled = reconciledStore.getOutboundCall(reserved.idempotencyKey);
  assert.equal(reconciled.state, 'outcome_unknown');
  assert.match(reconciled.error, /not redialed/i);
  assert.deepEqual(reconciledStore.listQueuedOutboundCalls(), []);
  const retry = reconciledStore.reserveOutboundCall({
    idempotencyKey: reserved.idempotencyKey,
    request,
    callId: 'must-not-replace-call-id',
  });
  assert.equal(retry.created, false);
  assert.equal(retry.conflict, false);
  assert.equal(retry.callId, 'outbound-call-stable');
  assert.equal(retry.state, 'outcome_unknown');
  assert.equal(reconciledStore.reserveOutboundCall({
    idempotencyKey: reserved.idempotencyKey,
    request: { ...request, message: 'Different request.' },
    callId: 'conflicting-call-id',
  }).conflict, true);
});

test('outbound cancellation tombstones queued work and preserves post-intent uncertainty', (t) => {
  const { store, dbPath } = withStore(t);
  const queued = store.reserveOutboundCall({
    idempotencyKey: 'outbound-cancel-before-intent',
    request: { to: '1001', message: 'Do not dial.', mode: 'announce' },
    callId: 'queued-cancel-call',
  });
  const canceled = store.requestOutboundCallCancellation({
    callId: queued.callId,
    reason: 'operator_stop',
  });
  assert.equal(canceled.changed, true);
  assert.equal(canceled.record.state, 'canceled');
  assert.ok(canceled.record.cancellationRequestedAt);
  assert.equal(store.claimOutboundCallIntent({
    idempotencyKey: queued.idempotencyKey,
    callId: queued.callId,
  }).changed, false);

  const dialing = store.reserveOutboundCall({
    idempotencyKey: 'outbound-cancel-after-intent',
    request: { to: '1002', message: 'Stop after intent.', mode: 'announce' },
    callId: 'dialing-cancel-call',
  });
  store.claimOutboundCallIntent({
    idempotencyKey: dialing.idempotencyKey,
    callId: dialing.callId,
  });
  const requested = store.requestOutboundCallCancellation({
    callId: dialing.callId,
    reason: 'panic_stop',
  });
  assert.equal(requested.record.state, 'cancel_requested');
  assert.deepEqual(
    store.listUnconfirmedOutboundCancellations().map((record) => record.callId),
    ['dialing-cancel-call']
  );
  store.close();

  const resumed = new VoiceStateStore({ dbPath });
  t.after(() => resumed.close());
  resumed.recoverInterruptedOutboundCalls();
  const uncertain = resumed.getOutboundCallByCallId(dialing.callId);
  assert.equal(uncertain.state, 'outcome_unknown');
  assert.match(uncertain.error, /quiescence was confirmed/i);
  assert.deepEqual(
    resumed.listUnconfirmedOutboundCancellations().map((record) => record.callId),
    ['dialing-cancel-call']
  );
});

test('voice-state never persists client SIP routes and migration scrubs legacy route destinations', (t) => {
  const { store, dbPath } = withStore(t);
  const timestamp = new Date().toISOString();
  const thread = store.createThread({ callerId: '1001', callbackTarget: '1001' });
  store.db.prepare('UPDATE voice_threads SET callback_dial_uri = ? WHERE id = ?').run(
    'sip:1001@attacker.example:65000;transport=tcp',
    thread.id
  );
  store.db.prepare(`
    INSERT INTO outbound_call_inbox (
      idempotency_key, request_hash, request_json, call_id, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `).run(
    'legacy-webhook-row',
    'legacy-hash',
    JSON.stringify({
      to: '1001',
      message: 'Legacy callback.',
      mode: 'announce',
      webhookUrl: 'http://127.0.0.1/internal',
      dialUri: 'sip:1001@attacker.example:5060;transport=udp',
    }),
    'legacy-webhook-call',
    timestamp,
    timestamp
  );
  store.close();

  const migrated = new VoiceStateStore({ dbPath });
  t.after(() => migrated.close());
  const record = migrated.getOutboundCall('legacy-webhook-row');
  assert.equal(Object.hasOwn(record.request, 'webhookUrl'), false);
  assert.equal(Object.hasOwn(record.request, 'dialUri'), false);
  assert.notEqual(record.requestHash, 'legacy-hash');
  assert.equal(
    migrated.db.prepare('SELECT callback_dial_uri FROM voice_threads WHERE id = ?')
      .get(thread.id).callback_dial_uri,
    null
  );
  assert.equal(Object.hasOwn(migrated.getThread(thread.id), 'callback_dial_uri'), false);

  const newlyReserved = migrated.reserveOutboundCall({
    idempotencyKey: 'new-route-is-scrubbed',
    callId: 'new-route-call',
    request: {
      to: '1001',
      message: 'Safe route.',
      dialUri: 'sip:1001@another-attacker.example:5060',
      webhookUrl: 'http://another-attacker.example/',
    },
  });
  assert.equal(Object.hasOwn(newlyReserved.request, 'dialUri'), false);
  assert.equal(Object.hasOwn(newlyReserved.request, 'webhookUrl'), false);
});

test('notification migration never replays legacy terminal jobs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-notification-migration-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = new VoiceStateStore({ dbPath });
  const thread = store.createThread({ callerId: '1001' });
  const realtime = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'legacy-notification-call',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: realtime.id,
    toolCallId: 'legacy-notification-tool',
    profile: 'codex-luna',
    provider: 'codex',
    request: 'Inspect legacy state.',
  }).job;
  store.markJobRunning(job.id);
  store.markJobCompleted(job.id, { voiceResult: 'Legacy result.' });
  store.close();

  const legacy = new Database(dbPath);
  legacy.exec(`
    ALTER TABLE jobs DROP COLUMN notification_delivered_at;
    ALTER TABLE jobs DROP COLUMN notification_last_attempt_at;
    ALTER TABLE jobs DROP COLUMN notification_attempts;
    ALTER TABLE jobs DROP COLUMN notification_status;
  `);
  legacy.close();

  store = new VoiceStateStore({ dbPath });
  t.after(() => store.close());
  assert.equal(store.getJob(job.id).notification_status, 'skipped');
  assert.deepEqual(store.listPendingJobNotifications(thread.id), []);
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
  store.recoverInterruptedRealtimeSessions();
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
