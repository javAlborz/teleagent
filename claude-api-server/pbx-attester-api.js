'use strict';

const { exact } = require('./owner-session-catalog');
const { sessionError } = require('./owner-session-endpoint');

// Lives only in the isolated PBX attester. The controller receives no ARI
// credential, private attester key, raw event injection route or media path.
class PbxAttesterControlStore {
  constructor(db) {
    if (db.inTransaction || !['wal', 'memory'].includes(db.pragma('journal_mode', { simple: true })) ||
        db.pragma('synchronous', { simple: true }) !== 2) throw sessionError('PBX_ATTESTER_STORAGE_UNSAFE');
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS pbx_attester_control (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), locked INTEGER NOT NULL CHECK(locked IN (0,1))
    ) STRICT; INSERT OR IGNORE INTO pbx_attester_control VALUES(1,0);`);
  }
  isLocked() { return this.db.prepare('SELECT locked FROM pbx_attester_control WHERE singleton=1').get()?.locked !== 0; }
  lock() {
    if (this.db.inTransaction) throw sessionError('PBX_ATTESTER_STORAGE_UNSAFE');
    this.db.prepare('UPDATE pbx_attester_control SET locked=1 WHERE singleton=1').run();
  }
}

function createPbxAttesterApi({ calls, attester, armVerifier, adapter, router, assertBoundary, controlStore, epoch, assertReady }) {
  if (!controlStore || typeof controlStore.isLocked !== 'function' || typeof controlStore.lock !== 'function') {
    throw sessionError('PBX_ATTESTER_STORAGE_REQUIRED');
  }
  let busy = false;
  return Object.freeze({
    async health() {
      if (controlStore.isLocked() || typeof assertReady !== 'function') throw sessionError('PBX_ATTESTER_LOCKED');
      await assertBoundary(); assertReady();
      if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
      return { ready: true, epoch, protocol: 'independent-pbx-owner-v1' };
    },
    async resolveCall(sipCallId) {
      if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
      await assertBoundary();
      if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
      return calls.issueApprovalHandle(sipCallId);
    },
    async validateCall(sipCallId) {
      if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
      await assertBoundary();
      const handle = calls.handleForSipCall(sipCallId);
      await calls.assertCurrent(handle);
      if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
      // No approval lease, playback, DTMF or private call identity is returned.
      return { current: true };
    },
    async attest(armToken) {
      if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
      if (busy) throw sessionError('PBX_ATTESTER_BUSY');
      busy = true;
      let arm;
      try {
        arm = armVerifier.verify(armToken);
        // Only a per-approval handle returned by this independent API can arm.
        if (!calls.leases.has(arm.claims.pbx_call_handle)) throw sessionError('PBX_ARI_CALL_NOT_CURRENT');
        await assertBoundary();
        if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
        return await attester.attest(armToken);
      } finally {
        if (arm) calls.releaseApprovalHandle(arm.claims.pbx_call_handle);
        busy = false;
      }
    },
    async panic() {
      controlStore.lock(); adapter.cancel();
      try { return { locked: true, ...(await router.stop()) }; }
      catch { return { locked: true, quiesced: false }; }
    },
    async handle(route, body) {
      if (route === '/v1/health') { exact(body, []); return this.health(); }
      if (route === '/v1/call') {
        exact(body, ['sipCallId']); return this.resolveCall(body.sipCallId);
      }
      if (route === '/v1/validate-call') {
        exact(body, ['sipCallId']); return this.validateCall(body.sipCallId);
      }
      if (route === '/v1/attest') {
        exact(body, ['armToken']); return this.attest(body.armToken);
      }
      if (route === '/v1/panic') { exact(body, []); return this.panic(); }
      throw sessionError('PBX_ATTESTER_ROUTE_NOT_FOUND');
    },
  });
}
module.exports = { createPbxAttesterApi, PbxAttesterControlStore };
