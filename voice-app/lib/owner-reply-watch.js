'use strict';

// One serial, call-local read watcher; it never sends instructions or starts
// agents. Ending a watch never cancels native work. No callback/redial promise.
class OwnerReplyWatch {
  constructor({ read, speak, available, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { read, speak, available, schedule, cancel });
    this.current = null;
  }
  start(operationId) {
    if (this.current?.operationId === operationId) return;
    this.stop();
    const watch = { operationId, result: null };
    this.current = watch;
    this.arm(watch);
  }
  arm(watch) {
    if (this.current !== watch) return;
    watch.timer = this.schedule(() => { void this.tick(watch); }, 5000);
    watch.timer?.unref?.();
  }
  async tick(watch) {
    if (this.current !== watch) return;
    try {
      if (!this.available()) { this.arm(watch); return; }
      if (!watch.result) {
        const result = await this.read(watch.operationId);
        if (this.current !== watch) return;
        const turn = result?.success === true ? result.result?.history?.latestTurn : null;
        if (turn?.status === 'completed' && turn.reply) watch.result = result.result;
      }
      if (watch.result && this.available() && this.speak(watch.result)) { this.stop(); return; }
    } catch {
      if (this.current !== watch) return;
    }
    this.arm(watch);
  }
  stop() {
    if (this.current) this.cancel(this.current.timer);
    this.current = null;
  }
}

module.exports = { OwnerReplyWatch };
