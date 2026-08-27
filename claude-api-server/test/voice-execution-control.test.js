'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  VoiceExecutionControl,
  cleanLabel,
  compensateIncoherentVoiceUnlock,
} = require('../../lib/voice-execution-control');

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-voice-lock-'));
  const lockFile = path.join(directory, 'state', 'voice.lock.json');
  const control = new VoiceExecutionControl({
    lockFile,
    now: () => '2026-08-13T12:00:00.000Z',
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { control, lockFile };
}

function createStrictFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-strict-voice-state-'));
  fs.chmodSync(directory, 0o700);
  const lockFile = path.join(directory, 'voice-execution.lock.json');
  fs.writeFileSync(lockFile, `${JSON.stringify({
    version: 1,
    locked: false,
    revision: 0,
    updatedAt: '2026-08-13T11:59:00.000Z',
    lockedAt: null,
    unlockedAt: '2026-08-13T11:59:00.000Z',
    reason: null,
    source: 'disabled_installer_initialization',
    remotePanicPending: false,
    remotePanicConfirmedAt: null,
  })}\n`, { mode: 0o600, flag: 'wx' });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    lockFile,
    strictPersistentState: true,
    expectedUid: process.geteuid(),
    expectedGid: process.getegid(),
  };
  return { directory, lockFile, options };
}

test('voice execution lock persists, is idempotent, and unlocks explicitly', (t) => {
  const { control, lockFile } = createFixture(t);
  assert.equal(control.getStatus().locked, false);

  const locked = control.lock({ reason: 'panic stop', source: 'asterisk 1001' });
  assert.equal(locked.locked, true);
  assert.equal(locked.persistent, true);
  assert.equal(locked.reason, 'panic_stop');
  assert.equal(locked.source, 'asterisk_1001');
  assert.equal(fs.statSync(lockFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(lockFile)).mode & 0o777, 0o700);

  const reopened = new VoiceExecutionControl({ lockFile });
  assert.equal(reopened.getStatus().locked, true);
  assert.equal(reopened.lock().alreadyLocked, true);

  const unlocked = control.unlock({ source: 'operator cli' });
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.wasLocked, true);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(control.getStatus().locked, false);
});

test('invalid lock files fail closed until an explicit unlock', (t) => {
  const { control, lockFile } = createFixture(t);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, 'not-json', { mode: 0o600 });

  const status = control.getStatus();
  assert.equal(status.locked, true);
  assert.equal(status.reason, 'lock_state_invalid');
  assert.match(status.error, /JSON/);

  assert.equal(control.unlock().locked, false);
  assert.equal(control.getStatus().locked, false);
});

test('remote panic must be durably confirmed before the lock can be cleared', (t) => {
  const { control, lockFile } = createFixture(t);
  const pending = control.lock({
    reason: 'panic stop',
    source: 'asterisk 1001',
    remotePanicPending: true,
  });
  assert.equal(pending.remotePanicPending, true);

  const reopened = new VoiceExecutionControl({
    lockFile,
    now: () => '2026-08-13T12:05:00.000Z',
  });
  assert.equal(reopened.getStatus().remotePanicPending, true);
  const refused = reopened.unlock({ source: 'operator cli' });
  assert.equal(refused.locked, true);
  assert.equal(refused.error, 'remote_panic_unconfirmed');
  assert.equal(fs.existsSync(lockFile), true);

  const confirmed = reopened.confirmRemotePanic({ source: 'voice app retry' });
  assert.equal(confirmed.remotePanicPending, false);
  assert.equal(confirmed.remotePanicConfirmedAt, '2026-08-13T12:05:00.000Z');
  assert.equal(new VoiceExecutionControl({ lockFile }).getStatus().remotePanicPending, false);

  assert.equal(reopened.unlock({ source: 'operator cli' }).locked, false);
  assert.equal(fs.existsSync(lockFile), false);
});

test('strict controller state persists explicit unlocked and panic states without deletion', (t) => {
  const { lockFile, options } = createStrictFixture(t);
  const control = new VoiceExecutionControl({
    ...options,
    now: () => '2026-08-13T12:00:00.000Z',
  });
  assert.equal(control.getStatus().locked, false);
  const locked = control.lock({
    reason: 'panic stop',
    source: 'asterisk 1001',
    remotePanicPending: true,
  });
  assert.equal(locked.locked, true);
  assert.equal(locked.persistent, true);
  assert.equal(locked.revision, 1);
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(new VoiceExecutionControl(options).getStatus().locked, true);

  const confirmed = control.confirmRemotePanic({ source: 'voice app retry' });
  assert.equal(confirmed.remotePanicPending, false);
  assert.equal(confirmed.revision, 2);
  const unlocked = control.unlock({ source: 'root operator' });
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.persistent, true);
  assert.equal(unlocked.wasLocked, true);
  assert.equal(unlocked.revision, 3);
  assert.equal(fs.existsSync(lockFile), true);
  const persisted = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(persisted.locked, false);
  assert.equal(persisted.reason, null);
  assert.equal(persisted.remotePanicPending, false);
  assert.equal(fs.statSync(lockFile).nlink, 1);
  assert.equal(fs.statSync(lockFile).mode & 0o777, 0o600);
  assert.equal(new VoiceExecutionControl(options).getStatus().locked, false);
});

test('strict controller startup refuses missing, tampered, or unresolved state', (t) => {
  const { directory, lockFile, options } = createStrictFixture(t);
  const exactInitialState = fs.readFileSync(lockFile, 'utf8');
  const nonCanonical = { ...JSON.parse(exactInitialState), unreviewed: true };
  fs.writeFileSync(lockFile, `${JSON.stringify(nonCanonical)}\n`, { mode: 0o600 });
  assert.throws(() => new VoiceExecutionControl(options), /exact schema/);
  fs.writeFileSync(lockFile, exactInitialState, { mode: 0o600 });

  fs.unlinkSync(lockFile);
  assert.throws(() => new VoiceExecutionControl(options), /absent, unreadable, or invalid/);

  fs.writeFileSync(lockFile, '{}\n', { mode: 0o600, flag: 'wx' });
  assert.throws(() => new VoiceExecutionControl(options), /exact schema|invalid schema/);
  fs.unlinkSync(lockFile);

  fs.writeFileSync(lockFile, 'not-state\n', { mode: 0o644, flag: 'wx' });
  assert.throws(() => new VoiceExecutionControl(options), /absent, unreadable, or invalid/);
  fs.unlinkSync(lockFile);

  const target = path.join(directory, 'symlink-target');
  fs.writeFileSync(target, 'not-state\n', { mode: 0o600 });
  fs.symlinkSync(target, lockFile);
  assert.throws(() => new VoiceExecutionControl(options), /absent, unreadable, or invalid/);
  fs.unlinkSync(lockFile);
  fs.unlinkSync(target);

  fs.writeFileSync(lockFile, `${JSON.stringify({
    version: 1,
    locked: false,
    revision: 0,
    updatedAt: '2026-08-13T11:59:00.000Z',
    lockedAt: null,
    unlockedAt: '2026-08-13T11:59:00.000Z',
    reason: null,
    source: 'disabled_installer_initialization',
    remotePanicPending: false,
    remotePanicConfirmedAt: null,
  })}\n`, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(`${lockFile}.transition`, '{}\n', { mode: 0o600, flag: 'wx' });
  assert.throws(() => new VoiceExecutionControl(options), /transition is unresolved/);
});

test('an incoherent unlock re-panics executor, voice, and worker planes', async () => {
  const calls = [];
  const result = await compensateIncoherentVoiceUnlock({
    source: 'root operator',
    voiceExecution: { locked: true, persistent: false },
    executor: { panic: { locked: false } },
    workerSessions: { success: true, persisted: true, quiesced: true },
    voiceExecutionControl: {
      lock(input) {
        calls.push(['voice', input]);
        return { locked: true, persistent: true, reason: input.reason };
      },
    },
    executorTaskStore: {
      panic(input) {
        calls.push(['executor', input]);
        return { accepted: true, persisted: true, quiesced: true, panic: { locked: true } };
      },
    },
    workerSessionEnabled: true,
    workerSessionProxy: {
      async panic(input) {
        calls.push(['worker', input]);
        return {
          status: 200,
          payload: { success: true, persisted: true, quiesced: true },
        };
      },
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_UNLOCK_COHERENCE_UNCONFIRMED');
  assert.equal(result.voiceExecution.locked, true);
  assert.equal(result.executor.panic.locked, true);
  assert.equal(result.workerSessions.success, true);
  assert.equal(result.workerBoundaryCode, 'WORKER_SESSION_PANIC_LOCKED');
  assert.deepEqual(calls.map(([plane]) => plane), ['executor', 'voice', 'worker']);
  for (const [, input] of calls) {
    assert.equal(input.reason, 'controller_unlock_coherence_failed');
    assert.equal(input.source, 'controller_unlock_rollback');
  }
});

test('control labels are bounded and contain no shell syntax', () => {
  assert.equal(cleanLabel(' asterisk; rm -rf / ', 'fallback'), 'asterisk_rm_-rf_');
  assert.equal(cleanLabel('', 'fallback'), 'fallback');
});
