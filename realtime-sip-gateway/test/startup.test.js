import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runEntrypoint } from '../src/index.js';
import { SipStateStorageError } from '../src/state-storage-boundary.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runGateway(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: process.env.PATH ?? '',
      ...env,
    },
  });
}

test('the checked-in example environment can never make the public gateway ready', () => {
  const result = runGateway(['--env-file=.env.example', 'src/index.js']);
  assert.equal(result.status, 78);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Invalid Realtime SIP gateway configuration/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /gateway listening/u);
});

test('an explicit replace-with API credential exits before binding a listener', () => {
  const result = runGateway(['src/index.js'], {
    OPENAI_API_KEY: 'sk-replace-with-openai-api-key',
    OPENAI_WEBHOOK_SECRET: 'whsec_4V7k2Q9m5N8x1R6z3A0c',
  });
  assert.equal(result.status, 78);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /OPENAI_API_KEY contains an obvious placeholder/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /gateway listening/u);
  assert.doesNotMatch(result.stderr, /sk-replace-with-openai-api-key/u);
});

test('entrypoint runs when invoked through the canonical release symlink', (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'teleagent-sip-entrypoint-'));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  const entrypointLink = path.join(fixtureRoot, 'realtime-sip-gateway-index.js');
  symlinkSync(path.join(packageRoot, 'src/index.js'), entrypointLink);

  const result = runGateway([entrypointLink], {
    OPENAI_API_KEY: 'sk-replace-with-openai-api-key',
    OPENAI_WEBHOOK_SECRET: 'whsec_4V7k2Q9m5N8x1R6z3A0c',
  });

  assert.equal(result.status, 78);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Invalid Realtime SIP gateway configuration/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /gateway listening/u);
});

test('durable-storage startup refusal exits non-restartably before listener setup', async () => {
  const events = [];
  const errors = [];
  const runtimeProcess = {
    exitCode: null,
    exit() {
      assert.fail('startup refusal must not enter shutdown handling');
    },
    once(event) {
      events.push(event);
    },
  };
  const runtimeLogger = {
    error(message) {
      errors.push(message);
    },
    info() {},
  };

  await runEntrypoint({
    createAppImpl: async () => {
      throw new SipStateStorageError(
        'SIP_STATE_CAPACITY_EXHAUSTED',
        'durable state reserve is exhausted',
      );
    },
    loadConfigImpl: () => Object.freeze({}),
    runtimeLogger,
    runtimeProcess,
  });

  assert.equal(runtimeProcess.exitCode, 77);
  assert.deepEqual(events, []);
  assert.deepEqual(errors, ['Realtime SIP canary gateway failed']);
});

test('repeated termination signals allow one bounded graceful close to finish', async (t) => {
  const entrypoint = new URL('../src/index.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { main } from ${JSON.stringify(entrypoint)};
    const keepAlive = setInterval(() => {}, 1000);
    let closes = 0;
    await main({
      loadConfigImpl: () => ({}),
      runtimeLogger: { info() {}, error() { process.exitCode = 1; } },
      createAppImpl: async () => ({
        listen: async () => process.send('ready'),
        close: async () => {
          closes += 1;
          process.send('closing');
          await new Promise(resolve => setTimeout(resolve, 100));
          process.send({ closed: closes });
          clearInterval(keepAlive);
          process.disconnect();
        },
      }),
    });
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH ?? '' } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let closed;
  const result = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('gateway shutdown probe timed out')), 3000);
    child.once('error', reject);
    child.on('message', (message) => {
      if (message === 'ready' || message === 'closing') child.kill('SIGTERM');
      else closed = message;
    });
    child.once('exit', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }); });
  });
  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(closed, { closed: 1 });
});
