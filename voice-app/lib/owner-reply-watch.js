'use strict';

// One serial, call-local scheduler for several results; it never sends instructions or starts
// agents. Ending a watch never cancels native work. No callback/redial promise.
class OwnerReplyWatch {
  constructor({ read, speak, available, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { read, speak, available, schedule, cancel });
    this.watches = new Map();
    this.reading = false;
  }
  get current() { return this.watches.values().next().value || null; }
  has(operationId) { return this.watches.has(operationId); }
  start(operationId) {
    if (this.watches.has(operationId)) return;
    const watch = { operationId, result: null };
    this.watches.set(operationId, watch);
    if (this.current === watch) this.arm(watch);
  }
  arm(watch) {
    if (!watch || this.current !== watch || this.reading || watch.timer) return;
    watch.timer = this.schedule(() => { void this.tick(watch); }, 5000);
    watch.timer?.unref?.();
  }
  async tick(watch) {
    if (this.current !== watch || this.reading) return;
    this.cancel(watch.timer);
    watch.timer = null;
    this.reading = true;
    try {
      if (!this.available()) return;
      if (!watch.result) {
        const result = await this.read(watch.operationId);
        if (this.current !== watch) return;
        const turn = result?.success === true ? result.result?.history?.latestTurn : null;
        if (['completed', 'failed', 'interrupted'].includes(turn?.status)) watch.result = result.result;
      }
      if (watch.result && this.available() && this.speak(watch.result, watch.operationId)) {
        this.stop(watch.operationId); return;
      }
    } catch {
      // A read failure never causes a resend or claims completion.
    } finally {
      this.reading = false;
      // Round robin: a long-running task must not starve a finished peer.
      if (this.watches.get(watch.operationId) === watch) {
        this.watches.delete(watch.operationId);
        this.watches.set(watch.operationId, watch);
      }
      this.arm(this.current);
    }
  }
  stop(operationId) {
    const current = this.current;
    if (operationId !== undefined) {
      const watch = this.watches.get(operationId);
      if (!watch) return;
      this.cancel(watch.timer);
      this.watches.delete(operationId);
      if (current === watch && this.current) this.arm(this.current);
    } else {
      for (const watch of this.watches.values()) this.cancel(watch.timer);
      this.watches.clear();
    }
  }
}

module.exports = { OwnerReplyWatch };
