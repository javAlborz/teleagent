'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectExactStateFile } = require('./durable-state-storage-boundary');

const STRICT_STATE_VERSION = 1;
const MAX_STRICT_STATE_BYTES = 4096n;
const STRICT_STATE_KEYS = Object.freeze([
  'version',
  'locked',
  'revision',
  'updatedAt',
  'lockedAt',
  'unlockedAt',
  'reason',
  'source',
  'remotePanicPending',
  'remotePanicConfirmedAt',
]);
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function cleanLabel(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 96);
  return normalized || fallback;
}

function exactTimestamp(value) {
  if (typeof value !== 'string' || !STRICT_TIMESTAMP.test(value) ||
      !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

async function compensateIncoherentVoiceUnlock({
  source = 'operator',
  voiceExecution,
  executor,
  workerSessions,
  voiceExecutionControl,
  executorTaskStore,
  workerSessionEnabled = false,
  workerSessionProxy = null,
  cause = null,
} = {}) {
  const reason = 'controller_unlock_coherence_failed';
  const rollbackSource = 'controller_unlock_rollback';
  let fencedExecutor;
  try {
    fencedExecutor = executorTaskStore.panic({ reason, source: rollbackSource });
  } catch (error) {
    let panic = null;
    try { panic = executorTaskStore.getPanicStatus(); } catch {
      // The structured failure below remains fail-closed even if status is unavailable.
    }
    fencedExecutor = {
      accepted: false,
      persisted: panic?.locked === true,
      quiesced: panic?.quiesced === true,
      panic,
      error: error.message,
    };
  }

  let fencedVoice;
  try {
    fencedVoice = voiceExecutionControl.lock({ reason, source: rollbackSource });
  } catch (error) {
    let status = null;
    try { status = voiceExecutionControl.getStatus(); } catch {
      // Preserve an explicit locked response if even status inspection is unavailable.
    }
    fencedVoice = {
      ...(status || {}),
      locked: true,
      persistent: status?.persistent === true,
      error: error.message,
    };
  }

  let fencedWorker = workerSessions;
  let workerBoundaryCode = null;
  if (workerSessionEnabled) {
    try {
      if (!workerSessionProxy?.panic) throw new Error('Worker panic proxy is unavailable.');
      const response = await workerSessionProxy.panic({ reason, source: rollbackSource });
      const payload = response?.payload;
      const confirmed = response?.status === 200 && payload?.success === true &&
        payload?.persisted === true && payload?.quiesced === true;
      fencedWorker = {
        ...(payload || {}),
        status: response?.status ?? null,
        success: confirmed,
      };
      workerBoundaryCode = confirmed
        ? 'WORKER_SESSION_PANIC_LOCKED'
        : 'WORKER_SESSION_PANIC_UNCONFIRMED';
    } catch (error) {
      fencedWorker = {
        success: false,
        persisted: false,
        quiesced: false,
        error: error.message,
      };
      workerBoundaryCode = 'WORKER_SESSION_PANIC_UNCONFIRMED';
    }
  }

  return {
    success: false,
    code: 'VOICE_UNLOCK_COHERENCE_UNCONFIRMED',
    error: cause?.message ||
      'Voice, executor, and worker unlock did not commit coherently; every plane was re-fenced.',
    voiceExecution: fencedVoice || voiceExecution,
    executor: fencedExecutor || executor,
    workerSessions: fencedWorker,
    workerBoundaryCode,
    requestedBy: cleanLabel(source, 'operator'),
  };
}

class VoiceExecutionControl {
  constructor({
    lockFile,
    now = () => new Date().toISOString(),
    strictPersistentState = false,
    expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : null,
    expectedGid = typeof process.getegid === 'function' ? process.getegid() : null,
  } = {}) {
    if (!lockFile) throw new Error('VoiceExecutionControl requires lockFile');
    this.lockFile = path.resolve(lockFile);
    this.transitionFile = `${this.lockFile}.transition`;
    this.now = now;
    this.strictPersistentState = strictPersistentState === true;
    this.expectedUid = expectedUid;
    this.expectedGid = expectedGid;
    this.memoryLock = null;
    if (this.strictPersistentState) {
      if (!Number.isSafeInteger(this.expectedUid) || this.expectedUid < 0 ||
          !Number.isSafeInteger(this.expectedGid) || this.expectedGid < 0) {
        throw new Error('Strict voice execution state requires exact numeric ownership.');
      }
      this._readStrictState();
    }
  }

  _sameIdentity(left, right) {
    return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink']
      .every((field) => BigInt(left?.[field]) === BigInt(right?.[field]));
  }

  _safeStrictFile(metadata) {
    return metadata?.isFile?.() === true && metadata.isSymbolicLink?.() !== true &&
      BigInt(metadata.uid) === BigInt(this.expectedUid) &&
      BigInt(metadata.gid) === BigInt(this.expectedGid) &&
      BigInt(metadata.nlink) === 1n && (BigInt(metadata.mode) & 0o7777n) === 0o600n;
  }

  _strictFileIdentity(filename, { allowAbsent = false } = {}) {
    return inspectExactStateFile(filename, {
      expectedUid: this.expectedUid,
      expectedGid: this.expectedGid,
      allowAbsent,
    });
  }

  _readExactStrictFile(filename) {
    const inspected = this._strictFileIdentity(filename);
    let descriptor;
    try {
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!this._safeStrictFile(before) || BigInt(before.dev) !== inspected.dev ||
          BigInt(before.ino) !== inspected.ino || BigInt(before.size) > MAX_STRICT_STATE_BYTES) {
        throw new Error('Strict voice execution state changed while it was opened.');
      }
      const body = fs.readFileSync(descriptor, 'utf8');
      const after = fs.fstatSync(descriptor, { bigint: true });
      const finalPath = fs.lstatSync(filename, { bigint: true });
      if (!this._sameIdentity(before, after) || !this._sameIdentity(after, finalPath) ||
          BigInt(before.size) !== BigInt(after.size) ||
          BigInt(after.size) !== BigInt(finalPath.size) ||
          BigInt(before.mtimeNs) !== BigInt(after.mtimeNs) ||
          BigInt(after.mtimeNs) !== BigInt(finalPath.mtimeNs) ||
          BigInt(before.ctimeNs) !== BigInt(after.ctimeNs) ||
          BigInt(after.ctimeNs) !== BigInt(finalPath.ctimeNs) ||
          fs.realpathSync(filename) !== filename) {
        throw new Error('Strict voice execution state changed while it was read.');
      }
      return body;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  _normalizeStrictState(parsed) {
    const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed)
      : [];
    if (keys.length !== STRICT_STATE_KEYS.length ||
        keys.some((key, index) => key !== STRICT_STATE_KEYS[index])) {
      throw new Error('Strict voice execution state does not have the exact schema.');
    }
    const timestamp = parsed.updatedAt;
    const invalidConfirmation = ![null, undefined].includes(parsed?.remotePanicConfirmedAt) &&
      !exactTimestamp(parsed.remotePanicConfirmedAt);
    if (!parsed || parsed.version !== STRICT_STATE_VERSION || typeof parsed.locked !== 'boolean' ||
        !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 ||
        !exactTimestamp(timestamp) ||
        typeof parsed.remotePanicPending !== 'boolean' || invalidConfirmation) {
      throw new Error('Strict voice execution state has an invalid schema.');
    }
    const cleanSource = cleanLabel(parsed?.source, '');
    if (!cleanSource || cleanSource !== parsed.source) {
      throw new Error('Strict voice execution state source is invalid.');
    }
    if (parsed.locked && (!exactTimestamp(parsed.lockedAt) ||
        parsed.unlockedAt !== null ||
        cleanLabel(parsed.reason, '') !== parsed.reason ||
        cleanLabel(parsed.source, '') !== parsed.source ||
        (parsed.remotePanicPending && parsed.remotePanicConfirmedAt !== null))) {
      throw new Error('Strict locked voice execution state is invalid.');
    }
    if (!parsed.locked && (!exactTimestamp(parsed.unlockedAt) ||
        parsed.lockedAt !== null || parsed.remotePanicPending ||
        parsed.remotePanicConfirmedAt !== null || parsed.reason !== null)) {
      throw new Error('Strict unlocked voice execution state is invalid.');
    }
    return {
      locked: parsed.locked,
      revision: parsed.revision,
      updatedAt: timestamp,
      lockedAt: parsed.lockedAt || null,
      unlockedAt: parsed.unlockedAt || null,
      reason: parsed.reason,
      source: cleanLabel(parsed.source, parsed.locked ? 'unknown' : 'operator'),
      remotePanicPending: parsed.remotePanicPending,
      remotePanicConfirmedAt: parsed.remotePanicConfirmedAt || null,
      lockFile: this.lockFile,
      persistent: true,
    };
  }

  _parseStrictState(body) {
    const parsed = JSON.parse(body);
    const normalized = this._normalizeStrictState(parsed);
    const canonical = {
      version: STRICT_STATE_VERSION,
      locked: parsed.locked,
      revision: parsed.revision,
      updatedAt: parsed.updatedAt,
      lockedAt: parsed.lockedAt,
      unlockedAt: parsed.unlockedAt,
      reason: parsed.reason,
      source: parsed.source,
      remotePanicPending: parsed.remotePanicPending,
      remotePanicConfirmedAt: parsed.remotePanicConfirmedAt,
    };
    if (body !== `${JSON.stringify(canonical)}\n`) {
      throw new Error('Strict voice execution state is not exact canonical JSON.');
    }
    return normalized;
  }

  _readStrictState() {
    const transition = this._strictFileIdentity(this.transitionFile, { allowAbsent: true });
    if (transition.exists) {
      throw new Error('A strict voice execution state transition is unresolved.');
    }
    try {
      return this._parseStrictState(this._readExactStrictFile(this.lockFile));
    } catch (error) {
      throw new Error(`Strict voice execution state is absent, unreadable, or invalid: ${error.message}`);
    }
  }

  _fsyncStrictDirectory() {
    const directory = path.dirname(this.lockFile);
    const before = fs.lstatSync(directory, { bigint: true });
    if (before.isDirectory() !== true || before.isSymbolicLink() === true ||
        BigInt(before.uid) !== BigInt(this.expectedUid) ||
        BigInt(before.gid) !== BigInt(this.expectedGid) ||
        (BigInt(before.mode) & 0o7777n) !== 0o700n ||
        fs.realpathSync(directory) !== directory) {
      throw new Error('Strict voice execution state directory is unsafe.');
    }
    let descriptor;
    try {
      descriptor = fs.openSync(
        directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0)
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!this._sameIdentity(before, opened)) {
        throw new Error('Strict voice execution state directory changed while opened.');
      }
      fs.fsyncSync(descriptor);
      const after = fs.lstatSync(directory, { bigint: true });
      if (!this._sameIdentity(opened, after) || fs.realpathSync(directory) !== directory) {
        throw new Error('Strict voice execution state directory changed while synchronized.');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  _createStrictFile(filename, body, { retainOnFailure = false } = {}) {
    let descriptor;
    let identity = null;
    try {
      descriptor = fs.openSync(
        filename,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW || 0),
        0o600
      );
      const before = fs.fstatSync(descriptor, { bigint: true });
      identity = { dev: BigInt(before.dev), ino: BigInt(before.ino) };
      if (!this._safeStrictFile(before)) {
        throw new Error('A new strict voice execution state file has unsafe metadata.');
      }
      const bytes = Buffer.from(body, 'utf8');
      if (BigInt(bytes.length) > MAX_STRICT_STATE_BYTES) {
        throw new Error('Strict voice execution state exceeds its fixed bound.');
      }
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('Strict voice execution state write made no progress.');
        offset += written;
      }
      fs.fsyncSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const pathMetadata = fs.lstatSync(filename, { bigint: true });
      if (!this._sameIdentity(before, after) || !this._sameIdentity(after, pathMetadata) ||
          fs.realpathSync(filename) !== filename) {
        throw new Error('A new strict voice execution state file changed while written.');
      }
      return { dev: BigInt(after.dev), ino: BigInt(after.ino) };
    } catch (error) {
      if (!retainOnFailure && identity) {
        try {
          const current = fs.lstatSync(filename, { bigint: true });
          if (BigInt(current.dev) === identity.dev && BigInt(current.ino) === identity.ino) {
            fs.unlinkSync(filename);
          }
        } catch {
          // Leave an unverifiable partial file for operator inspection.
        }
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  _unlinkStrictFile(filename, identity) {
    const metadata = fs.lstatSync(filename, { bigint: true });
    if (!this._safeStrictFile(metadata) || BigInt(metadata.dev) !== identity.dev ||
        BigInt(metadata.ino) !== identity.ino || fs.realpathSync(filename) !== filename) {
      throw new Error('A strict voice execution state cleanup target changed.');
    }
    fs.unlinkSync(filename);
  }

  _persistStrictState(state) {
    const previous = this._readStrictState();
    const previousIdentity = this._strictFileIdentity(this.lockFile);
    const previousRecheck = this._parseStrictState(this._readExactStrictFile(this.lockFile));
    if (previousRecheck.revision !== previous.revision ||
        previousRecheck.locked !== previous.locked) {
      throw new Error('Strict voice execution state changed before transition fencing.');
    }
    const timestamp = this.now();
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new Error('Strict voice execution state clock is invalid.');
    }
    const next = {
      version: STRICT_STATE_VERSION,
      locked: state.locked === true,
      revision: previous.revision + 1,
      updatedAt: timestamp,
      lockedAt: state.locked ? (state.lockedAt || timestamp) : null,
      unlockedAt: state.locked ? null : (state.unlockedAt || timestamp),
      reason: state.locked ? cleanLabel(state.reason, 'voice_panic_stop') : null,
      source: cleanLabel(state.source, state.locked ? 'local' : 'operator'),
      remotePanicPending: state.locked ? Boolean(state.remotePanicPending) : false,
      remotePanicConfirmedAt: state.locked ? (state.remotePanicConfirmedAt || null) : null,
    };
    const transitionBody = `${JSON.stringify({
      version: STRICT_STATE_VERSION,
      operation: next.locked ? 'lock' : 'unlock',
      fromRevision: previous.revision,
      toRevision: next.revision,
      startedAt: timestamp,
    })}\n`;
    const transitionIdentity = this._createStrictFile(
      this.transitionFile,
      transitionBody,
      { retainOnFailure: true }
    );
    this._fsyncStrictDirectory();

    const temporaryFile = `${this.lockFile}.${process.pid}.${Date.now()}.tmp`;
    let temporaryIdentity = null;
    try {
      temporaryIdentity = this._createStrictFile(temporaryFile, `${JSON.stringify(next)}\n`);
      const current = this._strictFileIdentity(this.lockFile);
      if (current.dev !== previousIdentity.dev || current.ino !== previousIdentity.ino) {
        throw new Error('Strict voice execution state changed before publication.');
      }
      // Re-read the exact current state immediately before the atomic replacement.
      const rechecked = this._readExactStrictFile(this.lockFile);
      const parsedRecheck = this._parseStrictState(rechecked);
      if (parsedRecheck.revision !== previous.revision || parsedRecheck.locked !== previous.locked) {
        throw new Error('Strict voice execution state changed before publication.');
      }
      const publishedIdentity = temporaryIdentity;
      fs.renameSync(temporaryFile, this.lockFile);
      temporaryIdentity = null;
      const published = this._strictFileIdentity(this.lockFile);
      if (published.dev !== publishedIdentity.dev || published.ino !== publishedIdentity.ino) {
        throw new Error('Strict voice execution state publication identity is invalid.');
      }
      this._fsyncStrictDirectory();
      const verified = this._parseStrictState(this._readExactStrictFile(this.lockFile));
      if (verified.revision !== next.revision || verified.locked !== next.locked) {
        throw new Error('Strict voice execution state publication did not verify.');
      }
      this._unlinkStrictFile(this.transitionFile, transitionIdentity);
      this._fsyncStrictDirectory();
      this.memoryLock = null;
      return verified;
    } catch (error) {
      if (temporaryIdentity) {
        try { this._unlinkStrictFile(temporaryFile, temporaryIdentity); } catch {
          // Leave an unverifiable temporary file for operator inspection.
        }
      }
      throw error;
    }
  }

  _persistState(state) {
    if (this.strictPersistentState) {
      try {
        return this._persistStrictState(state);
      } catch (error) {
        this.memoryLock = {
          locked: true,
          lockedAt: state.lockedAt || null,
          reason: 'lock_state_persistence_failed',
          source: cleanLabel(state.source, 'local'),
          remotePanicPending: Boolean(state.remotePanicPending),
          remotePanicConfirmedAt: null,
          lockFile: this.lockFile,
          persistent: false,
          error: error.message,
        };
        return { ...this.memoryLock };
      }
    }
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
    if (this.strictPersistentState) {
      if (this.memoryLock) return { ...this.memoryLock };
      try {
        return this._readStrictState();
      } catch (error) {
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
    }
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
    if (this.strictPersistentState) {
      if (previous.error) return { ...previous, locked: true };
      if (!previous.locked) {
        return {
          ...previous,
          wasLocked: false,
          source: cleanLabel(source, 'operator'),
        };
      }
      const unlocked = this._persistState({
        locked: false,
        unlockedAt: this.now(),
        source,
        remotePanicPending: false,
      });
      return {
        ...unlocked,
        wasLocked: true,
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
  compensateIncoherentVoiceUnlock,
};
