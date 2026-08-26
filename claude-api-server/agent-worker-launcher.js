'use strict';

const { lstatSync, realpathSync } = require('node:fs');
const path = require('node:path');

const SAFE_ACCOUNT = /^[a-z_][a-z0-9_-]{0,30}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KNOWN_PROVIDERS = new Set(['claude', 'codex']);
const FIXED_PROVIDER_USERS = Object.freeze({
  claude: 'teleagent-claude-worker',
  codex: 'teleagent-codex-worker',
});
const FIXED_PROVIDER_HOMES = Object.freeze({
  claude: '/nonexistent/teleagent-claude-worker',
  codex: '/nonexistent/teleagent-codex-worker',
});
const FIXED_CLIENT_PATH = '/usr/local/libexec/teleagent-provider-supervisor-client';

function strictBoolean(value, name, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

function cleanAbsolutePath(value, label) {
  const normalized = String(value || '').trim();
  if (
    !normalized ||
    !path.isAbsolute(normalized) ||
    /[\0\r\n]/.test(normalized) ||
    normalized.split(path.sep).includes('..')
  ) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.normalize(normalized);
}

function cleanPathList(value) {
  const entries = String(value || '').split(':');
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new Error('AGENT_WORKER_PATH must not contain an empty entry.');
  }
  return entries.map((entry) => cleanAbsolutePath(entry, 'AGENT_WORKER_PATH entry')).join(':');
}

function validateSecureDeploymentPath(filePath, label) {
  let metadata;
  let canonicalPath;
  try {
    metadata = lstatSync(filePath);
    canonicalPath = realpathSync(filePath);
  } catch {
    throw new Error(`${label} is missing or cannot be inspected.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || canonicalPath !== filePath) {
    throw new Error(`${label} must be a canonical ordinary file.`);
  }
  if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} must be root-owned and not group/world-writable.`);
  }
  if ((metadata.mode & 0o111) === 0 && label !== 'AGENT_WORKER_CONFIG_PATH') {
    throw new Error(`${label} must be executable.`);
  }
}

function normalizeWorkerConfig(environment = process.env, {
  validateDeploymentPath = validateSecureDeploymentPath,
} = {}) {
  const deprecatedUser = String(environment.AGENT_WORKER_USER || '').trim();
  const legacySameUidEnabled = strictBoolean(
    environment.AGENT_WORKER_LEGACY_SAME_UID_ENABLED,
    'AGENT_WORKER_LEGACY_SAME_UID_ENABLED',
    false
  );
  if (deprecatedUser) {
    throw new Error(
      'AGENT_WORKER_USER is unsafe and obsolete; configure both provider-specific worker identities.'
    );
  }
  const providerUsers = Object.freeze({
    claude: String(environment.AGENT_CLAUDE_WORKER_USER || '').trim(),
    codex: String(environment.AGENT_CODEX_WORKER_USER || '').trim(),
  });
  const configuredCount = Object.values(providerUsers).filter(Boolean).length;
  if (configuredCount === 0) {
    return Object.freeze({
      enabled: false,
      hardened: false,
      legacySameUidEnabled,
      readinessCode: legacySameUidEnabled
        ? 'AGENT_WORKER_LEGACY_ROLLBACK_ACTIVE'
        : 'AGENT_PROVIDER_WORKERS_REQUIRED',
    });
  }
  if (configuredCount !== 2) {
    throw new Error('Both Claude and Codex provider worker identities are required.');
  }
  if (legacySameUidEnabled) {
    throw new Error(
      'AGENT_WORKER_LEGACY_SAME_UID_ENABLED cannot be combined with provider workers.'
    );
  }
  for (const provider of KNOWN_PROVIDERS) {
    const user = providerUsers[provider];
    if (!SAFE_ACCOUNT.test(user) || user === 'root' || user !== FIXED_PROVIDER_USERS[provider]) {
      throw new Error(
        `AGENT_${provider.toUpperCase()}_WORKER_USER must be ${FIXED_PROVIDER_USERS[provider]}.`
      );
    }
  }
  const providerHomes = Object.freeze({
    claude: cleanAbsolutePath(
      environment.AGENT_CLAUDE_WORKER_HOME || FIXED_PROVIDER_HOMES.claude,
      'AGENT_CLAUDE_WORKER_HOME'
    ),
    codex: cleanAbsolutePath(
      environment.AGENT_CODEX_WORKER_HOME || FIXED_PROVIDER_HOMES.codex,
      'AGENT_CODEX_WORKER_HOME'
    ),
  });
  for (const provider of KNOWN_PROVIDERS) {
    if (providerHomes[provider] !== FIXED_PROVIDER_HOMES[provider]) {
      throw new Error(
        `AGENT_${provider.toUpperCase()}_WORKER_HOME must be ${FIXED_PROVIDER_HOMES[provider]}.`
      );
    }
  }
  const executablePath = cleanPathList(
    environment.AGENT_WORKER_PATH || '/opt/teleagent/agent-tools:/usr/local/bin:/usr/bin'
  );
  const workspaceRoot = cleanAbsolutePath(
    environment.AGENT_WORKER_WORKSPACE_ROOT || '/srv/teleagent-agent-workspaces',
    'AGENT_WORKER_WORKSPACE_ROOT'
  );
  const defaultWorkspace = cleanAbsolutePath(
    environment.AGENT_WORKER_DEFAULT_WORKSPACE || path.join(workspaceRoot, 'phone'),
    'AGENT_WORKER_DEFAULT_WORKSPACE'
  );
  const relativeDefault = path.relative(workspaceRoot, defaultWorkspace);
  if (!relativeDefault || relativeDefault.startsWith('..') || path.isAbsolute(relativeDefault)) {
    throw new Error('AGENT_WORKER_DEFAULT_WORKSPACE must be a child of AGENT_WORKER_WORKSPACE_ROOT.');
  }
  const clientPath = cleanAbsolutePath(
    environment.AGENT_PROVIDER_SUPERVISOR_CLIENT_PATH || FIXED_CLIENT_PATH,
    'AGENT_PROVIDER_SUPERVISOR_CLIENT_PATH'
  );
  if (clientPath !== FIXED_CLIENT_PATH) {
    throw new Error('Provider-supervisor client path is a fixed deployment boundary.');
  }
  const codexPath = cleanAbsolutePath(
    environment.AGENT_WORKER_CODEX_BIN || '/opt/teleagent/agent-tools/codex',
    'AGENT_WORKER_CODEX_BIN'
  );
  const claudePath = cleanAbsolutePath(
    environment.AGENT_WORKER_CLAUDE_BIN || '/opt/teleagent/agent-tools/claude',
    'AGENT_WORKER_CLAUDE_BIN'
  );

  for (const [filePath, label] of [
    [clientPath, 'AGENT_PROVIDER_SUPERVISOR_CLIENT_PATH'],
    [codexPath, 'AGENT_WORKER_CODEX_BIN'],
    [claudePath, 'AGENT_WORKER_CLAUDE_BIN'],
  ]) {
    validateDeploymentPath(filePath, label);
  }

  return Object.freeze({
    enabled: true,
    hardened: true,
    legacySameUidEnabled: false,
    readinessCode: null,
    providerUsers,
    providerHomes,
    executablePath,
    workspaceRoot,
    defaultWorkspace,
    clientPath,
    providerCommands: Object.freeze({ codex: codexPath, claude: claudePath }),
  });
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function wrapAgentInvocation(invocation, {
  config,
  taskId = null,
} = {}) {
  if (!config?.enabled) {
    const error = new Error(
      'A hardened teleagent-worker boundary is required before launching Claude or Codex.'
    );
    error.code = 'AGENT_WORKER_ISOLATION_REQUIRED';
    throw error;
  }
  const provider = String(invocation?.provider || '').trim().toLowerCase();
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error('Isolated agent provider must be codex or claude.');
  }
  const accessMode = String(invocation?.accessMode || '').trim();
  if (!['read-only', 'mutating'].includes(accessMode)) {
    throw new Error('Agent invocation requires an exact provider access mode.');
  }
  const command = cleanAbsolutePath(invocation?.command, 'Agent command');
  if (command !== config.providerCommands[provider]) {
    throw new Error(`Agent command does not match the pinned ${provider} executable.`);
  }
  const cwd = cleanAbsolutePath(invocation?.cwd, 'Agent working directory');
  if (!isPathWithin(config.workspaceRoot, cwd)) {
    throw new Error('Agent working directory must be a child of AGENT_WORKER_WORKSPACE_ROOT.');
  }

  let workerStdinInput = String(invocation?.stdinInput || '');
  let originalArgs = Array.isArray(invocation?.args) ? invocation.args.map(String) : [];
  if (provider === 'claude' && workerStdinInput.length === 0) {
    if (!['-p', '--print'].includes(originalArgs[0]) || originalArgs.length < 2) {
      throw new Error('Claude worker prompts must be supplied through stdin in print mode.');
    }
    workerStdinInput = originalArgs[1];
    originalArgs = [originalArgs[0], ...originalArgs.slice(2)];
  }
  if (originalArgs.length > 256 || originalArgs.some(value => /[\0\r\n]/.test(value) || value.length > 8192)) {
    throw new Error('Agent arguments contain an invalid value or exceed the worker limit.');
  }
  if (provider === 'claude' && !['-p', '--print'].includes(originalArgs[0])) {
    throw new Error('Claude worker must run in non-interactive print mode.');
  }

  const normalizedTaskId = taskId === null || taskId === undefined || taskId === ''
    ? null
    : String(taskId);
  if (normalizedTaskId && !SAFE_TASK_ID.test(normalizedTaskId)) {
    throw new Error('Agent worker task ID is invalid.');
  }

  const launcherArgs = [
    '--provider', provider,
    '--workspace', cwd,
    '--mode', 'managed',
    '--access-mode', accessMode,
  ];
  if (normalizedTaskId) launcherArgs.push('--task-id', normalizedTaskId);
  launcherArgs.push('--', ...originalArgs);

  return {
    ...invocation,
    command: config.clientPath,
    args: launcherArgs,
    // The controller never needs traverse access to the worker workspace.
    // The fixed launcher canonicalizes and enters it after sudo drops UID.
    cwd: '/',
    // The parent only needs a minimal environment to start sudo. No controller
    // secret or provider credential crosses into the worker process.
    env: {
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
    stdinInput: workerStdinInput,
    isolatedWorker: true,
    workerUser: config.providerUsers[provider],
    workerHome: config.providerHomes[provider],
  };
}

module.exports = {
  normalizeWorkerConfig,
  validateSecureDeploymentPath,
  wrapAgentInvocation,
};
