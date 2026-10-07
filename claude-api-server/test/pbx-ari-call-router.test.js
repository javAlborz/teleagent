'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PbxAriCallRouter } = require('../pbx-ari-call-router');
const { APP } = require('../pbx-ari-client');

function fixture(t) {
  const ari = new EventEmitter(); const operations = [];
  ari.epoch = 'epoch'; ari.assertEpoch = (epoch) => assert.equal(epoch, 'epoch');
  ari.channel = async (id) => ({ id, name: 'PJSIP/1001-00000001',
    dialplan: { context: 'from-linphone', exten: '7', app_name: 'Stasis' } });
  ari.variable = async () => ({ value: '1001' });
  for (const method of ['createBridge', 'destroyBridge', 'answer', 'hangup', 'originateTrunk', 'restoreHandset', 'forwardStar']) {
    ari[method] = async (...args) => { operations.push({ method, args }); };
  }
  const calls = { calls: new Map(), async bind(input) { operations.push({ method: 'bind', args: [input] }); return 'handle'; } };
  const approvalAdapter = { busy: false, cancel() { operations.push({ method: 'cancelApproval', args: [] }); } };
  const router = new PbxAriCallRouter({ ari, calls, approvalAdapter, assertPbxBoundary: async () => {} });
  t.after(() => router.close().catch(() => {}));
  const event = (type, channel, args = []) => ({ type, application: APP, channel: { id: channel }, args });
  return { router, ari, operations, approvalAdapter, event };
}

test('router creates only the fixed conductor trunk and binds its exact answered bridge', async (t) => {
  const f = fixture(t);
  await f.router.event(f.event('StasisStart', 'owner', ['owner', '7']), 'epoch');
  const call = f.router.current;
  assert.equal(call.phase, 'dialing');
  assert.deepEqual(f.operations.find((entry) => entry.method === 'originateTrunk').args,
    [{ id: call.trunkId, ownerId: 'owner', route: '7' }]);
  await f.router.event(f.event('StasisStart', call.trunkId, ['trunk', 'owner']), 'epoch');
  assert.equal(call.phase, 'connected'); assert.equal(call.handle, 'handle');
  assert.deepEqual(f.operations.filter((entry) => entry.method === 'restoreHandset').map((entry) => entry.args),
    [[call.bridgeId, call.trunkId], [call.bridgeId, call.ownerId]]);
  await f.router.event(f.event('StasisEnd', 'owner'), 'epoch');
  assert.equal(f.router.current, null);
  assert.deepEqual(f.operations.filter((entry) => entry.method === 'hangup').map((entry) => entry.args[0]), ['owner', call.trunkId]);
});

test('second callers and non-owner endpoints cannot start an extra trunk', async (t) => {
  const f = fixture(t);
  await f.router.event(f.event('StasisStart', 'owner', ['owner', '7']), 'epoch');
  await f.router.event(f.event('StasisStart', 'other', ['owner', '7']), 'epoch');
  assert.equal(f.operations.filter((entry) => entry.method === 'originateTrunk').length, 1);
  assert.equal(f.operations.find((entry) => entry.method === 'hangup').args[0], 'other');
  await f.router.stop();
  f.ari.variable = async () => ({ value: 'claude-phone' });
  await assert.rejects(f.router.event(f.event('StasisStart', 'forged', ['owner', '7']), 'epoch'),
    { code: 'PBX_ROUTER_OWNER_INVALID' });
  assert.equal(f.operations.filter((entry) => entry.method === 'originateTrunk').length, 1);
});

test('star forwards only from the handset outside approval, never from the trunk', async (t) => {
  const f = fixture(t);
  await f.router.event(f.event('StasisStart', 'owner', ['owner', '7']), 'epoch');
  const call = f.router.current;
  await f.router.event(f.event('StasisStart', call.trunkId, ['trunk', 'owner']), 'epoch');
  await f.router.event({ ...f.event('ChannelDtmfReceived', call.trunkId), digit: '*' }, 'epoch');
  f.approvalAdapter.busy = true;
  await f.router.event({ ...f.event('ChannelDtmfReceived', 'owner'), digit: '*' }, 'epoch');
  f.approvalAdapter.busy = false;
  await f.router.event({ ...f.event('ChannelDtmfReceived', 'owner'), digit: '#' }, 'epoch');
  await f.router.event({ ...f.event('ChannelDtmfReceived', 'owner'), digit: '*' }, 'epoch');
  assert.deepEqual(f.operations.filter((entry) => entry.method === 'forwardStar').map((entry) => entry.args), [[call.trunkId]]);
  assert.equal(f.operations.filter((entry) => entry.method === 'cancelApproval').length, 1);
});

test('lost originate or disconnect cannot redial and uncertain cleanup stays locked', async (t) => {
  const f = fixture(t);
  f.ari.originateTrunk = async () => { throw new Error('lost response'); };
  f.ari.emit('event', f.event('StasisStart', 'owner', ['owner', '7']), 'epoch');
  await Promise.allSettled([...f.router.pending]);
  assert.equal(f.router.locked, true);
  f.ari.emit('disconnect');
  await f.router.event(f.event('StasisStart', 'other', ['owner', '7']), 'epoch');
  assert.equal(f.router.current, null);
});

// Asterisk can emit BridgeDestroyed before acknowledging our own DELETE.
test('three consecutive calls survive their own bridge teardown events', async t => {
  const f = fixture(t);
  f.ari.destroyBridge = async id => {
    f.ari.emit('event', { type: 'BridgeDestroyed', application: APP, bridge: { id } }, 'epoch');
    await new Promise(resolve => setImmediate(resolve));
  };
  for (let i = 0; i < 3; i++) {
    const owner = `owner-${i}`;
    await f.router.event(f.event('StasisStart', owner, ['owner', '7']), 'epoch');
    const call = f.router.current;
    assert.ok(call, 'next caller must be admitted after proved cleanup');
    await f.router.event(f.event('StasisStart', call.trunkId, ['trunk', owner]), 'epoch');
    await f.router.event(f.event('ChannelHangupRequest', owner), 'epoch');
    await Promise.allSettled([...f.router.pending]);
    assert.equal(f.router.locked, false);
    assert.equal(f.router.current, null);
  }
});

test('unexpected bridge destruction and uncertain owned cleanup still lock the router', async t => {
  for (const uncertain of [false, true]) {
    const f = fixture(t);
    await f.router.event(f.event('StasisStart', 'owner', ['owner', '7']), 'epoch');
    const call = f.router.current;
    if (uncertain) {
      f.ari.destroyBridge = async id => {
        f.ari.emit('event', { type: 'BridgeDestroyed', application: APP, bridge: { id } }, 'epoch');
        throw new Error('DELETE acknowledgement lost');
      };
      await assert.rejects(f.router.stop(), { code: 'PBX_ROUTER_STOP_UNCONFIRMED' });
    } else {
      await f.router.event({ type: 'BridgeDestroyed', application: APP, bridge: { id: call.bridgeId } }, 'epoch');
    }
    assert.equal(f.router.locked, true);
  }
});
