'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

test('AGENT_API_URL and AGENT_API_TOKEN override legacy environment names', () => {
  const modulePath = require.resolve('../lib/claude-api-config');
  const original = {
    AGENT_API_URL: process.env.AGENT_API_URL,
    CLAUDE_API_URL: process.env.CLAUDE_API_URL,
    AGENT_API_TOKEN: process.env.AGENT_API_TOKEN,
    CLAUDE_API_TOKEN: process.env.CLAUDE_API_TOKEN,
  };

  process.env.AGENT_API_URL = 'http://agent.example:3333';
  process.env.CLAUDE_API_URL = 'http://legacy.example:3333';
  process.env.AGENT_API_TOKEN = 'neutral-token';
  process.env.CLAUDE_API_TOKEN = 'legacy-token';
  delete require.cache[modulePath];

  const config = require('../lib/claude-api-config');
  assert.equal(config.AGENT_API_URL, 'http://agent.example:3333');
  assert.equal(config.CLAUDE_API_URL, config.AGENT_API_URL);
  assert.equal(config.buildAgentApiHeaders().Authorization, 'Bearer neutral-token');

  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[modulePath];
});
