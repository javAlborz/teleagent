'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { VoiceStateStore } = require('../lib/voice-state-store');

const SPOKEN_PROMPT = [
  'Approval needed.',
  'Restart teleagent.service on Hermes.',
  'Press pound to approve or star to cancel.',
].join(' ');

function arm(store, threadId, { callId, realtimeSessionId, suffix }) {
  return store.armFocusedApproval(threadId, {
    spokenPrompt: SPOKEN_PROMPT,
    purpose: 'approval_prompt',
    responseId: `response-${suffix}`,
    itemId: `item-${suffix}`,
    playbackCompletedAt: new Date().toISOString(),
    playoutMarker: `approval:${suffix}`,
    playoutBoundary: 'freeswitch_playout_marker',
    callId,
    realtimeSessionId,
  });
}

test('a persisted approval arm is usable only by the exact call and realtime session that heard it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-approval-binding-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = new VoiceStateStore({ dbPath });
  const thread = store.createThread({ callerId: '1001', selectedProfile: 'codex-sol' });
  const firstSession = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-first',
    model: 'gpt-realtime-2.1-mini',
  });
  const secondSession = store.createRealtimeSession({
    voiceThreadId: thread.id,
    callId: 'call-second',
    model: 'gpt-realtime-2.1-mini',
  });
  const job = store.createJob({
    voiceThreadId: thread.id,
    realtimeSessionId: firstSession.id,
    toolCallId: 'cross-call-store-cas',
    profile: 'codex-sol',
    provider: 'codex',
    request: 'Restart teleagent.service.',
    requiresApproval: true,
    riskLevel: 'high',
    operation: { spokenApprovalPrompt: SPOKEN_PROMPT },
    approvalPrompt: SPOKEN_PROMPT,
  }).job;

  const firstArm = arm(store, thread.id, {
    callId: 'call-first',
    realtimeSessionId: firstSession.id,
    suffix: 'first',
  });
  assert.equal(firstArm.changed, true);
  store.close();

  store = new VoiceStateStore({ dbPath });
  t.after(() => store.close());
  const persisted = store.getJob(job.id);
  assert.ok(persisted.approval_armed_at);
  assert.equal(persisted.approvalArmCallId, 'call-first');
  assert.equal(persisted.approvalArmRealtimeSessionId, firstSession.id);

  const wrongSessionApproval = store.approveFocusedJobCas(thread.id, {
    method: 'dtmf-pound',
    decidedBy: 'caller',
    callId: 'call-second',
    realtimeSessionId: secondSession.id,
  });
  assert.equal(wrongSessionApproval.changed, false);
  assert.equal(wrongSessionApproval.reason, 'approval_session_mismatch');
  assert.equal(store.getJob(job.id).status, 'awaiting_approval');
  assert.equal(
    store.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(job.id).status,
    'pending'
  );

  const wrongSessionDisarm = store.invalidateFocusedApprovalArm(thread.id, {
    callId: 'call-second',
    realtimeSessionId: secondSession.id,
    reason: 'unrelated_session_teardown',
  });
  assert.equal(wrongSessionDisarm.changed, false);
  assert.equal(wrongSessionDisarm.reason, 'approval_session_mismatch');
  assert.ok(store.getJob(job.id).approval_armed_at);

  const exactDisarm = store.invalidateFocusedApprovalArm(thread.id, {
    callId: 'call-first',
    realtimeSessionId: firstSession.id,
    reason: 'owning_session_teardown',
  });
  assert.equal(exactDisarm.changed, true);
  assert.equal(exactDisarm.job.status, 'awaiting_approval');
  assert.equal(exactDisarm.job.approval_armed_at, null);
  assert.equal(exactDisarm.job.approvalArmCallId, null);
  assert.equal(exactDisarm.job.approvalArmRealtimeSessionId, null);

  const rebound = arm(store, thread.id, {
    callId: 'call-second',
    realtimeSessionId: secondSession.id,
    suffix: 'second',
  });
  assert.equal(rebound.changed, true);
  const exactApproval = store.approveFocusedJobCas(thread.id, {
    method: 'dtmf-pound',
    decidedBy: 'caller',
    callId: 'call-second',
    realtimeSessionId: secondSession.id,
  });
  assert.equal(exactApproval.changed, true);
  assert.equal(exactApproval.job.status, 'queued');
});
