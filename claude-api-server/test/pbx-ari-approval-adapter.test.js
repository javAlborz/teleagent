'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { PbxAriApprovalAdapter, PbxAriCallCatalog } = require('../pbx-ari-approval-adapter');
const { PbxAriClient, APP } = require('../pbx-ari-client');
const { hashText, validatePbxObservation } = require('../../lib/pbx-approval-protocol');

const NOW = 1800000000000;
function fixture() {
  let now = NOW + 1000;
  const ari = new EventEmitter();
  ari.epoch = 'fixture-epoch'; ari.ready = true;
  ari.assertEpoch = (epoch) => { if (!ari.ready || epoch !== ari.epoch) throw new Error('lost'); };
  const handset = { id: 'handset', name: 'PJSIP/1001-00000001', state: 'Up',
    creationtime: new Date(NOW).toISOString(), dialplan: { app_name: 'Stasis', context: 'from-linphone', exten: '7' } };
  const trunk = { id: 'trunk', name: 'PJSIP/assistant-openai-realtime-00000002', state: 'Up',
    dialplan: { app_name: 'Stasis' } };
  const bridge = { id: 'bridge', bridge_type: 'mixing', channels: ['handset', 'trunk'] };
  const state = { operations: [], released: 0, boundaryCalls: 0, wrongEndpoint: false, mode: 'rfc4733',
    driver: null, restoreFails: false, boundaryFails: false, detached: false, secure: '1' };
  ari.channel = async (id) => structuredClone(id === 'handset' ? handset : trunk);
  ari.bridge = async () => structuredClone(bridge);
  ari.variable = async (_id, variable) => ({ value: {
    'CHANNEL(pjsip,call-id)': 'fixture-call@pbx',
    'CHANNEL(rtp,secure,audio)': state.secure,
    'CHANNEL(endpoint)': state.wrongEndpoint ? 'claude-phone' : '1001', 'CHANNEL(linkedid)': 'linked',
    'PJSIP_ENDPOINT(1001,dtmf_mode)': state.mode, 'PJSIP_ENDPOINT(1001,direct_media)': 'false',
  }[variable] });
  ari.removeHandset = async () => { state.operations.push('detach'); state.detached = true; bridge.channels = ['trunk']; };
  ari.restoreHandset = async () => {
    state.operations.push('restore');
    if (state.restoreFails) throw new Error('restore failed');
    state.detached = false; bridge.channels = ['trunk', 'handset'];
  };
  ari.stopPlayback = async () => { state.operations.push('stop'); };
  const event = (type, fields, at) => {
    now = at;
    ari.emit('event', { type, application: APP, timestamp: new Date(at).toISOString(), ...fields }, ari.epoch);
  };
  ari.play = async (handsetId, id, audioHash) => {
    state.operations.push('play');
    assert.equal(state.detached, true);
    const playback = { id, target_uri: `channel:${handsetId}`, media_uri: `sound:teleagent-approval/${audioHash}` };
    if (state.driver) await state.driver({ event, playback, ari, state });
    else {
      event('PlaybackStarted', { playback: { ...playback, state: 'playing' } }, NOW + 1100);
      event('PlaybackFinished', { playback: { ...playback, state: 'done' } }, NOW + 2100);
      event('ChannelDtmfReceived', { channel: handset, digit: '#', duration_ms: 100 }, NOW + 2400);
    }
  };
  const calls = new PbxAriCallCatalog({ ari, pbxInstanceId: 'fixture-pbx' });
  const renderer = { async render(prompt) { return { promptSha256: hashText(prompt), audioSha256: 'a'.repeat(64), durationMs: 1000 }; },
    async release() { state.released++; } };
  const adapter = new PbxAriApprovalAdapter({ ari, calls, renderer, now: () => now,
    assertPbxBoundary: async () => { state.boundaryCalls++; if (state.boundaryFails) throw new Error('unsafe'); } });
  const request = { approvalId: 'approval-test', armSha256: 'b'.repeat(64), pbxCallHandle: null,
    prompt: 'Send the exact instruction to Fixture. Press pound to approve.', notBeforeMs: NOW, expiresAtMs: NOW + 10000 };
  request.promptSha256 = hashText(request.prompt);
  return { ari, calls, state, adapter, request, renderer, handset, bridge,
    async bind() { request.pbxCallHandle = await calls.bind({ handsetId: 'handset', trunkId: 'trunk', bridgeId: 'bridge', route: '7' }); } };
}

test('ARI approval isolates exact handset, completes exact audio and observes a fresh pound press', async () => {
  const f = fixture(); await f.bind();
  const evidence = await f.adapter.collectApproval(f.request);
  assert.equal(evidence.call_leg.handset_uniqueid, 'handset');
  assert.equal(evidence.call_leg.trunk_uniqueid, 'trunk');
  assert.deepEqual(f.state.operations, ['detach', 'play', 'restore']);
  assert.equal(f.state.released, 1); assert.equal(f.state.boundaryCalls, 3);
  assert.doesNotThrow(() => validatePbxObservation(evidence, { pbx_call_handle: f.request.pbxCallHandle,
    prompt_sha256: f.request.promptSha256, nbf: NOW / 1000, exp: NOW / 1000 + 10 }, { now: () => NOW + 3000 }));
});

test('call binding rejects trunk endpoint impersonation, in-band DTMF and a wrong bridge', async () => {
  for (const alter of [(f) => { f.state.wrongEndpoint = true; },
    (f) => { f.state.mode = 'auto'; }, (f) => { f.bridge.channels.push('other'); },
    (f) => { f.handset.dialplan.context = 'from-claude-phone'; }]) {
    const f = fixture(); alter(f);
    await assert.rejects(f.bind(), { code: 'PBX_ARI_CALL_IDENTITY_INVALID' });
    assert.equal(f.state.operations.length, 0);
  }
});

test('unknown or stale call handles never render or play an approval', async () => {
  const f = fixture(); await f.bind();
  const old = f.request.pbxCallHandle;
  f.request.pbxCallHandle = crypto.randomBytes(32).toString('base64url');
  await assert.rejects(f.adapter.collectApproval(f.request), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
  f.request.pbxCallHandle = old;
  f.ari.emit('disconnect');
  await assert.rejects(f.adapter.collectApproval(f.request), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
  assert.equal(f.state.operations.length, 0);
});

test('unencrypted or downgraded handset media cannot approve even with exact channel events', async () => {
  const f = fixture(); await f.bind(); f.state.secure = '0';
  await assert.rejects(f.adapter.collectApproval(f.request), { code: 'PBX_ARI_HANDSET_MEDIA_UNAUTHENTICATED' });
  assert.equal(f.state.operations.length, 0);
  const second = fixture(); await second.bind();
  second.state.driver = ({ event, playback }) => {
    event('PlaybackStarted', { playback: { ...playback, state: 'playing' } }, NOW + 1100);
    event('PlaybackFinished', { playback: { ...playback, state: 'done' } }, NOW + 2100);
    second.state.secure = '0';
    event('ChannelDtmfReceived', { channel: second.handset, digit: '#', duration_ms: 100 }, NOW + 2400);
  };
  await assert.rejects(second.adapter.collectApproval(second.request), { code: 'PBX_ARI_HANDSET_MEDIA_UNAUTHENTICATED' });
  assert.equal(second.state.released, 1);
});

test('prompt substitution and missing independent PBX boundary fail before media changes', async () => {
  const f = fixture(); await f.bind();
  f.request.prompt += ' changed';
  await assert.rejects(f.adapter.collectApproval(f.request), { code: 'PBX_ARI_PROMPT_CHANGED' });
  assert.equal(f.state.operations.length, 0);
  assert.throws(() => new PbxAriApprovalAdapter({ ari: f.ari, calls: f.calls, renderer: f.renderer }),
    { code: 'PBX_ARI_BOUNDARY_REQUIRED' });
});

test('early or held pound and any refusal digit cannot approve', async () => {
  for (const mode of ['early', 'held', 'star']) {
    const f = fixture(); await f.bind();
    f.state.driver = ({ event, playback }) => {
      event('PlaybackStarted', { playback: { ...playback, state: 'playing' } }, NOW + 1100);
      if (mode !== 'early') event('PlaybackFinished', { playback: { ...playback, state: 'done' } }, NOW + 2100);
      event('ChannelDtmfReceived', { channel: f.handset, digit: mode === 'star' ? '*' : '#',
        duration_ms: mode === 'held' ? 1000 : 100 }, NOW + 2400);
    };
    await assert.rejects(f.adapter.collectApproval(f.request), { code: 'PBX_ARI_DTMF_REFUSED' });
    assert.equal(f.state.released, 1); assert.equal(f.state.detached, false);
  }
});

test('trunk digit cannot approve, even after handset playback; disconnect discards the arm', async () => {
  const f = fixture(); await f.bind();
  f.state.driver = ({ event, playback }) => {
    event('PlaybackStarted', { playback: { ...playback, state: 'playing' } }, NOW + 1100);
    event('PlaybackFinished', { playback: { ...playback, state: 'done' } }, NOW + 2100);
    event('ChannelDtmfReceived', { channel: { id: 'trunk' }, digit: '#', duration_ms: 100 }, NOW + 2400);
    f.ari.emit('disconnect');
  };
  await assert.rejects(f.adapter.collectApproval(f.request));
  assert.equal(f.state.released, 1);
});

test('wrong, short or failed playback cannot produce evidence', async () => {
  for (const mode of ['wrong-target', 'wrong-media', 'short', 'failed', 'no-start']) {
    const f = fixture(); await f.bind();
    f.state.driver = ({ event, playback }) => {
      if (mode !== 'no-start') event('PlaybackStarted', { playback: { ...playback, state: 'playing' } }, NOW + 1100);
      const changed = { ...playback, state: mode === 'failed' ? 'failed' : 'done' };
      if (mode === 'wrong-target') changed.target_uri = 'channel:trunk';
      if (mode === 'wrong-media') changed.media_uri = 'sound:other';
      event('PlaybackFinished', { playback: changed }, NOW + (mode === 'short' ? 1500 : 2100));
    };
    await assert.rejects(f.adapter.collectApproval(f.request));
    assert.equal(f.state.released, 1);
  }
});

test('transfer, changed channels and restore failure invalidate otherwise positive evidence', async () => {
  for (const mode of ['transfer', 'changed', 'restore']) {
    const f = fixture(); await f.bind();
    if (mode === 'restore') f.state.restoreFails = true;
    else f.state.driver = ({ event, playback }) => {
      event('PlaybackStarted', { playback: { ...playback, state: 'playing' } }, NOW + 1100);
      event('PlaybackFinished', { playback: { ...playback, state: 'done' } }, NOW + 2100);
      if (mode === 'transfer') event('BridgeBlindTransfer', {}, NOW + 2200);
      else f.handset.name = 'PJSIP/1001-00000009';
      event('ChannelDtmfReceived', { channel: f.handset, digit: '#', duration_ms: 100 }, NOW + 2400);
    };
    await assert.rejects(f.adapter.collectApproval(f.request));
    assert.equal(f.state.released, 1);
  }
});

test('ARI client cannot select arbitrary variables or media URLs', () => {
  const client = new PbxAriClient({ username: 'teleagent-attester', password: 'x'.repeat(40) });
  assert.throws(() => client.variable('handset', 'SHELL(evil)'), { code: 'PBX_ARI_VARIABLE_DENIED' });
  assert.throws(() => client.play('handset', 'test', 'https://evil'), { code: 'PBX_ARI_MEDIA_DENIED' });
  assert.throws(() => client.channel('../other'), { code: 'PBX_ARI_IDENTIFIER_INVALID' });
});

test('rendered media is released when approval expires during rendering', async () => {
  const f = fixture(); await f.bind();
  const render = f.renderer.render;
  f.renderer.render = async (prompt) => {
    const result = await render(prompt);
    f.request.expiresAtMs = NOW + 500;
    return result;
  };
  await assert.rejects(f.adapter.collectApproval(f.request), { code: 'PBX_ARI_APPROVAL_EXPIRED' });
  assert.equal(f.state.released, 1); assert.equal(f.state.operations.length, 0);
});

test('ARI evidence passes all three independent signature roles without voice authority', async () => {
  const { createPbxArmIssuer, createPbxArmVerifier, createPbxEvidenceIssuer, keyFingerprint } =
    require('../../lib/pbx-approval-protocol');
  const { createPbxApprovalAttester } = require('../../lib/pbx-approval-attester');
  const { MemoryPbxApprovalAttesterStore } = require('../../lib/pbx-approval-attester-store');
  const { createTelecap2ControllerAuthority, createTelecap2Verifier, PBX_EVIDENCE_METHOD } =
    require('../../lib/telecap2-execution-capability');
  const f = fixture(); await f.bind();
  const armKeys = crypto.generateKeyPairSync('ed25519');
  const pbxKeys = crypto.generateKeyPairSync('ed25519');
  const executionKeys = crypto.generateKeyPairSync('ed25519');
  const armPublic = { arm: armKeys.publicKey }; const pbxPublic = { pbx: pbxKeys.publicKey };
  const now = () => NOW + 3000;
  const armInput = { approvalId: 'approval-full-chain', jobId: 'job_chain', operation: 'owner-session-message',
    requestHash: 'd'.repeat(64), planHash: 'e'.repeat(64), target: 'owner-codex:fixture',
    provider: 'codex', profile: 'owner-codex-session', prompt: f.request.prompt, pbxCallHandle: f.request.pbxCallHandle };
  const armToken = createPbxArmIssuer({ privateKey: armKeys.privateKey, keyId: 'arm',
    now: () => NOW, ttlSeconds: 10 }).issue(armInput);
  const attester = createPbxApprovalAttester({
    armVerifier: createPbxArmVerifier({ publicKeys: armPublic, now }),
    evidenceIssuer: createPbxEvidenceIssuer({ privateKey: pbxKeys.privateKey, keyId: 'pbx', controllerArmPublicKeys: armPublic, now }),
    adapter: f.adapter, store: new MemoryPbxApprovalAttesterStore(), now,
  });
  const evidence = await attester.attest(armToken);
  let replayed = false;
  const authority = createTelecap2ControllerAuthority({ executionPrivateKey: executionKeys.privateKey,
    executionKeyId: 'execution', controllerArmPublicKeys: armPublic, pbxAttesterPublicKeys: pbxPublic, now,
    pbxEvidenceReplayStore: { consume() { if (replayed) return false; replayed = true; return true; } } });
  const receipt = authority.consumePbxEvidence(evidence.evidenceToken, { armToken });
  const token = authority.issue({ consumedPbxEvidence: receipt });
  const verifier = createTelecap2Verifier({ publicKeys: { execution: executionKeys.publicKey }, now, consumeReplay: () => true });
  const authorized = verifier.authorize(token, { controllerKeyId: 'execution', approvalId: armInput.approvalId,
    evidenceSha256: evidence.evidenceSha256, controllerArmKeyId: 'arm', controllerArmKeyFingerprint: keyFingerprint(armKeys.publicKey),
    pbxAttesterKeyId: 'pbx', pbxAttesterKeyFingerprint: keyFingerprint(pbxKeys.publicKey),
    evidenceMethod: PBX_EVIDENCE_METHOD, jobId: armInput.jobId, operation: armInput.operation,
    requestHash: armInput.requestHash, planHash: armInput.planHash, target: armInput.target,
    provider: armInput.provider, profile: armInput.profile });
  assert.equal(authorized.authorized, true);
  await assert.rejects(attester.attest(armToken));
});

test('PBX handle lookup uses exact native trunk SIP Call-ID', async () => {
  const f = fixture(); await f.bind();
  assert.equal(f.calls.handleForSipCall('fixture-call@pbx'), f.request.pbxCallHandle);
  assert.throws(() => f.calls.handleForSipCall('other-call@pbx'), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
  f.ari.emit('event', { type: 'StasisEnd', channel: { id: 'handset' } });
  assert.throws(() => f.calls.handleForSipCall('fixture-call@pbx'), { code: 'PBX_ARI_CALL_NOT_CURRENT' });
});

test('no production service imports the source ARI approval path', () => {
  const fs = require('node:fs'); const path = require('node:path');
  for (const filename of ['server.js', 'worker-session-broker-service.js', 'owner-session-broker-service.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), /require\([^)]*pbx-(?:ari|prompt)/);
  }
});

test('star during rendering cancels the pending approval before any media switch', async () => {
  const f = fixture(); await f.bind();
  const render = f.renderer.render;
  f.renderer.render = async (prompt) => { f.adapter.cancel(); return render(prompt); };
  await assert.rejects(f.adapter.collectApproval(f.request), { code: 'PBX_ARI_APPROVAL_CANCELLED' });
  assert.equal(f.state.released, 1); assert.deepEqual(f.state.operations, []);
});
