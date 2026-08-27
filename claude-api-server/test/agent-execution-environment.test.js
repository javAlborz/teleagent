'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAgentExecutionEnvironment,
  isSensitiveEnvironmentKey,
} = require('../../lib/agent-execution-environment');

test('recognizes generic secret-bearing names without deleting ordinary runtime settings', () => {
  for (const key of [
    'GH_TOKEN',
    'CUSTOM_API_KEY',
    'DATABASE_PASSWORD',
    'SERVICE_PRIVATE_KEY',
    'SSH_AUTH_SOCK',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    assert.equal(isSensitiveEnvironmentKey(key), true, key);
  }

  for (const key of ['PATH', 'HOME', 'LANG', 'TERM', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
    assert.equal(isSensitiveEnvironmentKey(key), false, key);
  }
});

test('sanitizes a child environment and supports a narrow explicit override', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/var/lib/teleagent-worker',
    API_TOKEN: 'drop-me',
    REQUIRED_TEST_TOKEN: 'keep-me-for-test',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
  };

  assert.deepEqual(buildAgentExecutionEnvironment(source), {
    PATH: '/usr/bin',
    HOME: '/var/lib/teleagent-worker',
  });
  assert.deepEqual(buildAgentExecutionEnvironment(source, {
    preserveKeys: ['REQUIRED_TEST_TOKEN'],
  }), {
    PATH: '/usr/bin',
    HOME: '/var/lib/teleagent-worker',
    REQUIRED_TEST_TOKEN: 'keep-me-for-test',
  });
});
