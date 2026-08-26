'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

class OutboundRuntimeFenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OutboundRuntimeFenceError';
    this.code = code;
  }
}

class OutboundRuntimeFence {
  constructor({ stateDbPath, lockDbPath = null } = {}) {
    const statePath = String(stateDbPath || '').trim();
    if (!path.isAbsolute(statePath) || statePath === ':memory:') {
      throw new OutboundRuntimeFenceError(
        'OUTBOUND_FENCE_PATH_INVALID',
        'A file-backed absolute voice-state DB path is required for the outbound runtime fence.'
      );
    }
    this.lockDbPath = lockDbPath || `${statePath}.outbound-owner.sqlite`;
    const directory = path.dirname(this.lockDbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.db = null;
    this.held = false;

    try {
      this.db = new Database(this.lockDbPath, { timeout: 0 });
      this.db.pragma('journal_mode = DELETE');
      this.db.pragma('synchronous = FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS outbound_owner_fence (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1)
        );
      `);
      this.db.exec('BEGIN EXCLUSIVE');
      this.held = true;
      fs.chmodSync(this.lockDbPath, 0o600);
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        // The acquisition error remains authoritative.
      }
      this.db = null;
      const busy = error?.code === 'SQLITE_BUSY' || /database is locked/i.test(error?.message || '');
      throw new OutboundRuntimeFenceError(
        busy ? 'OUTBOUND_RUNTIME_ALREADY_ACTIVE' : 'OUTBOUND_FENCE_ACQUIRE_FAILED',
        busy
          ? 'Another voice-app process already owns the outbound dial worker fence.'
          : 'The outbound dial worker fence could not be acquired safely.'
      );
    }
  }

  assertHeld() {
    if (!this.held || !this.db?.open || !this.db.inTransaction) {
      throw new OutboundRuntimeFenceError(
        'OUTBOUND_FENCE_NOT_HELD',
        'The outbound dial worker fence is not held.'
      );
    }
    return true;
  }

  release() {
    if (!this.db) return { changed: false };
    const wasHeld = this.held;
    try {
      if (this.db.open && this.db.inTransaction) this.db.exec('COMMIT');
    } finally {
      this.held = false;
      if (this.db.open) this.db.close();
      this.db = null;
    }
    return { changed: wasHeld };
  }
}

module.exports = {
  OutboundRuntimeFence,
  OutboundRuntimeFenceError,
};
