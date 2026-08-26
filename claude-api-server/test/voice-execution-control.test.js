'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VoiceExecutionControl, cleanLabel } = require('../../lib/voice-execution-control');

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

test('control labels are bounded and contain no shell syntax', () => {
  assert.equal(cleanLabel(' asterisk; rm -rf / ', 'fallback'), 'asterisk_rm_-rf_');
  assert.equal(cleanLabel('', 'fallback'), 'fallback');
});
