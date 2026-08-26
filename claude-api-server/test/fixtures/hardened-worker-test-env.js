'use strict';

const path = require('node:path');

function hardenedWorkerTestEnvironment() {
  return {
    NODE_ENV: 'test',
    NODE_OPTIONS: `--require=${path.join(__dirname, 'hardened-worker-preload.js')}`,
    TELEAGENT_TEST_HARDENED_WORKER: '1',
    AGENT_CLAUDE_WORKER_USER: 'teleagent-claude-worker',
    AGENT_CODEX_WORKER_USER: 'teleagent-codex-worker',
    WORKER_SESSION_BROKER_ENABLED: 'true',
    WORKER_SESSION_BROKER_SOCKET_PATH: '/run/teleagent-worker-session/broker.sock',
    WORKER_SESSION_BROKER_HEALTH_POLL_MS: '250',
    CLAUDE_MODEL: 'claude-sonnet-5',
    PHONE_CLAUDE_MODEL: 'claude-haiku-4-5-20251001',
    PHONE_HAIKU_CLAUDE_MODEL: 'claude-haiku-4-5-20251001',
    PHONE_SONNET_CLAUDE_MODEL: 'claude-sonnet-5',
    PHONE_OPUS_CLAUDE_MODEL: 'claude-opus-5',
    PHONE_DEPLOY_CLAUDE_MODEL: 'claude-sonnet-5',
    PHONE_CODEX_LUNA_MODEL: 'gpt-5.6-luna',
    PHONE_CODEX_TERRA_MODEL: 'gpt-5.6-terra',
    PHONE_CODEX_SOL_MODEL: 'gpt-5.6-sol',
    PHONE_CODEX_DEPLOY_MODEL: 'gpt-5.6-sol',
    PHONE_CODEX_LUNA_REASONING_EFFORT: 'low',
    PHONE_CODEX_TERRA_REASONING_EFFORT: 'medium',
    PHONE_CODEX_SOL_REASONING_EFFORT: 'high',
    PHONE_CODEX_DEPLOY_REASONING_EFFORT: 'high',
  };
}

module.exports = { hardenedWorkerTestEnvironment };
