'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OutboundRuntimeFence } = require('../lib/outbound-runtime-fence');
const {
  openVoiceRuntimeState,
  releaseVoiceRuntimeFenceAfterShutdown,
} = require('../lib/voice-runtime-state');

function temporaryStatePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-outbound-fence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'voice.sqlite');
}

test('a duplicate runtime is fenced before it can open or recover shared state', (t) => {
  const dbPath = temporaryStatePath(t);
  const owner = openVoiceRuntimeState({ dbPath });
  const request = { to: '1001', message: 'Owner still dialing.', mode: 'announce' };
  const reserved = owner.stateStore.reserveOutboundCall({
    idempotencyKey: 'live-owner-call',
    callId: 'live-owner-call-id',
    request,
  });
  owner.stateStore.claimOutboundCallIntent(reserved);

  assert.throws(
    () => openVoiceRuntimeState({ dbPath }),
    (error) => error?.code === 'OUTBOUND_RUNTIME_ALREADY_ACTIVE'
  );
  const unchanged = owner.stateStore.getOutboundCall(reserved.idempotencyKey);
  assert.equal(unchanged.state, 'dial_intent');
  assert.equal(unchanged.recoveryRequired, false);

  owner.stateStore.close();
  owner.runtimeFence.release();

  const replacement = openVoiceRuntimeState({ dbPath });
  t.after(() => {
    replacement.stateStore.close();
    replacement.runtimeFence.release();
  });
  const recovered = replacement.stateStore.getOutboundCall(reserved.idempotencyKey);
  assert.equal(recovered.state, 'outcome_unknown');
  assert.equal(recovered.recoveryRequired, true);
  assert.equal(replacement.recovery.outboundCalls, 1);
});

test('startup failure releases the owner fence without opening a recovery window', (t) => {
  const dbPath = temporaryStatePath(t);
  class BrokenStore {
    constructor() {
      throw new Error('injected state open failure');
    }
  }
  assert.throws(
    () => openVoiceRuntimeState({ dbPath, StoreClass: BrokenStore }),
    /injected state open failure/
  );

  const fence = new OutboundRuntimeFence({ stateDbPath: dbPath });
  assert.equal(fence.assertHeld(), true);
  fence.release();
});

test('outbound drain alone never releases the full voice-process fence', (t) => {
  const dbPath = temporaryStatePath(t);
  const runtime = openVoiceRuntimeState({ dbPath });
  const outboundOnly = releaseVoiceRuntimeFenceAfterShutdown({
    runtimeFence: runtime.runtimeFence,
    stateStore: runtime.stateStore,
    brokerDrain: { safeToClose: false },
    outboundDrain: { safeToClose: true },
    inboundDrain: { safeToClose: true },
    transportsClosed: true,
  });
  assert.deepEqual(outboundOnly, { released: false, safeToReplace: false });
  assert.equal(runtime.runtimeFence.assertHeld(), true);
  assert.throws(
    () => new OutboundRuntimeFence({ stateDbPath: dbPath }),
    (error) => error?.code === 'OUTBOUND_RUNTIME_ALREADY_ACTIVE'
  );

  runtime.stateStore.close();
  const globalDrain = releaseVoiceRuntimeFenceAfterShutdown({
    runtimeFence: runtime.runtimeFence,
    stateStore: runtime.stateStore,
    brokerDrain: { safeToClose: true },
    outboundDrain: { safeToClose: true },
    inboundDrain: { safeToClose: true },
    transportsClosed: true,
  });
  assert.deepEqual(globalDrain, { released: true, safeToReplace: true });
  const replacement = new OutboundRuntimeFence({ stateDbPath: dbPath });
  replacement.release();
});
