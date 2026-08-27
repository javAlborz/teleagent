import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureRuntimeSecrets,
  getRuntimeSecretEnvironment,
  validRuntimeSecret
} from '../lib/runtime-security.js';

test('runtime secret migration rejects placeholders and duplicate scopes', () => {
  const shared = 'a'.repeat(64);
  const config = {
    secrets: {
      agentApi: 'replace-with-known-example-token-at-least-32-bytes',
      executorApi: shared,
      voiceControl: shared,
      privilegedActionApi: 'changeme-but-this-string-is-definitely-long-enough',
      outboundApi: ''
    }
  };

  const result = ensureRuntimeSecrets(config);
  const environment = getRuntimeSecretEnvironment(config);
  const values = Object.values(environment);

  assert.equal(result.changed, true);
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.every(validRuntimeSecret));
  assert.ok(values.every((value) => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(Object.hasOwn(config.secrets, 'privilegedActionApi'), false);
  assert.equal(Object.hasOwn(environment, 'PRIVILEGED_ACTION_API_TOKEN'), false);
  assert.equal(ensureRuntimeSecrets(config).changed, false);
});

test('split deployments can persist an explicitly provisioned shared credential set', () => {
  const environment = {
    AGENT_API_TOKEN: '1'.repeat(64),
    EXECUTOR_API_TOKEN: '2'.repeat(64),
    VOICE_CONTROL_TOKEN: '3'.repeat(64),
    OUTBOUND_API_TOKEN: '5'.repeat(64)
  };
  const config = { secrets: {} };

  assert.equal(ensureRuntimeSecrets(config, environment).changed, true);
  assert.deepEqual(getRuntimeSecretEnvironment(config), environment);
  assert.equal(Object.hasOwn(config.secrets, 'privilegedActionApi'), false);
});
