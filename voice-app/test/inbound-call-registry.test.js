'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { InboundCallRegistry } = require('../lib/inbound-call-registry');
const { OutboundRuntimeFence } = require('../lib/outbound-runtime-fence');
const { releaseVoiceRuntimeFenceAfterShutdown } = require('../lib/voice-runtime-state');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function responseRecorder() {
  return {
    statuses: [],
    send(status) { this.statuses.push(status); },
  };
}

test('late INVITE is synchronously rejected without starting provider or media work', async () => {
  const registry = new InboundCallRegistry();
  const res = responseRecorder();
  let handlerCalls = 0;

  const result = await registry.dispatch({}, res, async () => { handlerCalls += 1; });

  assert.deepEqual(result, { rejected: true, reason: 'voice_runtime_draining' });
  assert.deepEqual(res.statuses, [503]);
  assert.equal(handlerCalls, 0);
  assert.equal(registry.getStatus().activeCount, 0);
});

test('shutdown aborts and destroys every acquired inbound dialog and endpoint', async () => {
  const registry = new InboundCallRegistry();
  registry.startAccepting();
  const started = deferred();
  let dialogDestroyed = 0;
  let endpointDestroyed = 0;
  const dialog = { async destroy() { dialogDestroyed += 1; } };
  const endpoint = { async destroy() { endpointDestroyed += 1; } };

  const call = registry.dispatch({}, responseRecorder(), async ({ signal, onResources }) => {
    onResources({ dialog, endpoint });
    started.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  await started.promise;

  const drain = await registry.shutdown({ timeoutMs: 100 });
  await call;

  assert.equal(drain.safeToClose, true);
  assert.equal(drain.activeCount, 0);
  assert.equal(dialogDestroyed, 1);
  assert.equal(endpointDestroyed, 1);
  assert.equal(registry.getStatus().accepting, false);
});

test('an INVITE racing admission shutdown is tracked, while the next one is rejected', async () => {
  const registry = new InboundCallRegistry();
  registry.startAccepting();
  const release = deferred();
  let firstStarted = 0;
  let lateStarted = 0;
  const first = registry.dispatch({}, responseRecorder(), async ({ signal }) => {
    firstStarted += 1;
    await release.promise;
    assert.equal(signal.aborted, true);
  });
  assert.equal(registry.getStatus().activeCount, 1, 'dispatch must register before async work');
  registry.stopAccepting();
  const lateRes = responseRecorder();
  const late = registry.dispatch({}, lateRes, async () => { lateStarted += 1; });
  const shutdown = registry.shutdown({ timeoutMs: 100 });
  release.resolve();

  assert.equal((await shutdown).safeToClose, true);
  await first;
  assert.deepEqual(await late, { rejected: true, reason: 'voice_runtime_draining' });
  assert.equal(firstStarted, 1);
  assert.equal(lateStarted, 0);
  assert.deepEqual(lateRes.statuses, [503]);
});

test('a failed inbound dialog teardown is never reported as safe to replace', async () => {
  const registry = new InboundCallRegistry();
  registry.startAccepting();
  const started = deferred();
  const call = registry.dispatch({}, responseRecorder(), async ({ signal, onResources }) => {
    onResources({
      dialog: { async destroy() { throw new Error('SIP BYE was not confirmed'); } },
      endpoint: { async destroy() {} },
    });
    started.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  await started.promise;

  const drain = await registry.shutdown({ timeoutMs: 100 });
  await call;
  assert.equal(drain.cleanupSucceeded, false);
  assert.equal(drain.safeToClose, false);
  assert.equal(drain.error, 'inbound_call_quiescence_unconfirmed');
  assert.equal(registry.getStatus().cleanupUncertain, true);
  assert.equal(registry.startAccepting().accepting, false);
});

test('cleanup uncertainty remains fenced even when it predates shutdown', async () => {
  const registry = new InboundCallRegistry();
  registry.startAccepting();
  await registry.dispatch({}, responseRecorder(), async ({ onResources }) => {
    onResources({
      dialog: { async destroy() { throw new Error('dialog may still exist'); } },
    });
  });

  assert.equal(registry.getStatus().activeCount, 1);
  assert.equal(registry.getStatus().cleanupUncertain, true);
  assert.equal(registry.getStatus().accepting, false);
  const drain = await registry.shutdown({ timeoutMs: 100 });
  assert.equal(drain.safeToClose, false);
  assert.equal(drain.activeCount, 1);
});

test('uncooperative inbound work times out and keeps the process-lifetime fence held', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-inbound-fence-'));
  const stateDbPath = path.join(tempDir, 'voice.sqlite');
  const fence = new OutboundRuntimeFence({ stateDbPath });
  const release = deferred();
  t.after(() => {
    try { fence.release(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const registry = new InboundCallRegistry();
  registry.startAccepting();
  const call = registry.dispatch({}, responseRecorder(), async () => release.promise);

  const inboundDrain = await registry.shutdown({ timeoutMs: 15 });
  assert.equal(inboundDrain.safeToClose, false);
  const runtimeRelease = releaseVoiceRuntimeFenceAfterShutdown({
    runtimeFence: fence,
    stateStore: { db: { open: false } },
    brokerDrain: { safeToClose: true },
    outboundDrain: { safeToClose: true },
    inboundDrain,
    transportsClosed: true,
  });
  assert.equal(runtimeRelease.released, false);
  assert.equal(fence.assertHeld(), true);
  assert.throws(
    () => new OutboundRuntimeFence({ stateDbPath }),
    (error) => error.code === 'OUTBOUND_RUNTIME_ALREADY_ACTIVE'
  );

  release.resolve();
  await call;
});
