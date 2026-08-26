import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
