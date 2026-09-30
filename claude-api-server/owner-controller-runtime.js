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

function createOwnerControllerRuntime({ db, assertUnlocked }) {
  if (!fs.existsSync(ENABLE)) return null;
  const authority = loadOwnerAuthority('controller');
  const enabled = protectedRead(ENABLE);
  if (enabled !== `${authority.epoch}\n`) throw sessionError('OWNER_AUTHORITY_ENABLE_INVALID');
  let closing = false;
  const assertAdmission = () => {
    if (closing || protectedRead(ENABLE) !== enabled) throw sessionError('OWNER_APPROVAL_LOCKED');
    assertUnlocked(); authority.assertCurrent(); assertOwnerHostHeadroom();
  };
  const broker = createOwnerSessionProxy();
  const coordinator = new OwnerApprovalCoordinator({ ...authority, store: new OwnerApprovalStore(db),
    broker, attester: createPbxAttesterProxy(), assertAdmission });
  const api = createOwnerPhoneApi({ broker, coordinator, assertUnlocked: assertAdmission });
  return { api, coordinator, async start() { authority.assertCurrent(); await coordinator.recover(); },
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
module.exports = { createOwnerControllerRuntime };
