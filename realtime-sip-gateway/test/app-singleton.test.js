import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.js';
import { acquireGatewaySingleton, gatewaySingletonPath } from '../src/gateway-singleton.js';
import {
  createSipStateStorageGuard,
  SipStateStorageError,
  SIP_STATE_DATABASE,
  SIP_STATE_MARKER_CREDENTIAL,
} from '../src/state-storage-boundary.js';
import { alwaysAdmittedStorageGuard, makeConfig, silentLogger } from './helpers.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function temporaryState(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-app-singleton-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'gateway-state.sqlite3');
}

function fakeStateStore(counters = {}) {
  return {
    async init() {
      counters.init = (counters.init ?? 0) + 1;
    },
    async close() {
      counters.close = (counters.close ?? 0) + 1;
    },
  };
}

function fakeGateway(counters = {}) {
  return {
    async recover() {
      counters.recover = (counters.recover ?? 0) + 1;
    },
    async close() {
      counters.close = (counters.close ?? 0) + 1;
      return { quiesced: true };
    },
  };
}

function nextMessage(child) {
  return new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`singleton holder exited before reporting: ${code ?? signal}`));
    });
  });
}

test('a duplicate app is fenced before state init, recovery, or provider activity', async (t) => {
  const stateDatabasePath = temporaryState(t);
  const firstCounters = {};
  const first = await createApp({
    config: makeConfig({ stateDatabasePath }),
    logger: silentLogger,
    callService: {},
    stateStore: fakeStateStore(firstCounters),
    callGateway: fakeGateway(firstCounters),
    storageGuard: alwaysAdmittedStorageGuard,
  });
  t.after(() => first.close());

  const duplicateCounters = {};
  await assert.rejects(
    () => createApp({
      config: makeConfig({ stateDatabasePath }),
      logger: silentLogger,
      callService: new Proxy({}, {
        get() {
          duplicateCounters.providerAccess = (duplicateCounters.providerAccess ?? 0) + 1;
          return undefined;
        },
      }),
      stateStore: fakeStateStore(duplicateCounters),
      callGateway: fakeGateway(duplicateCounters),
      storageGuard: alwaysAdmittedStorageGuard,
    }),
    /kernel-backed singleton lock/u,
  );
  assert.deepEqual(duplicateCounters, {});

  await first.close();
  const replacementCounters = {};
  const replacement = await createApp({
    config: makeConfig({ stateDatabasePath }),
    logger: silentLogger,
    callService: {},
    stateStore: fakeStateStore(replacementCounters),
    callGateway: fakeGateway(replacementCounters),
    storageGuard: alwaysAdmittedStorageGuard,
  });
  assert.equal(replacementCounters.init, 1);
  assert.equal(replacementCounters.recover, 1);
  await replacement.close();
});

test('capacity refusal precedes the lifetime lock, state init, and recovery', async (t) => {
  const stateDatabasePath = temporaryState(t);
  const counters = {};
  await assert.rejects(() => createApp({
    config: makeConfig({ stateDatabasePath }),
    logger: silentLogger,
    callService: {},
    stateStore: fakeStateStore(counters),
    callGateway: fakeGateway(counters),
    storageGuard: {
      assertOpen() {
        throw new SipStateStorageError(
          'SIP_STATE_CAPACITY_EXHAUSTED',
          'test capacity refusal',
          { phase: 'sqlite_open' },
        );
      },
      assertNewRecord() { assert.fail('new-record admission must not run'); },
      inspect: () => ({ admitted: false }),
    },
  }), { code: 'SIP_STATE_CAPACITY_EXHAUSTED' });
  assert.equal(fs.existsSync(gatewaySingletonPath(stateDatabasePath)), false);
  assert.deepEqual(counters, {});
});

test('direct production startup refuses a missing initialization marker before provider activity', async () => {
  const counters = {};
  await assert.rejects(() => createApp({
    config: makeConfig({ stateDatabasePath: SIP_STATE_DATABASE }),
    logger: silentLogger,
    callService: new Proxy({}, {
      get() {
        counters.providerAccess = (counters.providerAccess ?? 0) + 1;
        return undefined;
      },
    }),
    stateStore: fakeStateStore(counters),
    callGateway: fakeGateway(counters),
    createStorageGuard: () => createSipStateStorageGuard({
      expectedUid: 991,
      expectedGid: 992,
      markerPath: SIP_STATE_MARKER_CREDENTIAL,
      inspect: () => ({ admitted: true }),
      inspectInitialization: () => {
        throw new SipStateStorageError(
          'SIP_STATE_INITIALIZATION_INVALID',
          'root-authored initialization marker is absent',
        );
      },
    }),
  }), { code: 'SIP_STATE_INITIALIZATION_INVALID' });
  assert.deepEqual(counters, {});
});

test('a process crash releases the kernel singleton for exactly one replacement', async (t) => {
  const stateDatabasePath = temporaryState(t);
  const fixture = path.join(testDirectory, 'fixtures', 'gateway-singleton-holder.js');
  const child = fork(fixture, [stateDatabasePath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => child.kill('SIGKILL'));
  assert.deepEqual(await nextMessage(child), { status: 'acquired' });

  assert.throws(
    () => acquireGatewaySingleton({ stateDatabasePath }),
    /kernel-backed singleton lock/u,
  );
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const replacement = acquireGatewaySingleton({ stateDatabasePath });
  replacement.release();
});

test('production singleton mode refuses a missing initialized lock instead of recreating it', (t) => {
  const stateDatabasePath = temporaryState(t);
  const lockPath = gatewaySingletonPath(stateDatabasePath);
  assert.throws(
    () => acquireGatewaySingleton({ stateDatabasePath, requireExisting: true }),
    { code: 'ENOENT' },
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test('singleton replacement between checked descriptor and SQLite open is refused', (t) => {
  const stateDatabasePath = temporaryState(t);
  const lockPath = gatewaySingletonPath(stateDatabasePath);
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  const replacementPath = `${lockPath}.replacement`;
  fs.writeFileSync(replacementPath, '', { mode: 0o600 });
  fs.chmodSync(replacementPath, 0o600);
  const initialized = fs.statSync(lockPath, { bigint: true });
  let databaseClosed = false;
  const storageGuard = {
    assertFileIdentity() {
      const current = fs.statSync(lockPath, { bigint: true });
      if (current.ino !== initialized.ino) {
        throw new SipStateStorageError(
          'SIP_STATE_INITIALIZATION_INVALID',
          'singleton replacement detected',
        );
      }
      return initialized;
    },
  };

  assert.throws(() => acquireGatewaySingleton({
    stateDatabasePath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    requireExisting: true,
    storageGuard,
    databaseFactory() {
      fs.renameSync(replacementPath, lockPath);
      return {
        close() { databaseClosed = true; },
      };
    },
  }), /singleton replacement detected|changed during SQLite open/u);
  assert.equal(databaseClosed, true);
});

test('a failed close retains ownership and is retryable before replacement starts', async (t) => {
  const stateDatabasePath = temporaryState(t);
  const counters = {};
  let closeAllowed = false;
  const gateway = {
    async recover() {
      counters.recover = (counters.recover ?? 0) + 1;
    },
    async close() {
      counters.gatewayClose = (counters.gatewayClose ?? 0) + 1;
      if (!closeAllowed) throw new Error('provider call cleanup is unconfirmed');
      return { quiesced: true };
    },
  };
  const stateStore = fakeStateStore(counters);
  const app = await createApp({
    config: makeConfig({ stateDatabasePath }),
    logger: silentLogger,
    callService: {},
    stateStore,
    callGateway: gateway,
    storageGuard: alwaysAdmittedStorageGuard,
  });

  await assert.rejects(() => app.close(), /cleanup is unconfirmed/u);
  assert.equal(counters.gatewayClose, 1);
  assert.equal(counters.close ?? 0, 0, 'state must remain open for gateway retry');
  assert.throws(
    () => acquireGatewaySingleton({ stateDatabasePath }),
    /kernel-backed singleton lock/u,
  );
  await assert.rejects(() => app.listen(), /cannot listen after close has started/u);

  closeAllowed = true;
  const result = await app.close();
  assert.equal(result.quiesced, true);
  assert.equal(counters.gatewayClose, 2);
  assert.equal(counters.close, 1);

  const replacement = acquireGatewaySingleton({ stateDatabasePath });
  replacement.release();
});
