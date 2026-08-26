'use strict';

const fs = require('node:fs');
const path = require('node:path');

function cleanLabel(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 96);
  return normalized || fallback;
}

class VoiceExecutionControl {
  constructor({ lockFile, now = () => new Date().toISOString() } = {}) {
    if (!lockFile) throw new Error('VoiceExecutionControl requires lockFile');
    this.lockFile = path.resolve(lockFile);
    this.now = now;
    this.memoryLock = null;
  }

  _persistState(state) {
    const directory = path.dirname(this.lockFile);
    const temporaryFile = `${this.lockFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      fs.writeFileSync(
        temporaryFile,
        `${JSON.stringify({
          locked: true,
          lockedAt: state.lockedAt,
          reason: state.reason,
          source: state.source,
          remotePanicPending: Boolean(state.remotePanicPending),
          remotePanicConfirmedAt: state.remotePanicConfirmedAt || null,
        })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      );
      fs.renameSync(temporaryFile, this.lockFile);
      fs.chmodSync(this.lockFile, 0o600);
      this.memoryLock = { ...state, lockFile: this.lockFile, persistent: true };
    } catch (error) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch {
        // Ignore cleanup failures; the in-memory lock remains fail-closed.
      }
      this.memoryLock = {
        ...state,
        lockFile: this.lockFile,
        persistent: false,
        error: error.message,
      };
    }
    return { ...this.memoryLock };
  }

  getStatus() {
    if (this.memoryLock) {
      return { ...this.memoryLock };
    }

    let raw;
    try {
      raw = fs.readFileSync(this.lockFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          locked: false,
          lockFile: this.lockFile,
          persistent: true,
        };
      }

      return {
        locked: true,
        lockedAt: null,
        reason: 'lock_state_unreadable',
        source: 'bridge',
        lockFile: this.lockFile,
        persistent: false,
        error: error.message,
      };
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed?.locked === true) {
        return {
          locked: true,
          lockedAt: parsed.lockedAt || null,
          reason: cleanLabel(parsed.reason, 'voice_panic_stop'),
          source: cleanLabel(parsed.source, 'unknown'),
          remotePanicPending: Boolean(parsed.remotePanicPending),
          remotePanicConfirmedAt: parsed.remotePanicConfirmedAt || null,
          lockFile: this.lockFile,
          persistent: true,
        };
      }
    } catch (error) {
      return {
        locked: true,
        lockedAt: null,
        reason: 'lock_state_invalid',
        source: 'bridge',
        lockFile: this.lockFile,
        persistent: false,
        error: error.message,
      };
    }

    return {
      locked: true,
      lockedAt: null,
      reason: 'lock_state_invalid',
      source: 'bridge',
      lockFile: this.lockFile,
      persistent: false,
      error: 'Lock file exists without an active lock marker',
    };
  }

  lock({
    reason = 'voice_panic_stop',
    source = 'local',
    remotePanicPending = false,
  } = {}) {
    const previous = this.getStatus();
    if (previous.locked && !previous.error) {
      if (remotePanicPending && !previous.remotePanicPending) {
        return this._persistState({
          ...previous,
          remotePanicPending: true,
          remotePanicConfirmedAt: null,
        });
      }
      return { ...previous, alreadyLocked: true };
    }

    const state = {
      locked: true,
      lockedAt: this.now(),
      reason: cleanLabel(reason, 'voice_panic_stop'),
      source: cleanLabel(source, 'local'),
      remotePanicPending: Boolean(remotePanicPending),
      remotePanicConfirmedAt: null,
      lockFile: this.lockFile,
      persistent: false,
      alreadyLocked: previous.locked,
    };
    this.memoryLock = state;

    return this._persistState(state);
  }

  markRemotePanicPending({ reason = null, source = null } = {}) {
    const previous = this.getStatus();
    if (!previous.locked) {
      return this.lock({
        reason: reason || 'voice_panic_stop',
        source: source || 'local',
        remotePanicPending: true,
      });
    }
    return this._persistState({
      ...previous,
      reason: cleanLabel(reason || previous.reason, 'voice_panic_stop'),
      source: cleanLabel(source || previous.source, 'local'),
      remotePanicPending: true,
      remotePanicConfirmedAt: null,
    });
  }

  confirmRemotePanic({ source = null } = {}) {
    const previous = this.getStatus();
    if (!previous.locked) return previous;
    return this._persistState({
      ...previous,
      source: cleanLabel(source || previous.source, 'local'),
      remotePanicPending: false,
      remotePanicConfirmedAt: this.now(),
    });
  }

  unlock({ source = 'operator' } = {}) {
    const previous = this.getStatus();
    if (previous.locked && previous.remotePanicPending) {
      return {
        ...previous,
        locked: true,
        error: 'remote_panic_unconfirmed',
      };
    }
    let persistent = true;
    let errorMessage = null;

    try {
      fs.unlinkSync(this.lockFile);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        persistent = false;
        errorMessage = error.message;
      }
    }

    if (!persistent) {
      return {
        ...previous,
        locked: true,
        persistent: false,
        error: errorMessage,
      };
    }

    this.memoryLock = null;
    return {
      locked: false,
      unlockedAt: this.now(),
      source: cleanLabel(source, 'operator'),
      wasLocked: previous.locked,
      lockFile: this.lockFile,
      persistent: true,
    };
  }
}

module.exports = {
  VoiceExecutionControl,
  cleanLabel,
};
