'use strict';

const { buildAgentExecutionEnvironment } = require('../lib/agent-execution-environment');

const CODEX_SANDBOXES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
const CODEX_APPROVAL_POLICIES = new Set([
  'untrusted',
  'on-request',
  'never',
]);
const CODEX_REASONING_EFFORTS = new Set([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const CODEX_STRIPPED_ENV_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
]);
const CLAUDE_EMPTY_MCP_CONFIG = '/etc/teleagent/provider-runtime/empty-mcp.json';
const CLAUDE_EMPTY_SETTINGS = '/etc/teleagent/provider-runtime/empty-settings.json';

function normalizeChoice(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeCodexSandbox(value, fallback = 'read-only') {
  return normalizeChoice(value, CODEX_SANDBOXES, fallback);
}

function normalizeCodexApprovalPolicy(value, fallback = 'never') {
  return normalizeChoice(value, CODEX_APPROVAL_POLICIES, fallback);
}

function normalizeCodexReasoningEffort(value, fallback = 'medium') {
  return normalizeChoice(value, CODEX_REASONING_EFFORTS, fallback);
}

function buildCodexArgs({
  model,
  reasoningEffort,
  sandbox,
  approvalPolicy,
  workingDirectory,
  sessionId = null,
}) {
  if (!model) {
    throw new Error('Codex model is required');
  }
  if (sessionId) {
    throw new Error('Persistent Codex provider sessions are disabled');
  }
  if (!workingDirectory) {
    throw new Error('Codex working directory is required');
  }

  const normalizedSandbox = normalizeCodexSandbox(sandbox);
  const args = [
    '--ask-for-approval', normalizeCodexApprovalPolicy(approvalPolicy),
    '--sandbox', normalizedSandbox,
    '--model', model,
    '--config', `model_reasoning_effort="${normalizeCodexReasoningEffort(reasoningEffort)}"`,
    '--cd', workingDirectory,
  ];

  args.push('exec');

  // Never load worker-home or project rules/config. A prior approved mutation
  // must not persist a hook/instruction that turns a later read-only launch
  // into a side effect. Exact launch config comes only from root-owned argv.
  args.push('--ignore-user-config', '--ignore-rules', '--strict-config');

  args.push('--skip-git-repo-check', '--json');

  // Read the prompt from stdin so spoken requests do not appear in argv.
  args.push('-');
  return args;
}

function buildClaudeArgs({
  model,
  permissionMode,
  tools = [],
  allowedTools = [],
  sessionId = null,
  newSessionId = null,
}) {
  if (!model || !permissionMode) {
    throw new Error('Claude launch requires an exact model and permission mode');
  }
  if (sessionId || newSessionId) {
    throw new Error('Persistent Claude provider sessions are disabled');
  }
  const args = [
    '-p',
    '--bare',
    '--safe-mode',
    '--strict-mcp-config',
    '--mcp-config', CLAUDE_EMPTY_MCP_CONFIG,
    '--settings', CLAUDE_EMPTY_SETTINGS,
    '--model', String(model),
    '--permission-mode', String(permissionMode),
  ];
  if (tools.length > 0) args.push('--tools', tools.map(String).join(','));
  if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.map(String).join(','));
  return args;
}

function buildCodexEnvironment(baseEnvironment = {}) {
  const environment = buildAgentExecutionEnvironment(baseEnvironment);
  for (const key of CODEX_STRIPPED_ENV_KEYS) {
    delete environment[key];
  }
  return environment;
}

function parseClaudeStdout(stdout) {
  let response = '';

  for (const line of String(stdout || '').trim().split('\n')) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'result' && parsed.result) {
        response = parsed.result;
      }
    } catch {
      // Claude can also emit formatted, non-JSON output.
    }
  }

  if (!response) {
    response = String(stdout || '').trim();
  }

  return { response, providerContextPersistent: false };
}

function parseCodexStdout(stdout) {
  let response = '';
  let error = null;

  for (const line of String(stdout || '').trim().split('\n')) {
    try {
      const parsed = JSON.parse(line);

      if (
        parsed.type === 'item.completed' &&
        parsed.item?.type === 'agent_message' &&
        typeof parsed.item.text === 'string'
      ) {
        response = parsed.item.text;
      }

      if (parsed.type === 'turn.failed' || parsed.type === 'error') {
        error = parsed.error?.message || parsed.message || error;
      }
    } catch {
      // Codex --json should be JSONL, but preserve a raw-output fallback.
    }
  }

  if (!response && !error) {
    response = String(stdout || '').trim();
  }

  return {
    response,
    error,
    providerContextPersistent: false,
  };
}

function parseAgentStdout(provider, stdout) {
  return provider === 'codex'
    ? parseCodexStdout(stdout)
    : parseClaudeStdout(stdout);
}

module.exports = {
  CLAUDE_EMPTY_MCP_CONFIG,
  CLAUDE_EMPTY_SETTINGS,
  buildClaudeArgs,
  buildCodexArgs,
  buildCodexEnvironment,
  normalizeCodexApprovalPolicy,
  normalizeCodexReasoningEffort,
  normalizeCodexSandbox,
  parseAgentStdout,
  parseClaudeStdout,
  parseCodexStdout,
};
