'use strict';

const { OwnerCodexClient } = require('./owner-codex-client');
const { OwnerClaudeClient } = require('./owner-claude-client');
const { inspectOwnerSession, requestPlan, deliverOwnerSession, hash } = require('./owner-session-delivery');
const { sessionError } = require('./owner-session-endpoint');
const { exact } = require('./owner-session-catalog');

function nativeClient(entry) {
  return entry.provider === 'codex' ? new OwnerCodexClient({ endpoint: entry.endpoint })
    : new OwnerClaudeClient({ registration: { registryRoot: entry.registryRoot,
      socketRoot: entry.socketRoot, pid: entry.endpoint.pid, uid: entry.endpoint.uid } });
}

// No background polling and no unbounded queue. A single broker instance owns
// one admission slot. Its service must also hold an exclusive lifetime lock.
class OwnerSessionBroker {
  constructor({ catalog, store, authority, clientFactory = nativeClient, assertAdmission = null, assertBoundary = null,
    nativePermissions = false }) {
    this.catalog = catalog; this.store = store; this.authority = authority;
    this.assertBoundary = assertBoundary;
    this.nativePermissions = nativePermissions === true;
    this.clientFactory = clientFactory; this.assertAdmission = assertAdmission; this.busy = false; this.closing = false;
  }
  async serial(work) {
    if (this.closing) throw sessionError('OWNER_BROKER_CLOSING');
    if (this.store.isLocked()) throw sessionError('OWNER_SESSION_PANIC_LOCKED');
    if (this.busy) throw sessionError('OWNER_BROKER_BUSY');
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  async session(id, work) {
    const entry = this.catalog.get(id);
    const client = this.clientFactory(entry);
    try {
      await client.connect();
      const session = await inspectOwnerSession(client, entry.provider, entry.sessionId);
      this.catalog.assertEntry(entry, client, session);
      const assertEnrolled = () => this.catalog.assertEntry(entry, client, session);
      return await work({ entry, client, session, assertEnrolled });
    } finally { client.close(); }
  }
  health() {
    if (this.closing || !this.authority || typeof this.assertBoundary !== 'function' || this.store.isLocked()) {
      throw sessionError('OWNER_BROKER_UNAVAILABLE');
    }
    this.assertBoundary(); this.catalog.assertCurrent();
    return { ready: true, epoch: this.authority.epoch, protocol: 'independent-pbx-owner-v1',
      deliveryPolicy: this.nativePermissions ? 'native-session-permissions-v1' : 'pbx-approval-v1' };
  }
  list() {
    // Inventory is enrollment, not a claim that every session is still running.
    return this.catalog.entries().map(({ id, label, provider }) => ({ id, label, provider,
      availability: 'unchecked' }));
  }
  inspect(id, { history = false } = {}) {
    return this.serial(() => this.session(id, async ({ entry, client, session, assertEnrolled }) => {
      const recent = history ? await client.history(entry.sessionId) : null;
      assertEnrolled();
      return { id: entry.id, label: entry.label, provider: entry.provider,
        status: session.status, sessionFingerprint: session.sessionFingerprint,
        activeTurnId: session.activeTurnId, ...(recent ? { history: recent } : {}) };
    }));
  }
  prepare(input) {
    exact(input, ['id', 'operationId', 'message']);
    return this.serial(() => this.session(input.id, ({ entry, session, assertEnrolled }) => {
      assertEnrolled();
      const request = { operationId: input.operationId, provider: entry.provider,
        sessionId: entry.sessionId, sessionFingerprint: session.sessionFingerprint,
        expectedTurnId: session.activeTurnId, message: input.message };
      const plan = requestPlan(request);
      return { id: entry.id, label: entry.label, request: { ...request, message: plan.message },
        planHash: hash(plan), requestHash: hash(plan.message) };
    }));
  }
  deliver(input) {
    exact(input, ['id', 'request', 'capability', 'approval']);
    exact(input.approval, ['approvalId', 'evidenceSha256']);
    return this.serial(async () => {
      if (!this.authority) throw sessionError('OWNER_SESSION_AUTHORITY_UNAVAILABLE');
      if (typeof this.assertAdmission !== 'function') throw sessionError('OWNER_BROKER_ADMISSION_UNAVAILABLE');
      const entry = this.catalog.get(input.id);
      const plan = requestPlan(input.request);
      if (plan.provider !== entry.provider || plan.sessionId !== entry.sessionId) {
        throw sessionError('OWNER_SESSION_IDENTITY_CHANGED');
      }
      const previous = this.store.get(plan.operationId, hash(plan));
      if (previous) return previous;
      return this.session(input.id, ({ client, assertEnrolled }) => deliverOwnerSession({ client,
        store: this.store, request: input.request, capability: input.capability,
        beforeAdmission: () => {
          assertEnrolled();
          const admitted = this.assertAdmission(entry);
          if (admitted && typeof admitted.then === 'function') throw sessionError('OWNER_SESSION_ASYNC_ADMISSION_GUARD');
        },
        authority: { publicKeys: this.authority.publicKeys,
          bindings: { ...input.approval, ...this.authority.bindings } } }));
    });
  }
  forward(input) {
    exact(input, ['id', 'request']);
    return this.serial(async () => {
      if (!this.nativePermissions || !this.authority || typeof this.assertBoundary !== 'function' ||
          typeof this.assertAdmission !== 'function') throw sessionError('OWNER_NATIVE_DELIVERY_DISABLED');
      this.assertBoundary();
      const entry = this.catalog.get(input.id);
      const plan = requestPlan(input.request);
      if (plan.provider !== entry.provider || plan.sessionId !== entry.sessionId) {
        throw sessionError('OWNER_SESSION_IDENTITY_CHANGED');
      }
      const previous = this.store.get(plan.operationId, hash(plan));
      if (previous) return previous;
      return this.session(input.id, ({ client, assertEnrolled }) => deliverOwnerSession({
        client, store: this.store, request: input.request, nativePermissions: true,
        beforeAdmission: () => {
          this.assertBoundary(); assertEnrolled();
          return this.assertAdmission(entry);
        },
      }));
    });
  }
  result(input) {
    exact(input, ['operationId', 'planHash']);
    if (!/^job_[A-Za-z0-9]{1,128}$/.test(input.operationId) || !/^[a-f0-9]{64}$/.test(input.planHash)) {
      throw sessionError('OWNER_SESSION_REQUEST_INVALID');
    }
    return this.store.get(input.operationId, input.planHash);
  }
  panic() {
    this.store.lock();
    // An RPC already handed to a native agent may still execute there. This
    // proves only that our bounded delivery slot has drained behind the lock.
    return { locked: true, quiesced: false, deliveryQuiesced: !this.busy };
  }
  close() { this.closing = true; }
}

module.exports = { OwnerSessionBroker, nativeClient };
