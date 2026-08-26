'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPrivilegedActionProxy } = require('../../claude-api-server/privileged-action-proxy');
const { acquireBrokerSingletonLock, createPrivilegedActionServer } = require('../server');

function fixture(t, { panic = { locked: false, recoveryBlocked: false }, readinessProvider = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privileged-broker-test-'));
  fs.chmodSync(directory, 0o750);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'broker.sock');
  const actions = new Map();
  const broker = {
    submit(body) {
      const action = {
        id: 'pact_test', idempotencyKey: body.idempotencyKey,
        state: 'queued', terminal: false,
      };
      actions.set(body.idempotencyKey, action);
      return { created: true, action };
    },
    getAction() { return actions.values().next().value || null; },
    getByIdempotencyKey(key) { return actions.get(key) || null; },
    cancel() { return { changed: true, action: { state: 'canceled', terminal: true } }; },
    cancelByIdempotency() { return { tombstoned: true, created: true }; },
    panic() { return { panic: { locked: true }, actionIds: [] }; },
  };
  const store = { getPanicStatus() { return panic; } };
  const server = createPrivilegedActionServer({
    broker,
    store,
    socketPath,
    expectedUid: process.geteuid(),
    controllerGid: process.getegid(),
    readinessProvider,
  });
  return { actions, server, socketPath };
}

function unixRequest(socketPath, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method: 'GET' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function nextChildMessage(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for lock contender.')), timeoutMs);
    child.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('private Unix broker and controller proxy forward exact actions without a socket mount in voice', async (t) => {
  const { actions, server, socketPath } = fixture(t);
  await server.listen();
  t.after(() => server.close());
  const proxy = createPrivilegedActionProxy({ socketPath, timeoutMs: 1000 });
  const response = await proxy.submit({
    idempotencyKey: 'job_proxy',
    jobId: 'job_proxy',
    callId: 'call-proxy',
    plan: { exact: true },
    authorization: { capability: 'bearer-confined-to-forwarding-request' },
  });
  assert.equal(response.status, 202);
  assert.equal(response.payload.action.id, 'pact_test');
  assert.equal(actions.get('job_proxy').authorization, undefined);
  const recovered = await proxy.getByIdempotencyKey('job_proxy');
  assert.equal(recovered.payload.action.id, 'pact_test');
});

test('broker refuses to unlink or replace a live socket', async (t) => {
  const first = fixture(t);
  await first.server.listen();
  t.after(() => first.server.close());
  const second = createPrivilegedActionServer({
    broker: { submit() {} },
    store: { getPanicStatus() { return { locked: false }; } },
    socketPath: first.socketPath,
    expectedUid: process.geteuid(),
    controllerGid: process.getegid(),
  });
  await assert.rejects(() => second.listen(), /already listening/);
  assert.equal(fs.statSync(first.socketPath).isSocket(), true);
});

test('health is 503 while recovery is unresolved or persistent panic remains locked', async (t) => {
  const blocked = fixture(t, {
    panic: { locked: true, recoveryBlocked: true },
    readinessProvider: () => ({
      ready: false,
      recoveryAttempted: true,
      recoveryResolved: false,
      panicLocked: true,
      recoveryBlocked: true,
    }),
  });
  await blocked.server.listen();
  t.after(() => blocked.server.close());
  const response = await unixRequest(blocked.socketPath, '/health');
  assert.equal(response.status, 503);
  assert.equal(response.payload.success, false);
  assert.equal(response.payload.ready, false);
  assert.equal(response.payload.panic.recoveryBlocked, true);
});

test('singleton lock fences recovery before a second broker can inspect or kill children', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privileged-broker-lock-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, 'broker.sock.lock');
  const first = acquireBrokerSingletonLock(lockPath, { expectedUid: process.geteuid() });
  assert.throws(
    () => acquireBrokerSingletonLock(lockPath, { expectedUid: process.geteuid() }),
    /kernel-backed singleton lock/
  );
  first.release();
  const replacement = acquireBrokerSingletonLock(lockPath, { expectedUid: process.geteuid() });
  replacement.release();
});

test('two processes racing a stale singleton database allow exactly one recovery owner', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privileged-broker-lock-race-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, 'broker.lock.sqlite3');
  fs.closeSync(fs.openSync(lockPath, 'wx', 0o600));
  const fixturePath = path.join(__dirname, 'fixtures', 'singleton-lock-runner.js');
  const contenders = [0, 1].map(() => fork(fixturePath, [lockPath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }));
  t.after(() => {
    for (const contender of contenders) contender.kill('SIGKILL');
  });
  const responses = contenders.map((contender) => nextChildMessage(contender));
  for (const contender of contenders) contender.send('go');
  const results = await Promise.all(responses);
  assert.deepEqual(results.map((result) => result.status).sort(), ['acquired', 'blocked']);
  assert.equal(results.some((result) => result.status === 'error'), false);
  const winner = contenders[results.findIndex((result) => result.status === 'acquired')];
  winner.send('release');
});
