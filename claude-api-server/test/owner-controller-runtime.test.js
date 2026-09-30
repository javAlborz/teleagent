'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OwnerPlaneReadiness } = require('../owner-controller-runtime');

function fixture() {
  const state = { time: 10000, calls: [], epoch: 'a'.repeat(64), failed: false, pause: null };
  const broker = { async health() { state.calls.push('broker'); if (state.pause) await state.pause;
    if (state.failed) throw new Error('down');
    return { ready: true, epoch: state.epoch, protocol: 'independent-pbx-owner-v1' }; } };
  const attester = { async health() { state.calls.push('pbx');
    return { ready: true, epoch: 'a'.repeat(64), protocol: 'independent-pbx-owner-v1' }; } };
  return { state, attester, readiness: new OwnerPlaneReadiness({ broker, attester, epoch: 'a'.repeat(64), now: () => state.time }) };
}

test('both matching planes are required and stale or failed readiness withdraws availability', async () => {
  const { state, readiness } = fixture();
  assert.equal(readiness.available(), false);
  assert.equal(await readiness.refresh(), true);
  assert.deepEqual(state.calls, ['broker', 'pbx']);
  state.time += 30000; assert.equal(readiness.available(), false);
  assert.equal(await readiness.refresh(), true);
  state.time += 5000; state.failed = true;
  assert.equal(await readiness.refresh(), false);
  assert.equal(readiness.available(), false);
});

test('wrong authority, wrong protocol and locked PBX cannot advertise controls', async () => {
  for (const change of ['epoch', 'protocol', 'locked']) {
    const { state, attester, readiness } = fixture();
    if (change === 'epoch') state.epoch = 'b'.repeat(64);
    if (change === 'protocol') attester.health = async () => ({ ready: true, epoch: state.epoch, protocol: 'legacy' });
    if (change === 'locked') attester.health = async () => ({ ready: false, epoch: state.epoch, protocol: 'independent-pbx-owner-v1' });
    assert.equal(await readiness.refresh(), false);
  }
});

test('slow probes share one slot, cannot extend freshness, and do not accumulate polling', async () => {
  const { state, readiness } = fixture(); let release;
  state.pause = new Promise((resolve) => { release = resolve; });
  const first = readiness.refresh(); const second = readiness.refresh();
  assert.equal(first, second); assert.deepEqual(state.calls, ['broker']);
  state.time += 31000; release();
  assert.equal(await first, false);
  state.pause = null; assert.equal(await readiness.refresh(), true);
  const count = state.calls.length;
  await readiness.refresh(); assert.equal(state.calls.length, count);
});
