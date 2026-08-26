'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrivilegedActionDispatcher } = require('../executor');
const { privilegedActionRequestHash } = require('../../lib/privileged-action-plan');
const { PrivilegedActionStore } = require('../store');
const { actionPlan, policy } = require('./helpers');

function waitForMessage(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for orphan fixture.')), timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Orphan fixture exited early (${code ?? signal}).`));
    };
    child.once('exit', onExit);
    child.once('message', (message) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (message?.error) reject(new Error(String(message.error)));
      else resolve(message);
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error('Timed out waiting for fixture exit.')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessRecord(store, actionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = store.listProcessRecoveryRecords()
      .find((candidate) => candidate.actionId === actionId && candidate.state === 'spawned');
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for durable spawned-process identity.');
}

test('SIGKILL restart recovery kills the exact orphan before claims and keeps panic locked', {
  skip: process.platform !== 'linux' ? 'Linux /proc and process groups are required.' : false,
  timeout: 20000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privileged-orphan-recovery-'));
  fs.chmodSync(directory, 0o700);
  const dbPath = path.join(directory, 'state.sqlite3');
  let childPid = null;
  t.after(() => {
    if (childPid) {
      try { process.kill(-childPid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const fixture = fork(path.join(__dirname, 'fixtures', 'orphan-process-runner.js'), [dbPath], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ready = await waitForMessage(fixture);
  assert.equal(ready.ready, true);
  childPid = ready.childPid;
  assert.equal(processExists(childPid), true);
  fixture.kill('SIGKILL');
  await waitForExit(fixture);
  assert.equal(processExists(childPid), true, 'detached privileged child must survive broker SIGKILL');
  process.kill(-childPid, 'SIGSTOP');

  const store = new PrivilegedActionStore({
    dbPath,
    expectedUid: process.geteuid(),
    strictOwnership: true,
  });
  const recoveredPolicy = policy();
  recoveredPolicy.adapters.argv.exact_rules.push({
    argv: ['/usr/bin/sleep', '60'],
    cwd: '/',
  });
  const dispatcher = new PrivilegedActionDispatcher({
    store,
    policy: recoveredPolicy,
    expectedUid: 0,
    processUid: process.geteuid(),
    terminationGraceMs: 500,
    terminationPollMs: 20,
  });
  t.after(async () => {
    await dispatcher.close();
    store.close();
  });

  assert.throws(() => dispatcher.start(), { code: 'PRIVILEGED_RECOVERY_NOT_RUN' });
  const recovery = await dispatcher.recoverStartup();
  assert.equal(recovery.required, true);
  assert.equal(recovery.quiesced, true);
  assert.deepEqual(recovery.recoveredActionIds, [ready.actionId]);
  assert.equal(processExists(childPid), false);
  childPid = null;
  assert.equal(store.getAction(ready.actionId).state, 'outcome_unknown');
  assert.equal(store.getAction(ready.queuedActionId).state, 'queued');
  const recoveredProcess = store.listProcessRecoveryRecords({ includeQuiesced: true })
    .find((record) => record.actionId === ready.actionId);
  assert.equal(recoveredProcess.pid, ready.childPid);
  assert.equal(recoveredProcess.processStartTicks, ready.childStartTicks);
  assert.equal(recoveredProcess.processGroupId, ready.processGroupId);
  assert.equal(recoveredProcess.evidence.sigkill_escalated, true);
  assert.equal(store.listProcessRecoveryRecords().length, 0);
  const panic = store.getPanicStatus();
  assert.equal(panic.locked, true);
  assert.equal(panic.recoveryBlocked, false);
  assert.equal(dispatcher.getReadiness().ready, false);

  dispatcher.start();
  assert.equal(await dispatcher.runOnce(), false, 'panic lock must prevent queued claims');
  assert.equal(store.getAction(ready.queuedActionId).state, 'queued');
  store.unlockPanic({ source: 'root_local_recovery_test', activeChildCount: 0 });
  assert.equal(dispatcher.getReadiness().ready, true);
  assert.equal(await dispatcher.runOnce(), true);
  assert.equal(store.getAction(ready.queuedActionId).state, 'completed');
});

test('dispatcher shutdown awaits child termination and durable outcome uncertainty', {
  skip: process.platform !== 'linux' ? 'Linux /proc and process groups are required.' : false,
  timeout: 10000,
}, async () => {
  const store = new PrivilegedActionStore();
  const plan = actionPlan(['/usr/bin/sleep', '60']);
  const action = store.submitAction({
    idempotencyKey: 'job_shutdown_drain',
    jobId: 'job_shutdown_drain',
    callId: 'call-shutdown-drain',
    target: plan.target,
    plan,
    planHash: privilegedActionRequestHash(plan),
    approval: { allowed: true, method: 'shutdown-drain-fixture' },
  }).action;
  const testPolicy = policy();
  testPolicy.adapters.argv.exact_rules.push({ argv: plan.argv, cwd: plan.cwd });
  const dispatcher = new PrivilegedActionDispatcher({
    store,
    policy: testPolicy,
    expectedUid: 0,
    processUid: process.geteuid(),
    terminationGraceMs: 500,
    terminationPollMs: 20,
  });
  const run = dispatcher.runOnce();
  const processRecord = await waitForProcessRecord(store, action.id);
  assert.equal(processExists(processRecord.pid), true);
  const closed = await dispatcher.close();
  await run;
  assert.equal(closed.safeToClose, true);
  assert.equal(processExists(processRecord.pid), false);
  assert.equal(store.getAction(action.id).state, 'outcome_unknown');
  assert.equal(store.listProcessRecoveryRecords().length, 0);
  assert.equal(store.getPanicStatus().locked, true);
  assert.equal(store.getPanicStatus().recoveryBlocked, false);
  store.close();
});

test('a persisted recovery barrier is rechecked and clears only to ordinary panic', {
  skip: process.platform !== 'linux' ? 'Linux /proc is required.' : false,
}, async () => {
  const store = new PrivilegedActionStore();
  store.setRecoveryBarrier({
    reason: 'previous_scan_unavailable',
    details: { scanFailed: true },
  });
  const dispatcher = new PrivilegedActionDispatcher({
    store,
    policy: policy(),
    expectedUid: 0,
    processUid: process.geteuid(),
    processOperations: {
      identity() { return null; },
      scan() { return []; },
      groupExists() { return false; },
      signalGroup() { throw new Error('No process group should be signaled.'); },
    },
  });
  const recovery = await dispatcher.recoverStartup();
  assert.equal(recovery.required, true);
  assert.equal(recovery.quiesced, true);
  assert.equal(store.getPanicStatus().recoveryBlocked, false);
  assert.equal(store.getPanicStatus().locked, true);
  assert.equal(dispatcher.getReadiness().ready, false);
  await dispatcher.close();
  store.close();
});
