'use strict';

const crypto = require('node:crypto');
const { APP, identifier } = require('./pbx-ari-client');
const { sessionError } = require('./owner-session-endpoint');

// Only the two fixed conductor routes. There is no arbitrary dialing, endpoint,
// channel variable, transfer or command API. Dial 9 remains independent.
class PbxAriCallRouter {
  constructor({ ari, calls, approvalAdapter, assertPbxBoundary }) {
    this.ari = ari; this.calls = calls; this.approvalAdapter = approvalAdapter;
    this.assertPbxBoundary = assertPbxBoundary; this.current = null; this.locked = false;
    this.pending = new Set();
    this.onEvent = (event, epoch) => {
      const work = this.event(event, epoch).catch(async () => {
        this.locked = true; await this.stop().catch(() => {});
      });
      this.pending.add(work); void work.finally(() => this.pending.delete(work));
    };
    this.onDisconnect = () => {
      this.locked = true;
      // No automatic reconnect, adoption, originate retry, or call resumption.
      // The host recovery path must prove these channels are gone before unlock.
      if (this.current) clearTimeout(this.current.timer);
    };
    ari.on('event', this.onEvent); ari.on('disconnect', this.onDisconnect);
  }
  async event(event, epoch) {
    if (event.application !== APP) throw sessionError('PBX_ROUTER_EVENT_INVALID');
    this.ari.assertEpoch(epoch);
    if (event.type === 'StasisStart') {
      const id = event.channel?.id; identifier(id);
      if (event.args?.[0] === 'owner') {
        if (this.locked || this.current || event.args.length !== 2 || !['7', '77'].includes(event.args[1])) {
          await this.ari.hangup(id); return;
        }
        // Reserve admission before the first await so two callers cannot race.
        const call = this.current = { ownerId: id, trunkId: `ta-trunk-${crypto.randomUUID()}`,
          bridgeId: `ta-bridge-${crypto.randomUUID()}`, route: event.args[1], epoch,
          phase: 'preflight', handle: null, timer: null, stopping: null };
        await this.assertPbxBoundary();
        const owner = await this.ari.channel(id);
        const endpoint = await this.ari.variable(id, 'CHANNEL(endpoint)');
        if (endpoint.value !== '1001' || owner.dialplan?.context !== 'from-linphone' ||
            owner.dialplan?.exten !== call.route || owner.dialplan?.app_name !== 'Stasis' ||
            !/^PJSIP\/1001-[a-f0-9]+$/i.test(owner.name)) throw sessionError('PBX_ROUTER_OWNER_INVALID');
        this.assertCurrent(call);
        await this.ari.createBridge(call.bridgeId); this.assertCurrent(call);
        call.phase = 'dialing';
        call.timer = setTimeout(() => { void this.stop().catch(() => { this.locked = true; }); }, 35000);
        // A lost originate response is ambiguous. Never retry.
        await this.ari.originateTrunk({ id: call.trunkId, ownerId: id, route: call.route });
        return;
      }
      const call = this.current;
      if (!call || call.phase !== 'dialing' || id !== call.trunkId ||
          event.args.length !== 2 || event.args[0] !== 'trunk' || event.args[1] !== call.ownerId) {
        await this.ari.hangup(id); return;
      }
      call.phase = 'bridging'; clearTimeout(call.timer);
      await this.ari.answer(call.ownerId); this.assertCurrent(call);
      await this.ari.restoreHandset(call.bridgeId, call.trunkId); this.assertCurrent(call);
      await this.ari.restoreHandset(call.bridgeId, call.ownerId); this.assertCurrent(call);
      call.handle = await this.calls.bind({ handsetId: call.ownerId, trunkId: call.trunkId,
        bridgeId: call.bridgeId, route: call.route });
      this.assertCurrent(call); call.phase = 'connected'; return;
    }
    const call = this.current;
    if (!call) return;
    if (['StasisEnd', 'ChannelDestroyed', 'ChannelHangupRequest'].includes(event.type) &&
        [call.ownerId, call.trunkId].includes(event.channel?.id)) { await this.stop(); return; }
    if (event.type.includes('Transfer') || (event.type === 'BridgeDestroyed' && event.bridge?.id === call.bridgeId)) {
      this.locked = true; await this.stop(); return;
    }
    if (event.type === 'ChannelDtmfReceived' && event.channel?.id === call.ownerId && event.digit === '*' &&
        call.phase === 'connected') {
      if (this.approvalAdapter.busy) this.approvalAdapter.cancel();
      else await this.ari.forwardStar(call.trunkId);
    }
  }
  assertCurrent(call) {
    this.ari.assertEpoch(call.epoch);
    if (this.locked || this.current !== call || call.phase === 'stopping') {
      throw sessionError('PBX_ROUTER_CALL_CHANGED');
    }
  }
  async stop() {
    const call = this.current;
    if (!call) return { quiesced: true };
    if (call.stopping) return call.stopping;
    call.phase = 'stopping'; clearTimeout(call.timer);
    if (call.handle) this.calls.calls.delete(call.handle);
    call.stopping = (async () => {
      // Both exact legs are attempted even if one has already disappeared.
      // Any uncertain deletion keeps the router locked until operator recovery.
      let uncertain = false;
      for (const id of [call.ownerId, call.trunkId]) {
        try { await this.ari.hangup(id); } catch { uncertain = true; }
      }
      try { await this.ari.destroyBridge(call.bridgeId); } catch { uncertain = true; }
      if (uncertain) { this.locked = true; throw sessionError('PBX_ROUTER_STOP_UNCONFIRMED'); }
      if (this.current === call) this.current = null;
      return { quiesced: true };
    })();
    return call.stopping;
  }
  async close() {
    this.locked = true;
    this.ari.removeListener('event', this.onEvent); this.ari.removeListener('disconnect', this.onDisconnect);
    await Promise.allSettled([...this.pending]);
    return this.stop();
  }
}
module.exports = { PbxAriCallRouter };
