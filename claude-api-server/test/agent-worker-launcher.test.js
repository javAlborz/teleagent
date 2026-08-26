'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWorkerConfig,
  wrapAgentInvocation,
} = require('../agent-worker-launcher');

const acceptSecurePaths = () => {};
const workers = (overrides = {}) => ({
  AGENT_CLAUDE_WORKER_USER: 'teleagent-claude-worker',
  AGENT_CODEX_WORKER_USER: 'teleagent-codex-worker',
  ...overrides,
});

test('worker isolation defaults fail closed and legacy rollback is explicit', () => {
  assert.deepEqual(normalizeWorkerConfig({}), {
    enabled: false,
    hardened: false,
    legacySameUidEnabled: false,
    readinessCode: 'AGENT_PROVIDER_WORKERS_REQUIRED',
  });
  assert.deepEqual(normalizeWorkerConfig({
    AGENT_WORKER_LEGACY_SAME_UID_ENABLED: 'true',
  }), {
    enabled: false,
    hardened: false,
    legacySameUidEnabled: true,
    readinessCode: 'AGENT_WORKER_LEGACY_ROLLBACK_ACTIVE',
  });
  assert.throws(() => normalizeWorkerConfig(workers({
    AGENT_WORKER_LEGACY_SAME_UID_ENABLED: 'true',
  })), /cannot be combined/);
  assert.throws(() => normalizeWorkerConfig(workers({
    AGENT_CODEX_WORKER_USER: 'root',
  })), /teleagent-codex-worker/);
  assert.throws(() => normalizeWorkerConfig(workers({
    AGENT_CLAUDE_WORKER_HOME: 'relative',
  })), /absolute path/);
  assert.throws(() => normalizeWorkerConfig(workers({
    AGENT_WORKER_PATH: '/opt/teleagent/agent-tools::/usr/bin',
  }), { validateDeploymentPath: acceptSecurePaths }), /empty entry/);
  assert.throws(() => normalizeWorkerConfig({
    AGENT_WORKER_USER: 'teleagent-worker',
  }), /unsafe and obsolete/);
});

test('wrapper never falls back to controller UID, including rollback diagnostics mode', () => {
  const invocation = {
    command: '/usr/bin/claude',
    args: ['-p'],
    cwd: '/srv/teleagent-agent-workspaces/phone',
    provider: 'claude',
    accessMode: 'read-only',
  };
  assert.throws(
    () => wrapAgentInvocation(invocation, { config: normalizeWorkerConfig({}) }),
    { code: 'AGENT_WORKER_ISOLATION_REQUIRED' }
  );
  assert.throws(() => wrapAgentInvocation(invocation, {
    config: normalizeWorkerConfig({ AGENT_WORKER_LEGACY_SAME_UID_ENABLED: 'true' }),
  }), { code: 'AGENT_WORKER_ISOLATION_REQUIRED' });
});

test('isolated invocation crosses the narrow supervisor client with an empty fixed environment', () => {
  const config = normalizeWorkerConfig(workers({
    AGENT_WORKER_PATH: '/opt/teleagent/agent-tools:/usr/bin',
  }), { validateDeploymentPath: acceptSecurePaths });
  const wrapped = wrapAgentInvocation({
    command: '/opt/teleagent/agent-tools/codex',
    args: ['--model', 'gpt-5.6-sol', 'exec', '-'],
    cwd: '/srv/teleagent-agent-workspaces/homelab',
    env: {
      OPENAI_REALTIME_API_KEY: 'must-not-cross',
      AGENT_API_TOKEN: 'must-not-cross-either',
    },
    stdinInput: 'Inspect the cluster.',
    provider: 'codex',
    accessMode: 'read-only',
  }, { config, taskId: 'job_abc123' });

  assert.equal(wrapped.command, '/usr/local/libexec/teleagent-provider-supervisor-client');
  assert.deepEqual(wrapped.env, {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  });
  assert.deepEqual(wrapped.args.slice(0, 2), ['--provider', 'codex']);
  assert.ok(wrapped.args.includes('codex'));
  assert.ok(wrapped.args.includes('--workspace'));
  assert.ok(wrapped.args.includes('job_abc123'));
  assert.equal(wrapped.args.includes('/usr/bin/env'), false);
  assert.equal(wrapped.args.includes('/usr/bin/sudo'), false);
  assert.equal(wrapped.args.includes('/opt/teleagent/agent-tools/codex'), false);
  assert.equal(wrapped.args.join('\n').includes('must-not-cross'), false);
  assert.equal(wrapped.stdinInput, 'Inspect the cluster.');
  assert.equal(wrapped.cwd, '/');
  assert.equal(wrapped.isolatedWorker, true);
  assert.equal(wrapped.workerHome, '/nonexistent/teleagent-codex-worker');
  assert.ok(wrapped.args.includes('--mode'));
  assert.ok(wrapped.args.includes('managed'));
});

test('Claude and Codex always cross into distinct provider identities and homes', () => {
  const config = normalizeWorkerConfig(workers(), {
    validateDeploymentPath: acceptSecurePaths,
  });
  const base = {
    args: ['exec', '-'],
    cwd: '/srv/teleagent-agent-workspaces/phone',
    stdinInput: 'test',
    accessMode: 'read-only',
  };
  const codex = wrapAgentInvocation({
    ...base, provider: 'codex', command: '/opt/teleagent/agent-tools/codex',
  }, { config });
  const claude = wrapAgentInvocation({
    ...base, provider: 'claude', command: '/opt/teleagent/agent-tools/claude', args: ['-p'],
  }, { config });
  assert.equal(codex.workerUser, 'teleagent-codex-worker');
  assert.equal(codex.workerHome, '/nonexistent/teleagent-codex-worker');
  assert.equal(claude.workerUser, 'teleagent-claude-worker');
  assert.equal(claude.workerHome, '/nonexistent/teleagent-claude-worker');
  assert.notEqual(codex.workerUser, claude.workerUser);
});

test('isolated invocation refuses relative commands and NUL-bearing arguments', () => {
  const config = normalizeWorkerConfig(
    workers(),
    { validateDeploymentPath: acceptSecurePaths }
  );
  assert.throws(() => wrapAgentInvocation({
    command: 'codex', args: [], cwd: '/tmp', provider: 'codex',
    accessMode: 'read-only',
  }, { config }), /absolute path/);
  assert.throws(() => wrapAgentInvocation({
    command: '/opt/teleagent/agent-tools/codex',
    args: ['bad\0arg'],
    cwd: '/srv/teleagent-agent-workspaces/phone',
    provider: 'codex',
    accessMode: 'read-only',
  }, { config }), /invalid value/);
});

test('enabled isolation fails closed when fixed deployment files are missing', () => {
  assert.throws(
    () => normalizeWorkerConfig(workers()),
    /missing or cannot be inspected/,
  );
});

test('deployment paths are all validated before isolation is enabled', () => {
  const inspected = [];
  const config = normalizeWorkerConfig(workers(), {
    validateDeploymentPath(filePath, label) {
      inspected.push([filePath, label]);
    },
  });
  assert.deepEqual(inspected.map(([, label]) => label), [
    'AGENT_PROVIDER_SUPERVISOR_CLIENT_PATH',
    'AGENT_WORKER_CODEX_BIN',
    'AGENT_WORKER_CLAUDE_BIN',
  ]);
  assert.equal(config.providerCommands.codex, '/opt/teleagent/agent-tools/codex');
});

test('Claude prompt is moved from argv to stdin before sudo', () => {
  const config = normalizeWorkerConfig(
    workers(),
    { validateDeploymentPath: acceptSecurePaths },
  );
  const prompt = 'Summarize the private request without logging it.';
  const wrapped = wrapAgentInvocation({
    command: '/opt/teleagent/agent-tools/claude',
    args: ['-p', prompt, '--model', 'sonnet', '--permission-mode', 'dontAsk'],
    cwd: '/srv/teleagent-agent-workspaces/phone',
    env: { OPENAI_API_KEY: 'must-not-cross' },
    stdinInput: '',
    provider: 'claude',
    accessMode: 'read-only',
  }, { config, taskId: 'job_claude_1' });

  assert.equal(wrapped.stdinInput, prompt);
  assert.equal(wrapped.args.includes(prompt), false);
  assert.equal(wrapped.args.includes('/usr/bin/env'), false);
  assert.deepEqual(wrapped.args.slice(-5), [
    '-p', '--model', 'sonnet', '--permission-mode', 'dontAsk',
  ]);
});

test('wrapper rejects command, workspace, provider, and task-id drift', () => {
  const config = normalizeWorkerConfig(
    workers(),
    { validateDeploymentPath: acceptSecurePaths },
  );
  const base = {
    command: '/opt/teleagent/agent-tools/codex',
    args: ['exec', '-'],
    cwd: '/srv/teleagent-agent-workspaces/phone',
    provider: 'codex',
    stdinInput: 'test',
    accessMode: 'read-only',
  };

  assert.throws(
    () => wrapAgentInvocation({ ...base, command: '/usr/bin/codex' }, { config }),
    /pinned codex executable/,
  );
  assert.throws(
    () => wrapAgentInvocation({ ...base, cwd: '/home/alborz/phone' }, { config }),
    /WORKSPACE_ROOT/,
  );
  assert.throws(
    () => wrapAgentInvocation({ ...base, provider: 'shell' }, { config }),
    /codex or claude/,
  );
  assert.throws(
    () => wrapAgentInvocation(base, { config, taskId: '../bad' }),
    /task ID/,
  );
});
