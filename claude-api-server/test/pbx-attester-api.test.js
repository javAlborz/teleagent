'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createPbxAttesterApi, PbxAttesterControlStore } = require('../pbx-attester-api');
const { PbxAriCallCatalog } = require('../pbx-ari-approval-adapter');
const { EventEmitter } = require('node:events');

function fixture(t) {
  const db = new Database(':memory:'); db.pragma('synchronous=FULL'); t.after(() => db.close());
  const controlStore = new PbxAttesterControlStore(db);
  const ari = new EventEmitter(); ari.epoch = 'fixture'; ari.assertEpoch = (epoch) => assert.equal(epoch, 'fixture');
  const calls = new PbxAriCallCatalog({ ari, pbxInstanceId: 'fixture', now: () => 1800000000000 });
  calls.calls.set('base', { epoch: 'fixture', sipCallId: 'call@pbx', leg: { handset_uniqueid: 'handset', trunk_uniqueid: 'trunk' } });
  const state = { attestations: 0, cancellations: 0, boundary: 0, pause: null };
  const options = { calls, controlStore,
    armVerifier: { verify: (token) => ({ claims: { pbx_call_handle: token } }) },
    attester: { async attest() { state.attestations++; if (state.pause) await state.pause; return { evidenceToken: 'fixture' }; } },
    adapter: { cancel() { state.cancellations++; } },
    router: { async stop() { return { quiesced: true }; } },
    assertBoundary: async () => { state.boundary++; },
  };
  return { api: createPbxAttesterApi(options), state, options, calls, db };
}

test('each approval gets a fresh one-use handle for the same live call', async (t) => {
  const f = fixture(t);
  const first = await f.api.resolveCall('call@pbx');
  assert.equal(f.calls.get(first).sipCallId, 'call@pbx');
  assert.deepEqual(await f.api.attest(first), { evidenceToken: 'fixture' });
  await assert.rejects(f.api.attest(first), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
  const second = await f.api.resolveCall('call@pbx');
  assert.notEqual(first, second);
  await f.api.attest(second);
  assert.equal(f.state.attestations, 2); assert.equal(f.calls.leases.size, 0);
  await assert.rejects(f.api.attest('base'), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
});

test('the API refuses invented observations, extra fields and arbitrary routes', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.api.handle('/v1/attest', { armToken: 'base', approved: true }));
  await assert.rejects(f.api.handle('/v1/ari', {}), { code: 'PBX_ATTESTER_ROUTE_NOT_FOUND' });
  await assert.rejects(f.api.resolveCall('other@pbx'), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
  assert.equal(f.state.attestations, 0);
});

test('panic persists across API replacement and stops pending collection', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.api.panic(), { locked: true, quiesced: true });
  const restarted = createPbxAttesterApi({ ...f.options, controlStore: new PbxAttesterControlStore(f.db) });
  await assert.rejects(restarted.resolveCall('call@pbx'), { code: 'PBX_ATTESTER_LOCKED' });
  assert.equal(f.state.cancellations, 1);
});

test('parallel attestations are refused and failed requests release their handle', async (t) => {
  const f = fixture(t); let resume;
  f.state.pause = new Promise((resolve) => { resume = resolve; });
  const first = await f.api.resolveCall('call@pbx');
  const second = await f.api.resolveCall('call@pbx');
  const pending = f.api.attest(first);
  await assert.rejects(f.api.attest(second), { code: 'PBX_ATTESTER_BUSY' });
  resume(); await pending;
  assert.equal(f.calls.leases.has(first), false);
  f.options.attester.attest = async () => { throw new Error('failure'); };
  await assert.rejects(f.api.attest(second));
  assert.equal(f.calls.leases.size, 0);
});

test('ended calls and expired handles cannot be revived by a signed arm', async (t) => {
  const f = fixture(t);
  const handle = await f.api.resolveCall('call@pbx');
  f.calls.now = () => 1800000120001;
  assert.throws(() => f.calls.get(handle), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
  f.calls.calls.clear();
  await assert.rejects(f.api.resolveCall('call@pbx'), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
});
