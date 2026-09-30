'use strict';

const crypto = require('node:crypto');
const { hashText, DTMF_SOURCE, validateCallLeg } = require('../lib/pbx-approval-protocol');
const { sessionError } = require('./owner-session-endpoint');
const { APP, identifier } = require('./pbx-ari-client');

function timestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw sessionError('PBX_ARI_EVENT_INVALID');
  return parsed;
}

// The call router, not voice or SIP headers, enrolls channels it has placed in
// its own Stasis bridge. It must revoke the binding on StasisEnd/transfer.
class PbxAriCallCatalog {
  constructor({ ari, pbxInstanceId }) {
    identifier(pbxInstanceId);
    this.ari = ari; this.pbxInstanceId = pbxInstanceId; this.calls = new Map(); this.binding = false;
    ari.on('disconnect', () => this.calls.clear());
    ari.on('event', (event) => {
      if (['StasisEnd', 'ChannelDestroyed', 'ChannelHangupRequest', 'BridgeDestroyed',
        'BridgeAttendedTransfer', 'BridgeBlindTransfer'].includes(event.type)) {
        for (const [handle, call] of this.calls) {
          if (event.channel?.id === call.leg.handset_uniqueid || event.channel?.id === call.leg.trunk_uniqueid ||
              event.bridge?.id === call.leg.bridge_id || event.type.includes('Transfer')) this.calls.delete(handle);
        }
      }
    });
  }
  async bind(input) {
    if (this.binding) throw sessionError('PBX_ARI_CALL_ADMISSION_REFUSED');
    this.binding = true;
    try { return await this._bind(input); } finally { this.binding = false; }
  }
  async _bind({ handsetId, trunkId, bridgeId, route }) {
    if (this.calls.size || !['7', '77'].includes(route)) throw sessionError('PBX_ARI_CALL_ADMISSION_REFUSED');
    const epoch = this.ari.epoch; this.ari.assertEpoch(epoch);
    const handset = await this.ari.channel(handsetId);
    const trunk = await this.ari.channel(trunkId);
    const bridge = await this.ari.bridge(bridgeId);
    const endpoint = await this.ari.variable(handsetId, 'CHANNEL(endpoint)');
    const linked = await this.ari.variable(handsetId, 'CHANNEL(linkedid)');
    const mode = await this.ari.variable(handsetId, 'PJSIP_ENDPOINT(1001,dtmf_mode)');
    const direct = await this.ari.variable(handsetId, 'PJSIP_ENDPOINT(1001,direct_media)');
    const sipCall = await this.ari.variable(trunkId, 'CHANNEL(pjsip,call-id)');
    this.ari.assertEpoch(epoch);
    if (typeof sipCall?.value !== 'string' || !/^[A-Za-z0-9_.@:+-]{1,256}$/.test(sipCall.value) ||
        endpoint?.value !== '1001' || mode?.value !== 'rfc4733' || direct?.value !== 'false' ||
        handset?.id !== handsetId || !/^PJSIP\/1001-[a-f0-9]+$/i.test(handset.name) ||
        handset.state !== 'Up' || handset.dialplan?.app_name !== 'Stasis' ||
        handset.dialplan?.context !== 'from-linphone' || handset.dialplan?.exten !== route ||
        trunk?.id !== trunkId || trunk.state !== 'Up' || trunk.dialplan?.app_name !== 'Stasis' ||
        !/^PJSIP\/assistant-openai-realtime(?:-resume)?-[a-f0-9]+$/i.test(trunk.name) ||
        bridge?.id !== bridgeId || bridge.bridge_type !== 'mixing' ||
        !Array.isArray(bridge.channels) || bridge.channels.length !== 2 ||
        !bridge.channels.includes(handsetId) || !bridge.channels.includes(trunkId)) {
      throw sessionError('PBX_ARI_CALL_IDENTITY_INVALID');
    }
    const handle = crypto.randomBytes(32).toString('base64url');
    const leg = validateCallLeg({ pbx_instance_id: this.pbxInstanceId, linkedid: linked.value,
      handset_uniqueid: handsetId, handset_endpoint: 'PJSIP/1001', channel_birth_ms: timestamp(handset.creationtime),
      trunk_uniqueid: trunkId, bridge_id: bridgeId, dialed_route: route });
    this.calls.set(handle, { epoch, leg, handsetName: handset.name, trunkName: trunk.name, sipCallId: sipCall.value });
    return handle;
  }
  handleForSipCall(sipCallId) {
    for (const [handle, call] of this.calls) {
      if (call.sipCallId === sipCallId) { this.get(handle); return handle; }
    }
    throw sessionError('PBX_ARI_CALL_NOT_CURRENT');
  }
  get(handle) {
    const call = this.calls.get(handle);
    if (!call) throw sessionError('PBX_ARI_CALL_NOT_CURRENT');
    this.ari.assertEpoch(call.epoch);
    return structuredClone(call);
  }
  async assertCurrent(handle, { detached = false } = {}) {
    const call = this.get(handle);
    const handset = await this.ari.channel(call.leg.handset_uniqueid);
    const trunk = await this.ari.channel(call.leg.trunk_uniqueid);
    const bridge = await this.ari.bridge(call.leg.bridge_id);
    this.get(handle);
    if (handset.id !== call.leg.handset_uniqueid || handset.name !== call.handsetName ||
        timestamp(handset.creationtime) !== call.leg.channel_birth_ms || handset.state !== 'Up' ||
        handset.dialplan?.app_name !== 'Stasis' || trunk.id !== call.leg.trunk_uniqueid ||
        trunk.name !== call.trunkName || trunk.state !== 'Up' || trunk.dialplan?.app_name !== 'Stasis' ||
        bridge.id !== call.leg.bridge_id || bridge.bridge_type !== 'mixing' ||
        !Array.isArray(bridge.channels) || bridge.channels.length !== (detached ? 1 : 2) ||
        !bridge.channels.includes(call.leg.trunk_uniqueid) ||
        bridge.channels.includes(call.leg.handset_uniqueid) === detached) {
      this.calls.delete(handle); throw sessionError('PBX_ARI_CALL_IDENTITY_CHANGED');
    }
    return call;
  }
}

// A real ARI event adapter; it is not sufficient by itself for promotion. The
// installed PBX must disable INFO/in-band DTMF sources and other control clients.
// ARI ChannelDtmfReceived alone does not identify the transport of the digit.
class PbxAriApprovalAdapter {
  constructor({ ari, calls, renderer, assertPbxBoundary, now = Date.now }) {
    if (typeof assertPbxBoundary !== 'function') throw sessionError('PBX_ARI_BOUNDARY_REQUIRED');
    this.ari = ari; this.calls = calls; this.renderer = renderer;
    this.assertPbxBoundary = assertPbxBoundary; this.now = now; this.busy = false;
    this.generation = 0; this.rejectActive = null;
  }
  cancel() {
    this.generation++;
    this.rejectActive?.('PBX_ARI_APPROVAL_CANCELLED');
  }
  async collectApproval(request) {
    if (this.busy) throw sessionError('PBX_ARI_APPROVAL_BUSY');
    this.busy = true;
    try { return await this._collect(request); } finally { this.busy = false; }
  }
  async _collect(request) {
    const generation = this.generation;
    const window = () => {
      if (this.generation !== generation) throw sessionError('PBX_ARI_APPROVAL_CANCELLED');
      if (!Number.isSafeInteger(request.notBeforeMs) || !Number.isSafeInteger(request.expiresAtMs) ||
          request.expiresAtMs - request.notBeforeMs > 300000 || this.now() < request.notBeforeMs ||
          this.now() >= request.expiresAtMs) throw sessionError('PBX_ARI_APPROVAL_EXPIRED');
    };
    window();
    if (hashText(request.prompt) !== request.promptSha256) throw sessionError('PBX_ARI_PROMPT_CHANGED');
    await this.assertPbxBoundary();
    const call = await this.calls.assertCurrent(request.pbxCallHandle);
    const artifact = await this.renderer.render(request.prompt);
    try {
      window();
      if (artifact.promptSha256 !== request.promptSha256 || !/^[a-f0-9]{64}$/.test(artifact.audioSha256) ||
          !Number.isSafeInteger(artifact.durationMs) || artifact.durationMs < 1 || artifact.durationMs > 90000) {
        throw sessionError('PBX_ARI_AUDIO_INVALID');
      }
    } catch (error) { await this.renderer.release(artifact); throw error; }
    const playbackId = `ta-${crypto.randomUUID()}`;
    const mediaUri = `sound:teleagent-approval/${artifact.audioSha256}`;
    let started = null; let completed = null; let settled = false; let detached = false;
    let detachAttempted = false; let playAttempted = false;
    let resolveEvidence; let rejectEvidence;
    const evidence = new Promise((resolve, reject) => { resolveEvidence = resolve; rejectEvidence = reject; });
    // Attach a rejection handler before asynchronous detach/play work can fail.
    evidence.catch(() => {});
    const fail = (code) => {
      if (settled) return;
      settled = true; rejectEvidence(sessionError(code));
    };
    const assertLive = () => {
      window(); this.calls.get(request.pbxCallHandle);
      if (settled) throw sessionError('PBX_ARI_APPROVAL_ABORTED');
    };
    const onDisconnect = () => fail('PBX_ARI_CONNECTION_CHANGED');
    const onEvent = (event, epoch) => {
      if (settled) return;
      try {
        assertLive();
        if (epoch !== call.epoch || event.application !== APP) throw sessionError('PBX_ARI_CONNECTION_CHANGED');
        if (['StasisEnd', 'ChannelDestroyed', 'ChannelHangupRequest', 'BridgeDestroyed',
          'BridgeAttendedTransfer', 'BridgeBlindTransfer'].includes(event.type)) {
          this.calls.get(request.pbxCallHandle); return;
        }
        if (event.type === 'ChannelEnteredBridge' && event.channel?.id === call.leg.handset_uniqueid) {
          throw sessionError('PBX_ARI_PROMPT_NOT_ISOLATED');
        }
        if (['PlaybackStarted', 'PlaybackFinished'].includes(event.type) && event.playback?.id === playbackId) {
          const playback = event.playback;
          const at = timestamp(event.timestamp);
          if (!playAttempted || !detached || playback.target_uri !== `channel:${call.leg.handset_uniqueid}` ||
              playback.media_uri !== mediaUri || at < request.notBeforeMs || at > this.now() ||
              at >= request.expiresAtMs) throw sessionError('PBX_ARI_PLAYBACK_INVALID');
          if (event.type === 'PlaybackStarted') {
            if (started !== null || playback.state !== 'playing') throw sessionError('PBX_ARI_PLAYBACK_INVALID');
            started = at;
          } else {
            if (started === null || completed !== null || playback.state !== 'done' ||
                at - started < artifact.durationMs) throw sessionError('PBX_ARI_PLAYBACK_INCOMPLETE');
            completed = at;
          }
        } else if (event.type === 'ChannelDtmfReceived' && event.channel?.id === call.leg.handset_uniqueid) {
          const at = timestamp(event.timestamp);
          if (event.digit !== '#' || !Number.isSafeInteger(event.duration_ms) || event.duration_ms < 40 ||
              event.duration_ms > 5000 || completed === null || at - event.duration_ms <= completed ||
              at >= request.expiresAtMs || at > this.now()) throw sessionError('PBX_ARI_DTMF_REFUSED');
          settled = true;
          resolveEvidence({ pbx_call_handle: request.pbxCallHandle, call_leg: call.leg,
            prompt_sha256: request.promptSha256, prompt_audio_sha256: artifact.audioSha256,
            playback_id: playbackId, playback_started_at_ms: started, playback_completed_at_ms: completed,
            digit: '#', dtmf_source: DTMF_SOURCE,
            dtmf_event_id: `ta-${crypto.randomUUID()}`, dtmf_received_at_ms: at });
        }
      } catch (error) { fail(error.code || 'PBX_ARI_EVENT_INVALID'); }
    };
    this.rejectActive = fail;
    this.ari.on('event', onEvent); this.ari.on('disconnect', onDisconnect);
    const timer = setTimeout(() => fail('PBX_ARI_APPROVAL_EXPIRED'), Math.max(1, request.expiresAtMs - this.now()));
    try {
      assertLive(); await this.assertPbxBoundary(); assertLive();
      detachAttempted = true;
      await this.ari.removeHandset(call.leg.bridge_id, call.leg.handset_uniqueid);
      assertLive(); await this.calls.assertCurrent(request.pbxCallHandle, { detached: true });
      assertLive(); detached = true; playAttempted = true;
      await this.ari.play(call.leg.handset_uniqueid, playbackId, artifact.audioSha256);
      const observation = await evidence;
      window(); await this.assertPbxBoundary();
      await this.calls.assertCurrent(request.pbxCallHandle, { detached: true }); window();
      return observation;
    } finally {
      this.rejectActive = null;
      clearTimeout(timer); this.ari.removeListener('event', onEvent); this.ari.removeListener('disconnect', onDisconnect);
      // Uncertain detach/play is never repeated. Failure to restore the exact
      // still-live bridge invalidates even an otherwise positive observation.
      if (playAttempted && completed === null) {
        try { await this.ari.stopPlayback(playbackId); } catch { /* Cleanup remains uncertain. */ }
      }
      try {
        if (detachAttempted) {
          await this.calls.assertCurrent(request.pbxCallHandle, { detached: true });
          await this.ari.restoreHandset(call.leg.bridge_id, call.leg.handset_uniqueid);
          await this.calls.assertCurrent(request.pbxCallHandle);
        }
      } finally { await this.renderer.release(artifact); }
      if (this.generation !== generation) throw sessionError('PBX_ARI_APPROVAL_CANCELLED');
    }
  }
}
module.exports = { PbxAriApprovalAdapter, PbxAriCallCatalog, timestamp };
