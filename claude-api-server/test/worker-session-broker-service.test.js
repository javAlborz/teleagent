'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const test = require('node:test');
const {
  FIXED_BROKER_HOME,
  FIXED_BROKER_USER,
  FIXED_BROKER_SOCKET,
  FIXED_PROVIDER_VIEW,
  FIXED_SINGLETON_DB,
  FIXED_STATE_DB,
  FIXED_TMUX_SOCKET,
  FIXED_WORKSPACE_ROOT,
  acquireWorkerSessionSingletonLock,
  assertCredentialFreeEnvironment,
  assertInheritedSocketBoundary,
  inheritedSocketFd,
  lookupSystemGroupGid,
  normalizeWorkerSessionServiceConfig,
  parseInspectionRoots,
  startWorkerSessionBroker,
} = require('../worker-session-broker-service');

function nextMessage(child) {
  return new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== null && code !== 0 && code !== 17) {
        reject(new Error(`lock child exited ${code || signal} before reporting`));
      }
    });
  });
}

function environment(overrides = {}) {
  return {
    HOME: FIXED_BROKER_HOME,
    LISTEN_PID: '4242',
    LISTEN_FDS: '1',
    LISTEN_FDNAMES: 'worker-session-broker',
    WORKER_SESSION_BROKER_SOCKET_PATH: FIXED_BROKER_SOCKET,
    WORKER_SESSION_TMUX_SOCKET_PATH: FIXED_TMUX_SOCKET,
    WORKER_SESSION_DB_PATH: FIXED_STATE_DB,
    WORKER_SESSION_SINGLETON_DB_PATH: FIXED_SINGLETON_DB,
    WORKER_SESSION_PROVIDER_VIEW: FIXED_PROVIDER_VIEW,
    WORKER_SESSION_WORKSPACE_ROOT: FIXED_WORKSPACE_ROOT,
    WORKER_SESSION_INSPECTION_ROOTS: `${FIXED_WORKSPACE_ROOT}/phone`,
    ...overrides,
  };
}

test('service config requires the worker UID contract and one named inherited socket', () => {
  assert.ok(Number.isInteger(lookupSystemGroupGid()));
  const config = normalizeWorkerSessionServiceConfig(environment(), {
    uid: 1234,
    username: FIXED_BROKER_USER,
    pid: 4242,
    controllerGid: 5678,
  });
  assert.equal(config.listenFd, 3);
  assert.equal(config.controllerGid, 5678);
  assert.equal(config.home, FIXED_BROKER_HOME);
  assert.equal(config.providerView, FIXED_PROVIDER_VIEW);
  assert.equal(config.brokerSocket, FIXED_BROKER_SOCKET);
  assert.equal(config.tmuxSocket, FIXED_TMUX_SOCKET);
  assert.deepEqual(config.inspectionRoots, [`${FIXED_WORKSPACE_ROOT}/phone`]);

  assert.throws(() => normalizeWorkerSessionServiceConfig(environment(), {
    uid: 0, username: 'root', pid: 4242, controllerGid: 5678,
  }), /non-root teleagent-session-broker/);
  assert.throws(() => inheritedSocketFd(environment({ LISTEN_FDS: '2' }), 4242), /exactly one/);
  assert.throws(() => normalizeWorkerSessionServiceConfig(
    environment({ WORKER_SESSION_TMUX_SOCKET_PATH: '/tmp/other.sock' }),
    { uid: 1234, username: FIXED_BROKER_USER, pid: 4242, controllerGid: 5678 }
  ), /WORKER_SESSION_TMUX_SOCKET_PATH/);
});

test('inspection roots cannot escape the fixed worker workspace', () => {
  assert.deepEqual(parseInspectionRoots(''), [FIXED_WORKSPACE_ROOT]);
  assert.throws(() => parseInspectionRoots('/home/alborz'), /fixed workspace/);
  assert.throws(() => parseInspectionRoots(`${FIXED_WORKSPACE_ROOT}/../secrets`), /canonical/);
});

test('worker session service refuses provider/controller credentials and loader injection by name', () => {
  assert.doesNotThrow(() => assertCredentialFreeEnvironment(environment()));
  for (const name of [
    'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PRIVILEGED_ACTION_API_TOKEN',
    'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'LD_PRELOAD',
  ]) {
    assert.throws(
      () => assertCredentialFreeEnvironment({ ...environment(), [name]: 'do-not-print-this-value' }),
      (error) => error.message.includes(name) && !error.message.includes('do-not-print')
    );
  }
});

test('real inherited Unix listener validates path metadata and adopts the exact path', async () => {
  const net = require('node:net');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-session-listener-'));
  const socketPath = path.join(directory, 'broker.sock');
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o660);
  try {
    const fd = listener._handle.fd;
    assertInheritedSocketBoundary(fd, socketPath, process.getuid(), process.getgid(), {
      allowTestPath: true,
    });
    const fixture = path.join(__dirname, 'fixtures', 'worker-session-inherited-socket-child.js');
    const child = spawn(process.execPath, [fixture, socketPath], {
      stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), socketPath);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('kernel-backed lifetime lock excludes a second broker until release', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-session-lock-'));
  fs.chmodSync(directory, 0o700);
  const lockPath = path.join(directory, 'lifetime.sqlite');
  const options = { expectedUid: process.getuid(), allowTestPath: true };
  const first = acquireWorkerSessionSingletonLock(lockPath, options);
  assert.throws(
    () => acquireWorkerSessionSingletonLock(lockPath, options),
    /holds the lifetime lock/
  );
  first.release();
  const replacement = acquireWorkerSessionSingletonLock(lockPath, options);
  replacement.release();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a lifetime-lock loser performs no store open, recovery, tmux, or listen work', async () => {
  const calls = [];
  class ForbiddenStore {
    constructor() { calls.push('store'); }
  }
  class ForbiddenInspector {
    constructor() { calls.push('inspector'); }
  }
  await assert.rejects(startWorkerSessionBroker({
    config: {
      uid: 1234,
      controllerGid: 5678,
      listenFd: 3,
      brokerSocket: FIXED_BROKER_SOCKET,
      singletonDb: FIXED_SINGLETON_DB,
      stateDb: FIXED_STATE_DB,
      inspectionRoots: [FIXED_WORKSPACE_ROOT],
      providerView: FIXED_PROVIDER_VIEW,
      tmuxSocket: FIXED_TMUX_SOCKET,
    },
    Store: ForbiddenStore,
    Inspector: ForbiddenInspector,
    assertSocketBoundary() { calls.push('socket_checked'); },
    acquireSingleton() {
      calls.push('lock_attempted');
      throw new Error('Another worker session broker holds the lifetime lock.');
    },
    createBroker() { calls.push('broker'); },
  }), /holds the lifetime lock/);
  assert.deepEqual(calls, ['socket_checked', 'lock_attempted']);
});

test('independent brokers race once and SIGKILL releases the kernel lifetime lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-session-process-lock-'));
  fs.chmodSync(directory, 0o700);
  const lockPath = path.join(directory, 'lifetime.sqlite');
  const auditPath = path.join(directory, 'audit.log');
  const fixture = path.join(__dirname, 'fixtures', 'worker-session-lock-child.js');
  const children = [0, 1].map(() => fork(fixture, [lockPath, auditPath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }));
  try {
    const reports = children.map(nextMessage);
    for (const child of children) child.send('start');
    const results = await Promise.all(reports);
    const winnerIndex = results.findIndex((result) => result.status === 'acquired');
    const loserIndex = results.findIndex((result) => result.status === 'rejected');
    assert.notEqual(winnerIndex, -1, JSON.stringify(results));
    assert.notEqual(loserIndex, -1, JSON.stringify(results));
    assert.match(results[loserIndex].message, /holds the lifetime lock/);

    const audit = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    const loserPid = results[loserIndex].pid;
    assert.deepEqual(
      audit.filter((line) => line.startsWith(`${loserPid}:`)),
      [`${loserPid}:lock_rejected`]
    );

    children[winnerIndex].kill('SIGKILL');
    await new Promise((resolve) => children[winnerIndex].once('exit', resolve));

    const replacement = fork(fixture, [lockPath, auditPath], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const replacementReport = nextMessage(replacement);
    replacement.send('start');
    assert.equal((await replacementReport).status, 'acquired');
    replacement.kill('SIGTERM');
    await new Promise((resolve) => replacement.once('exit', resolve));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
