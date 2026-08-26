'use strict';
const { TEST_RUNTIME_SECRETS, installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  getAgentTimeoutSeconds,
  getClaudeTimeoutSeconds,
} = require('../lib/phone-agent-config');

test('agentTimeoutSeconds takes precedence over the legacy Claude timeout key', () => {
  const device = {
    agentTimeoutSeconds: 120,
    claudeTimeoutSeconds: 30,
  };

  assert.equal(getAgentTimeoutSeconds(device), 120);
  assert.equal(getClaudeTimeoutSeconds(device), 120);
});

test('legacy timeout configuration remains supported', () => {
  assert.equal(getAgentTimeoutSeconds({ claudeTimeoutSeconds: 45 }), 45);
  assert.equal(getAgentTimeoutSeconds({}), DEFAULT_AGENT_TIMEOUT_SECONDS);
});

test('voice client pins the controller and exposes only executor and voice-control bearers', (t) => {
  const modulePath = require.resolve('../lib/claude-api-config');
  const original = {
    AGENT_API_URL: process.env.AGENT_API_URL,
    CLAUDE_API_URL: process.env.CLAUDE_API_URL,
    AGENT_API_TOKEN: process.env.AGENT_API_TOKEN,
    CLAUDE_API_TOKEN: process.env.CLAUDE_API_TOKEN,
    EXECUTOR_API_TOKEN: process.env.EXECUTOR_API_TOKEN,
    VOICE_CONTROL_TOKEN: process.env.VOICE_CONTROL_TOKEN,
  };

  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[modulePath];
  });

  process.env.AGENT_API_URL = 'http://127.0.0.1:3333';
  delete process.env.CLAUDE_API_URL;
  process.env.AGENT_API_TOKEN = 'neutral-token';
  process.env.CLAUDE_API_TOKEN = 'legacy-token';
  process.env.EXECUTOR_API_TOKEN = 'executor-token';
  process.env.VOICE_CONTROL_TOKEN = 'voice-control-token';
  delete require.cache[modulePath];

  const config = require('../lib/claude-api-config');
  assert.equal(config.AGENT_API_URL, 'http://127.0.0.1:3333');
  assert.equal(config.CLAUDE_API_URL, config.AGENT_API_URL);
  assert.throws(
    () => config.loadAgentApiConfig({ AGENT_API_URL: 'http://agent.example:3333' }),
    (error) => error.code === 'AGENT_API_CONFIG_INVALID'
  );
  assert.throws(
    () => config.loadAgentApiConfig({ CLAUDE_API_URL: 'http://legacy.example:3333' }),
    (error) => error.code === 'AGENT_API_CONFIG_INVALID'
  );
  assert.equal(Object.hasOwn(config, 'buildAgentApiHeaders'), false);
  assert.equal(Object.hasOwn(config, 'buildClaudeApiHeaders'), false);
  assert.equal(
    config.buildExecutorApiHeaders().Authorization,
    `Bearer ${TEST_RUNTIME_SECRETS.executorApiToken}`,
  );
  assert.equal(
    config.buildVoiceControlApiHeaders().Authorization,
    `Bearer ${TEST_RUNTIME_SECRETS.voiceControlToken}`,
  );

  delete process.env.EXECUTOR_API_TOKEN;
  delete process.env.VOICE_CONTROL_TOKEN;
  assert.equal(
    config.buildExecutorApiHeaders().Authorization,
    `Bearer ${TEST_RUNTIME_SECRETS.executorApiToken}`,
  );
  assert.equal(
    config.buildVoiceControlApiHeaders().Authorization,
    `Bearer ${TEST_RUNTIME_SECRETS.voiceControlToken}`,
  );
});

test('voice container explicitly strips general and legacy agent bearers', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
  const voiceService = compose.slice(compose.indexOf('  voice-app:'));
  assert.match(voiceService, /AGENT_API_TOKEN:\s*["']{2}/);
  assert.match(voiceService, /CLAUDE_API_TOKEN:\s*["']{2}/);
});

test('Docker build context excludes credentials, trust keys, and durable databases', () => {
  const dockerIgnore = fs.readFileSync(path.join(__dirname, '..', '..', '.dockerignore'), 'utf8');
  for (const requiredPattern of [
    '**/.env',
    '**/*.pem',
    '**/*.key',
    '**/*.sqlite',
    '**/*.sqlite-*',
    '**/*.sqlite3',
    '**/*.db',
    '**/credentials/**',
  ]) {
    assert.ok(
      dockerIgnore.split(/\r?\n/u).includes(requiredPattern),
      `missing Docker ignore boundary: ${requiredPattern}`,
    );
  }
});
