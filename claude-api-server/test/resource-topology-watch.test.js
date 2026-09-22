'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { beginTopologyObservation } = require('../../deploy/worker-session/teleagent-resource-admission');
const execute = promisify(execFile);
const fixture = path.join(__dirname, 'fixtures/resource-topology-watch-fixture.py');
const helper = '/usr/local/libexec/teleagent-resource-topology-watch';
const boot = '11111111-2222-3333-4444-555555555555\n';

function metadata() {
  return { lstatSync: (name) => ({ uid: 0, gid: 0, nlink: 1,
    mode: name === helper ? 0o100555 : 0o40755,
    isDirectory: () => name !== helper, isFile: () => name === helper }),
  realpathSync: (name) => name };
}

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-topology-'));
  fs.mkdirSync(path.join(root, 'existing'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'existing/nested'), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(root) {
  const eventInventory = new Map();
  function visit(relative) {
    const filename = path.join(root, relative);
    const value = fs.statSync(filename, { bigint: true });
    eventInventory.set(relative, { identity: `${value.dev}:${value.ino}` });
    for (const name of fs.readdirSync(filename)) visit(relative ? `${relative}/${name}` : name);
  }
  visit('');
  return { boot, eventInventory };
}

async function observer(root, mode = 'valid') {
  let child;
  const watch = await beginTopologyObservation({ fileSystem: metadata(), launch(command, args, options) {
    assert.equal(command, '/usr/bin/python3');
    assert.deepEqual(args, ['-I', helper]);
    assert.deepEqual(options.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
    assert.equal(options.cwd, '/');
    child = spawn(command, ['-I', fixture, root, mode], options);
    return child;
  } });
  return { watch, child };
}

test('real raw-inotify witness binds boot and all retained identities and requires clean final receipt', async (t) => {
  const root = directory(t);
  const { watch, child } = await observer(root);
  try {
    watch.assertSnapshot(snapshot(root));
    await watch.finish();
    assert.equal(child.exitCode, 0);
    await assert.rejects(watch.finish(), { code: 'RESOURCE_TOPOLOGY_UNCONFIRMED' });
  } finally { await watch.cleanup(); }
});

test('witness refuses wrong boot, incomplete inventory and mismatched directory identity', async (t) => {
  const root = directory(t);
  for (const mutation of [(s) => { s.boot = 'different'; },
    (s) => s.eventInventory.delete('existing/nested'),
    (s) => { s.eventInventory.get('existing').identity = '1:2'; }]) {
    const { watch } = await observer(root);
    try {
      const value = snapshot(root); mutation(value);
      assert.throws(() => watch.assertSnapshot(value), { code: 'RESOURCE_TOPOLOGY_UNCONFIRMED' });
    } finally { await watch.cleanup(); }
  }
});

test('a nested directory created and removed entirely between samples still refuses', async (t) => {
  const root = directory(t);
  const before = snapshot(root);
  const { watch } = await observer(root);
  try {
    watch.assertSnapshot(before);
    const transient = path.join(root, 'existing/nested/transient');
    fs.mkdirSync(transient); fs.rmdirSync(transient);
    assert.deepEqual(snapshot(root), before, 'both snapshots have identical names and dev:ino values');
    await assert.rejects(watch.finish(), { code: 'RESOURCE_TOPOLOGY_UNCONFIRMED' });
  } finally { await watch.cleanup(); }
});

test('rename and attribute changes poison the existing observation', async (t) => {
  for (const change of [
    (root) => fs.renameSync(path.join(root, 'existing/nested'), path.join(root, 'existing/moved')),
    (root) => fs.chmodSync(path.join(root, 'existing/nested'), 0o750),
  ]) {
    const root = directory(t);
    const { watch } = await observer(root);
    try {
      change(root);
      await assert.rejects(watch.finish(), { code: 'RESOURCE_TOPOLOGY_UNCONFIRMED' });
    } finally { await watch.cleanup(); }
  }
});

test('malformed or missing receipts, extra output and observer death cannot admit', async (t) => {
  const root = directory(t);
  for (const mode of ['partial', 'crash', 'wrong-nonce', 'no-receipt', 'duplicate', 'extra-byte', 'receipt-crash']) {
    await assert.rejects(async () => {
      const { watch } = await observer(root, mode);
      try { await watch.finish(); } finally { await watch.cleanup(); }
    }, { code: 'RESOURCE_TOPOLOGY_UNCONFIRMED' }, mode);
  }
});

test('parent deadline kills and reaps an unresponsive witness', async (t) => {
  const root = directory(t);
  const { watch, child } = await observer(root, 'stall');
  const started = Date.now();
  try { await assert.rejects(watch.finish(), { code: 'RESOURCE_TOPOLOGY_UNCONFIRMED' }); }
  finally { await watch.cleanup(); }
  assert.equal(child.signalCode, 'SIGKILL');
  assert.ok(Date.now() - started < 4000);
});

test('injected raw overflow, ignored, unmount, EOF and read errors plus real setup churn refuse', async () => {
  const result = await execute('/usr/bin/python3', ['-I', fixture, 'selftest'], { timeout: 3000 });
  assert.match(result.stdout, /setup churn refused/);
  assert.match(result.stdout, /inherited FD closed/);
});

test('observer independently expires and is reaped without a parent timeout', async (t) => {
  const root = directory(t);
  const result = await execute('/usr/bin/python3', ['-I', fixture, root, 'self-deadline'], { timeout: 5000 });
  assert.match(result.stdout, /independent helper deadline refused and reaped/);
});

test('coordinator death terminates the exact observer generation and fixture reaps it', async (t) => {
  const root = directory(t);
  const result = await execute('/usr/bin/python3', ['-I', fixture, root, 'parent-death'], { timeout: 4000 });
  assert.match(result.stdout, /parent-death observer reaped/);
});

test('missing or replaceable fixed helper refuses before process creation, without fallback', async () => {
  let starts = 0;
  const launch = () => { starts += 1; throw new Error('must not spawn'); };
  const absent = metadata();
  absent.lstatSync = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  await assert.rejects(beginTopologyObservation({ fileSystem: absent, launch }), { code: 'ENOENT' });
  for (const override of [{ uid: 1000 }, { nlink: 2 }, { mode: 0o100755 }]) {
    const unsafe = metadata();
    const original = unsafe.lstatSync;
    unsafe.lstatSync = (name) => name === helper ? { ...original(name), ...override } : original(name);
    await assert.rejects(beginTopologyObservation({ fileSystem: unsafe, launch }),
      { code: 'RESOURCE_TOPOLOGY_HELPER_UNSAFE' });
  }
  assert.equal(starts, 0);
});
