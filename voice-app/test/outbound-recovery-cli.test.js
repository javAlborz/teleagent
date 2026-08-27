'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OutboundRuntimeFence } = require('../lib/outbound-runtime-fence');
const { openVoiceRuntimeState } = require('../lib/voice-runtime-state');
const { OUTBOUND_QUIESCENCE_CONFIRMATION, VoiceStateStore } = require('../lib/voice-state-store');
const { resolveOutboundRecovery } = require('../../scripts/resolve-outbound-recovery');

function createBarrier(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-outbound-resolver-'));
  const dbPath = path.join(directory, 'voice.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let runtime = openVoiceRuntimeState({ dbPath });
  const reserved = runtime.stateStore.reserveOutboundCall({
    idempotencyKey: 'offline-recovery-call',
    callId: 'offline-recovery-call-id',
    request: { to: '1001', message: 'Ambiguous call.', mode: 'announce' },
  });
  runtime.stateStore.claimOutboundCallIntent(reserved);
  runtime.stateStore.close();
  runtime.runtimeFence.release();
  runtime = openVoiceRuntimeState({ dbPath });
  assert.equal(runtime.stateStore.getOutboundCallByCallId(reserved.callId).recoveryRequired, true);
  runtime.stateStore.close();
  runtime.runtimeFence.release();
  return { dbPath, callId: reserved.callId };
}

function argumentsFor({ dbPath, callId, confirmation = OUTBOUND_QUIESCENCE_CONFIRMATION }) {
  return ['--db', dbPath, '--call-id', callId, '--confirm', confirmation];
}

test('offline recovery requires root, exact confirmation, and an inactive runtime', (t) => {
  const barrier = createBarrier(t);
  assert.throws(
    () => resolveOutboundRecovery({ argv: argumentsFor(barrier), effectiveUid: 1000 }),
    /run as root/i
  );
  assert.throws(
    () => resolveOutboundRecovery({
      argv: argumentsFor({ ...barrier, confirmation: 'yes' }),
      effectiveUid: 0,
    }),
    /must be exactly/
  );

  const liveFence = new OutboundRuntimeFence({ stateDbPath: barrier.dbPath });
  assert.throws(
    () => resolveOutboundRecovery({ argv: argumentsFor(barrier), effectiveUid: 0 }),
    (error) => error?.code === 'OUTBOUND_RUNTIME_ALREADY_ACTIVE'
  );
  liveFence.release();
});

test('offline recovery clears only the exact barrier and appends a high-risk audit', (t) => {
  const barrier = createBarrier(t);
  const result = resolveOutboundRecovery({
    argv: argumentsFor(barrier),
    effectiveUid: 0,
  });
  assert.equal(result.success, true);
  assert.equal(result.callId, barrier.callId);
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.recoveryRequired, false);
  assert.ok(result.recoveryBarrierResolvedAt);

  const store = new VoiceStateStore({ dbPath: barrier.dbPath });
  t.after(() => store.close());
  const record = store.getOutboundCallByCallId(barrier.callId);
  assert.equal(record.state, 'outcome_unknown');
  assert.equal(record.recoveryRequired, false);
  const audit = store.listAuditEvents({ limit: 100 }).find(
    (event) => event.action === 'outbound_recovery_barrier_resolved'
  );
  assert.ok(audit);
  assert.equal(audit.risk_level, 'high');
  assert.equal(audit.metadata.source, 'offline_root_cli');
  assert.equal(audit.metadata.call_id, barrier.callId);
});

test('offline recovery rejects insecure or symlinked state DB files', (t) => {
  const barrier = createBarrier(t);
  fs.chmodSync(barrier.dbPath, 0o644);
  assert.throws(
    () => resolveOutboundRecovery({ argv: argumentsFor(barrier), effectiveUid: 0 }),
    /group or other users/i
  );
  fs.chmodSync(barrier.dbPath, 0o600);
  const linkPath = `${barrier.dbPath}.link`;
  fs.symlinkSync(barrier.dbPath, linkPath);
  assert.throws(
    () => resolveOutboundRecovery({
      argv: argumentsFor({ ...barrier, dbPath: linkPath }),
      effectiveUid: 0,
    }),
    /not a symlink/i
  );
});
