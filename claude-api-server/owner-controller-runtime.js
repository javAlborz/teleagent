'use strict';

const fs = require('node:fs');
const { protectedRead, loadOwnerAuthority } = require('./owner-authority-config');
const { createOwnerSessionProxy } = require('./owner-session-proxy');
const { createPbxAttesterProxy } = require('./pbx-attester-http');
const { OwnerApprovalStore, OwnerApprovalCoordinator } = require('./owner-approval-coordinator');
const { createOwnerPhoneApi } = require('./owner-phone-api');
const { assertOwnerHostHeadroom } = require('./owner-session-admission');
const { sessionError } = require('./owner-session-endpoint');
const ENABLE = '/etc/teleagent/controller/OWNER_SESSION_ENABLE';

// Cached readiness never contacts native agents. One bounded probe at a time;
// a failed, stale or mismatched response withdraws the phone capability.
class OwnerPlaneReadiness {
  constructor({ broker, attester, epoch, now = () => performance.now() }) {
    this.broker = broker; this.attester = attester; this.epoch = epoch; this.now = now;
    this.checkedAt = -Infinity; this.attemptedAt = -Infinity; this.ready = false; this.pending = null;
  }
  available() { return this.ready && this.now() - this.checkedAt < 30000; }
  refresh() {
    if (this.pending) return this.pending;
    if (this.now() - this.attemptedAt < 5000) return Promise.resolve(this.available());
    this.attemptedAt = this.now();
    const started = this.attemptedAt;
    this.pending = (async () => {
      try {
        for (const plane of [this.broker, this.attester]) {
          const status = await plane.health();
          if (status?.ready !== true || status.epoch !== this.epoch ||
              status.protocol !== 'independent-pbx-owner-v1') throw sessionError('OWNER_PLANE_UNAVAILABLE');
        }
        this.checkedAt = started; this.ready = true;
      } catch { this.ready = false; }
      finally { this.pending = null; }
      return this.available();
    })();
    return this.pending;
  }
}

function createOwnerControllerRuntime({ db, assertUnlocked }) {
  if (!fs.existsSync(ENABLE)) return null;
  const authority = loadOwnerAuthority('controller');
  const enabled = protectedRead(ENABLE);
  if (enabled !== `${authority.epoch}\n`) throw sessionError('OWNER_AUTHORITY_ENABLE_INVALID');
  let closing = false;
  const assertConfiguration = () => {
    if (closing || protectedRead(ENABLE) !== enabled) throw sessionError('OWNER_APPROVAL_LOCKED');
    authority.assertCurrent(); assertOwnerHostHeadroom();
  };
  const broker = createOwnerSessionProxy();
  const attester = createPbxAttesterProxy();
  const readiness = new OwnerPlaneReadiness({ broker, attester, epoch: authority.epoch });
  const assertAdmission = () => {
    assertConfiguration(); assertUnlocked();
    if (!readiness.available()) throw sessionError('OWNER_PLANE_UNAVAILABLE');
  };
  const coordinator = new OwnerApprovalCoordinator({ ...authority, store: new OwnerApprovalStore(db),
    broker, attester, assertAdmission });
  const api = createOwnerPhoneApi({ broker, coordinator, assertUnlocked: assertAdmission });
  return { api, coordinator, async start() {
      authority.assertCurrent(); await readiness.refresh(); await coordinator.recover();
    },
    refreshHealth: () => readiness.refresh(),
    // Local operator recovery checks the owner locks separately from the global
    // phone lock it is about to clear. A global panic is not its own unlock gate.
    recoveryReady() {
      try { assertConfiguration(); coordinator.store.assertUnlocked(); return readiness.available(); }
      catch { return false; }
    },
    health() {
      try { assertAdmission(); coordinator.store.assertUnlocked(); return { configured: true, available: true,
        protocol: 'independent-pbx-owner-v1' }; }
      catch { return { configured: true, available: false, protocol: 'independent-pbx-owner-v1' }; }
    },
    async close() {
      closing = true;
      // Pending arms cannot send after shutdown starts; dispatching work remains
      // recoverable through the broker receipt. Do not panic unrelated agents.
      for (const id of coordinator.active.keys()) coordinator.cancel(id);
      await Promise.allSettled([...coordinator.active.values()]);
    },
  };
}
module.exports = { createOwnerControllerRuntime, OwnerPlaneReadiness };
