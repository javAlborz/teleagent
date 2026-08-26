'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WorkerSessionOperationStore,
  requestHash,
} = require('../worker-session-operation-store');

function request(overrides = {}) {
  return {
    operationId: 'job_worker_store_1',
    target: '%12',
    message: 'Inspect the current changes.',
    sessionFingerprint: 'a'.repeat(64),
    timeoutMs: 60000,
    ...overrides,
  };
}

function preparedInput(value = request()) {
  return {
    operationId: value.operationId,
    requestHash: requestHash(value),
    target: value.target,
    stableTarget: '%12',
    sessionFingerprint: value.sessionFingerprint,
    provider: 'codex',
    operationMarker: `<teleagent-operation id="${value.operationId}">`,
  };
}

test('worker operation identity is exact and never persists the target message', (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const value = request();
  const first = store.prepare(preparedInput(value));
  assert.equal(first.created, true);
  assert.equal(store.prepare(preparedInput(value)).created, false);

  assert.throws(
    () => store.prepare(preparedInput(request({ message: 'Different message.' }))),
    { code: 'WORKER_SESSION_IDEMPOTENCY_CONFLICT' }
  );
  assert.throws(
    () => store.prepare({ ...preparedInput(value), requestHash: 'not-a-digest' }),
    { code: 'WORKER_SESSION_REQUEST_INVALID' }
  );

  const persisted = JSON.stringify(store.db.prepare(
    'SELECT * FROM worker_session_operations'
  ).all());
  assert.doesNotMatch(persisted, /Inspect the current changes/);
});

test('restart requeues only a pre-delivery claim and preserves delivery for reconciliation', (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const first = request({ operationId: 'job_pre_delivery' });
  const second = request({ operationId: 'job_delivery_started' });
  store.prepare(preparedInput(first));
  store.claimCommit(first.operationId, requestHash(first));
  store.prepare(preparedInput(second));
  store.claimCommit(second.operationId, requestHash(second));
  store.markDeliveryStarted(second.operationId, requestHash(second));

  const recovered = store.recoverInterrupted();
  assert.deepEqual(recovered, { recoveredPreDelivery: 1, reconciliationRequired: 1 });
  assert.equal(store.get(first.operationId).state, 'prepared');
  assert.equal(store.get(second.operationId).state, 'delivery_started');
  assert.ok(store.listEvents(second.operationId).some(
    (event) => event.eventType === 'delivery_reconciliation_required'
  ));
});

test('unknown delivery becomes completed only with exact marker, session, and final-response evidence', (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const value = request({ operationId: 'job_evidence_bound' });
  const input = preparedInput(value);
  store.prepare(input);
  store.claimCommit(value.operationId, valueHash(value));
  store.markDeliveryStarted(value.operationId, valueHash(value));
  store.outcomeUnknown(value.operationId, new Error('transport lost'));

  const result = {
    success: true,
    delivered: true,
    response_verified: true,
    response: 'Verified response.',
  };
  assert.throws(() => store.completeReconciled(value.operationId, result, {
    operationMarker: 'wrong-marker',
    sessionFingerprint: value.sessionFingerprint,
  }), { code: 'WORKER_SESSION_RECONCILIATION_EVIDENCE_INVALID' });
  assert.equal(store.get(value.operationId).state, 'outcome_unknown');

  const completed = store.completeReconciled(value.operationId, result, {
    operationMarker: input.operationMarker,
    sessionFingerprint: value.sessionFingerprint,
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.response, 'Verified response.');
  assert.ok(store.listEvents(value.operationId).some(
    (event) => event.eventType === 'completed_by_exact_reconciliation'
  ));
});

test('pane attestations bind one creation to exact provider identity, session, workspace, and stable pane', (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const plan = {
    creationId: 'session_0123456789abcdef',
    sessionName: 'phone-claude-01234567',
    provider: 'claude',
    providerUser: 'teleagent-claude-worker',
    providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
    workspace: '/srv/teleagent-agent-workspaces/phone',
    launcherPath: '/usr/local/libexec/teleagent-session-pane-entry',
  };
  assert.equal(store.planPaneAttestation(plan).created, true);
  assert.equal(store.planPaneAttestation(plan).created, false);
  assert.throws(
    () => store.planPaneAttestation({ ...plan, providerUser: 'teleagent-codex-worker' }),
    { code: 'WORKER_SESSION_ATTESTATION_INVALID' }
  );
  assert.throws(
    () => store.planPaneAttestation({ ...plan, workspace: '/srv/other' }),
    { code: 'WORKER_SESSION_ATTESTATION_CONFLICT' }
  );

  const active = store.activatePaneAttestation(plan.creationId, '%42');
  assert.equal(active.paneId, '%42');
  assert.equal(active.providerSessionId, plan.providerSessionId);
  assert.equal(store.getPaneAttestationByPaneId('%42').provider, 'claude');
  assert.throws(
    () => store.activatePaneAttestation(plan.creationId, '%43'),
    { code: 'WORKER_SESSION_ATTESTATION_CAS_FAILED' }
  );
  assert.equal(store.listPaneAttestations().length, 1);
  assert.equal(store.retirePaneAttestation(plan.creationId, 'pane_absent').state, 'retired');
  assert.equal(store.getPaneAttestationByPaneId('%42'), null);

  const events = store.db.prepare(
    'SELECT event_type FROM worker_session_pane_events ORDER BY sequence'
  ).all().map((row) => row.event_type);
  assert.deepEqual(events, ['pane_planned', 'pane_activated', 'pane_retired']);
  assert.throws(
    () => store.db.prepare('DELETE FROM worker_session_pane_events').run(),
    /append-only/
  );
});

test('panic is durable, terminalizes each delivery boundary truthfully, and gates mutation', (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const prepared = request({ operationId: 'job_panic_prepared' });
  const claimed = request({ operationId: 'job_panic_claimed' });
  const delivered = request({ operationId: 'job_panic_delivered' });

  for (const value of [prepared, claimed, delivered]) store.prepare(preparedInput(value));
  store.claimCommit(claimed.operationId, requestHash(claimed));
  store.claimCommit(delivered.operationId, requestHash(delivered));
  store.markDeliveryStarted(delivered.operationId, requestHash(delivered));

  const first = store.panic({ reason: 'dial_nine', source: 'phone' });
  assert.equal(first.accepted, true);
  assert.equal(first.persisted, true);
  assert.equal(first.alreadyLocked, false);
  assert.deepEqual(first.activeOperationIds, [
    claimed.operationId,
    delivered.operationId,
    prepared.operationId,
  ]);
  assert.equal(store.get(prepared.operationId).state, 'failed_pre_delivery');
  assert.equal(store.get(claimed.operationId).state, 'failed_pre_delivery');
  assert.equal(store.get(delivered.operationId).state, 'outcome_unknown');
  assert.deepEqual(store.panicStatus().activeOperationIds, []);
  assert.equal(store.panicStatus().locked, true);

  assert.throws(
    () => store.prepare(preparedInput(request({ operationId: 'job_after_panic' }))),
    { code: 'WORKER_SESSION_PANIC_LOCKED' }
  );
  const pane = {
    creationId: 'session_fedcba9876543210',
    sessionName: 'phone-codex-fedcba98',
    provider: 'codex',
    providerUser: 'teleagent-codex-worker',
    providerSessionId: '123e4567-e89b-42d3-a456-426614174001',
    workspace: '/srv/teleagent-agent-workspaces/phone',
    launcherPath: '/usr/local/libexec/teleagent-session-pane-entry',
  };
  assert.throws(() => store.planPaneAttestation(pane), {
    code: 'WORKER_SESSION_PANIC_LOCKED',
  });

  const second = store.panic({ reason: 'dial_nine_retry', source: 'phone' });
  assert.equal(second.alreadyLocked, true);
  const controlEvents = store.db.prepare(`
    SELECT event_type, details_json FROM worker_session_control_events ORDER BY sequence
  `).all();
  assert.equal(controlEvents.length, 2);
  assert.equal(JSON.parse(controlEvents[1].details_json).reasserted, true);
  assert.throws(
    () => store.db.prepare('DELETE FROM worker_session_control_events').run(),
    /append-only/
  );

  const unlocked = store.unlockPanic();
  assert.equal(unlocked.success, true);
  assert.equal(unlocked.quiesced, true);
  assert.equal(store.panicStatus().locked, false);
  assert.equal(store.prepare(preparedInput(request({ operationId: 'job_after_unlock' }))).created, true);
});

function valueHash(value) {
  return requestHash(value);
}
