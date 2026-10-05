'use strict';

const { exact } = require('./owner-session-catalog');
const { sessionError } = require('./owner-session-endpoint');
const { hash } = require('./owner-session-delivery');

// The ordinary voice bearer can request a canonical approval, never submit
// evidence, a capability, an endpoint, or a native session identifier.
function createOwnerPhoneApi({ broker, coordinator, assertUnlocked }) {
  return Object.freeze({
    async handle(action, body) {
      assertUnlocked(); coordinator.store.assertUnlocked();
      if (action === 'list') {
        exact(body, []);
        return { sessions: await broker.list(), scope: 'explicitly_enrolled_owner_sessions',
          inventoryProvesLiveness: false, tmuxPaneBinding: false };
      }
      if (action === 'inspect') {
        exact(body, ['id', 'history', ...(Object.hasOwn(body, 'selection') ? ['selection'] : [])]);
        const selection = require('./owner-session-history').validateSelection(body.selection);
        if (selection && body.history !== true) throw sessionError('OWNER_HISTORY_SELECTION_INVALID');
        if (typeof body.history !== 'boolean') throw sessionError('OWNER_PHONE_REQUEST_INVALID');
        const result = await broker.inspect(body.id, body.history, selection);
        return { id: result.id, label: result.label, provider: result.provider, status: result.status,
          ...(result.history ? { history: result.history } : {}), scope: 'exact_enrolled_native_session' };
      }
      if (action === 'request') {
        exact(body, ['id', 'operationId', 'message', 'sipCallId']);
        const { sipCallId, ...input } = body;
        return coordinator.request(input, { sipCallId });
      }
      if (action === 'reply') {
        exact(body, ['operationId']);
        if (typeof body.operationId !== 'string' || !/^job_[a-f0-9]{64}$/.test(body.operationId)) {
          throw sessionError('OWNER_PHONE_REQUEST_INVALID');
        }
        const row = coordinator.store.get(body.operationId);
        if (!row) throw sessionError('OWNER_PHONE_OPERATION_NOT_FOUND');
        return broker.reply({ id: row.catalog_id, request: JSON.parse(row.request_json) });
      }
      if (action === 'status') {
        exact(body, ['operationId']);
        if (typeof body.operationId !== 'string' || !/^job_[A-Za-z0-9]{1,128}$/.test(body.operationId)) {
          throw sessionError('OWNER_PHONE_REQUEST_INVALID');
        }
        return (await coordinator.reconcile(body.operationId)) || { operationId: body.operationId, state: 'not_found', completed: false };
      }
      if (action === 'cancel') {
        exact(body, ['operationId', 'sipCallId']);
        const row = coordinator.store.get(body.operationId);
        if (!row || row.sip_call_hash !== hash(body.sipCallId)) throw sessionError('OWNER_PHONE_CALL_CHANGED');
        return coordinator.cancel(body.operationId);
      }
      throw sessionError('OWNER_PHONE_ACTION_INVALID');
    },
  });
}

function installOwnerPhoneRoutes(app, getRuntime) {
  for (const action of ['list', 'inspect', 'request', 'status', 'reply', 'cancel']) {
    app.post(`/voice-control/owner/${action}`, async (req, res) => {
      try {
        const runtime = getRuntime();
        if (!runtime) throw sessionError('OWNER_PHONE_UNAVAILABLE');
        const result = await runtime.api.handle(action, req.body);
        res.json({ success: true, result });
      } catch (error) {
        res.status(409).json({ success: false,
          code: /^OWNER_[A-Z_]+$/.test(error.code || '') ? error.code : 'OWNER_PHONE_UNAVAILABLE' });
      }
    });
  }
}
module.exports = { createOwnerPhoneApi, installOwnerPhoneRoutes };
