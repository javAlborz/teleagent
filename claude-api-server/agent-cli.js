'use strict';

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
  if (!workingDirectory) {
    throw new Error('Codex working directory is required');
  }

  const args = [
    '--ask-for-approval', normalizeCodexApprovalPolicy(approvalPolicy),
    '--sandbox', normalizeCodexSandbox(sandbox),
    '--model', model,
    '--config', `model_reasoning_effort="${normalizeCodexReasoningEffort(reasoningEffort)}"`,
    '--cd', workingDirectory,
    'exec',
  ];

  if (sessionId) {
    args.push('resume');
  }

  args.push('--skip-git-repo-check', '--json');

  if (sessionId) {
    args.push(sessionId);
  }

  // Read the prompt from stdin so spoken requests do not appear in argv.
  args.push('-');
  return args;
}

function parseClaudeStdout(stdout) {
  let response = '';
  let sessionId = null;

  for (const line of String(stdout || '').trim().split('\n')) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'result' && parsed.result) {
        response = parsed.result;
        sessionId = parsed.session_id || sessionId;
      }
    } catch {
      // Claude can also emit formatted, non-JSON output.
    }
  }

  if (!response) {
    response = String(stdout || '').trim();
  }

  return { response, sessionId };
}

function parseCodexStdout(stdout) {
  let response = '';
  let sessionId = null;
  let error = null;

  for (const line of String(stdout || '').trim().split('\n')) {
    try {
      const parsed = JSON.parse(line);

      if (parsed.type === 'thread.started' && parsed.thread_id) {
        sessionId = parsed.thread_id;
      }

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

  if (!response && !sessionId) {
    response = String(stdout || '').trim();
  }

  return { response, sessionId, error };
}

function parseAgentStdout(provider, stdout) {
  return provider === 'codex'
    ? parseCodexStdout(stdout)
    : parseClaudeStdout(stdout);
}

module.exports = {
  buildCodexArgs,
  normalizeCodexApprovalPolicy,
  normalizeCodexReasoningEffort,
  normalizeCodexSandbox,
  parseAgentStdout,
  parseClaudeStdout,
  parseCodexStdout,
};
