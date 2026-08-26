'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  PrivilegedActionDispatcher,
  PROCESS_MARKER_NAME,
  outputCollector,
  persistedExecution,
  runExactProcess,
  validateExecutionBoundary,
} = require('../executor');
const {
  buildPrivilegedActionPlan,
  privilegedActionRequestHash,
} = require('../../lib/privileged-action-plan');
const { PrivilegedActionStore } = require('../store');
const { actionPlan, policy } = require('./helpers');

function queue(store, plan) {
  return store.submitAction({
    idempotencyKey: `job_${Math.random().toString(16).slice(2)}`,
    jobId: `job_${Math.random().toString(16).slice(2)}`,
    callId: 'call-test',
    target: plan.target,
    plan,
    planHash: privilegedActionRequestHash(plan),
    approval: { allowed: true, method: 'test' },
  }).action;
}

function spawnWithOutput(stdoutText, stderrText = '', exitCode = 0) {
  let current = null;
  let live = false;
  const spawnImpl = (_filename, _argv, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const marker = options.env[PROCESS_MARKER_NAME];
    current = {
      pid: child.pid,
      uid: process.geteuid(),
      processGroupId: child.pid,
      processStartTicks: '123456',
      processState: 'R',
      environmentReadable: true,
      staticMarker: true,
      markerHash: crypto.createHash('sha256').update(marker).digest('hex'),
    };
    live = true;
    process.nextTick(() => {
      if (stdoutText) child.stdout.emit('data', Buffer.from(stdoutText));
      if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
      live = false;
      child.emit('close', exitCode, null);
    });
    return child;
  };
  spawnImpl.processOperations = {
    identity(pid) { return live && pid === current?.pid ? current : null; },
    scan() { return live && current ? [current] : []; },
    groupExists(processGroupId) {
      return live && processGroupId === current?.processGroupId;
    },
    signalGroup() { live = false; },
  };
  return spawnImpl;
}

test('exact process uses fixed environment and never invokes a shell', async () => {
  process.env.TELEAGENT_TEST_SECRET = 'must-not-cross-boundary';
  const result = await runExactProcess(['/usr/bin/env'], { cwd: '/', timeoutSeconds: 5 });
  delete process.env.TELEAGENT_TEST_SECRET;
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout.text, /TELEAGENT_TEST_SECRET/);
  assert.match(result.stdout.text, /PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
});

test('output is bounded and persists as digest metadata even if a legacy caller requests preview', () => {
  const collector = outputCollector(4096);
  collector.push(Buffer.from([
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'password=hunter2',
    'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'private material',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n')));
  const output = collector.value();
  assert.doesNotMatch(output.text, /hunter2|ABCDEFGHIJKLMNOPQRSTUVWXYZ123456|private material/);
  assert.equal(output.redacted, true);
  const hidden = persistedExecution({
    exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1,
    stdout: output, stderr: output,
  });
  assert.equal(hidden.stdout.preview, undefined);
  assert.match(hidden.stdout.sha256, /^[a-f0-9]{64}$/);
  const visible = persistedExecution({
    exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1,
    stdout: output, stderr: output,
  }, { preview: true });
  assert.equal(visible.stdout.preview, undefined);
  assert.doesNotMatch(JSON.stringify(visible), /hunter2|ABCDEFGHIJKLMNOPQRSTUVWXYZ123456|private material/);
});

test('nonzero exit after spawn is outcome_unknown and never ordinary failed', async () => {
  const store = new PrivilegedActionStore();
  const plan = actionPlan(['/usr/bin/false']);
  const action = queue(store, plan);
  const dispatcher = new PrivilegedActionDispatcher({
    store,
    policy: policy(),
    spawnImpl: spawnWithOutput('', '', 1),
    pollMs: 25,
  });
  await dispatcher.runOnce();
  const terminal = store.getAction(action.id);
  assert.equal(terminal.state, 'outcome_unknown');
  assert.equal(terminal.errorCode, 'PRIVILEGED_ACTION_EXIT_NONZERO_OUTCOME_UNKNOWN');
  assert.equal(terminal.result.outcome_unknown, true);
  store.close();
});

test('a failed durable spawn-stage write stops the child and remains outcome_unknown', async () => {
  const store = new PrivilegedActionStore();
  const plan = actionPlan(['/usr/bin/true']);
  const action = queue(store, plan);
  store.recordProcessSpawned = () => {
    throw new Error('injected durable spawn record failure');
  };
  const dispatcher = new PrivilegedActionDispatcher({ store, policy: policy(), pollMs: 25 });
  const startedAt = Date.now();
  await dispatcher.runOnce();
  const terminal = store.getAction(action.id);
  assert.equal(terminal.state, 'outcome_unknown');
  assert.equal(terminal.errorCode, 'PRIVILEGED_ACTION_OUTCOME_UNKNOWN');
  assert.equal(terminal.result.outcome_unknown, true);
  assert.ok(Date.now() - startedAt < 5000, 'spawned child should be terminated promptly');
  store.close();
});

test('high-risk argv output remains digest-only even if legacy policy requests persistence', async () => {
  const plan = actionPlan(['/usr/bin/printf', 'hello']);
  const hiddenStore = new PrivilegedActionStore();
  const hiddenAction = queue(hiddenStore, plan);
  const hiddenDispatcher = new PrivilegedActionDispatcher({
    store: hiddenStore, policy: policy(), spawnImpl: spawnWithOutput('hello'), pollMs: 25,
  });
  await hiddenDispatcher.runOnce();
  const hidden = hiddenStore.getAction(hiddenAction.id);
  assert.equal(hidden.state, 'completed');
  assert.equal(hidden.result.execution.stdout.preview, undefined);
  assert.match(hidden.result.execution.stdout.sha256, /^[a-f0-9]{64}$/);
  hiddenStore.close();

  const legacyPolicy = policy();
  legacyPolicy.adapters.argv.persist_output = true;
  const legacyStore = new PrivilegedActionStore();
  const legacyAction = queue(legacyStore, plan);
  const legacyDispatcher = new PrivilegedActionDispatcher({
    store: legacyStore,
    policy: legacyPolicy,
    spawnImpl: spawnWithOutput('hello'),
    pollMs: 25,
  });
  await legacyDispatcher.runOnce();
  const legacyResult = legacyStore.getAction(legacyAction.id).result.execution.stdout;
  assert.equal(legacyResult.preview, undefined);
  assert.match(legacyResult.sha256, /^[a-f0-9]{64}$/);
  legacyStore.close();
});

test('typed privileged reads never persist or return arbitrary secret-bearing output', async () => {
  const secret = 'root:$6$not-a-regex-token:token-that-must-never-reach-voice';
  const plans = [
    buildPrivilegedActionPlan({
      adapter: 'systemctl', action: 'status', unit: 'teleagent.service',
    }),
    buildPrivilegedActionPlan({
      adapter: 'journalctl', unit: 'teleagent.service', lines: 20,
    }),
  ];
  for (const plan of plans) {
    const store = new PrivilegedActionStore();
    const action = queue(store, plan);
    const dispatcher = new PrivilegedActionDispatcher({
      store,
      policy: policy(),
      spawnImpl: spawnWithOutput(secret, `stderr:${secret}`),
      pollMs: 25,
    });
    await dispatcher.runOnce();
    const terminal = store.getAction(action.id);
    assert.equal(terminal.state, 'completed');
    assert.doesNotMatch(JSON.stringify(terminal), new RegExp(secret.replaceAll('$', '\\$')));
    assert.equal(terminal.result.execution.stdout.preview, undefined);
    assert.equal(terminal.result.execution.stderr.preview, undefined);
    assert.match(terminal.result.execution.stdout.sha256, /^[a-f0-9]{64}$/);
    store.close();
  }
});

test('execution boundary revalidates canonical root-owned executable and cwd', () => {
  const plan = actionPlan();
  assert.deepEqual(validateExecutionBoundary(plan, policy(), { expectedUid: 0 }), plan);
  const unsafePolicy = policy();
  unsafePolicy.adapters.argv.allowed_executable_roots = ['/tmp'];
  unsafePolicy.adapters.argv.exact_rules = [];
  assert.throws(() => validateExecutionBoundary(plan, unsafePolicy, { expectedUid: 0 }), {
    code: 'PRIVILEGED_ACTION_DENIED',
  });
});
