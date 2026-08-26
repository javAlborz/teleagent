export class CallRegistry {
  #stateStore;
  #sessions = new Map();

  constructor({ stateStore }) {
    if (!stateStore) throw new TypeError('CallRegistry requires a durable state store');
    this.#stateStore = stateStore;
  }

  get stateStore() {
    return this.#stateStore;
  }

  update(callId, state, fields = {}) {
    const record = this.#stateStore.updateCall(callId, state, fields);
    return { ...record, session: this.#sessions.get(callId) ?? null };
  }

  get(callId) {
    const record = this.#stateStore.getCall(callId);
    if (!record) return null;
    return { ...record, session: this.#sessions.get(callId) ?? null };
  }

  attachSession(callId, session) {
    if (!this.#stateStore.getCall(callId)) throw new Error(`Unknown durable SIP call ${callId}`);
    this.#sessions.set(callId, session);
  }

  detachSession(callId, session) {
    if (session === undefined || this.#sessions.get(callId) === session) {
      this.#sessions.delete(callId);
    }
  }

  activeRecords() {
    return this.#stateStore.activeRecords().map((record) => ({
      ...record,
      session: this.#sessions.get(record.callId) ?? null,
    }));
  }

  summary() {
    return this.#stateStore.summary();
  }
}
