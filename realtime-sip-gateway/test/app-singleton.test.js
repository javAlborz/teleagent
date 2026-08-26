import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.js';
import { acquireGatewaySingleton } from '../src/gateway-singleton.js';
import { makeConfig, silentLogger } from './helpers.js';

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
  });
  assert.equal(replacementCounters.init, 1);
  assert.equal(replacementCounters.recover, 1);
  await replacement.close();
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
