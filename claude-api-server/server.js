/**
 * Teleagent HTTP Agent Bridge
 *
 * HTTP server that wraps Claude Code and Codex CLIs with session management
 * Runs on the API server to handle voice interface queries
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   POST /ask - Send a prompt to an agent (with optional callId for session)
 *   POST /cancel-session - Cancel active agent work for a call
 *   POST /end-session - Clean up session for a call
 *   GET /health - Health check
 */

const express = require('express');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const {
  buildQueryContext,
  buildStructuredPrompt,
  tryParseJsonFromText,
  validateRequiredFields,
  buildRepairPrompt,
} = require('./structured');
const { looksLikePhoneDeployRequest } = require('../lib/phone-deploy-intent');
const {
  buildClaudeArgs,
  buildCodexArgs,
  buildCodexEnvironment,
  normalizeCodexApprovalPolicy,
  normalizeCodexSandbox,
  parseAgentStdout,
} = require('./agent-cli');
const {
  getDeploymentAuthorization,
  resolveEffectiveSessionType: resolveProfileSessionType,
} = require('./agent-profiles');
const {
  VoiceExecutionControl,
  cleanLabel,
} = require('../lib/voice-execution-control');
const {
  RISK_LEVELS,
  classifyVoiceOperation,
  requestHash,
} = require('../lib/voice-operation-risk');
const { canonicalizeTargetSessionMessage } = require('../lib/target-session-message');
const {
  REASONING_EFFORT_BY_MODEL,
  requireCanonicalProviderModel,
} = require('../lib/provider-model-contract');
const {
  assertSensitiveAgentLoggingDisabled,
  summarizeSensitiveText,
} = require('../lib/safe-agent-logging');
const {
  ExecutorTaskStore,
  ExecutorTaskStoreError,
} = require('./executor-task-store');
const {
  ExecutorTaskDispatcher,
  captureProcessExecution,
} = require('./executor-task-dispatcher');
const {
  authorizeManagedVoiceRequest,
  authorizeTargetSessionRequest,
  createConfiguredApprovalVerifier,
} = require('./voice-approval-verifier');
const { hashApprovalPlan } = require('../lib/voice-approval-capability');
const {
  buildManagedAgentApprovalPlan,
  buildStructuredAgentApprovalContext,
  buildTargetSessionApprovalPlan,
  managedAgentTarget,
  profileForSessionType,
  profileForTargetSession,
  targetSessionOperationMarker,
} = require('../lib/voice-authorization-plan');
const { buildAgentExecutionEnvironment } = require('../lib/agent-execution-environment');
const {
  normalizeWorkerConfig,
  wrapAgentInvocation,
} = require('./agent-worker-launcher');
const {
  WorkerSessionProxyError,
  createWorkerSessionProxy,
  normalizeWorkerSessionProxyConfig,
} = require('./worker-session-proxy');
const {
  PrivilegedActionProxyError,
  createPrivilegedActionProxy,
} = require('./privileged-action-proxy');
const {
  performCoordinatedVoicePanic,
  privilegedSubmissionBoundary,
} = require('./voice-panic-coordinator');

const MAX_AGENT_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_STDERR_BYTES = 1024 * 1024;
const MAX_AGENT_OUTPUT_BYTES = MAX_AGENT_STDOUT_BYTES + MAX_AGENT_STDERR_BYTES;

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...valueParts] = trimmed.split('=');
    if (!key || valueParts.length === 0) continue;

    if (process.env[key] === undefined) {
      process.env[key] = valueParts.join('=');
    }
  }
}

function normalizeScopedApiToken(value) {
  const token = String(value || '');
  const byteLength = Buffer.byteLength(token, 'utf8');
  if (token !== token.trim() || byteLength < 32 || byteLength > 4096 ||
      /[\u0000-\u001F\u007F]/.test(token) ||
      /^(replace|change|your)[-_ ]?with|placeholder|example|changeme/i.test(token)) {
    return '';
  }
  return token;
}

function isLoopbackBindHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(
    String(host || '').trim().toLowerCase()
  );
}

function parseStrictBoolean(value, name, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

// Load the project-level .env so the voice app and agent bridge can share bind/auth settings.
loadEnvFile(path.join(__dirname, '..', '.env'));

const HOME = process.env.HOME || os.homedir() || '/root';
const app = express();
const PORT = process.env.PORT || 3333;
const BIND_HOST = String(
  process.env.AGENT_API_BIND_HOST || process.env.CLAUDE_API_BIND_HOST || '127.0.0.1'
).trim();
const AGENT_API_NON_LOOPBACK_ENABLED = parseStrictBoolean(
  process.env.AGENT_API_NON_LOOPBACK_ENABLED,
  'AGENT_API_NON_LOOPBACK_ENABLED',
  false
);
if (!isLoopbackBindHost(BIND_HOST) && !AGENT_API_NON_LOOPBACK_ENABLED) {
  throw new Error(
    'Non-loopback agent API binding requires AGENT_API_NON_LOOPBACK_ENABLED=true.'
  );
}
const AGENT_API_TOKEN = normalizeScopedApiToken(process.env.AGENT_API_TOKEN);
const EXECUTOR_API_TOKEN = normalizeScopedApiToken(process.env.EXECUTOR_API_TOKEN);
const VOICE_CONTROL_TOKEN = normalizeScopedApiToken(process.env.VOICE_CONTROL_TOKEN);
const PRIVILEGED_ACTION_API_TOKEN = normalizeScopedApiToken(
  process.env.PRIVILEGED_ACTION_API_TOKEN
);
const SCOPED_API_TOKENS = Object.freeze({
  AGENT_API_TOKEN,
  EXECUTOR_API_TOKEN,
  VOICE_CONTROL_TOKEN,
  PRIVILEGED_ACTION_API_TOKEN,
});
const seenScopedApiTokens = new Map();
for (const [name, token] of Object.entries(SCOPED_API_TOKENS)) {
  if (!token) continue;
  const reusedFrom = seenScopedApiTokens.get(token);
  if (reusedFrom) {
    throw new Error(`Scoped API tokens must be pairwise distinct: ${reusedFrom} and ${name}.`);
  }
  seenScopedApiTokens.set(token, name);
}
const SCOPED_AUTH_CONFIGURATION_VALID = Object.values(SCOPED_API_TOKENS).every(Boolean);
const PRIVILEGED_ACTION_PROXY_ENABLED = parseStrictBoolean(
  process.env.PRIVILEGED_ACTION_PROXY_ENABLED,
  'PRIVILEGED_ACTION_PROXY_ENABLED',
  false
);
const EXPECTED_PRIVILEGED_ACTION_SOCKET_PATH = '/run/teleagent-privileged-action/broker.sock';
const PRIVILEGED_ACTION_SOCKET_PATH = String(
  process.env.PRIVILEGED_ACTION_PROXY_SOCKET_PATH || ''
).trim();
const VOICE_EXECUTION_LOCK_FILE = process.env.VOICE_EXECUTION_LOCK_FILE ||
  path.join(__dirname, '..', 'voice-app', 'state', 'voice-execution.lock.json');
const EXECUTOR_TASK_DB_PATH = process.env.EXECUTOR_TASK_DB_PATH ||
  path.join(HOME, '.local', 'state', 'teleagent', 'executor-tasks.sqlite');
const EXECUTOR_TASK_LEASE_MS = parsePositiveInteger(process.env.EXECUTOR_TASK_LEASE_MS, 15000);
const EXECUTOR_TASK_HEARTBEAT_MS = parsePositiveInteger(process.env.EXECUTOR_TASK_HEARTBEAT_MS, 5000);
const EXECUTOR_TASK_POLL_MS = parsePositiveInteger(process.env.EXECUTOR_TASK_POLL_MS, 250);
const EXECUTOR_TASK_CONCURRENCY = parsePositiveInteger(process.env.EXECUTOR_TASK_CONCURRENCY, 1);
const agentWorkerConfig = normalizeWorkerConfig(process.env);
const workerSessionProxyConfig = normalizeWorkerSessionProxyConfig(process.env);
if (agentWorkerConfig.legacySameUidEnabled && PRIVILEGED_ACTION_PROXY_ENABLED) {
  throw new Error(
    'AGENT_WORKER_LEGACY_SAME_UID_ENABLED is incompatible with the privileged action proxy.'
  );
}
if (PRIVILEGED_ACTION_PROXY_ENABLED && !PRIVILEGED_ACTION_API_TOKEN) {
  throw new Error('Enabled privileged action proxy requires PRIVILEGED_ACTION_API_TOKEN.');
}
if (PRIVILEGED_ACTION_PROXY_ENABLED &&
    PRIVILEGED_ACTION_SOCKET_PATH !== EXPECTED_PRIVILEGED_ACTION_SOCKET_PATH) {
  throw new Error(
    `Enabled privileged action proxy requires socket ${EXPECTED_PRIVILEGED_ACTION_SOCKET_PATH}.`
  );
}
const privilegedActionProxy = PRIVILEGED_ACTION_PROXY_ENABLED
  ? createPrivilegedActionProxy({
      socketPath: PRIVILEGED_ACTION_SOCKET_PATH,
      timeoutMs: parsePositiveInteger(process.env.PRIVILEGED_ACTION_PROXY_TIMEOUT_MS, 10000),
    })
  : null;
const workerSessionProxy = workerSessionProxyConfig.enabled
  ? createWorkerSessionProxy({
      socketPath: workerSessionProxyConfig.socketPath,
      timeoutMs: workerSessionProxyConfig.timeoutMs,
    })
  : null;
const voiceExecutionControl = new VoiceExecutionControl({ lockFile: VOICE_EXECUTION_LOCK_FILE });
const executorTaskStore = new ExecutorTaskStore({
  dbPath: EXECUTOR_TASK_DB_PATH,
  defaultLeaseMs: EXECUTOR_TASK_LEASE_MS,
});
let approvalVerifier;
try {
  approvalVerifier = createConfiguredApprovalVerifier({
    environment: process.env,
    sqliteDatabase: executorTaskStore.db,
  });
} catch {
  executorTaskStore.close();
  throw new Error('Approval capability verification is misconfigured; refusing to start.');
}
let executorTaskDispatcher = null;
let serverReady = false;
let shutdownRequested = false;
let httpServer = null;
let shutdownPromise = null;
let executorStoreClosed = false;
let workerSessionHealthTimer = null;
let workerSessionBoundaryStatus = Object.freeze({
  ready: false,
  code: !agentWorkerConfig.enabled
    ? agentWorkerConfig.readinessCode
    : (workerSessionProxy ? 'WORKER_SESSION_BROKER_UNVERIFIED' : 'WORKER_SESSION_BROKER_REQUIRED'),
  checkedAt: null,
});
const TEST_PRE_REGISTRATION_BARRIER = process.env.NODE_ENV === 'test'
  ? String(process.env.TELEAGENT_TEST_PRE_REGISTRATION_BARRIER || '').trim()
  : '';
// The controller intentionally has no direct workspace, provider-log, or tmux
// inspector. Those operations cross only the worker-owned Unix-socket broker.
const operatorInspector = workerSessionProxy?.inspector || null;
const tmuxAgentController = workerSessionProxy?.controller || null;
const CLAUDE_WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
const CODEX_WORKING_DIR = process.env.CODEX_WORKING_DIR || CLAUDE_WORKING_DIR;
const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND || 'claude';
const CODEX_COMMAND = process.env.CODEX_COMMAND || 'codex';
function requireExactProfileValue(value, expected, label) {
  const actual = String(value === undefined || value === null || value === '' ? expected : value);
  if (actual !== expected) {
    throw new Error(`${label} is fixed to ${expected}`);
  }
  return actual;
}

const CLAUDE_MODEL = requireCanonicalProviderModel(
  'claude',
  process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  'CLAUDE_MODEL'
);
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
requireExactProfileValue(
  process.env.PHONE_CLAUDE_MODEL,
  'claude-haiku-4-5-20251001',
  'PHONE_CLAUDE_MODEL'
);
const PHONE_CLAUDE_PERMISSION_MODE = process.env.PHONE_CLAUDE_PERMISSION_MODE || 'dontAsk';
const PHONE_HAIKU_CLAUDE_MODEL = requireExactProfileValue(
  process.env.PHONE_HAIKU_CLAUDE_MODEL, 'claude-haiku-4-5-20251001',
  'PHONE_HAIKU_CLAUDE_MODEL'
);
const PHONE_SONNET_CLAUDE_MODEL = requireExactProfileValue(
  process.env.PHONE_SONNET_CLAUDE_MODEL, 'claude-sonnet-5',
  'PHONE_SONNET_CLAUDE_MODEL'
);
const PHONE_OPUS_CLAUDE_MODEL = requireExactProfileValue(
  process.env.PHONE_OPUS_CLAUDE_MODEL, 'claude-opus-5',
  'PHONE_OPUS_CLAUDE_MODEL'
);
const PHONE_DEPLOY_CLAUDE_MODEL = requireCanonicalProviderModel(
  'claude', process.env.PHONE_DEPLOY_CLAUDE_MODEL || PHONE_SONNET_CLAUDE_MODEL,
  'PHONE_DEPLOY_CLAUDE_MODEL'
);
const PHONE_HAIKU_CLAUDE_PERMISSION_MODE = process.env.PHONE_HAIKU_CLAUDE_PERMISSION_MODE || PHONE_CLAUDE_PERMISSION_MODE;
const PHONE_SONNET_CLAUDE_PERMISSION_MODE = process.env.PHONE_SONNET_CLAUDE_PERMISSION_MODE || PHONE_CLAUDE_PERMISSION_MODE;
const PHONE_OPUS_CLAUDE_PERMISSION_MODE = process.env.PHONE_OPUS_CLAUDE_PERMISSION_MODE || PHONE_CLAUDE_PERMISSION_MODE;
const PHONE_DEPLOY_CLAUDE_PERMISSION_MODE =
  process.env.PHONE_DEPLOY_CLAUDE_PERMISSION_MODE || PHONE_SONNET_CLAUDE_PERMISSION_MODE;
const PHONE_CODEX_LUNA_MODEL = requireExactProfileValue(
  process.env.PHONE_CODEX_LUNA_MODEL, 'gpt-5.6-luna', 'PHONE_CODEX_LUNA_MODEL'
);
const PHONE_CODEX_TERRA_MODEL = requireExactProfileValue(
  process.env.PHONE_CODEX_TERRA_MODEL, 'gpt-5.6-terra', 'PHONE_CODEX_TERRA_MODEL'
);
const PHONE_CODEX_SOL_MODEL = requireExactProfileValue(
  process.env.PHONE_CODEX_SOL_MODEL, 'gpt-5.6-sol', 'PHONE_CODEX_SOL_MODEL'
);
const PHONE_CODEX_DEPLOY_MODEL = requireCanonicalProviderModel(
  'codex', process.env.PHONE_CODEX_DEPLOY_MODEL || PHONE_CODEX_SOL_MODEL,
  'PHONE_CODEX_DEPLOY_MODEL'
);
const PHONE_CODEX_LUNA_WORKING_DIR = process.env.PHONE_CODEX_LUNA_WORKING_DIR || CODEX_WORKING_DIR;
const PHONE_CODEX_TERRA_WORKING_DIR = process.env.PHONE_CODEX_TERRA_WORKING_DIR || CODEX_WORKING_DIR;
const PHONE_CODEX_SOL_WORKING_DIR = process.env.PHONE_CODEX_SOL_WORKING_DIR || CODEX_WORKING_DIR;
const PHONE_CODEX_DEPLOY_WORKING_DIR =
  process.env.PHONE_CODEX_DEPLOY_WORKING_DIR || PHONE_CODEX_SOL_WORKING_DIR;
const PHONE_CODEX_LUNA_REASONING_EFFORT = requireExactProfileValue(
  process.env.PHONE_CODEX_LUNA_REASONING_EFFORT, 'low', 'PHONE_CODEX_LUNA_REASONING_EFFORT'
);
const PHONE_CODEX_TERRA_REASONING_EFFORT = requireExactProfileValue(
  process.env.PHONE_CODEX_TERRA_REASONING_EFFORT, 'medium', 'PHONE_CODEX_TERRA_REASONING_EFFORT'
);
const PHONE_CODEX_SOL_REASONING_EFFORT = requireExactProfileValue(
  process.env.PHONE_CODEX_SOL_REASONING_EFFORT, 'high', 'PHONE_CODEX_SOL_REASONING_EFFORT'
);
const PHONE_CODEX_DEPLOY_REASONING_EFFORT = requireExactProfileValue(
  process.env.PHONE_CODEX_DEPLOY_REASONING_EFFORT,
  REASONING_EFFORT_BY_MODEL[PHONE_CODEX_DEPLOY_MODEL],
  'PHONE_CODEX_DEPLOY_REASONING_EFFORT'
);
const PHONE_CODEX_LUNA_SANDBOX = normalizeCodexSandbox(
  process.env.PHONE_CODEX_LUNA_SANDBOX,
  'read-only'
);
const PHONE_CODEX_TERRA_SANDBOX = normalizeCodexSandbox(
  process.env.PHONE_CODEX_TERRA_SANDBOX,
  'workspace-write'
);
const PHONE_CODEX_SOL_SANDBOX = normalizeCodexSandbox(
  process.env.PHONE_CODEX_SOL_SANDBOX,
  'danger-full-access'
);
const PHONE_CODEX_DEPLOY_SANDBOX = normalizeCodexSandbox(
  process.env.PHONE_CODEX_DEPLOY_SANDBOX,
  'danger-full-access'
);
const PHONE_CODEX_APPROVAL_POLICY = normalizeCodexApprovalPolicy(
  process.env.PHONE_CODEX_APPROVAL_POLICY,
  'never'
);
const PHONE_DEPLOY_TIMEOUT_SECONDS = parsePositiveInteger(process.env.PHONE_DEPLOY_TIMEOUT_SECONDS, 900);
assertSensitiveAgentLoggingDisabled();

function parseListEnv(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeStructuredRetryCount(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  // Structured repair is intentionally a single bounded formatting retry.
  // Mutating requests narrow this to zero below because a second provider
  // launch could repeat a side effect completed by malformed first output.
  return Math.min(parsed, 1);
}

function structuredMutationOutcomeUnknown({
  provider,
  validationError,
  rawResponse = '',
  durationMs = 0,
  attempts = 1,
}) {
  return {
    success: false,
    provider,
    code: 'AGENT_EXECUTION_OUTCOME_UNKNOWN',
    agentCode: 'AGENT_EXECUTION_OUTCOME_UNKNOWN',
    error: 'The operation may have completed, but its structured result could not be verified. Do not retry it automatically.',
    validation_error: validationError || 'The provider execution did not produce a verified terminal result.',
    raw_response: rawResponse,
    duration_ms: durationMs,
    attempts,
    outcome_unknown: true,
    retry_safe: false,
  };
}

function structuredMutationRequiresDurableExecutor({ provider, classification }) {
  return {
    success: false,
    provider,
    code: 'STRUCTURED_MUTATION_REQUIRES_DURABLE_EXECUTOR',
    agentCode: 'STRUCTURED_MUTATION_REQUIRES_DURABLE_EXECUTOR',
    error: 'Mutating structured requests must be submitted through the durable executor.',
    risk: classification,
    durable_executor_required: true,
    retry_safe: false,
  };
}

function mutationRequiresDurableExecutor({ provider, classification }) {
  return {
    success: false,
    provider,
    code: 'MUTATION_REQUIRES_DURABLE_EXECUTOR',
    agentCode: 'MUTATION_REQUIRES_DURABLE_EXECUTOR',
    error: 'Mutating agent requests must be submitted through the durable executor.',
    risk: classification,
    durable_executor_required: true,
    retry_safe: false,
  };
}

function deployUnavailableUntilToolBroker(provider) {
  return {
    success: false,
    provider,
    code: 'DEPLOY_UNAVAILABLE_UNTIL_TOOL_BROKER',
    agentCode: 'DEPLOY_UNAVAILABLE_UNTIL_TOOL_BROKER',
    error: 'Deploy and publish operations require a separate audited tool broker.',
    retry_safe: false,
  };
}

function providerResumeUnavailable(provider) {
  return {
    success: false,
    provider,
    code: 'PROVIDER_SESSION_RESUME_DISABLED',
    agentCode: 'PROVIDER_SESSION_RESUME_DISABLED',
    error: 'Provider session resume is disabled; durable voice state supplies conversation continuity.',
    provider_context_persistent: false,
    retry_safe: true,
  };
}

function requestsProviderResume(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function requestsSensitiveValueRetrieval(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ');
  const compact = text.replace(/[^a-z0-9]+/g, '');
  const retrieval = /\b(?:read|show|reveal|print|cat|dump|display|speak|say|tell|give|fetch|open|expose|return)\b/.test(text) ||
    /(?:read|show|reveal|print|cat|dump|display|speak|tell|give)(?:the)?(?:env|password|token|secret|apikey|privatekey|authjson|kubeconfig)/.test(compact);
  const sensitive = /(?:^|[\/\s])\.env(?!\.example)(?:$|[\/\s])|auth\.json|\.credentials\.json|kubeconfig|id_(?:rsa|ed25519)|private[\s_-]*key|api[\s_-]*key|access[\s_-]*token|bearer[\s_-]*token|password|credential|(?:^|\W)secret(?:\W|$)/.test(text) ||
    /(?:envfile|authjson|credentialsjson|kubeconfig|privatekey|apikey|accesstoken|bearertoken|password|credential|secret)/.test(compact);
  const presenceOnly = /\b(?:present|presence|exists?|configured|missing|status|metadata|mode|owner|permission)\b/.test(text) &&
    !/\b(?:value|contents?|raw|actual|exact|full)\b/.test(text);
  return retrieval && sensitive && !presenceOnly;
}

function sensitiveValueRetrievalDenied(provider) {
  return {
    success: false,
    provider,
    code: 'SENSITIVE_VALUE_RETRIEVAL_DENIED',
    agentCode: 'SENSITIVE_VALUE_RETRIEVAL_DENIED',
    error: 'Agent requests may report credential presence or status, but never retrieve raw secret values.',
    retry_safe: false,
  };
}

function toAgentErrorCode(legacyCode) {
  switch (legacyCode) {
    case 'CLAUDE_TIMEOUT':
      return 'AGENT_TIMEOUT';
    case 'CLAUDE_CANCELED':
      return 'AGENT_CANCELED';
    case 'CLAUDE_API_UNAVAILABLE':
      return 'AGENT_API_UNAVAILABLE';
    default:
      return legacyCode ? legacyCode.replace(/^CLAUDE_/, 'AGENT_') : null;
  }
}

function valuePresence(value) {
  return value ? 'yes' : 'no';
}

function logTextSummary(label, text) {
  console.log(`${label}: ${summarizeSensitiveText(text)}`);
}

function logSessionSummary(timestamp, {
  callId,
  sessionKey,
  hasExistingSession
}) {
  console.log(
    `[${timestamp}] SESSION: callLinked=${valuePresence(callId)} sessionKey=${valuePresence(sessionKey)} existing=${hasExistingSession ? 'yes' : 'no'}`
  );
}

function logAgentProfile(timestamp, profile) {
  console.log(`[${timestamp}] PROVIDER: ${profile.provider}`);
  console.log(`[${timestamp}] MODEL: ${profile.model}`);
  console.log(`[${timestamp}] SESSION TYPE: ${profile.sessionType}`);

  if (profile.provider === 'codex') {
    console.log(`[${timestamp}] REASONING EFFORT: ${profile.reasoningEffort}`);
    console.log(`[${timestamp}] SANDBOX: ${profile.sandbox}`);
    console.log(`[${timestamp}] APPROVAL POLICY: ${profile.approvalPolicy}`);
    console.log(`[${timestamp}] WORKING DIRECTORY: ${profile.workingDirectory || CODEX_WORKING_DIR}`);
    return;
  }

  console.log(`[${timestamp}] PERMISSION MODE: ${profile.permissionMode}`);
  console.log(`[${timestamp}] TOOLS: ${profile.tools.length > 0 ? profile.tools.join(',') : 'default'}`);
}

const CLAUDE_ALLOWED_TOOLS = parseListEnv(process.env.CLAUDE_ALLOWED_TOOLS);
const PHONE_CLAUDE_ALLOWED_TOOLS = parseListEnv(process.env.PHONE_CLAUDE_ALLOWED_TOOLS);
const PHONE_HAIKU_CLAUDE_ALLOWED_TOOLS = parseListEnv(process.env.PHONE_HAIKU_CLAUDE_ALLOWED_TOOLS || PHONE_CLAUDE_ALLOWED_TOOLS.join(','));
const PHONE_SONNET_CLAUDE_ALLOWED_TOOLS = parseListEnv(process.env.PHONE_SONNET_CLAUDE_ALLOWED_TOOLS || PHONE_CLAUDE_ALLOWED_TOOLS.join(','));
const PHONE_OPUS_CLAUDE_ALLOWED_TOOLS = parseListEnv(process.env.PHONE_OPUS_CLAUDE_ALLOWED_TOOLS || PHONE_CLAUDE_ALLOWED_TOOLS.join(','));
const PHONE_DEPLOY_CLAUDE_ALLOWED_TOOLS = parseListEnv(
  process.env.PHONE_DEPLOY_CLAUDE_ALLOWED_TOOLS || process.env.PHONE_SONNET_CLAUDE_ALLOWED_TOOLS || process.env.PHONE_CLAUDE_ALLOWED_TOOLS
);
const CLAUDE_TOOLS = parseListEnv(process.env.CLAUDE_TOOLS);
const PHONE_CLAUDE_TOOLS = parseListEnv(process.env.PHONE_CLAUDE_TOOLS);
const PHONE_HAIKU_CLAUDE_TOOLS = parseListEnv(process.env.PHONE_HAIKU_CLAUDE_TOOLS || PHONE_CLAUDE_TOOLS.join(','));
const PHONE_SONNET_CLAUDE_TOOLS = parseListEnv(process.env.PHONE_SONNET_CLAUDE_TOOLS || PHONE_CLAUDE_TOOLS.join(','));
const PHONE_OPUS_CLAUDE_TOOLS = parseListEnv(process.env.PHONE_OPUS_CLAUDE_TOOLS || PHONE_CLAUDE_TOOLS.join(','));
const PHONE_DEPLOY_CLAUDE_TOOLS = parseListEnv(
  process.env.PHONE_DEPLOY_CLAUDE_TOOLS || 'Read,Write,Edit,Glob,Grep,Bash,Skill'
);
const ENABLED_AGENT_PROVIDERS = (() => {
  const requested = parseListEnv(process.env.AGENT_PROVIDERS).map(provider => provider.toLowerCase());
  const enabled = ['claude', 'codex'].filter(provider => requested.includes(provider));
  return enabled.length > 0 ? enabled : ['claude', 'codex'];
})();

function normalizeSessionType(sessionType) {
  switch (sessionType) {
    case 'phone':
    case 'phone-haiku':
      return 'phone-haiku';
    case 'phone-sonnet':
      return 'phone-sonnet';
    case 'phone-opus':
      return 'phone-opus';
    case 'phone-deploy':
      return 'phone-deploy';
    case 'phone-codex':
    case 'phone-codex-luna':
      return 'phone-codex-luna';
    case 'phone-codex-terra':
      return 'phone-codex-terra';
    case 'phone-codex-sol':
      return 'phone-codex-sol';
    case 'phone-codex-deploy':
      return 'phone-codex-deploy';
    default:
      return 'default';
  }
}

function isPhoneSessionType(sessionType) {
  return normalizeSessionType(sessionType).startsWith('phone-');
}

function voiceExecutionLockedPayload(status = voiceExecutionControl.getStatus()) {
  return {
    success: false,
    code: 'VOICE_EXECUTION_LOCKED',
    agentCode: 'AGENT_VOICE_EXECUTION_LOCKED',
    error: 'Voice-originated agent execution is locked',
    userMessage: 'Voice-started agent work is locked after an emergency stop. An operator must unlock it locally before I can start another task.',
    voiceExecution: status,
  };
}

function assertVoiceExecutionAllowed(profile) {
  if (!isPhoneSessionType(profile?.sessionType)) return;

  const status = voiceExecutionControl.getStatus();
  if (!status.locked) return;

  const error = new Error('Voice-originated agent execution is locked');
  error.code = 'VOICE_EXECUTION_LOCKED';
  error.agentCode = 'AGENT_VOICE_EXECUTION_LOCKED';
  error.voiceExecution = status;
  throw error;
}

function workerBoundaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

function validateWorkerSessionHealth(payload) {
  return Boolean(
    payload?.success === true &&
    payload?.ready === true &&
    payload?.service === 'teleagent-worker-session-broker' &&
    Number.isInteger(payload?.uid) &&
    payload.uid > 0 &&
    payload?.capabilities?.workspaceRead === true &&
    payload?.capabilities?.tmuxInspect === true &&
    payload?.capabilities?.targetDelivery === true &&
    payload?.capabilities?.freshProviderLaunches === true &&
    payload?.capabilities?.providerContextPersistent === false &&
    payload?.capabilities?.attestedSessionCreation === false &&
    payload?.capabilities?.providerSupervisorsReady === true &&
    payload?.capabilities?.privilegedExecution === false
  );
}

function validateWorkerSessionIdentity(payload) {
  return Boolean(
    payload?.service === 'teleagent-worker-session-broker' &&
    Number.isInteger(payload?.uid) &&
    payload.uid > 0 &&
    payload?.capabilities?.workspaceRead === true &&
    payload?.capabilities?.tmuxInspect === true &&
    payload?.capabilities?.targetDelivery === true &&
    payload?.capabilities?.providerContextPersistent === false &&
    payload?.capabilities?.attestedSessionCreation === false &&
    payload?.capabilities?.privilegedExecution === false
  );
}

async function refreshWorkerSessionBoundaryHealth() {
  const checkedAt = new Date().toISOString();
  if (!agentWorkerConfig.enabled) {
    workerSessionBoundaryStatus = Object.freeze({
      ready: false,
      code: agentWorkerConfig.readinessCode || 'AGENT_WORKER_REQUIRED',
      checkedAt,
    });
    return workerSessionBoundaryStatus;
  }
  if (!workerSessionProxy) {
    workerSessionBoundaryStatus = Object.freeze({
      ready: false,
      code: 'WORKER_SESSION_BROKER_REQUIRED',
      checkedAt,
    });
    return workerSessionBoundaryStatus;
  }
  try {
    const health = await workerSessionProxy.health();
    const ready = validateWorkerSessionHealth(health);
    const panicLocked = validateWorkerSessionIdentity(health) && health?.panicLocked === true;
    workerSessionBoundaryStatus = Object.freeze({
      ready,
      code: ready
        ? null
        : (panicLocked ? 'WORKER_SESSION_PANIC_LOCKED' : 'WORKER_SESSION_BROKER_IDENTITY_INVALID'),
      checkedAt,
    });
  } catch (error) {
    workerSessionBoundaryStatus = Object.freeze({
      ready: false,
      code: error?.code || 'WORKER_SESSION_BROKER_UNAVAILABLE',
      checkedAt,
    });
  }
  return workerSessionBoundaryStatus;
}

function requireHardenedWorkerBoundary() {
  if (agentWorkerConfig.enabled && workerSessionBoundaryStatus.ready) return;
  throw workerBoundaryError(
    workerSessionBoundaryStatus.code || 'AGENT_WORKER_ISOLATION_REQUIRED',
    'The hardened teleagent-worker and worker-session boundary is not ready.'
  );
}

async function callWorkerBoundary(operation) {
  requireHardenedWorkerBoundary();
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkerSessionProxyError && error.status >= 500) {
      workerSessionBoundaryStatus = Object.freeze({
        ready: false,
        code: error.code || 'WORKER_SESSION_BROKER_UNAVAILABLE',
        checkedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

function workerBoundaryHttpStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const code = String(error?.code || '');
  if (/OUTSIDE_WORKSPACE|INSPECTION_DENIED|SENSITIVE_PATH|PATH_OUTSIDE_ROOTS/.test(code)) {
    return 403;
  }
  if (/NOT_FOUND|SESSION_HISTORY_UNRESOLVED|AGENT_SESSION/.test(code)) return 404;
  if (/CONFLICT|CHANGED|OUTCOME_UNKNOWN|IN_PROGRESS|CANCELED/.test(code)) return 409;
  if (/TIMEOUT/.test(code)) return 504;
  if (/^(?:AGENT_WORKER|WORKER_SESSION_BROKER)_/.test(code) &&
      /REQUIRED|UNAVAILABLE|NOT_READY|CONFIG|IDENTITY_INVALID/.test(code)) return 503;
  return 400;
}

function safeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function buildVoiceAuthorizationContext(validation) {
  if (!validation?.voiceOrigin) return '';
  if (!validation.authorization) {
    return `[VOICE READ-ONLY EXECUTION BOUNDARY]\n` +
      `This request is classified read-only. Do not edit files, execute state-changing commands, send messages, deploy, publish, restart services, or use sudo.\n` +
      `If the requested answer requires a mutation, stop and say that a new extension-7 approval is required.\n` +
      `[END VOICE READ-ONLY EXECUTION BOUNDARY]\n\n`;
  }
  return `[VOICE OPERATION AUTHORIZATION]\n` +
    `Job: ${validation.authorization.job_id}\n` +
    `Approved by: DTMF pound\n` +
    `Risk: ${validation.classification.level}\n` +
    `Scope: ${String(validation.authorization.scope || '').slice(0, 1000)}\n` +
    `Do not expand this scope. If materially different work is required, stop and request a new approval.\n` +
    `[END VOICE OPERATION AUTHORIZATION]\n\n`;
}

function applyVoiceExecutionBoundary(profile, validation) {
  if (!validation?.voiceOrigin || validation.classification?.level !== RISK_LEVELS.READ_ONLY) {
    return profile;
  }
  if (profile.provider === 'codex') {
    return { ...profile, sandbox: 'read-only' };
  }
  // An empty Claude --tools configuration means "use the CLI defaults", not
  // "no tools".  Always install a closed, explicit tool set at the execution
  // boundary so a high-tier model selected for an informational request cannot
  // inherit Bash/Edit/Write from either its profile or the host configuration.
  const readOnlyTools = ['Read', 'Glob', 'Grep'];
  return {
    ...profile,
    permissionMode: 'dontAsk',
    tools: [...readOnlyTools],
    allowedTools: [...readOnlyTools],
  };
}

function applyProviderAccessBoundary(profile, validation) {
  const bounded = applyVoiceExecutionBoundary(profile, validation);
  return {
    ...bounded,
    accessMode: validation?.classification?.level === RISK_LEVELS.READ_ONLY
      ? 'read-only'
      : 'mutating',
  };
}

function resolveEffectiveSessionType(sessionType, prompt = '', devicePrompt = '') {
  return resolveProfileSessionType(sessionType, prompt, devicePrompt);
}

function resolveRequestTimeoutSeconds(sessionType, prompt = '', devicePrompt = '', requestedTimeoutSeconds = null) {
  const requested = parsePositiveInteger(requestedTimeoutSeconds);

  if (isPhoneSessionType(sessionType) && looksLikePhoneDeployRequest(prompt, devicePrompt)) {
    return Math.max(requested || 0, PHONE_DEPLOY_TIMEOUT_SECONDS);
  }

  return requested;
}

function resolveAgentProfile(sessionType, prompt = '', devicePrompt = '') {
  switch (resolveEffectiveSessionType(sessionType, prompt, devicePrompt)) {
    case 'phone-haiku':
      return {
        provider: 'claude',
        sessionType: 'phone-haiku',
        model: PHONE_HAIKU_CLAUDE_MODEL,
        permissionMode: PHONE_HAIKU_CLAUDE_PERMISSION_MODE,
        tools: PHONE_HAIKU_CLAUDE_TOOLS,
        allowedTools: PHONE_HAIKU_CLAUDE_ALLOWED_TOOLS,
      };
    case 'phone-sonnet':
      return {
        provider: 'claude',
        sessionType: 'phone-sonnet',
        model: PHONE_SONNET_CLAUDE_MODEL,
        permissionMode: PHONE_SONNET_CLAUDE_PERMISSION_MODE,
        tools: PHONE_SONNET_CLAUDE_TOOLS,
        allowedTools: PHONE_SONNET_CLAUDE_ALLOWED_TOOLS,
      };
    case 'phone-opus':
      return {
        provider: 'claude',
        sessionType: 'phone-opus',
        model: PHONE_OPUS_CLAUDE_MODEL,
        permissionMode: PHONE_OPUS_CLAUDE_PERMISSION_MODE,
        tools: PHONE_OPUS_CLAUDE_TOOLS,
        allowedTools: PHONE_OPUS_CLAUDE_ALLOWED_TOOLS,
      };
    case 'phone-deploy':
      return {
        provider: 'claude',
        sessionType: 'phone-deploy',
        model: PHONE_DEPLOY_CLAUDE_MODEL,
        permissionMode: PHONE_DEPLOY_CLAUDE_PERMISSION_MODE,
        tools: PHONE_DEPLOY_CLAUDE_TOOLS,
        allowedTools: PHONE_DEPLOY_CLAUDE_ALLOWED_TOOLS,
      };
    case 'phone-codex-luna':
      return {
        provider: 'codex',
        sessionType: 'phone-codex-luna',
        model: PHONE_CODEX_LUNA_MODEL,
        reasoningEffort: PHONE_CODEX_LUNA_REASONING_EFFORT,
        sandbox: PHONE_CODEX_LUNA_SANDBOX,
        approvalPolicy: PHONE_CODEX_APPROVAL_POLICY,
        tools: [],
        allowedTools: [],
        workingDirectory: PHONE_CODEX_LUNA_WORKING_DIR,
      };
    case 'phone-codex-terra':
      return {
        provider: 'codex',
        sessionType: 'phone-codex-terra',
        model: PHONE_CODEX_TERRA_MODEL,
        reasoningEffort: PHONE_CODEX_TERRA_REASONING_EFFORT,
        sandbox: PHONE_CODEX_TERRA_SANDBOX,
        approvalPolicy: PHONE_CODEX_APPROVAL_POLICY,
        tools: [],
        allowedTools: [],
        workingDirectory: PHONE_CODEX_TERRA_WORKING_DIR,
      };
    case 'phone-codex-sol':
      return {
        provider: 'codex',
        sessionType: 'phone-codex-sol',
        model: PHONE_CODEX_SOL_MODEL,
        reasoningEffort: PHONE_CODEX_SOL_REASONING_EFFORT,
        sandbox: PHONE_CODEX_SOL_SANDBOX,
        approvalPolicy: PHONE_CODEX_APPROVAL_POLICY,
        tools: [],
        allowedTools: [],
        workingDirectory: PHONE_CODEX_SOL_WORKING_DIR,
      };
    case 'phone-codex-deploy':
      return {
        provider: 'codex',
        sessionType: 'phone-codex-deploy',
        model: PHONE_CODEX_DEPLOY_MODEL,
        reasoningEffort: PHONE_CODEX_DEPLOY_REASONING_EFFORT,
        sandbox: PHONE_CODEX_DEPLOY_SANDBOX,
        approvalPolicy: PHONE_CODEX_APPROVAL_POLICY,
        tools: [],
        allowedTools: [],
        workingDirectory: PHONE_CODEX_DEPLOY_WORKING_DIR,
      };
    default:
      if (!ENABLED_AGENT_PROVIDERS.includes('claude') && ENABLED_AGENT_PROVIDERS.includes('codex')) {
        return resolveAgentProfile('phone-codex-luna');
      }
      return {
        provider: 'claude',
        sessionType: 'default',
        model: CLAUDE_MODEL,
        permissionMode: CLAUDE_PERMISSION_MODE,
        tools: CLAUDE_TOOLS,
        allowedTools: CLAUDE_ALLOWED_TOOLS,
      };
  }
}

/**
 * Build the full environment that Claude Code expects.
 * This avoids hardcoding macOS-specific paths so the server works on Linux.
 */
function buildClaudeEnvironment() {
  const PAI_DIR = process.env.PAI_DIR || path.join(HOME, '.claude');

  // Load ~/.claude/.env (all API keys)
  const envPath = path.join(PAI_DIR, '.env');
  const paiEnv = {};
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          paiEnv[key] = valueParts.join('=');
        }
      }
    }
  }

  const nvmBins = [];
  const nvmVersionsDir = path.join(HOME, '.nvm/versions/node');
  if (fs.existsSync(nvmVersionsDir)) {
    for (const version of fs.readdirSync(nvmVersionsDir)) {
      const binPath = path.join(nvmVersionsDir, version, 'bin');
      if (fs.existsSync(binPath)) {
        nvmBins.push(binPath);
      }
    }
  }

  const fullPath = [
    path.join(HOME, '.local/bin'),
    path.join(HOME, '.bun/bin'),
    path.join(HOME, '.cargo/bin'),
    path.join(HOME, '.pyenv/bin'),
    path.join(HOME, '.pyenv/shims'),
    path.join(HOME, 'go/bin'),
    path.join(HOME, 'bin'),
    path.join(HOME, '.lmstudio/bin'),
    path.join(HOME, '.opencode/bin'),
    ...nvmBins,
    '/usr/local/go/bin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/bin',
    '/sbin',
    '/snap/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/python@3.12/bin',
    '/opt/homebrew/opt/libpq/bin',
    ...(process.env.PATH ? process.env.PATH.split(':') : [])
  ]
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .filter((entry) => entry.startsWith('/opt/homebrew') || fs.existsSync(entry))
    .join(':');

  const env = {
    ...process.env,
    ...paiEnv,
    PATH: fullPath,
    HOME,
    PAI_DIR,
    PAI_HOME: HOME,
    DA: 'Morpheus',
    DA_COLOR: 'purple',
    GOROOT: '/usr/local/go',
    GOPATH: path.join(HOME, 'go'),
    PYENV_ROOT: path.join(HOME, '.pyenv'),
    BUN_INSTALL: path.join(HOME, '.bun'),
    // CRITICAL: These tell Claude Code it's running in the proper environment
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  };

  // CRITICAL: Remove ANTHROPIC_API_KEY so Claude CLI uses subscription auth
  // If ANTHROPIC_API_KEY is set (even to placeholder), CLI tries API auth instead
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_REALTIME_API_KEY;
  delete env.OPENAI_SAFETY_IDENTIFIER_SALT;

  return env;
}

// Pre-build the environment once at startup
const claudeEnv = buildAgentExecutionEnvironment(buildClaudeEnvironment());
const codexEnv = buildCodexEnvironment(claudeEnv);
console.log('[STARTUP] Loaded environment with', Object.keys(claudeEnv).length, 'variables');
console.log('[STARTUP] PATH includes:', claudeEnv.PATH.split(':').slice(0, 5).join(', '), '...');
console.log('[STARTUP] Claude working directory:', CLAUDE_WORKING_DIR);
console.log('[STARTUP] Codex working directory:', CODEX_WORKING_DIR);
console.log('[STARTUP] Dedicated agent worker:', agentWorkerConfig.enabled ? 'enabled' : 'disabled');

// Legacy in-memory correlation storage. It deliberately never contains a
// provider session ID; durable continuity belongs to Teleagent state.
const sessions = new Map();
// Session keys created by phone profiles. These are cleared by the panic stop.
const voiceSessionKeys = new Set();
// Active request storage: callId -> Map(requestId -> requestRecord)
const activeRequests = new Map();
// Deferred session expiry timers: sessionKey -> Timeout
const sessionExpiryTimers = new Map();
let activeRequestSequence = 0;

function resolveSessionKey(callId, sessionKey) {
  return sessionKey || callId || null;
}

function clearSessionExpiryTimer(sessionKey) {
  if (!sessionKey || !sessionExpiryTimers.has(sessionKey)) {
    return;
  }

  clearTimeout(sessionExpiryTimers.get(sessionKey));
  sessionExpiryTimers.delete(sessionKey);
}

function deleteSessionState(sessionKey) {
  if (!sessionKey) return false;

  clearSessionExpiryTimer(sessionKey);
  voiceSessionKeys.delete(sessionKey);
  return sessions.delete(sessionKey);
}

function scheduleSessionExpiry(sessionKey, preserveForSeconds) {
  const ttlSeconds = parsePositiveInteger(preserveForSeconds);
  if (!sessionKey || !ttlSeconds || !sessions.has(sessionKey)) {
    const hadSession = !!(sessionKey && sessions.has(sessionKey));
    if (sessionKey && !ttlSeconds) {
      deleteSessionState(sessionKey);
    }
    return {
      hadSession,
      preserved: false,
      ttlSeconds: ttlSeconds || 0,
      expiresAt: null,
    };
  }

  clearSessionExpiryTimer(sessionKey);

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  sessionExpiryTimers.set(
    sessionKey,
    setTimeout(() => {
      const deleted = sessions.delete(sessionKey);
      voiceSessionKeys.delete(sessionKey);
      sessionExpiryTimers.delete(sessionKey);
      console.log(
        `[${new Date().toISOString()}] SESSION EXPIRED: sessionKey=${sessionKey}, deleted=${deleted}`
      );
    }, ttlSeconds * 1000)
  );

  return {
    hadSession: true,
    preserved: true,
    ttlSeconds,
    expiresAt,
  };
}

function nextRequestId() {
  activeRequestSequence += 1;
  return `request:${activeRequestSequence}`;
}

function getActiveRequestBucket(callId, create = false) {
  if (!callId) return null;

  if (!activeRequests.has(callId) && create) {
    activeRequests.set(callId, new Map());
  }

  return activeRequests.get(callId) || null;
}

function registerActiveRequest(callId, requestRecord) {
  if (shutdownRequested) {
    transitionActiveRequest(requestRecord, 'canceled', 'controller_shutdown', { force: true });
    return false;
  }
  const bucket = getActiveRequestBucket(callId, true);
  if (!bucket) return false;
  bucket.set(requestRecord.requestId, requestRecord);
  return true;
}

function clearActiveRequest(callId, requestId) {
  const bucket = getActiveRequestBucket(callId, false);
  if (!bucket) return;

  bucket.delete(requestId);
  if (bucket.size === 0) {
    activeRequests.delete(callId);
  }
}

function killChildProcess(record, signal) {
  const pid = record?.child?.pid;
  if (!pid) return false;

  if (record.detached && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        console.warn(`[${new Date().toISOString()}] Failed to send ${signal} to process group ${pid}: ${error.message}`);
      }
    }
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') {
      console.warn(`[${new Date().toISOString()}] Failed to send ${signal} to pid ${pid}: ${error.message}`);
    }
    return false;
  }
}

function transitionActiveRequest(record, state, reason, { force = false } = {}) {
  if (!record || record.state !== 'running') {
    return false;
  }

  record.state = state;
  record.reason = reason;

  if (record.killTimer) {
    clearTimeout(record.killTimer);
    record.killTimer = null;
  }

  if (typeof record.cancel === 'function') {
    try {
      record.cancel(reason, { force });
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Active request cancellation callback failed: ${error.message}`);
    }
  }

  killChildProcess(record, 'SIGTERM');

  if (force) {
    killChildProcess(record, 'SIGKILL');
    return true;
  }


  if (!record.child) return true;

  if (record.forceKillTimer) {
    clearTimeout(record.forceKillTimer);
  }

  record.forceKillTimer = setTimeout(() => {
    if (record.state === state) {
      killChildProcess(record, 'SIGKILL');
    }
    record.forceKillTimer = null;
  }, 2000);
  if (typeof record.forceKillTimer.unref === 'function') {
    record.forceKillTimer.unref();
  }

  return true;
}

function cancelActiveRequests(callId, {
  sessionKey = null,
  resetSession = false,
  reason = 'cancel_session'
} = {}) {
  const bucket = getActiveRequestBucket(callId, false);
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);
  const requestIds = [];
  let canceledCount = 0;

  if (bucket) {
    for (const record of bucket.values()) {
      if (transitionActiveRequest(record, 'canceled', reason)) {
        canceledCount += 1;
        requestIds.push(record.requestId);
      }
    }
  }

  if (resetSession && resolvedSessionKey) {
    deleteSessionState(resolvedSessionKey);
  }

  return {
    active: !!(bucket && bucket.size > 0),
    canceledCount,
    requestIds,
    resetSession,
  };
}

function cancelAllVoiceRequests({ reason = 'voice_panic_stop' } = {}) {
  const requestIds = [];
  const callIds = new Set();
  let canceledCount = 0;

  for (const [callId, bucket] of activeRequests.entries()) {
    for (const record of bucket.values()) {
      if (!record.voiceOrigin) continue;
      if (transitionActiveRequest(record, 'canceled', reason, { force: true })) {
        canceledCount += 1;
        requestIds.push(record.requestId);
        callIds.add(callId);
      }
    }
  }

  let clearedSessionCount = 0;
  for (const sessionKey of [...voiceSessionKeys]) {
    if (deleteSessionState(sessionKey)) clearedSessionCount += 1;
  }

  return {
    active: canceledCount > 0,
    canceledCount,
    requestIds,
    callIds: [...callIds],
    clearedSessionCount,
  };
}

function snapshotActiveRequests() {
  const records = [];
  for (const [scopeKey, bucket] of activeRequests.entries()) {
    for (const record of bucket.values()) {
      records.push({ scopeKey, record });
    }
  }
  return records;
}

function waitForActiveRequestsToDrain(timeoutMs) {
  if (activeRequests.size === 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const check = () => {
      if (activeRequests.size === 0) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 25);
    };
    check();
  });
}

function controllerShuttingDownError() {
  const error = new Error('Controller shutdown is in progress.');
  error.code = 'CONTROLLER_SHUTTING_DOWN';
  return error;
}

async function waitForTestPreRegistrationBarrier() {
  if (!TEST_PRE_REGISTRATION_BARRIER) return;
  const waitingPath = `${TEST_PRE_REGISTRATION_BARRIER}.waiting`;
  const releasePath = `${TEST_PRE_REGISTRATION_BARRIER}.release`;
  fs.writeFileSync(waitingPath, 'waiting\n', { mode: 0o600 });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the test-only pre-registration barrier.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function drainAllActiveRequests({
  reason = 'controller_shutdown',
  gracefulMs = 1500,
  forceMs = 1000,
} = {}) {
  const initial = snapshotActiveRequests();
  for (const { record } of initial) {
    transitionActiveRequest(record, 'canceled', reason);
  }

  if (await waitForActiveRequestsToDrain(gracefulMs)) {
    return {
      requestedCount: initial.length,
      forcedCount: 0,
      quiesced: true,
      remainingRequestIds: [],
    };
  }

  const remaining = snapshotActiveRequests();
  let forcedCount = 0;
  for (const { record } of remaining) {
    if (record.child && killChildProcess(record, 'SIGKILL')) forcedCount += 1;
    if (typeof record.cancel === 'function') {
      try {
        record.cancel(reason, { force: true });
      } catch (error) {
        console.warn(
          `[${new Date().toISOString()}] Forced active request cancellation failed: ${error.message}`
        );
      }
    }
  }

  const quiesced = await waitForActiveRequestsToDrain(forceMs);
  return {
    requestedCount: initial.length,
    forcedCount,
    quiesced,
    remainingRequestIds: quiesced
      ? []
      : snapshotActiveRequests().map(({ record }) => record.requestId),
  };
}

function buildAgentInvocation({
  fullPrompt,
  sessionKey,
  resumeSessionId = null,
  timestamp,
  profile,
}) {
  const provider = profile.provider || 'claude';
  // Provider homes are intentionally credential- and history-free. Never
  // expose a previous provider session to a new launch/call; durable voice
  // context is the only authorized continuity boundary.
  void resumeSessionId;
  const existingSessionId = null;

  if (sessionKey) {
    clearSessionExpiryTimer(sessionKey);
  }

  if (provider === 'codex') {
    const workingDirectory = profile.workingDirectory || CODEX_WORKING_DIR;
    const args = buildCodexArgs({
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvalPolicy,
      workingDirectory,
      sessionId: existingSessionId,
    });

    console.log(`[${timestamp}] Starting fresh Codex execution boundary`);

    return {
      command: agentWorkerConfig.enabled
        ? agentWorkerConfig.providerCommands.codex
        : CODEX_COMMAND,
      args,
      cwd: workingDirectory,
      env: codexEnv,
      stdinInput: fullPrompt,
      provider,
      accessMode: profile.accessMode,
    };
  }

  const args = buildClaudeArgs({
    model: profile.model,
    permissionMode: profile.permissionMode,
    tools: profile.tools,
    allowedTools: profile.allowedTools,
    sessionId: existingSessionId,
    newSessionId: null,
  });

  console.log(`[${timestamp}] Starting fresh Claude execution boundary`);

  return {
    command: agentWorkerConfig.enabled
      ? agentWorkerConfig.providerCommands.claude
      : CLAUDE_COMMAND,
    args,
    cwd: CLAUDE_WORKING_DIR,
    env: claudeEnv,
    stdinInput: fullPrompt,
    provider,
    accessMode: profile.accessMode,
  };
}

function runAgentOnce({
  fullPrompt,
  callId,
  sessionKey,
  resumeSessionId = null,
  timestamp,
  profile,
  timeoutSeconds = null,
  signal = null,
  onStarted = null,
  onProviderLaunchStatus = null,
}) {
  if (shutdownRequested) return Promise.reject(controllerShuttingDownError());
  const startTime = Date.now();
  const resolvedTimeoutSeconds = parsePositiveInteger(timeoutSeconds);
  const requestId = nextRequestId();
  const requestScopeKey = callId || requestId;
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);
  const voiceOrigin = isPhoneSessionType(profile?.sessionType);

  assertVoiceExecutionAllowed(profile);
  requireHardenedWorkerBoundary();
  if (voiceOrigin && resolvedSessionKey) {
    voiceSessionKeys.add(resolvedSessionKey);
  }

  const invocation = wrapAgentInvocation(
    buildAgentInvocation({
      fullPrompt,
      sessionKey: resolvedSessionKey,
      resumeSessionId,
      timestamp,
      profile,
    }),
    {
      config: agentWorkerConfig,
      taskId: requestId,
    }
  );
  const providerLabel = invocation.provider === 'codex' ? 'Codex' : 'Claude';

  // This second synchronous fence is deliberately adjacent to spawn. Node
  // cannot dispatch the shutdown signal between this check and the Promise
  // executor below, so a request that was awaiting authorization cannot start
  // provider code once shutdown has begun.
  if (shutdownRequested) return Promise.reject(controllerShuttingDownError());
  return new Promise((resolve, reject) => {
    const agent = spawn(invocation.command, invocation.args, {
      // fd3 carries the authenticated provider-start fact. fd4 is the
      // controller acknowledgement written only after that fact is durably
      // recorded, so the client cannot forward the prompt first.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
      cwd: invocation.cwd,
      env: invocation.env
    });

    const requestRecord = {
      requestId,
      callId,
      child: agent,
      provider: invocation.provider,
      voiceOrigin,
      detached: process.platform !== 'win32',
      state: 'running',
      reason: null,
      killTimer: null,
      forceKillTimer: null,
      startedAt: startTime,
    };

    if (!registerActiveRequest(requestScopeKey, requestRecord)) {
      agent.once('error', () => {});
      agent.stdin.on('error', () => {});
      agent.stdout.resume();
      agent.stderr.resume();
      return reject(controllerShuttingDownError());
    }
    console.log(`[${timestamp}] ACTIVE REQUEST STARTED: requestId=${requestId} callLinked=${callId ? 'yes' : 'no'}`);

    const abortRequest = () => {
      const reason = signal?.reason?.message || signal?.reason || 'executor_task_canceled';
      transitionActiveRequest(requestRecord, 'canceled', String(reason));
    };
    if (signal) {
      if (signal.aborted) abortRequest();
      else signal.addEventListener('abort', abortRequest, { once: true });
    }
    if (typeof onStarted === 'function') {
      try {
        onStarted({
          pid: agent.pid,
          detached: requestRecord.detached,
          provider: invocation.provider,
          requestId,
        });
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to persist agent process identity: ${error.message}`);
        transitionActiveRequest(requestRecord, 'canceled', 'execution_identity_persistence_failed');
      }
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputBytes = 0;
    let providerStatusBytes = 0;
    let providerStatusBuffer = '';
    let providerLaunchStatus = null;
    let providerStatusComplete = false;
    let providerStatusAcknowledged = false;
    let settled = false;

    agent.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        console.warn(`[${new Date().toISOString()}] ${providerLabel} stdin error: ${error.message}`);
      }
    });
    agent.stdin.end(invocation.stdinInput);
    const captureAgentOutput = (stream, data) => {
      if (requestRecord.state === 'output_limited') return;
      const bytes = Buffer.from(data);
      const streamBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const streamLimit = stream === 'stdout'
        ? MAX_AGENT_STDOUT_BYTES
        : MAX_AGENT_STDERR_BYTES;
      if (streamBytes + bytes.length > streamLimit ||
          outputBytes + bytes.length > MAX_AGENT_OUTPUT_BYTES) {
        transitionActiveRequest(
          requestRecord,
          'output_limited',
          'provider_output_limit_exceeded'
        );
        return;
      }
      outputBytes += bytes.length;
      if (stream === 'stdout') {
        stdoutBytes += bytes.length;
        stdout += bytes.toString('utf8');
      } else {
        stderrBytes += bytes.length;
        stderr += bytes.toString('utf8');
      }
    };
    agent.stdout.on('data', (data) => captureAgentOutput('stdout', data));
    agent.stderr.on('data', (data) => captureAgentOutput('stderr', data));
    const persistProviderLaunchStatus = (status) => {
      if (typeof onProviderLaunchStatus !== 'function') return true;
      try {
        onProviderLaunchStatus(status);
        return true;
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] Failed to persist provider launch status: ${error.message}`
        );
        transitionActiveRequest(
          requestRecord,
          'canceled',
          'provider_launch_status_persistence_failed'
        );
        return false;
      }
    };
    const finalizeProviderStatus = () => {
      if (providerStatusComplete || providerStatusBytes > 1024) return;
      providerStatusComplete = true;
      const newline = providerStatusBuffer.indexOf('\n');
      if (newline <= 0 || newline !== providerStatusBuffer.length - 1) return;
      const line = providerStatusBuffer.slice(0, newline);
      try {
        const parsed = JSON.parse(line);
        if (parsed?.version !== 1 || typeof parsed.accepted !== 'boolean') return;
        if (parsed.accepted === true && /^launch_[a-f0-9]{32}$/.test(parsed.launchId || '')) {
          providerLaunchStatus = { accepted: true, launchId: parsed.launchId };
        } else if (parsed.code === 'PROVIDER_SUPERVISOR_BUSY') {
          providerLaunchStatus = { accepted: false, code: 'PROVIDER_SUPERVISOR_BUSY' };
        } else if (parsed.code === 'PROVIDER_EXECUTION_OUTCOME_UNKNOWN' &&
            parsed.providerStarted === false && parsed.providerExecutionAttempted === true &&
            parsed.retrySafe === false && parsed.quiesced === true &&
            /^launch_[a-f0-9]{32}$/.test(parsed.launchId || '')) {
          providerLaunchStatus = {
            accepted: false,
            code: 'PROVIDER_EXECUTION_OUTCOME_UNKNOWN',
            providerStarted: false,
            providerExecutionAttempted: true,
            retrySafe: false,
            quiesced: true,
            launchId: parsed.launchId,
          };
        } else {
          return;
        }
        if (!persistProviderLaunchStatus(providerLaunchStatus)) providerLaunchStatus = null;
        if (providerLaunchStatus?.accepted === true) {
          const ack = `${JSON.stringify({
            version: 1,
            statusPersisted: true,
            launchId: providerLaunchStatus.launchId,
          })}\n`;
          agent.stdio[4].end(ack);
          providerStatusAcknowledged = true;
        }
      } catch { /* malformed side-channel status is never retry-safe */ }
    };
    agent.stdio[3].on('data', (data) => {
      providerStatusBytes += data.length;
      if (providerStatusBytes <= 1024) {
        providerStatusBuffer += data.toString('utf8');
        if (providerStatusBuffer.includes('\n')) finalizeProviderStatus();
      }
    });
    agent.stdio[3].on('end', finalizeProviderStatus);
    agent.stdio[3].on('error', () => {});
    agent.stdio[4].on('error', () => {});

    function cleanup() {
      if (signal) signal.removeEventListener('abort', abortRequest);
      if (requestRecord.killTimer) {
        clearTimeout(requestRecord.killTimer);
        requestRecord.killTimer = null;
      }
      if (requestRecord.forceKillTimer) {
        clearTimeout(requestRecord.forceKillTimer);
        requestRecord.forceKillTimer = null;
      }
      clearActiveRequest(requestScopeKey, requestId);
    }

    function settleWithError(error) {
      if (settled) return;
      settled = true;
      if (providerLaunchStatus) error.providerLaunchStatus = providerLaunchStatus;
      error.providerWrapperSpawned = Number.isInteger(agent.pid) && agent.pid > 0;
      cleanup();
      reject(error);
    }

    function settleWithSuccess(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    if (resolvedTimeoutSeconds) {
      requestRecord.killTimer = setTimeout(() => {
        console.error(`[${new Date().toISOString()}] ${providerLabel.toUpperCase()} TIMEOUT after ${resolvedTimeoutSeconds}s; terminating request`);
        transitionActiveRequest(requestRecord, 'timed_out', `timeout_${resolvedTimeoutSeconds}s`);
      }, resolvedTimeoutSeconds * 1000);
    }

    agent.on('error', (error) => {
      settleWithError(error);
    });

    agent.on('close', (code) => {
      const duration_ms = Date.now() - startTime;
      finalizeProviderStatus();
      if (providerLaunchStatus?.accepted === true && !providerStatusAcknowledged) {
        const error = new Error('Provider accepted without a durable controller acknowledgement');
        error.code = 'PROVIDER_START_STATUS_UNACKNOWLEDGED';
        return settleWithError(error);
      }
      if (requestRecord.state === 'timed_out') {
        const error = new Error(`${providerLabel} request timed out after ${resolvedTimeoutSeconds} seconds`);
        error.code = 'CLAUDE_TIMEOUT';
        error.stdout = stdout;
        error.stderr = stderr;
        error.duration_ms = duration_ms;
        return settleWithError(error);
      }
      if (requestRecord.state === 'canceled') {
        const error = new Error(`${providerLabel} request canceled`);
        error.code = 'CLAUDE_CANCELED';
        error.reason = requestRecord.reason || 'cancel_session';
        error.stdout = stdout;
        error.stderr = stderr;
        error.duration_ms = duration_ms;
        return settleWithError(error);
      }
      if (requestRecord.state === 'output_limited') {
        const error = new Error(`${providerLabel} output exceeded the controller bound`);
        error.code = 'AGENT_OUTPUT_LIMIT_EXCEEDED';
        error.stdout = stdout;
        error.stderr = stderr;
        error.duration_ms = duration_ms;
        return settleWithError(error);
      }
      settleWithSuccess({
        code,
        stdout,
        stderr,
        duration_ms,
        provider: invocation.provider,
        providerLaunchStatus,
      });
    });
  });
}

/**
 * Voice Context - Prepended to all voice queries
 *
 * This tells the selected agent how to handle voice-specific patterns:
 * - Output VOICE_RESPONSE for TTS (conversational, 40 words max)
 * - Output COMPLETED for status logging (12 words max)
 * - For Slack delivery requests: do the work, send to Slack, then acknowledge
 */
const VOICE_CONTEXT = `[VOICE CALL CONTEXT]
This query comes via voice call. You MUST include BOTH of these lines in your response:

🗣️ VOICE_RESPONSE: [Your conversational answer in 40 words or less. This is what gets spoken aloud via TTS. Be natural and helpful, like talking to a friend.]

🎯 COMPLETED: [Status summary in 12 words or less. This is for logging only.]

IMPORTANT: The VOICE_RESPONSE line is what the caller HEARS. Make it conversational and complete - don't just say "Done" or "Task completed". Actually answer their question or confirm what you did in a natural way.

PHONE GIT SAFETY:
- For repo commit/push requests, use the phone-publish Bash wrapper instead of raw git commit/git push commands.
- For GitHub PR merge requests, use the phone-merge-pr Bash wrapper instead of raw gh pr merge.

PHONE TROUBLESHOOTING:
- Haiku and Sonnet are trusted troubleshooting-shell profiles on Hermes.
- For routine phone-runtime troubleshooting on Haiku or Sonnet, prefer this exact command shortlist first unless the caller clearly needs something else:
  - docker ps
  - docker logs --tail 100 voice-app
  - docker logs --tail 100 drachtio
  - docker logs --tail 100 freeswitch
  - docker logs --tail 100 hermes-asterisk
  - systemctl --user status claude-api-server
  - journalctl --user -u claude-api-server --no-pager -n 100
  - curl -fsS http://127.0.0.1:3000/health
  - curl -fsS http://127.0.0.1:3333/health
- Start with those commands before reaching for broader shell access.
- Treat Bash as operator-grade access on Hermes rather than a sandboxed wrapper.

PHONE CALLBACK DELIVERY: When the caller requests callback delivery (phrases like "call me when done", "phone me when done", "ring me when this finishes"):
1. Do the requested work first.
2. If the caller stays on the line, answer normally on the current call.
3. If the caller hangs up before you answer, the phone runtime will place the callback automatically.
4. Do not invoke the Call skill yourself from a live phone call unless the user explicitly wants an additional separate callback even after hearing the current answer.

SLACK DELIVERY: When the caller requests delivery to Slack (phrases like "send to Slack", "post to #channel", "message me when done"):
1. Do the requested work (research, generate content, analyze, etc.)
2. Send results to the specified Slack channel using the Slack skill
3. Include a VOICE_RESPONSE like: "Done! I sent the weather info to the 508 channel."

The caller may hang up while you're working (they'll hear hold music). That's fine - complete the work and send to Slack. They'll see it there.

Example query: "What's the weather in Royce City?"
Example response:
🗣️ VOICE_RESPONSE: It's 65 degrees and partly cloudy in Royce City right now. Great weather for being outside!
🎯 COMPLETED: Weather lookup for Royce City done.
[END VOICE CONTEXT]

`;

const PHONE_DEPLOY_CONTEXT = `[PHONE DEPLOY EXECUTION]
This request explicitly asks you to deploy, ship, merge, publish, or republish app-platform work.

Execution rules:
- Loading a skill only reads instructions. It does not execute the workflow.
- Do not say deployment started or completed unless you actually ran the required commands.
- Use Bash for the real workflow steps.
- For commit/push, use phone-publish instead of raw git commit/git push.
- For PR merge, use phone-merge-pr instead of raw gh pr merge.
- Treat the deploy as incomplete until GitHub/CI/workflow state confirms the step finished or you hit a concrete blocker.
- If something blocks execution, state the exact blocker instead of claiming the deploy is in progress.
[END PHONE DEPLOY EXECUTION]

`;

// Middleware
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Closing the HTTP listener stops new connections, while this guard also
// rejects requests that were already pipelined on an existing keep-alive
// connection. Health remains available and reports not_ready during drain.
app.use((req, res, next) => {
  if (!shutdownRequested || req.path === '/health') return next();
  return res.status(503).json({
    success: false,
    code: 'CONTROLLER_SHUTTING_DOWN',
    error: 'Controller shutdown is in progress.',
  });
});

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

function providedApiToken(req) {
  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch ? bearerMatch[1].trim() : '';
}

function hasValidApiToken(req, expectedToken = AGENT_API_TOKEN) {
  return Boolean(expectedToken) && safeEqual(providedApiToken(req), expectedToken);
}

function isExecutorPath(requestPath) {
  return requestPath === '/executor' || requestPath.startsWith('/executor/');
}

function isPrivilegedActionPath(requestPath) {
  return requestPath === '/privileged-actions' ||
    requestPath.startsWith('/privileged-actions/');
}

function isVoiceControlPath(requestPath) {
  return requestPath === '/voice-control' || requestPath.startsWith('/voice-control/');
}

function isOperatorPath(requestPath) {
  return requestPath === '/operator' || requestPath.startsWith('/operator/');
}

app.use((req, res, next) => {
  const localPanicStop = req.method === 'POST' &&
    req.path === '/voice-control/stop' &&
    isLoopbackRequest(req);

  if (req.path === '/' || req.path === '/health' || localPanicStop) {
    return next();
  }

  // Clearing the global phone-execution lock is an operator capability even
  // though this compatibility endpoint lives below /executor. The executor
  // bearer may request panic/cancellation, but can never unlock execution.
  if (req.method === 'POST' && req.path === '/executor/panic/unlock') {
    if (!VOICE_CONTROL_TOKEN) {
      return res.status(503).json({
        success: false,
        code: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
        error: 'Voice operator authentication is not configured.',
      });
    }
    if (hasValidApiToken(req, VOICE_CONTROL_TOKEN)) return next();
    return res.status(401).json({
      success: false,
      code: 'VOICE_CONTROL_UNAUTHORIZED',
      error: 'unauthorized',
    });
  }

  if (isExecutorPath(req.path)) {
    if (!EXECUTOR_API_TOKEN) {
      return res.status(503).json({
        success: false,
        code: 'EXECUTOR_AUTH_NOT_CONFIGURED',
        error: 'Durable executor authentication is not configured.',
      });
    }
    if (hasValidApiToken(req, EXECUTOR_API_TOKEN)) return next();
    return res.status(401).json({
      success: false,
      code: 'EXECUTOR_UNAUTHORIZED',
      error: 'unauthorized',
    });
  }

  if (isPrivilegedActionPath(req.path)) {
    if (!PRIVILEGED_ACTION_PROXY_ENABLED || !privilegedActionProxy) {
      return res.status(503).json({
        success: false,
        code: 'PRIVILEGED_ACTION_PROXY_DISABLED',
        error: 'Privileged action forwarding is disabled on this controller.',
      });
    }
    if (!PRIVILEGED_ACTION_API_TOKEN) {
      return res.status(503).json({
        success: false,
        code: 'PRIVILEGED_ACTION_AUTH_NOT_CONFIGURED',
        error: 'Privileged action proxy authentication is not configured.',
      });
    }
    if (hasValidApiToken(req, PRIVILEGED_ACTION_API_TOKEN)) return next();
    return res.status(401).json({
      success: false,
      code: 'PRIVILEGED_ACTION_UNAUTHORIZED',
      error: 'unauthorized',
    });
  }

  if (isVoiceControlPath(req.path) || isOperatorPath(req.path)) {
    if (!VOICE_CONTROL_TOKEN) {
      return res.status(503).json({
        success: false,
        code: 'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
        error: 'Voice operator authentication is not configured.',
      });
    }
    if (hasValidApiToken(req, VOICE_CONTROL_TOKEN)) return next();
    return res.status(401).json({
      success: false,
      code: 'VOICE_CONTROL_UNAUTHORIZED',
      error: 'unauthorized',
    });
  }

  if (!AGENT_API_TOKEN) {
    return res.status(503).json({
      success: false,
      code: 'AGENT_AUTH_NOT_CONFIGURED',
      error: 'Agent bridge authentication is not configured.',
    });
  }

  if (hasValidApiToken(req)) return next();

  return res.status(401).json({
    success: false,
    code: 'AGENT_UNAUTHORIZED',
    error: 'unauthorized',
  });
});

app.post('/operator/inspect', async (req, res) => {
  const action = String(req.body?.action || '').trim();
  const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
  const startedAt = Date.now();
  try {
    const result = await callWorkerBoundary(() => operatorInspector.execute(action, args));
    console.log(
      `[${new Date().toISOString()}] OPERATOR INSPECT action=${action || 'unknown'} ` +
      `success=yes duration_ms=${Date.now() - startedAt}`
    );
    return res.json({ success: true, action, result });
  } catch (error) {
    const code = error.code || 'OPERATOR_INSPECTION_FAILED';
    const status = workerBoundaryHttpStatus(error);
    console.warn(
      `[${new Date().toISOString()}] OPERATOR INSPECT action=${action || 'unknown'} ` +
      `success=no code=${code} duration_ms=${Date.now() - startedAt}`
    );
    return res.status(status).json({ success: false, code, error: error.message });
  }
});

app.post('/operator/session-message/prepare', async (req, res) => {
  const voiceExecution = voiceExecutionControl.getStatus();
  if (voiceExecution.locked) {
    return res.status(423).json(voiceExecutionLockedPayload(voiceExecution));
  }
  try {
    const result = await callWorkerBoundary(
      () => tmuxAgentController.prepare({ target: req.body?.target })
    );
    if (!ENABLED_AGENT_PROVIDERS.includes(result.provider)) {
      return res.status(503).json({
        success: false,
        code: 'AGENT_PROVIDER_DISABLED',
        error: `${result.provider} is not enabled on this agent bridge`,
      });
    }
    return res.json({ success: true, result });
  } catch (error) {
    const code = error.code || 'TARGET_SESSION_PREPARE_FAILED';
    const status = workerBoundaryHttpStatus(error);
    return res.status(status).json({ success: false, code, error: error.message });
  }
});

app.post('/operator/session-message', async (req, res) => {
  const voiceExecution = voiceExecutionControl.getStatus();
  if (voiceExecution.locked) {
    return res.status(423).json(voiceExecutionLockedPayload(voiceExecution));
  }

  const operationId = String(req.body?.operationId || '').trim();
  const target = req.body?.target;
  const message = String(req.body?.message || '').trim();
  const sessionFingerprint = String(req.body?.sessionFingerprint || '').trim();
  const authorization = req.body?.authorization || null;
  const timeoutSeconds = Math.max(
    30,
    Math.min(Number.parseInt(req.body?.timeoutSeconds, 10) || 1800, 3600)
  );
  if (!operationId || operationId.length > 200 || /[\u0000-\u001F\u007F]/.test(operationId)) {
    return res.status(400).json({
      success: false,
      code: 'OPERATION_ID_REQUIRED',
      error: 'A valid operationId is required.',
    });
  }
  if (!message || message.length > 4000 || message.includes('\0')) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_TARGET_MESSAGE',
      error: 'A plain-text message no longer than 4,000 characters is required.',
    });
  }

  let prepared;
  try {
    prepared = await callWorkerBoundary(() => tmuxAgentController.prepare({ target }));
  } catch (error) {
    const code = error.code || 'TARGET_SESSION_PREPARE_FAILED';
    const status = workerBoundaryHttpStatus(error);
    return res.status(status).json({ success: false, code, error: error.message });
  }
  if (!ENABLED_AGENT_PROVIDERS.includes(prepared.provider)) {
    return res.status(503).json({
      success: false,
      code: 'AGENT_PROVIDER_DISABLED',
      error: `${prepared.provider} is not enabled on this agent bridge`,
    });
  }

  const approval = await authorizeTargetSessionRequest({
    verifier: approvalVerifier,
    operationId,
    target,
    message,
    sessionFingerprint,
    timeoutSeconds,
    prepared,
    authorization,
  });
  if (!approval.allowed) {
    return res.status(403).json({
      success: false,
      code: approval.code,
      agentCode: approval.code,
      error: 'Job-specific DTMF approval is required for target-session delivery.',
      userMessage: 'Review the exact tmux target and message, then press pound to approve it.',
    });
  }

  const requestId = nextRequestId();
  const abortController = new globalThis.AbortController();
  const requestRecord = {
    requestId,
    callId: operationId,
    child: null,
    provider: null,
    voiceOrigin: true,
    detached: false,
    state: 'running',
    reason: null,
    killTimer: null,
    forceKillTimer: null,
    startedAt: Date.now(),
    cancel: () => abortController.abort(),
  };
  if (!registerActiveRequest(operationId, requestRecord)) {
    return res.status(503).json({
      success: false,
      code: 'CONTROLLER_SHUTTING_DOWN',
      error: 'Controller shutdown is in progress.',
    });
  }

  try {
    const result = await callWorkerBoundary(() => tmuxAgentController.send({
      target: prepared.stable_target || prepared.target,
      message,
      sessionFingerprint,
      timeoutMs: timeoutSeconds * 1000,
      signal: abortController.signal,
      operationId,
    }));
    requestRecord.provider = result.provider;
    return res.json({ success: true, result });
  } catch (error) {
    const code = error.code || 'TARGET_SESSION_MESSAGE_FAILED';
    const status = workerBoundaryHttpStatus(error);
    return res.status(status).json({ success: false, code, agentCode: code, error: error.message });
  } finally {
    clearActiveRequest(operationId, requestId);
  }
});

/**
 * POST /ask
 *
 * Request body:
 *   {
 *     "prompt": "What Docker containers are running?",
 *     "callId": "optional-call-uuid",
 *     "sessionKey": "optional-stable-session-uuid",
 *     "devicePrompt": "optional device-specific prompt",
 *     "sessionType": "optional profile name such as phone"
 *   }
 *
 * Response:
 *   { "success": true, "response": "...", "duration_ms": 1234 }
 *
 * Session Management:
 *   - Every provider process starts with an ephemeral, history-free home.
 *   - Provider session IDs and resume requests are deliberately ignored.
 *   - Conversation continuity belongs to the durable voice state, never a
 *     provider-wide Claude/Codex transcript store.
 *
 * Device Prompts:
 *   - If devicePrompt is provided, it's prepended before VOICE_CONTEXT
 *   - This allows each device (NAS, Proxmox, etc.) to have its own identity and skills
 */
async function handleAskRequest(req, res, {
  preauthorizedVoice = null,
  signal = null,
  onAgentStarted = null,
  onProviderLaunchStatus = null,
  durableExecution = false,
} = {}) {
  const {
    prompt,
    callId,
    sessionKey,
    resumeSessionId,
    devicePrompt,
    sessionType,
    timeoutSeconds,
    authorization,
  } = req.body;
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const deployIntent = looksLikePhoneDeployRequest(prompt, devicePrompt);
  const profile = resolveAgentProfile(sessionType, prompt, devicePrompt);
  const resolvedTimeoutSeconds = resolveRequestTimeoutSeconds(sessionType, prompt, devicePrompt, timeoutSeconds);
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);

  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: 'Missing prompt in request body'
    });
  }

  if (requestsSensitiveValueRetrieval(prompt)) {
    return res.status(403).json(sensitiveValueRetrievalDenied(profile.provider));
  }

  // Refuse before one-time approval verification/consumption. A generic
  // sessionKey remains a correlation key, but no provider transcript or
  // server-side response object is reusable across launches.
  if (requestsProviderResume(resumeSessionId)) {
    return res.status(409).json(providerResumeUnavailable(profile.provider));
  }

  // Provider launch namespaces have no GitHub, cluster, or homelab egress.
  // Refuse deploy-class work before one-time approval verification/consumption.
  if (deployIntent) {
    return res.status(503).json(deployUnavailableUntilToolBroker(profile.provider));
  }

  const requestClassification = classifyVoiceOperation(prompt);
  if (!durableExecution && requestClassification.level !== RISK_LEVELS.READ_ONLY) {
    return res.status(409).json(mutationRequiresDurableExecutor({
      provider: profile.provider,
      classification: requestClassification,
    }));
  }

  const voiceExecutionStatus = voiceExecutionControl.getStatus();
  if (isPhoneSessionType(profile.sessionType) && voiceExecutionStatus.locked) {
    return res.status(423).json(voiceExecutionLockedPayload(voiceExecutionStatus));
  }

  if (!ENABLED_AGENT_PROVIDERS.includes(profile.provider)) {
    return res.status(503).json({
      success: false,
      provider: profile.provider,
      code: 'AGENT_PROVIDER_DISABLED',
      agentCode: 'AGENT_PROVIDER_DISABLED',
      error: `${profile.provider} is not enabled on this agent bridge`,
    });
  }

  const deploymentAuthorization = getDeploymentAuthorization(sessionType, prompt, devicePrompt);
  if (!deploymentAuthorization.allowed) {
    return res.status(403).json({
      success: false,
      provider: profile.provider,
      code: deploymentAuthorization.code,
      agentCode: deploymentAuthorization.agentCode,
      error: 'Privileged Codex profile required',
      userMessage: deploymentAuthorization.message,
    });
  }

  try {
    requireHardenedWorkerBoundary();
  } catch (error) {
    return res.status(503).json({
      success: false,
      provider: profile.provider,
      code: error.code || 'AGENT_WORKER_ISOLATION_REQUIRED',
      agentCode: 'AGENT_WORKER_ISOLATION_REQUIRED',
      error: error.message,
    });
  }

  const voiceAuthorization = preauthorizedVoice ||
    await authorizeManagedVoiceRequest({
      verifier: approvalVerifier,
      profile,
      prompt,
      callId,
      sessionKey: resolvedSessionKey,
      sessionType,
      timeoutSeconds: resolvedTimeoutSeconds,
      devicePrompt,
      authorization,
    });
  if (!voiceAuthorization.allowed) {
    return res.status(403).json({
      success: false,
      provider: profile.provider,
      code: voiceAuthorization.code,
      agentCode: voiceAuthorization.code,
      error: 'Job-specific DTMF approval required',
      userMessage: voiceAuthorization.userMessage,
      risk: voiceAuthorization.classification,
    });
  }
  const executionProfile = applyProviderAccessBoundary(profile, voiceAuthorization);

  // Check if we have an existing session for this call
  const existingSession = resolvedSessionKey ? sessions.get(resolvedSessionKey) : null;

  logTextSummary(`[${timestamp}] QUERY`, prompt);
  logAgentProfile(timestamp, executionProfile);
  console.log(`[${timestamp}] DEPLOY INTENT: ${deployIntent}`);
  console.log(`[${timestamp}] TIMEOUT: ${resolvedTimeoutSeconds || 'none'}s`);
  logSessionSummary(timestamp, {
    callId,
    sessionKey: resolvedSessionKey,
    hasExistingSession: !!existingSession
  });
  console.log(`[${timestamp}] DEVICE PROMPT: ${valuePresence(devicePrompt)}`);

  try {
    /**
     * Prompt layering order:
     * 1. Device prompt (if provided) - identity and available skills
     * 2. VOICE_CONTEXT - general voice call instructions
     * 3. User's prompt - what they actually said
     */
    let fullPrompt = '';

    if (devicePrompt) {
      fullPrompt += `[DEVICE IDENTITY]\n${devicePrompt}\n[END DEVICE IDENTITY]\n\n`;
    }

    fullPrompt += VOICE_CONTEXT;
    fullPrompt += buildVoiceAuthorizationContext(voiceAuthorization);
    if (deployIntent) {
      fullPrompt += PHONE_DEPLOY_CONTEXT;
    }
    fullPrompt += prompt;

    await waitForTestPreRegistrationBarrier();
    const { code, stdout, stderr, duration_ms, provider, providerLaunchStatus } = await runAgentOnce({
      fullPrompt,
      callId,
      sessionKey: resolvedSessionKey,
      resumeSessionId,
      timestamp,
      profile: executionProfile,
      timeoutSeconds: resolvedTimeoutSeconds,
      signal,
      onStarted: onAgentStarted,
      onProviderLaunchStatus,
    });
    const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';

    if (code !== 0) {
      console.error(`[${new Date().toISOString()}] ERROR: ${providerLabel} CLI exited with code ${code}`);
      logTextSummary('STDERR', stderr, 500);
      logTextSummary('STDOUT', stdout, 500);
      const parsedFailure = parseAgentStdout(provider, stdout);
      const errorMsg = parsedFailure.error || stderr || parsedFailure.response || `Exit code ${code}`;
      const capacityDeferred = providerLaunchStatus?.accepted === false &&
        providerLaunchStatus?.code === 'PROVIDER_SUPERVISOR_BUSY';
      const explicitProviderOutcomeUnknown = providerLaunchStatus?.accepted === false &&
        providerLaunchStatus?.code === 'PROVIDER_EXECUTION_OUTCOME_UNKNOWN' &&
        providerLaunchStatus.providerExecutionAttempted === true &&
        providerLaunchStatus.retrySafe === false;
      const providerOutcomeUnknown = explicitProviderOutcomeUnknown ||
        (executionProfile.accessMode === 'mutating' && !capacityDeferred);
      return res.status(providerOutcomeUnknown ? 409 : (capacityDeferred ? 503 : 200)).json({
        success: false,
        provider,
        code: providerOutcomeUnknown
          ? 'EXECUTION_OUTCOME_UNKNOWN'
          : (capacityDeferred ? 'PROVIDER_SUPERVISOR_BUSY' : 'AGENT_CLI_FAILED'),
        agentCode: providerOutcomeUnknown
          ? 'EXECUTION_OUTCOME_UNKNOWN'
          : (capacityDeferred ? 'PROVIDER_SUPERVISOR_BUSY' : 'AGENT_CLI_FAILED'),
        error: providerOutcomeUnknown
          ? `${providerLabel} may have performed the approved mutation, but no verified success response was returned.`
          : (capacityDeferred
          ? `${providerLabel} capacity is occupied; the durable request remains queued.`
          : `${providerLabel} CLI failed: ${errorMsg}`),
        ...(capacityDeferred ? { provider_started: false, retry_safe: true } : {}),
        ...(providerOutcomeUnknown ? {
          provider_started: providerLaunchStatus?.accepted === true,
          provider_execution_attempted:
            providerLaunchStatus?.accepted === true ||
            providerLaunchStatus?.providerExecutionAttempted === true,
          retry_safe: false,
          outcome_unknown: true,
          execution_outcome_unknown: true,
        } : {}),
        duration_ms,
      });
    }

    const { response } = parseAgentStdout(provider, stdout);

    logTextSummary(`[${new Date().toISOString()}] RESPONSE (${duration_ms}ms)`, response);

    res.json({
      success: true,
      response,
      provider,
      provider_context_persistent: false,
      duration_ms,
    });

  } catch (error) {
    const duration_ms = Date.now() - startTime;
    console.error(`[${timestamp}] ERROR:`, error.message);

    const payload = {
      success: false,
      provider: profile.provider,
      error: error.message,
      duration_ms
    };

    if (error.code) {
      payload.code = error.code;
      payload.agentCode = toAgentErrorCode(error.code);
    }
    if (error.reason) {
      payload.reason = error.reason;
    }

    if (executionProfile.accessMode === 'mutating' && error.providerWrapperSpawned === true) {
      return res.status(409).json({
        ...payload,
        code: 'EXECUTION_OUTCOME_UNKNOWN',
        agentCode: 'EXECUTION_OUTCOME_UNKNOWN',
        error: 'The approved mutation may have executed, but its verified response channel ended.',
        outcome_unknown: true,
        execution_outcome_unknown: true,
        retry_safe: false,
        provider_started: error.providerLaunchStatus?.accepted === true,
        provider_execution_attempted:
          error.providerLaunchStatus?.accepted === true ||
          error.providerLaunchStatus?.providerExecutionAttempted === true,
      });
    }

    if (error.code === 'CONTROLLER_SHUTTING_DOWN') {
      return res.status(503).json(payload);
    }

    if (error.code === 'VOICE_EXECUTION_LOCKED') {
      payload.agentCode = error.agentCode || 'AGENT_VOICE_EXECUTION_LOCKED';
      payload.userMessage = voiceExecutionLockedPayload(error.voiceExecution).userMessage;
      payload.voiceExecution = error.voiceExecution;
      return res.status(423).json(payload);
    }

    return res.json(payload);
  }
}

app.post('/ask', handleAskRequest);

class ExecutorSubmissionError extends Error {
  constructor(status, payload) {
    super(payload?.error || 'Executor task submission failed');
    this.name = 'ExecutorSubmissionError';
    this.status = status;
    this.payload = payload;
  }
}

class ManagedAskTaskError extends Error {
  constructor(httpStatus, payload) {
    super(payload?.error || 'Managed ask task failed');
    this.name = 'ManagedAskTaskError';
    this.code = payload?.agentCode || payload?.code || 'MANAGED_ASK_FAILED';
    this.result = { httpStatus, payload };
  }
}

class TargetSessionTaskError extends Error {
  constructor(httpStatus, payload) {
    super(payload?.error || 'Target-session task failed');
    this.name = 'TargetSessionTaskError';
    this.code = payload?.agentCode || payload?.code || 'TARGET_SESSION_MESSAGE_FAILED';
    this.result = { httpStatus, payload };
  }
}

function sanitizeManagedAskRequest(request) {
  const source = request && typeof request === 'object' ? request : {};
  const sanitized = {};
  const stringFields = [
    ['prompt', 100000],
    ['callId', 200],
    ['sessionKey', 200],
    ['resumeSessionId', 200],
    ['devicePrompt', 20000],
    ['sessionType', 100],
  ];
  for (const [field, maxLength] of stringFields) {
    if (source[field] === undefined || source[field] === null) continue;
    sanitized[field] = String(source[field]).slice(0, maxLength);
  }
  const timeoutSeconds = parsePositiveInteger(source.timeoutSeconds);
  if (timeoutSeconds) sanitized.timeoutSeconds = timeoutSeconds;
  return sanitized;
}

function sanitizeTargetSessionRequest(request) {
  const source = request && typeof request === 'object' ? request : {};
  return {
    operationId: String(source.operationId || '').trim(),
    target: String(source.target || '').trim(),
    message: String(source.message || '').trim(),
    sessionFingerprint: String(source.sessionFingerprint || '').trim(),
    timeoutSeconds: Math.max(
      30,
      Math.min(Number.parseInt(source.timeoutSeconds, 10) || 1800, 3600)
    ),
  };
}

function validateTargetSessionRequest(request) {
  if (!/^job_[A-Za-z0-9]+$/.test(request.operationId) || request.operationId.length > 200) {
    throw new ExecutorSubmissionError(400, {
      success: false,
      code: 'OPERATION_ID_REQUIRED',
      error: 'A valid job-specific operationId is required.',
    });
  }
  if (!request.target || request.target.length > 512 ||
      /[\u0000-\u001F\u007F]/.test(request.target)) {
    throw new ExecutorSubmissionError(400, {
      success: false,
      code: 'EXACT_TMUX_TARGET_REQUIRED',
      error: 'An exact stable tmux target is required.',
    });
  }
  let message;
  try { message = canonicalizeTargetSessionMessage(request.message); }
  catch {
    throw new ExecutorSubmissionError(400, {
      success: false,
      code: 'INVALID_TARGET_MESSAGE',
      error: 'A plain-text message no longer than 4,000 characters is required.',
    });
  }
  if (!request.sessionFingerprint || request.sessionFingerprint.length > 512 ||
      /[\u0000-\u001F\u007F]/.test(request.sessionFingerprint)) {
    throw new ExecutorSubmissionError(400, {
      success: false,
      code: 'TARGET_SESSION_FINGERPRINT_REQUIRED',
      error: 'The prepared target-session fingerprint is required.',
    });
  }
  return { ...request, message };
}

function sanitizeExecutorMetadata(metadata) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const sanitized = {};
  const allowedFields = [
    'source',
    'callerId',
    'voiceThreadId',
    'realtimeSessionId',
    'controllerJobId',
    'profile',
  ];
  for (const field of allowedFields) {
    if (source[field] === undefined || source[field] === null) continue;
    sanitized[field] = String(source[field]).slice(0, 500);
  }
  return sanitized;
}

function sanitizeVoiceAuthorizationDecision(validation) {
  const classification = validation?.classification || {};
  const authorization = validation?.authorization;
  return {
    allowed: validation?.allowed === true,
    voiceOrigin: validation?.voiceOrigin === true,
    classification: {
      level: classification.level || RISK_LEVELS.READ_ONLY,
      requiresApproval: Boolean(classification.requiresApproval),
      capability: classification.capability || 'read',
      reasons: Array.isArray(classification.reasons)
        ? classification.reasons.map((reason) => String(reason).slice(0, 200)).slice(0, 20)
        : [],
      requestHash: classification.requestHash || null,
    },
    authorization: authorization ? {
      job_id: String(authorization.job_id || '').slice(0, 200),
      method: String(authorization.method || '').slice(0, 100),
      approved_at: String(authorization.approved_at || '').slice(0, 100),
      capability_key_id: String(authorization.capability_key_id || '').slice(0, 96),
      request_sha256: String(authorization.request_sha256 || '').slice(0, 128),
      plan_sha256: String(authorization.plan_sha256 || '').slice(0, 128),
      target: String(authorization.target || '').slice(0, 512),
      provider: String(authorization.provider || '').slice(0, 96),
      profile: String(authorization.profile || '').slice(0, 128),
      scope: String(authorization.scope || '').slice(0, 2000),
    } : null,
  };
}

function sanitizeTargetAuthorizationDecision(validation) {
  const authorization = validation?.authorization;
  return {
    allowed: validation?.allowed === true,
    profile: String(validation?.profile || '').slice(0, 128),
    authorization: authorization ? {
      job_id: String(authorization.job_id || '').slice(0, 200),
      method: String(authorization.method || '').slice(0, 100),
      approved_at: String(authorization.approved_at || '').slice(0, 100),
      capability_key_id: String(authorization.capability_key_id || '').slice(0, 96),
      request_sha256: String(authorization.request_sha256 || '').slice(0, 128),
      plan_sha256: String(authorization.plan_sha256 || '').slice(0, 128),
      target: String(authorization.target || '').slice(0, 512),
      provider: String(authorization.provider || '').slice(0, 96),
      profile: String(authorization.profile || '').slice(0, 128),
      scope: String(authorization.scope || '').slice(0, 2000),
    } : null,
  };
}

function canceledExecutorRequest(taskType, sanitizedRequest) {
  if (taskType === 'managed_ask') {
    return {
      ask: sanitizedRequest,
      canceledBeforeAuthorization: true,
    };
  }
  return {
    targetSession: { request: sanitizedRequest },
    canceledBeforeAuthorization: true,
  };
}

function targetSessionCapabilityBindings(request, prepared) {
  const plan = buildTargetSessionApprovalPlan({
    jobId: request?.operationId,
    target: request?.target,
    message: request?.message,
    sessionFingerprint: request?.sessionFingerprint,
    timeoutSeconds: request?.timeoutSeconds,
  });
  return {
    jobId: String(request?.operationId || '').trim(),
    requestHash: requestHash(request?.message),
    planHash: hashApprovalPlan(plan),
    target: String(request?.target || '').trim(),
    provider: String(prepared?.provider || '').trim(),
    profile: profileForTargetSession(prepared?.provider, request?.message) || '',
  };
}

function restoreTargetAuthorizationDecision(decision, request, prepared) {
  const authorization = decision?.authorization;
  const expected = targetSessionCapabilityBindings(request, prepared);
  const exact = decision?.allowed === true &&
    decision?.profile === expected.profile &&
    authorization?.method === 'dtmf-pound' &&
    Boolean(authorization?.capability_key_id) &&
    Number.isFinite(Date.parse(authorization?.approved_at || '')) &&
    safeEqual(authorization?.job_id, expected.jobId) &&
    safeEqual(authorization?.request_sha256, expected.requestHash) &&
    safeEqual(authorization?.plan_sha256, expected.planHash) &&
    safeEqual(authorization?.target, expected.target) &&
    safeEqual(authorization?.provider, expected.provider) &&
    safeEqual(authorization?.profile, expected.profile);
  if (!exact) {
    const error = new Error('Persisted target-session approval does not match the durable task');
    error.code = 'EXECUTOR_AUTHORIZATION_MISMATCH';
    throw error;
  }
  return { ...authorization, scope: String(request?.message || '').trim() };
}

function managedAskCapabilityBindings(ask, profile) {
  const resolvedSessionKey = resolveSessionKey(ask?.callId, ask?.sessionKey);
  const resolvedTimeoutSeconds = resolveRequestTimeoutSeconds(
    ask?.sessionType,
    ask?.prompt,
    ask?.devicePrompt,
    ask?.timeoutSeconds
  );
  const plan = buildManagedAgentApprovalPlan({
    jobId: ask?.callId,
    request: ask?.prompt,
    sessionKey: resolvedSessionKey,
    sessionType: ask?.sessionType,
    timeoutSeconds: resolvedTimeoutSeconds,
    devicePrompt: ask?.devicePrompt || null,
  });
  return {
    jobId: String(ask?.callId || '').trim(),
    requestHash: requestHash(ask?.prompt),
    planHash: hashApprovalPlan(plan),
    target: resolvedSessionKey ? managedAgentTarget(resolvedSessionKey) : '',
    provider: profile?.provider || '',
    profile: profileForSessionType(ask?.sessionType) || '',
  };
}

function restoreVoiceAuthorizationDecision(decision, profile, ask) {
  const prompt = ask?.prompt;
  const currentClassification = classifyVoiceOperation(prompt);
  const expectedVoiceOrigin = isPhoneSessionType(profile?.sessionType);
  const valid = decision?.allowed === true &&
    decision?.voiceOrigin === expectedVoiceOrigin &&
    decision?.classification?.requestHash === currentClassification.requestHash &&
    decision?.classification?.level === currentClassification.level;
  if (!valid) {
    const error = new Error('Persisted executor authorization decision does not match the task');
    error.code = 'EXECUTOR_AUTHORIZATION_MISMATCH';
    throw error;
  }
  if (currentClassification.requiresApproval) {
    const authorization = decision.authorization;
    const expected = managedAskCapabilityBindings(ask, profile);
    const approvedAt = Date.parse(authorization?.approved_at || '');
    const exact = authorization?.method === 'dtmf-pound' &&
      Boolean(authorization?.capability_key_id) &&
      Number.isFinite(approvedAt) &&
      safeEqual(authorization?.job_id, expected.jobId) &&
      safeEqual(authorization?.request_sha256, expected.requestHash) &&
      safeEqual(authorization?.plan_sha256, expected.planHash) &&
      safeEqual(authorization?.target, expected.target) &&
      safeEqual(authorization?.provider, expected.provider) &&
      safeEqual(authorization?.profile, expected.profile);
    if (!exact) {
      const error = new Error('Persisted executor approval is missing or request-mismatched');
      error.code = 'EXECUTOR_AUTHORIZATION_MISMATCH';
      throw error;
    }
  }
  return {
    allowed: true,
    voiceOrigin: expectedVoiceOrigin,
    classification: currentClassification,
    authorization: currentClassification.requiresApproval
      ? { ...decision.authorization, scope: String(prompt || '').trim() }
      : null,
  };
}

function authorizeManagedAskSubmission(rawRequest) {
  const sanitizedAsk = sanitizeManagedAskRequest(rawRequest);
  const { prompt, sessionType, devicePrompt } = sanitizedAsk;
  if (!prompt?.trim()) {
    throw new ExecutorSubmissionError(400, {
      success: false,
      code: 'EXECUTOR_PROMPT_REQUIRED',
      error: 'Managed executor tasks require request.prompt',
    });
  }

  const profile = resolveAgentProfile(sessionType, prompt, devicePrompt);
  if (requestsProviderResume(sanitizedAsk.resumeSessionId)) {
    throw new ExecutorSubmissionError(409, providerResumeUnavailable(profile.provider));
  }
  if (looksLikePhoneDeployRequest(prompt, devicePrompt)) {
    throw new ExecutorSubmissionError(
      503,
      deployUnavailableUntilToolBroker(profile.provider)
    );
  }
  if (!ENABLED_AGENT_PROVIDERS.includes(profile.provider)) {
    throw new ExecutorSubmissionError(503, {
      success: false,
      provider: profile.provider,
      code: 'AGENT_PROVIDER_DISABLED',
      agentCode: 'AGENT_PROVIDER_DISABLED',
      error: `${profile.provider} is not enabled on this agent bridge`,
    });
  }

  const deploymentAuthorization = getDeploymentAuthorization(sessionType, prompt, devicePrompt);
  if (!deploymentAuthorization.allowed) {
    throw new ExecutorSubmissionError(403, {
      success: false,
      provider: profile.provider,
      code: deploymentAuthorization.code,
      agentCode: deploymentAuthorization.agentCode,
      error: 'Privileged Codex profile required',
      userMessage: deploymentAuthorization.message,
    });
  }

  const voiceStatus = voiceExecutionControl.getStatus();
  if (isPhoneSessionType(profile.sessionType) && voiceStatus.locked) {
    throw new ExecutorSubmissionError(423, voiceExecutionLockedPayload(voiceStatus));
  }

  // This is the only durable submission seam that consumes capability
  // material. Its caller wraps this function and task insertion in one SQLite
  // transaction; only this reduced decision crosses the commit boundary.
  const resolvedSessionKey = resolveSessionKey(sanitizedAsk.callId, sanitizedAsk.sessionKey);
  const resolvedTimeoutSeconds = resolveRequestTimeoutSeconds(
    sessionType,
    prompt,
    devicePrompt,
    sanitizedAsk.timeoutSeconds
  );
  const voiceAuthorization = authorizeManagedVoiceRequest({
    verifier: approvalVerifier,
    profile,
    prompt,
    callId: sanitizedAsk.callId,
    sessionKey: resolvedSessionKey,
    sessionType,
    timeoutSeconds: resolvedTimeoutSeconds,
    devicePrompt,
    authorization: rawRequest?.authorization,
  });
  if (!voiceAuthorization.allowed) {
    throw new ExecutorSubmissionError(403, {
      success: false,
      provider: profile.provider,
      code: voiceAuthorization.code,
      agentCode: voiceAuthorization.code,
      error: 'Job-specific DTMF approval required',
      userMessage: voiceAuthorization.userMessage,
      risk: voiceAuthorization.classification,
    });
  }

  // The legacy field is inspected only to reject a resume attempt above. It
  // must never cross the durable task commit boundary, even when empty.
  delete sanitizedAsk.resumeSessionId;

  return {
    ask: sanitizedAsk,
    voiceAuthorization: sanitizeVoiceAuthorizationDecision(voiceAuthorization),
  };
}

function targetSessionFailureStatus(code) {
  if (['TARGET_SESSION_CHANGED', 'TARGET_MESSAGE_CANCELED', 'TARGET_SESSION_LOG_CHANGED']
    .includes(code)) return 409;
  if (['TARGET_IDLE_TIMEOUT', 'TARGET_DELIVERY_TIMEOUT', 'TARGET_RESPONSE_TIMEOUT']
    .includes(code)) return 504;
  if (['TMUX_TARGET_NOT_FOUND', 'AGENT_SESSION_NOT_FOUND', 'SESSION_HISTORY_UNRESOLVED']
    .includes(code)) return 404;
  if (code === 'AGENT_PROVIDER_DISABLED') return 503;
  return 400;
}

async function prepareTargetSessionSubmission(rawRequest) {
  const request = validateTargetSessionRequest(sanitizeTargetSessionRequest(rawRequest));
  const voiceStatus = voiceExecutionControl.getStatus();
  if (voiceStatus.locked) {
    throw new ExecutorSubmissionError(423, voiceExecutionLockedPayload(voiceStatus));
  }

  let resolved;
  try {
    resolved = await callWorkerBoundary(
      () => tmuxAgentController.prepare({ target: request.target })
    );
  } catch (error) {
    const code = error.code || 'TARGET_SESSION_PREPARE_FAILED';
    throw new ExecutorSubmissionError(targetSessionFailureStatus(code), {
      success: false,
      code,
      agentCode: code,
      error: error.message,
    });
  }
  if (!ENABLED_AGENT_PROVIDERS.includes(resolved.provider)) {
    throw new ExecutorSubmissionError(503, {
      success: false,
      code: 'AGENT_PROVIDER_DISABLED',
      agentCode: 'AGENT_PROVIDER_DISABLED',
      error: `${resolved.provider} is not enabled on this agent bridge`,
    });
  }

  const stableTarget = String(resolved.stable_target || resolved.target || '').trim();
  const fingerprint = String(resolved.session_fingerprint || '').trim();
  if (!safeEqual(stableTarget, request.target) ||
      !safeEqual(fingerprint, request.sessionFingerprint)) {
    throw new ExecutorSubmissionError(409, {
      success: false,
      code: 'TARGET_SESSION_CHANGED',
      agentCode: 'TARGET_SESSION_CHANGED',
      error: 'The exact tmux target no longer owns the provider session that was approved.',
    });
  }

  // Keep only the stable, non-secret binding required to verify and execute
  // the durable operation. Session-log paths and capability material never
  // cross the durable commit boundary.
  return {
    request,
    prepared: {
      target: String(resolved.target || '').trim(),
      stable_target: stableTarget,
      named_target: resolved.named_target ? String(resolved.named_target).slice(0, 512) : null,
      conversation_name: resolved.conversation_name
        ? String(resolved.conversation_name).slice(0, 512)
        : null,
      provider: String(resolved.provider || '').trim(),
      session_fingerprint: fingerprint,
    },
  };
}

function authorizeTargetSessionSubmission(rawRequest, preparedSubmission) {
  const { request, prepared } = preparedSubmission;
  const approval = authorizeTargetSessionRequest({
    verifier: approvalVerifier,
    operationId: request.operationId,
    target: request.target,
    message: request.message,
    sessionFingerprint: request.sessionFingerprint,
    timeoutSeconds: request.timeoutSeconds,
    prepared,
    authorization: rawRequest?.authorization,
  });
  if (!approval.allowed) {
    throw new ExecutorSubmissionError(403, {
      success: false,
      code: approval.code,
      agentCode: approval.code,
      error: 'Job-specific DTMF approval is required for target-session delivery.',
      userMessage: 'Review the exact tmux target and message, then press pound to approve it.',
    });
  }
  return {
    targetSession: { request, prepared },
    targetAuthorization: sanitizeTargetAuthorizationDecision(approval),
  };
}

function invokeAskHandler(body, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        if (!settled) {
          settled = true;
          resolve({ httpStatus: this.statusCode, payload });
        }
        return this;
      },
    };
    Promise.resolve(handleAskRequest({ body }, response, options))
      .then(() => {
        if (!settled) reject(new Error('Managed ask handler completed without a response'));
      })
      .catch(reject);
  });
}

async function executeManagedAskTask(task, context) {
  const ask = task.request?.ask;
  const profile = resolveAgentProfile(ask?.sessionType, ask?.prompt, ask?.devicePrompt);
  const preauthorizedVoice = restoreVoiceAuthorizationDecision(
    task.request?.voiceAuthorization,
    profile,
    ask
  );
  let processExecution = null;
  const response = await invokeAskHandler(ask, {
    preauthorizedVoice,
    durableExecution: true,
    signal: context.signal,
    onAgentStarted: ({ pid, detached, provider, requestId }) => {
      const execution = captureProcessExecution(pid, { detached });
      if (!execution) throw new Error('Could not capture spawned agent process identity');
      processExecution = { ...execution, provider, requestId };
      context.recordExecution(processExecution);
    },
    onProviderLaunchStatus: (status) => {
      if (status?.accepted === true && /^launch_[a-f0-9]{32}$/.test(status.launchId || '')) {
        if (!processExecution) {
          throw new Error('Provider acceptance arrived before process identity was durable');
        }
        context.recordExecution({
          ...processExecution,
          kind: 'managed_ask',
          stage: 'provider_started',
          providerStarted: true,
          providerExecutionAttempted: true,
          retrySafe: false,
          providerLaunchId: status.launchId,
          providerAcceptedAt: new Date().toISOString(),
        });
        return;
      }
      if (status?.accepted !== false || ![
        'PROVIDER_SUPERVISOR_BUSY',
        'PROVIDER_EXECUTION_OUTCOME_UNKNOWN',
      ].includes(status.code)) return;
      if (!processExecution) {
        throw new Error('Provider launch truth arrived before process identity was durable');
      }
      const outcomeUnknown = status.code === 'PROVIDER_EXECUTION_OUTCOME_UNKNOWN';
      context.recordExecution({
        ...processExecution,
        kind: 'managed_ask',
        stage: outcomeUnknown
          ? 'provider_execution_outcome_unknown'
          : 'provider_not_started_busy',
        providerStarted: false,
        providerExecutionAttempted: outcomeUnknown,
        retrySafe: !outcomeUnknown,
        denialCode: status.code,
        deniedAt: new Date().toISOString(),
      });
    },
  });
  if (!response.payload?.success) {
    throw new ManagedAskTaskError(response.httpStatus, response.payload);
  }
  return response;
}

async function executeTargetSessionTask(task, context) {
  const targetSession = task.request?.targetSession;
  const request = validateTargetSessionRequest(targetSession?.request || {});
  const prepared = targetSession?.prepared || {};
  restoreTargetAuthorizationDecision(task.request?.targetAuthorization, request, prepared);

  let deliveryExecution = null;
  const deliveryDeadlineAt = new Date(Date.now() + request.timeoutSeconds * 1000).toISOString();
  try {
    const result = await callWorkerBoundary(() => tmuxAgentController.send({
      target: request.target,
      message: request.message,
      sessionFingerprint: request.sessionFingerprint,
      timeoutMs: request.timeoutSeconds * 1000,
      signal: context.signal,
      operationId: request.operationId,
      onBeforeSubmit: ({ stableTarget, provider, operationMarker }) => {
        const stagedExecution = {
          kind: 'target_session_message',
          stage: 'delivery_attempt_started',
          operationId: request.operationId,
          operationMarker,
          stableTarget,
          provider,
          sessionFingerprint: request.sessionFingerprint,
          attemptedAt: new Date().toISOString(),
          deadlineAt: deliveryDeadlineAt,
        };
        // TmuxAgentController awaits this hook before it can paste anything.
        // The durable stage therefore commits before the external mutation.
        context.recordExecution(stagedExecution);
        deliveryExecution = stagedExecution;
      },
    }));
    const response = { httpStatus: 200, payload: { success: true, result } };
    context.recordExecution({
      ...deliveryExecution,
      kind: 'target_session_message',
      stage: 'delivery_verified',
      operationId: request.operationId,
      operationMarker: targetSessionOperationMarker(request.operationId),
      verifiedAt: new Date().toISOString(),
      result: response,
    });
    return response;
  } catch (error) {
    if (deliveryExecution?.stage === 'delivery_attempt_started') {
      const originalCode = error?.originalCode || error?.code || 'TARGET_SESSION_MESSAGE_FAILED';
      const delivered = originalCode === 'TARGET_RESPONSE_TIMEOUT'
        ? true
        : (error?.delivered === true ? true : null);
      const payload = {
        success: false,
        code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
        agentCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
        error: 'Target-session delivery became possible, but its exact outcome could not be verified. It was not retried.',
        originalCode,
        delivery_attempted: true,
        delivered,
        response_verified: false,
        reconciliation_required: true,
      };
      throw new TargetSessionTaskError(409, payload);
    }
    if (error instanceof ExecutorSubmissionError) throw error;
    const code = error.code || 'TARGET_SESSION_MESSAGE_FAILED';
    const payload = {
      success: false,
      code,
      agentCode: code,
      error: error.message || 'Target-session delivery failed.',
    };
    throw new TargetSessionTaskError(targetSessionFailureStatus(code), payload);
  }
}

async function executeExecutorTask(task, context) {
  if (task.taskType === 'managed_ask') return executeManagedAskTask(task, context);
  if (task.taskType === 'target_session_message') {
    return executeTargetSessionTask(task, context);
  }
  const error = new Error(`Unsupported executor task type: ${task.taskType}`);
  error.code = 'EXECUTOR_TASK_TYPE_UNSUPPORTED';
  throw error;
}

async function reconcileInterruptedExecutorTask(task) {
  const execution = task.execution || {};
  if (task.taskType === 'managed_ask') {
    const definitivePreProviderBusy = execution.kind === 'managed_ask' &&
      execution.stage === 'provider_not_started_busy' &&
      execution.providerStarted === false &&
      execution.retrySafe === true &&
      execution.denialCode === 'PROVIDER_SUPERVISOR_BUSY' &&
      ['claude', 'codex'].includes(execution.provider) &&
      Number.isInteger(execution.pid) && execution.pid > 0 &&
      /^\d+$/.test(String(execution.processStartTime || '')) &&
      typeof execution.requestId === 'string' && execution.requestId.length > 0;
    if (!definitivePreProviderBusy) return null;
    return task.state === 'cancel_requested'
      ? {
        disposition: 'cancel',
        reason: 'The managed request was canceled after a durable pre-provider capacity denial.',
      }
      : {
        disposition: 'requeue',
        reason: 'The provider supervisor durably refused the launch before provider acceptance.',
      };
  }
  if (task.taskType !== 'target_session_message') return null;
  if (!execution.stage || execution.stage === 'delivery_verified') return null;
  if (execution.stage !== 'delivery_attempt_started') return null;

  const targetSession = task.request?.targetSession;
  const request = validateTargetSessionRequest(targetSession?.request || {});
  const prepared = targetSession?.prepared || {};
  restoreTargetAuthorizationDecision(task.request?.targetAuthorization, request, prepared);

  const expectedMarker = targetSessionOperationMarker(request.operationId);
  if (!safeEqual(execution.operationId, request.operationId) ||
      !safeEqual(execution.operationMarker, expectedMarker) ||
      !safeEqual(execution.stableTarget, request.target) ||
      !safeEqual(execution.sessionFingerprint, request.sessionFingerprint)) {
    return {
      disposition: 'fail',
      reason: 'Persisted target-session delivery identity did not match the approved request.',
      errorCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
      errorMessage: 'The interrupted target-session delivery identity could not be trusted, so it was not resent.',
      result: {
        httpStatus: 409,
        payload: {
          success: false,
          code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          agentCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          error: 'Target-session delivery may have occurred before executor restart; it was not resent.',
          reconciliationReason: 'persisted_delivery_identity_mismatch',
        },
      },
    };
  }

  const deadlineAt = Date.parse(execution.deadlineAt || '');
  const deadlineExpired = !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt;

  let outcome;
  try {
    outcome = await callWorkerBoundary(() => tmuxAgentController.reconcileOperation({
      target: request.target,
      message: request.message,
      operationId: request.operationId,
      sessionFingerprint: request.sessionFingerprint,
    }));
  } catch (error) {
    if (!deadlineExpired) {
      return {
        disposition: 'monitor',
        reason: `Waiting to retry exact target-log reconciliation: ${error.code || 'reconciliation_failed'}`,
      };
    }
    outcome = { status: 'unknown', reason: error.code || 'reconciliation_failed' };
  }
  if (outcome?.status === 'completed' && outcome.result) {
    const result = { httpStatus: 200, payload: { success: true, result: outcome.result } };
    return {
      disposition: task.state === 'cancel_requested' ? 'cancel' : 'complete',
      reason: 'Verified the exact operation marker and final provider response after restart.',
      result,
    };
  }
  if (outcome?.status === 'in_progress' && !deadlineExpired) {
    return {
      disposition: 'monitor',
      reason: 'The exact operation marker is present; monitoring the original provider work without resending.',
    };
  }
  if (outcome?.status === 'in_progress') {
    return {
      disposition: 'fail',
      reason: 'The marked target-session delivery reached its original response deadline.',
      errorCode: 'TARGET_RESPONSE_TIMEOUT',
      errorMessage: 'The exact target message was delivered, but no verified final response arrived before its original deadline.',
      result: {
        httpStatus: 504,
        payload: {
          success: false,
          code: 'TARGET_RESPONSE_TIMEOUT',
          agentCode: 'TARGET_RESPONSE_TIMEOUT',
          error: 'The exact target message was delivered, but no final provider response was verified before timeout.',
          delivered: true,
          response_verified: false,
          reconciliationReason: outcome.reason,
        },
      },
    };
  }

  return {
    disposition: 'fail',
    reason: 'Target-session delivery became possible before restart and could not be verified exactly.',
    errorCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
    errorMessage: 'The bridge restarted after delivery became possible, so the operation was not resent.',
    result: {
      httpStatus: 409,
      payload: {
        success: false,
        code: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
        agentCode: 'TARGET_DELIVERY_OUTCOME_UNKNOWN',
        error: 'Target-session delivery may have occurred before executor restart; it was not resent.',
        delivered: Boolean(outcome?.delivered),
        reconciliationReason: outcome?.reason || 'verified_outcome_unavailable',
      },
    },
  };
}

executorTaskDispatcher = new ExecutorTaskDispatcher({
  store: executorTaskStore,
  executeTask: executeExecutorTask,
  reconcileInterruptedTask: reconcileInterruptedExecutorTask,
  concurrency: EXECUTOR_TASK_CONCURRENCY,
  leaseMs: EXECUTOR_TASK_LEASE_MS,
  heartbeatMs: EXECUTOR_TASK_HEARTBEAT_MS,
  pollMs: EXECUTOR_TASK_POLL_MS,
});

function executorStoreErrorResponse(error) {
  if (error instanceof ExecutorSubmissionError) {
    return { status: error.status, payload: error.payload };
  }
  if (error instanceof ExecutorTaskStoreError) {
    const status = error.code === 'TASK_NOT_FOUND' ? 404
      : (error.code === 'IDEMPOTENCY_CONFLICT' ? 409
        : (error.code === 'EXECUTION_PANIC_LOCKED' ? 423 : 400));
    return {
      status,
      payload: {
        success: false,
        code: error.code,
        error: error.message,
        details: error.details,
      },
    };
  }
  return {
    status: 500,
    payload: { success: false, code: 'EXECUTOR_TASK_ERROR', error: error.message },
  };
}

function taskApiPayload(task, { includeEvents = false } = {}) {
  return {
    success: true,
    task,
    ...(includeEvents ? { events: executorTaskStore.listEvents({ taskId: task.id }) } : {}),
  };
}

function matchingExecutorTaskForRetry(idempotencyKey, taskType, sanitizedRequest) {
  const existing = executorTaskStore.getTaskByIdempotencyKey(idempotencyKey);
  if (!existing) return null;
  const persistedRequest = taskType === 'managed_ask'
    ? existing.request?.ask
    : existing.request?.targetSession?.request;
  if (existing.taskType === taskType &&
      isDeepStrictEqual(persistedRequest, sanitizedRequest)) {
    return existing;
  }
  throw new ExecutorTaskStoreError(
    'IDEMPOTENCY_CONFLICT',
    `Idempotency key ${String(idempotencyKey || '')} is already bound to another request`,
    { idempotencyKey: String(idempotencyKey || ''), taskId: existing.id }
  );
}

async function forwardPrivilegedActionResponse(res, operation) {
  if (!privilegedActionProxy) {
    return res.status(503).json({
      success: false,
      code: 'PRIVILEGED_ACTION_PROXY_DISABLED',
      error: 'Privileged action forwarding is disabled on this controller.',
    });
  }
  try {
    const response = await operation();
    return res.status(response.status).json(response.payload);
  } catch (error) {
    if (error instanceof PrivilegedActionProxyError) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }
    return res.status(502).json({
      success: false,
      code: 'PRIVILEGED_BROKER_PROXY_FAILED',
      error: 'The private privileged action broker request failed.',
    });
  }
}

app.post('/privileged-actions', async (req, res) => {
  const boundary = privilegedSubmissionBoundary({
    voiceExecutionControl,
    executorTaskStore,
  });
  if (!boundary.allowed) {
    return res.status(423).json({
      ...voiceExecutionLockedPayload(boundary.voiceExecution),
      executor: boundary.executor,
    });
  }
  try {
    requireHardenedWorkerBoundary();
  } catch (error) {
    return res.status(503).json({
      success: false,
      code: error.code || 'AGENT_WORKER_ISOLATION_REQUIRED',
      error: error.message,
    });
  }
  const headerKey = String(req.get('idempotency-key') || '').trim();
  const bodyKey = String(req.body?.idempotencyKey || '').trim();
  if (!headerKey || !bodyKey || !safeEqual(headerKey, bodyKey)) {
    return res.status(400).json({
      success: false,
      code: 'PRIVILEGED_IDEMPOTENCY_KEY_MISMATCH',
      error: 'The non-empty Idempotency-Key header and request body must match exactly.',
    });
  }
  return forwardPrivilegedActionResponse(
    res,
    () => privilegedActionProxy.submit(req.body)
  );
});

app.get('/privileged-actions/health', async (_req, res) => {
  return forwardPrivilegedActionResponse(res, () => privilegedActionProxy.health());
});

app.get('/privileged-actions/by-idempotency/:idempotencyKey', async (req, res) => {
  return forwardPrivilegedActionResponse(
    res,
    () => privilegedActionProxy.getByIdempotencyKey(req.params.idempotencyKey)
  );
});

app.post('/privileged-actions/by-idempotency/:idempotencyKey/cancel', async (req, res) => {
  return forwardPrivilegedActionResponse(
    res,
    () => privilegedActionProxy.cancelByIdempotencyKey(req.params.idempotencyKey, req.body)
  );
});

app.get('/privileged-actions/:actionId', async (req, res) => {
  return forwardPrivilegedActionResponse(
    res,
    () => privilegedActionProxy.get(req.params.actionId)
  );
});

app.post('/privileged-actions/:actionId/cancel', async (req, res) => {
  return forwardPrivilegedActionResponse(
    res,
    () => privilegedActionProxy.cancel(req.params.actionId, req.body)
  );
});

app.post('/privileged-actions/panic', async (req, res) => {
  return forwardPrivilegedActionResponse(res, () => privilegedActionProxy.panic(req.body));
});

app.post('/executor/tasks', async (req, res) => {
  try {
    const headerIdempotencyKey = String(req.get('idempotency-key') || '').trim();
    const bodyIdempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (headerIdempotencyKey && bodyIdempotencyKey &&
        !safeEqual(headerIdempotencyKey, bodyIdempotencyKey)) {
      throw new ExecutorSubmissionError(400, {
        success: false,
        code: 'IDEMPOTENCY_KEY_MISMATCH',
        error: 'The Idempotency-Key header and request body must match exactly.',
      });
    }
    const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey;
    const taskType = String(req.body?.taskType || 'managed_ask');
    if (!['managed_ask', 'target_session_message'].includes(taskType)) {
      return res.status(400).json({
        success: false,
        code: 'EXECUTOR_TASK_TYPE_UNSUPPORTED',
        error: 'Supported executor task types are managed_ask and target_session_message',
      });
    }
    const sanitizedRequest = taskType === 'managed_ask'
      ? sanitizeManagedAskRequest(req.body?.request)
      : validateTargetSessionRequest(sanitizeTargetSessionRequest(req.body?.request));
    if (taskType === 'target_session_message' &&
        !safeEqual(idempotencyKey, sanitizedRequest.operationId)) {
      throw new ExecutorSubmissionError(400, {
        success: false,
        code: 'TARGET_IDEMPOTENCY_MISMATCH',
        error: 'Target-session task idempotency must equal the exact operationId.',
      });
    }

    const submissionProfile = taskType === 'managed_ask'
      ? resolveAgentProfile(
          sanitizedRequest.sessionType,
          sanitizedRequest.prompt,
          sanitizedRequest.devicePrompt
        )
      : null;
    if (taskType === 'managed_ask' && !isPhoneSessionType(submissionProfile?.sessionType)) {
      throw new ExecutorSubmissionError(403, {
        success: false,
        code: 'EXECUTOR_PHONE_PROFILE_REQUIRED',
        agentCode: 'EXECUTOR_PHONE_PROFILE_REQUIRED',
        error: 'Durable managed execution is restricted to explicit phone profiles.',
        userMessage: 'Use a phone speed-dial profile for durable voice execution.',
      });
    }
    const voiceOrigin = taskType === 'target_session_message' ||
      isPhoneSessionType(submissionProfile?.sessionType);

    // An exact idempotent retry is answered before target preparation or
    // capability consumption. Ambiguous POST recovery can therefore perform a
    // read-only lookup and never risks spending the one-time capability twice.
    const existing = matchingExecutorTaskForRetry(idempotencyKey, taskType, sanitizedRequest);
    if (existing) {
      return res.status(200).json({ success: true, created: false, task: existing });
    }

    const reservedBeforePreparation = voiceOrigin
      ? executorTaskStore.getCancellationReservation(idempotencyKey)
      : null;
    if (!reservedBeforePreparation) {
      try {
        requireHardenedWorkerBoundary();
      } catch (error) {
        throw new ExecutorSubmissionError(503, {
          success: false,
          code: error.code || 'AGENT_WORKER_ISOLATION_REQUIRED',
          agentCode: 'AGENT_WORKER_ISOLATION_REQUIRED',
          error: error.message,
        });
      }
    }
    const preparedTargetSubmission = taskType === 'target_session_message' && !reservedBeforePreparation
      ? await prepareTargetSessionSubmission(req.body?.request)
      : null;

    const submitAtomically = executorTaskStore.db.transaction(() => {
      // Recheck after acquiring the SQLite write transaction so another bridge
      // process cannot win the key between the optimistic lookup and consume.
      const racedExisting = matchingExecutorTaskForRetry(
        idempotencyKey,
        taskType,
        sanitizedRequest
      );
      if (racedExisting) return { created: false, task: racedExisting };

      // Cancellation and submission serialize on this SQLite write transaction.
      // If cancellation won, materialize a terminal task from sanitized input
      // without verifying, consuming, or persisting the stale capability.
      const cancellationReservation = voiceOrigin
        ? executorTaskStore.getCancellationReservation(idempotencyKey)
        : null;
      if (cancellationReservation) {
        return executorTaskStore.submitTask({
          idempotencyKey,
          taskType,
          callId: taskType === 'managed_ask'
            ? (sanitizedRequest.callId || null)
            : sanitizedRequest.operationId,
          voiceOrigin: true,
          request: canceledExecutorRequest(taskType, sanitizedRequest),
          metadata: sanitizeExecutorMetadata(req.body?.metadata),
          actor: 'authenticated_controller',
        });
      }

      const durableRequest = taskType === 'managed_ask'
        ? authorizeManagedAskSubmission(req.body?.request)
        : authorizeTargetSessionSubmission(req.body?.request, preparedTargetSubmission);
      return executorTaskStore.submitTask({
        idempotencyKey,
        taskType,
        callId: taskType === 'managed_ask'
          ? (durableRequest.ask.callId || null)
          : durableRequest.targetSession.request.operationId,
        voiceOrigin,
        request: durableRequest,
        metadata: sanitizeExecutorMetadata(req.body?.metadata),
        actor: 'authenticated_controller',
      });
    });
    const result = submitAtomically.immediate();
    executorTaskDispatcher.wake();
    return res.status(result.created ? 202 : 200).json({
      success: true,
      created: result.created,
      task: result.task,
    });
  } catch (error) {
    const failure = executorStoreErrorResponse(error);
    return res.status(failure.status).json(failure.payload);
  }
});

app.get('/executor/tasks', (req, res) => {
  try {
    const idempotencyKey = String(req.query?.idempotencyKey || '').trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        error: 'Bulk executor task listing is not available to the executor capability.',
      });
    }
    const task = executorTaskStore.getTaskByIdempotencyKey(idempotencyKey);
    if (!task) return res.status(404).json({ success: false, code: 'TASK_NOT_FOUND' });
    return res.json(taskApiPayload(task, { includeEvents: req.query?.events === '1' }));
  } catch (error) {
    const failure = executorStoreErrorResponse(error);
    return res.status(failure.status).json(failure.payload);
  }
});

app.get('/executor/tasks/by-idempotency/:idempotencyKey', (req, res) => {
  try {
    const task = executorTaskStore.getTaskByIdempotencyKey(req.params.idempotencyKey);
    if (!task) return res.status(404).json({ success: false, code: 'TASK_NOT_FOUND' });
    return res.json(taskApiPayload(task, { includeEvents: req.query?.events === '1' }));
  } catch (error) {
    const failure = executorStoreErrorResponse(error);
    return res.status(failure.status).json(failure.payload);
  }
});

app.get('/executor/tasks/:taskId', (req, res) => {
  const task = executorTaskStore.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, code: 'TASK_NOT_FOUND' });
  return res.json(taskApiPayload(task, { includeEvents: req.query?.events === '1' }));
});

app.post('/executor/tasks/:taskId/cancel', (req, res) => {
  try {
    const result = executorTaskDispatcher.requestCancellation({
      taskId: req.params.taskId,
      reason: cleanLabel(req.body?.reason, 'api_cancel'),
      source: cleanLabel(req.body?.source, 'authenticated_controller'),
    });
    return res.json({ success: true, changed: result.changed, task: result.task });
  } catch (error) {
    const failure = executorStoreErrorResponse(error);
    return res.status(failure.status).json(failure.payload);
  }
});

async function performVoicePanic({ reason, source }) {
  const result = await performCoordinatedVoicePanic({
    reason,
    source,
    voiceExecutionControl,
    cancelAllVoiceRequests,
    executorTaskDispatcher,
    privilegedActionProxy,
    privilegedActionProxyEnabled: PRIVILEGED_ACTION_PROXY_ENABLED,
    workerSessionProxy,
    workerSessionProxyEnabled: workerSessionProxyConfig.enabled,
  });
  if (result.workerCancellation?.configured) {
    workerSessionBoundaryStatus = Object.freeze({
      ready: false,
      code: result.workerCancellation.persisted
        ? 'WORKER_SESSION_PANIC_LOCKED'
        : 'WORKER_SESSION_PANIC_UNCONFIRMED',
      checkedAt: new Date().toISOString(),
    });
  }
  return result;
}

async function performVoiceUnlock({ source }) {
  const panic = executorTaskStore.getPanicStatus();
  if (!panic.quiesced) {
    return {
      success: false,
      code: 'VOICE_EXECUTION_NOT_QUIESCED',
      error: 'Phone execution remains locked until every durable task reaches a terminal state.',
      voiceExecution: voiceExecutionControl.getStatus(),
      executor: { wasLocked: false, panic },
      workerSessions: null,
    };
  }

  if (PRIVILEGED_ACTION_PROXY_ENABLED) {
    let privilegedHealth;
    try { privilegedHealth = await privilegedActionProxy.health(); }
    catch { privilegedHealth = null; }
    if (privilegedHealth?.status !== 200 || privilegedHealth?.payload?.ready !== true ||
        privilegedHealth?.payload?.panic?.locked === true) {
      return {
        success: false,
        code: 'PRIVILEGED_ACTION_PANIC_LOCKED',
        error: 'Root-local privileged recovery and unlock must complete before phone execution unlocks.',
        voiceExecution: voiceExecutionControl.getStatus(),
        executor: { wasLocked: false, panic },
        workerSessions: null,
      };
    }
  }

  let workerSessions = {
    success: true,
    persisted: true,
    quiesced: true,
    configured: false,
    notApplicable: true,
  };
  if (workerSessionProxyConfig.enabled && workerSessionProxy) {
    try {
      workerSessions = await workerSessionProxy.unlock();
    } catch (error) {
      return {
        success: false,
        code: error?.code || 'WORKER_SESSION_UNLOCK_UNCONFIRMED',
        error: 'The isolated worker boundary could not be unlocked safely.',
        voiceExecution: voiceExecutionControl.getStatus(),
        executor: { wasLocked: false, panic },
        workerSessions: { success: false, persisted: false, quiesced: false },
      };
    }
    if (workerSessions?.success !== true || workerSessions?.persisted !== true ||
        workerSessions?.quiesced !== true) {
      return {
        success: false,
        code: 'WORKER_SESSION_UNLOCK_UNCONFIRMED',
        error: 'The isolated worker boundary did not confirm durable quiescent unlock.',
        voiceExecution: voiceExecutionControl.getStatus(),
        executor: { wasLocked: false, panic },
        workerSessions,
      };
    }
    await refreshWorkerSessionBoundaryHealth();
    if (!workerSessionBoundaryStatus.ready) {
      await workerSessionProxy.panic({
        reason: 'controller_unlock_health_unconfirmed',
        source: 'controller_unlock_rollback',
      }).catch(() => {});
      return {
        success: false,
        code: workerSessionBoundaryStatus.code || 'WORKER_SESSION_BROKER_UNAVAILABLE',
        error: 'The isolated worker boundary did not become ready after unlock.',
        voiceExecution: voiceExecutionControl.getStatus(),
        executor: { wasLocked: false, panic },
        workerSessions: { ...workerSessions, success: false },
      };
    }
  }

  let executor;
  let voiceExecution;
  try {
    executor = executorTaskStore.unlockPanic({ source });
    // Unlock the durable queue first. If the legacy lock-file removal then
    // fails, synchronous /ask and new durable submissions remain fail-closed.
    voiceExecution = voiceExecutionControl.unlock({ source });
  } catch (error) {
    if (workerSessionProxyConfig.enabled && workerSessionProxy) {
      await workerSessionProxy.panic({
        reason: 'controller_unlock_local_failure',
        source: 'controller_unlock_rollback',
      }).catch(() => {});
      workerSessionBoundaryStatus = Object.freeze({
        ready: false,
        code: 'WORKER_SESSION_PANIC_LOCKED',
        checkedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
  return {
    success: voiceExecution.locked === false && executor.panic.locked === false,
    voiceExecution,
    executor,
    workerSessions,
  };
}

function synchronizePanicControls() {
  const voiceStatus = voiceExecutionControl.getStatus();
  const executorStatus = executorTaskStore.getPanicStatus();
  if (voiceStatus.locked && !executorStatus.locked) {
    executorTaskStore.panic({
      reason: voiceStatus.reason || 'voice_execution_lock_recovered',
      source: 'startup_reconciliation',
    });
  } else if (executorStatus.locked && !voiceStatus.locked) {
    voiceExecutionControl.lock({
      reason: executorStatus.reason || 'executor_panic_recovered',
      source: 'startup_reconciliation',
    });
  }
}

app.post('/executor/panic', async (req, res) => {
  const source = cleanLabel(req.body?.source, 'authenticated_controller');
  const reason = cleanLabel(req.body?.reason, 'voice_panic_stop');
  const result = await performVoicePanic({ reason, source });
  return res.status(result.accepted ? 200 : 503).json({
    success: result.success,
    accepted: result.accepted,
    persisted: result.persisted,
    quiesced: result.quiesced,
    voiceExecution: result.lock,
    activeRequests: result.activeCancellation,
    executorTasks: result.executorCancellation,
    privilegedActions: result.privilegedCancellation,
    workerSessions: result.workerCancellation,
  });
});

app.post('/executor/panic/unlock', async (req, res) => {
  const source = cleanLabel(req.body?.source, 'authenticated_operator');
  const result = await performVoiceUnlock({ source });
  const failureStatus = [
    'VOICE_EXECUTION_NOT_QUIESCED',
    'PRIVILEGED_ACTION_PANIC_LOCKED',
  ].includes(result.code) ? 409 : 503;
  return res.status(result.success ? 200 : failureStatus).json(result);
});

/**
 * POST /ask-structured
 *
 * Like /ask, but returns machine-validated JSON for n8n automations.
 *
 * Request body:
 *   {
 *     "prompt": "Check Ceph health",
 *     "callId": "optional-call-uuid",
 *     "sessionKey": "optional-stable-session-uuid",
 *     "devicePrompt": "optional device-specific prompt",
 *     "sessionType": "optional profile name such as phone",
 *     "schema": {
 *        "queryType": "ceph_health",
 *        "requiredFields": ["cluster_status","ssd_usage_percent","recommendation"],
 *        "fieldGuidance": { "cluster_status": "Ceph overall health, e.g. HEALTH_OK/HEALTH_WARN/HEALTH_ERR" },
 *        "allowExtraFields": true,
 *        "example": { "cluster_status": "HEALTH_WARN", "ssd_usage_percent": 88, "recommendation": "alert" }
 *     },
 *     "includeVoiceContext": false,
 *     "maxRetries": 1
 *   }
 *
 * Response (success):
 *   { "success": true, "data": {...}, "raw_response": "...", "duration_ms": 1234 }
 */
app.post('/ask-structured', async (req, res) => {
  const {
    prompt,
    callId,
    sessionKey,
    resumeSessionId,
    devicePrompt,
    sessionType,
    timeoutSeconds,
    schema = {},
    includeVoiceContext = false,
    maxRetries = 1,
    authorization,
  } = req.body || {};

  const timestamp = new Date().toISOString();
  const deployIntent = looksLikePhoneDeployRequest(prompt, devicePrompt);
  const profile = resolveAgentProfile(sessionType, prompt, devicePrompt);
  const resolvedTimeoutSeconds = resolveRequestTimeoutSeconds(sessionType, prompt, devicePrompt, timeoutSeconds);
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt in request body' });
  }


  if (requestsSensitiveValueRetrieval(prompt)) {
    return res.status(403).json(sensitiveValueRetrievalDenied(profile.provider));
  }

  if (requestsProviderResume(resumeSessionId)) {
    return res.status(409).json(providerResumeUnavailable(profile.provider));
  }

  // The legacy direct structured surface has no transaction that can combine
  // one-time approval consumption with durable task insertion. Reject every
  // non-read-only operation before capability verification (and therefore
  // before nonce consumption or provider spawn). Mutating structured work is
  // accepted only by the durable managed_ask submission path.
  const structuredClassification = classifyVoiceOperation(prompt);
  if (structuredClassification.level !== RISK_LEVELS.READ_ONLY) {
    return res.status(409).json(structuredMutationRequiresDurableExecutor({
      provider: profile.provider,
      classification: structuredClassification,
    }));
  }

  const voiceExecutionStatus = voiceExecutionControl.getStatus();
  if (isPhoneSessionType(profile.sessionType) && voiceExecutionStatus.locked) {
    return res.status(423).json(voiceExecutionLockedPayload(voiceExecutionStatus));
  }

  if (!ENABLED_AGENT_PROVIDERS.includes(profile.provider)) {
    return res.status(503).json({
      success: false,
      provider: profile.provider,
      code: 'AGENT_PROVIDER_DISABLED',
      agentCode: 'AGENT_PROVIDER_DISABLED',
      error: `${profile.provider} is not enabled on this agent bridge`,
    });
  }

  const deploymentAuthorization = getDeploymentAuthorization(sessionType, prompt, devicePrompt);
  if (!deploymentAuthorization.allowed) {
    return res.status(403).json({
      success: false,
      provider: profile.provider,
      code: deploymentAuthorization.code,
      agentCode: deploymentAuthorization.agentCode,
      error: 'Privileged Codex profile required',
      userMessage: deploymentAuthorization.message,
    });
  }

  try {
    requireHardenedWorkerBoundary();
  } catch (error) {
    return res.status(503).json({
      success: false,
      provider: profile.provider,
      code: error.code || 'AGENT_WORKER_ISOLATION_REQUIRED',
      agentCode: 'AGENT_WORKER_ISOLATION_REQUIRED',
      error: error.message,
    });
  }

  const voiceAuthorization = await authorizeManagedVoiceRequest({
    verifier: approvalVerifier,
    profile,
    prompt,
    callId,
    sessionKey: resolvedSessionKey,
    sessionType,
    timeoutSeconds: resolvedTimeoutSeconds,
    devicePrompt,
    executionContext: buildStructuredAgentApprovalContext({
      schema,
      includeVoiceContext,
      maxRetries,
    }),
    authorization,
  });
  if (!voiceAuthorization.allowed) {
    return res.status(403).json({
      success: false,
      provider: profile.provider,
      code: voiceAuthorization.code,
      agentCode: voiceAuthorization.code,
      error: 'Job-specific DTMF approval required',
      userMessage: voiceAuthorization.userMessage,
      risk: voiceAuthorization.classification,
    });
  }
  const executionProfile = applyProviderAccessBoundary(profile, voiceAuthorization);

  const queryContext = buildQueryContext({
    queryType: schema.queryType,
    requiredFields: schema.requiredFields,
    fieldGuidance: schema.fieldGuidance,
    allowExtraFields: schema.allowExtraFields !== false,
    example: schema.example,
  });

  let fullPrompt = buildStructuredPrompt({
    devicePrompt,
    queryContext: (includeVoiceContext ? VOICE_CONTEXT : '') +
      buildVoiceAuthorizationContext(voiceAuthorization) +
      (includeVoiceContext && deployIntent ? PHONE_DEPLOY_CONTEXT : '') +
      queryContext,
    userPrompt: prompt,
  });

  logTextSummary(`[${timestamp}] STRUCTURED QUERY`, prompt);
  logAgentProfile(timestamp, executionProfile);
  console.log(`[${timestamp}] DEPLOY INTENT: ${deployIntent}`);
  console.log(`[${timestamp}] TIMEOUT: ${resolvedTimeoutSeconds || 'none'}s`);
  logSessionSummary(timestamp, {
    callId,
    sessionKey: resolvedSessionKey,
    hasExistingSession: resolvedSessionKey ? sessions.has(resolvedSessionKey) : false
  });

  const mutatingExecution =
    voiceAuthorization.classification?.level !== RISK_LEVELS.READ_ONLY;
  let providerStarted = false;
  let attemptsMade = 0;
  let totalDuration = 0;

  try {
    let lastRaw = '';
    let lastError = 'Unknown error';
    const retries = mutatingExecution ? 0 : normalizeStructuredRetryCount(maxRetries);

    for (let attempt = 0; attempt <= retries; attempt++) {
      attemptsMade = attempt + 1;
      const { code, stdout, stderr, duration_ms, provider } = await runAgentOnce({
        fullPrompt,
        callId,
        sessionKey: resolvedSessionKey,
        timestamp,
        profile: executionProfile,
        timeoutSeconds: resolvedTimeoutSeconds,
        onStarted: () => {
          providerStarted = true;
        },
      });
      totalDuration += duration_ms;
      const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';

      if (code !== 0) {
        const parsedFailure = parseAgentStdout(provider, stdout);
        lastError = `${providerLabel} CLI failed: ${parsedFailure.error || stderr || parsedFailure.response || `exit code ${code}`}`;
        lastRaw = parsedFailure.response || '';
        if (mutatingExecution) {
          return res.status(422).json(structuredMutationOutcomeUnknown({
            provider,
            validationError: lastError,
            rawResponse: lastRaw,
            durationMs: totalDuration,
            attempts: attemptsMade,
          }));
        }
        return res.status(502).json({
          success: false,
          provider,
          code: 'AGENT_CLI_FAILED',
          agentCode: 'AGENT_CLI_FAILED',
          error: lastError,
          raw_response: lastRaw,
          duration_ms: totalDuration,
          attempts: attemptsMade,
        });
      }

      const { response } = parseAgentStdout(provider, stdout);
      lastRaw = response;

      const parsed = tryParseJsonFromText(response);
      if (!parsed.ok) {
        lastError = parsed.error || 'Failed to parse JSON';
      } else {
        const validation = validateRequiredFields(parsed.data, schema.requiredFields);
        if (validation.ok) {
          return res.json({
            success: true,
            provider,
            provider_context_persistent: false,
            data: parsed.data,
            json_text: parsed.jsonText,
            raw_response: response,
            duration_ms: totalDuration,
            attempts: attemptsMade,
          });
        }
        lastError = validation.error || 'Validation failed';
      }

      if (attempt >= retries) break;

      // Retry once with a repair prompt that forces "JSON only" formatting.
      const repairPrompt = buildRepairPrompt({
        queryType: schema.queryType,
        requiredFields: schema.requiredFields,
        fieldGuidance: schema.fieldGuidance,
        allowExtraFields: schema.allowExtraFields !== false,
        originalUserPrompt: prompt,
        invalidAssistantOutput: lastRaw,
        example: schema.example,
      });

      fullPrompt = buildStructuredPrompt({
        devicePrompt,
        queryContext: (includeVoiceContext ? VOICE_CONTEXT : '') +
          buildVoiceAuthorizationContext(voiceAuthorization),
        userPrompt: repairPrompt,
      });
    }

    if (mutatingExecution && attemptsMade > 0) {
      return res.status(422).json(structuredMutationOutcomeUnknown({
        provider: profile.provider,
        validationError: lastError,
        rawResponse: lastRaw,
        durationMs: totalDuration,
        attempts: attemptsMade,
      }));
    }

    return res.status(422).json({
      success: false,
      provider: profile.provider,
      error: lastError,
      raw_response: lastRaw,
      duration_ms: totalDuration,
      attempts: attemptsMade,
    });
  } catch (error) {
    console.error(`[${timestamp}] ERROR:`, error.message);
    if (mutatingExecution && providerStarted) {
      return res.status(422).json(structuredMutationOutcomeUnknown({
        provider: profile.provider,
        validationError: error.message,
        rawResponse: '',
        durationMs: totalDuration + (Number(error.duration_ms) || 0),
        attempts: Math.max(attemptsMade, 1),
      }));
    }
    const payload = { success: false, provider: profile.provider, error: error.message };
    if (error.code) {
      payload.code = error.code;
      payload.agentCode = toAgentErrorCode(error.code);
    }
    if (error.reason) {
      payload.reason = error.reason;
    }
    if (error.code === 'CONTROLLER_SHUTTING_DOWN') {
      return res.status(503).json(payload);
    }
    if (error.code === 'VOICE_EXECUTION_LOCKED') {
      payload.agentCode = error.agentCode || 'AGENT_VOICE_EXECUTION_LOCKED';
      payload.userMessage = voiceExecutionLockedPayload(error.voiceExecution).userMessage;
      payload.voiceExecution = error.voiceExecution;
      return res.status(423).json(payload);
    }
    return res.status(500).json(payload);
  }
});

/**
 * POST /cancel-session
 *
 * Cancel active agent work for a call without ending the call itself.
 *
 * Request body:
 *   {
 *     "callId": "call-uuid",
 *     "sessionKey": "optional-stable-session-uuid",
 *     "resetSession": false,
 *     "reason": "dtmf_cancel"
 *   }
 */
function handleCancelSession(req, res) {
  const {
    callId,
    sessionKey,
    idempotencyKey = callId,
    resetSession = false,
    reason = 'cancel_session'
  } = req.body || {};
  const timestamp = new Date().toISOString();
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);

  if (!callId) {
    return res.status(400).json({
      success: false,
      error: 'Missing callId in request body'
    });
  }

  const result = cancelActiveRequests(callId, {
    sessionKey: resolvedSessionKey,
    resetSession: !!resetSession,
    reason
  });
  const executorTasks = executorTaskDispatcher.cancelCallTasks({
    callId,
    idempotencyKey,
    reason,
    source: 'cancel_session',
  });

  console.log(
    `[${timestamp}] SESSION CANCELED: callLinked=yes sessionKey=${valuePresence(resolvedSessionKey)} active=${result.active} canceled=${result.canceledCount} resetSession=${result.resetSession} reason=${reason}`
  );

  return res.json({
    success: true,
    callId,
    sessionKey: resolvedSessionKey,
    ...result,
    executorTasks,
  });
}

// General callers retain the legacy AGENT-scoped lifecycle API. The voice
// process uses the narrowly scoped alias below and never receives AGENT_API_TOKEN.
app.post('/cancel-session', handleCancelSession);
app.post('/voice-control/session/cancel', handleCancelSession);

/**
 * POST /voice-control/stop
 *
 * Fail-closed emergency stop for every phone-originated agent request. Asterisk
 * may call this endpoint without the bearer token only over loopback. The stop
 * is persistent and idempotent; it does not affect ordinary terminal/API work.
 */
app.post('/voice-control/stop', async (req, res) => {
  const timestamp = new Date().toISOString();
  const source = cleanLabel(req.body?.source || req.query?.source, 'loopback_panic');
  const reason = cleanLabel(req.body?.reason || req.query?.reason, 'voice_panic_stop');
  const panic = await performVoicePanic({ reason, source });
  const lock = panic.lock;
  const cancellation = panic.activeCancellation;
  const success = panic.success;

  console.warn(
    `[${timestamp}] VOICE PANIC STOP: source=${source} persistent=${lock.persistent} canceled=${cancellation.canceledCount} sessionsCleared=${cancellation.clearedSessionCount}`
  );

  if (String(req.query?.response || '').toLowerCase() === 'plain') {
    return res.status(success ? 200 : 503).type('text/plain').send(success ? 'STOPPED' : 'PARTIAL');
  }

  return res.status(success ? 200 : 503).json({
    success,
    voiceExecution: lock,
    ...cancellation,
    executorTasks: panic.executorCancellation,
    privilegedActions: panic.privilegedCancellation,
    workerSessions: panic.workerCancellation,
  });
});

app.get('/voice-control/status', (req, res) => {
  const status = voiceExecutionControl.getStatus();
  return res.status(status.error ? 503 : 200).json({
    success: !status.error,
    voiceExecution: status,
    executor: executorTaskStore.getPanicStatus(),
  });
});

app.post('/voice-control/unlock', async (req, res) => {
  const source = cleanLabel(req.body?.source || req.query?.source, 'operator');
  const unlock = await performVoiceUnlock({ source });
  const result = unlock.voiceExecution;
  const success = unlock.success;
  console.warn(
    `[${new Date().toISOString()}] VOICE EXECUTION UNLOCK: source=${source} success=${success} wasLocked=${result.wasLocked}`
  );
  const failureStatus = [
    'VOICE_EXECUTION_NOT_QUIESCED',
    'PRIVILEGED_ACTION_PANIC_LOCKED',
  ].includes(unlock.code) ? 409 : 503;
  return res.status(success ? 200 : failureStatus).json({
    success,
    code: unlock.code || null,
    error: unlock.error || null,
    voiceExecution: result,
    executor: unlock.executor,
    workerSessions: unlock.workerSessions,
  });
});

/**
 * POST /end-session
 *
 * Clean up session when a call ends
 *
 * Request body:
 *   {
 *     "callId": "call-uuid",
 *     "sessionKey": "optional-stable-session-uuid",
 *     "preserveForSeconds": 0
 *   }
 */
function handleEndSession(req, res) {
  const { callId, sessionKey, preserveForSeconds = 0 } = req.body || {};
  const timestamp = new Date().toISOString();
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);
  const preserveSeconds = parsePositiveInteger(preserveForSeconds) || 0;
  const hadSession = !!(resolvedSessionKey && sessions.has(resolvedSessionKey));
  const expiry = scheduleSessionExpiry(resolvedSessionKey, preserveSeconds);

  console.log(
    `[${timestamp}] SESSION ENDED: callLinked=${valuePresence(callId)} sessionKey=${valuePresence(resolvedSessionKey)} hadSession=${hadSession} preserved=${expiry.preserved} ttlSeconds=${expiry.ttlSeconds} expiresAt=${expiry.expiresAt || 'none'}`
  );

  res.json({
    success: true,
    callId: callId || null,
    sessionKey: resolvedSessionKey,
    hadSession,
    preserved: expiry.preserved,
    ttlSeconds: expiry.ttlSeconds,
    expiresAt: expiry.expiresAt,
  });
}

app.post('/end-session', handleEndSession);
app.post('/voice-control/session/end', handleEndSession);

function controllerHealthSnapshot() {
  let executor;
  let executorReady = false;
  const voiceExecution = voiceExecutionControl.getStatus();
  try {
    const storeHealth = executorTaskStore.health();
    const dispatcher = executorTaskDispatcher.status();
    executorReady = Boolean(
      storeHealth.ok && storeHealth.panic?.locked !== true &&
      dispatcher.running && dispatcher.acceptingClaims
    );
    executor = {
      ok: storeHealth.ok,
      journalMode: storeHealth.journalMode,
      panic: storeHealth.panic,
      dispatcher,
    };
  } catch (error) {
    executor = { ok: false, error: error.message };
  }
  const workerReady = Boolean(
    agentWorkerConfig.enabled && workerSessionProxyConfig.enabled &&
    workerSessionBoundaryStatus.ready
  );
  const ready = serverReady && executorReady && workerReady &&
    voiceExecution.locked !== true && SCOPED_AUTH_CONFIGURATION_VALID && !shutdownRequested;
  return {
    ready,
    public: {
      status: ready ? 'ok' : 'not_ready',
      ready,
      service: 'claude-api-server',
      timestamp: new Date().toISOString(),
    },
    detailed: {
      status: ready ? 'ok' : 'not_ready',
      ready,
      service: 'claude-api-server',
      providers: ENABLED_AGENT_PROVIDERS,
      voiceExecution,
      approvalCapabilities: { verifierConfigured: Boolean(approvalVerifier) },
      authentication: {
        agentConfigured: Boolean(AGENT_API_TOKEN),
        executorConfigured: Boolean(EXECUTOR_API_TOKEN),
        voiceControlConfigured: Boolean(VOICE_CONTROL_TOKEN),
        privilegedActionConfigured: Boolean(PRIVILEGED_ACTION_API_TOKEN),
        allScopesConfiguredAndDistinct: SCOPED_AUTH_CONFIGURATION_VALID,
      },
      privilegedActions: {
        enabled: PRIVILEGED_ACTION_PROXY_ENABLED,
        proxyConfigured: Boolean(privilegedActionProxy),
        authConfigured: Boolean(PRIVILEGED_ACTION_API_TOKEN),
      },
      agentWorker: {
        enabled: agentWorkerConfig.enabled,
        hardened: agentWorkerConfig.hardened === true,
        legacySameUidEnabled: agentWorkerConfig.legacySameUidEnabled === true,
      },
      workerSessionBroker: {
        enabled: workerSessionProxyConfig.enabled,
        ready: workerSessionBoundaryStatus.ready,
        code: workerSessionBoundaryStatus.code,
        checkedAt: workerSessionBoundaryStatus.checkedAt,
      },
      executor,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * GET /operator/health
 * Authenticated diagnostic health. This intentionally contains deployment and
 * panic details that must not be exposed by the public readiness probe.
 */
app.get('/operator/health', (_req, res) => {
  const health = controllerHealthSnapshot();
  return res.status(health.ready ? 200 : 503).json(health.detailed);
});

/**
 * GET /health
 * Minimal unauthenticated liveness/readiness endpoint.
 */
app.get('/health', (_req, res) => {
  const health = controllerHealthSnapshot();
  return res.status(health.ready ? 200 : 503).json(health.public);
});

/**
 * GET /
 * Info endpoint
 */
app.get('/', (req, res) => {
  res.json({
    service: 'Teleagent HTTP Agent Bridge',
    version: '1.1.0',
    providers: ENABLED_AGENT_PROVIDERS,
    endpoints: {
      'POST /ask': 'Send a prompt to the selected agent',
      'POST /ask-structured': 'Send a prompt and return validated JSON (n8n)',
      'POST /executor/tasks': 'Submit an idempotent durable managed ask or target-session task',
      'GET /executor/tasks/:taskId': 'Read durable executor task status and result',
      'GET /executor/tasks/by-idempotency/:key': 'Recover a task after an ambiguous submit',
      'POST /executor/tasks/:taskId/cancel': 'Cancel one durable executor task',
      'POST /privileged-actions': 'Forward one signed privileged action to the private root broker',
      'GET /privileged-actions/:actionId': 'Read a redacted privileged action result',
      'GET /privileged-actions/by-idempotency/:key': 'Recover an ambiguous privileged submission without resending it',
      'POST /privileged-actions/:actionId/cancel': 'Request cancellation of one privileged action',
      'POST /privileged-actions/panic': 'Persistently stop privileged action execution',
      'POST /executor/panic': 'Persistently stop all phone-originated execution',
      'POST /executor/panic/unlock': 'Operator-token compatibility unlock after durable quiescence',
      'POST /operator/session-message/prepare': 'Resolve and fingerprint an exact tmux-attached provider session',
      'POST /operator/session-message': 'Deliver an approved message to that exact tmux-attached provider session',
      'GET /operator/health': 'Read authenticated controller diagnostics',
      'POST /cancel-session': 'Cancel active agent work for a call',
      'POST /voice-control/stop': 'Lock and terminate all phone-originated agent work',
      'GET /voice-control/status': 'Get the persistent phone execution lock state',
      'POST /voice-control/unlock': 'Unlock phone-originated execution with API authentication',
      'POST /end-session': 'Clean up session state for a call',
      'GET /health': 'Health check'
    }
  });
});

function listenForRequests() {
  return new Promise((resolve, reject) => {
    const candidate = app.listen(PORT, BIND_HOST);
    httpServer = candidate;
    const onError = (error) => {
      candidate.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      candidate.removeListener('error', onError);
      resolve(candidate);
    };
    candidate.once('error', onError);
    candidate.once('listening', onListening);
  });
}

function beginHttpShutdown() {
  if (!httpServer) return Promise.resolve({ closed: true, error: null });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error?.code === 'ERR_SERVER_NOT_RUNNING') error = null;
      resolve({ closed: !error, error });
    };
    try {
      httpServer.close(finish);
    } catch (error) {
      finish(error);
    }
  });
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ settled: false, value: null });
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true, value: { closed: false, error } });
      }
    );
  });
}

function closeExecutorTaskStore() {
  if (executorStoreClosed) return;
  executorTaskStore.close();
  executorStoreClosed = true;
}

async function startServer() {
  try {
    synchronizePanicControls();
    await refreshWorkerSessionBoundaryHealth();
    if (workerSessionBoundaryStatus.ready) {
      await executorTaskDispatcher.start();
    }
    if (shutdownRequested) return;
    await listenForRequests();
    if (shutdownRequested) return;
    serverReady = true;
    workerSessionHealthTimer = setInterval(() => {
      void refreshWorkerSessionBoundaryHealth().then(async (status) => {
        if (status.ready && !executorTaskDispatcher.status().running && !shutdownRequested) {
          await executorTaskDispatcher.start();
        }
      }).catch(() => {});
    }, workerSessionProxyConfig.healthPollMs);
    if (typeof workerSessionHealthTimer.unref === 'function') workerSessionHealthTimer.unref();

    console.log('='.repeat(64));
    console.log('Teleagent HTTP Agent Bridge');
    console.log('='.repeat(64));
    console.log(`\nListening on: http://${BIND_HOST}:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Agent API auth: ${AGENT_API_TOKEN ? 'enabled' : 'unavailable'}`);
    console.log(`Executor API auth: ${EXECUTOR_API_TOKEN ? 'enabled' : 'unavailable'}`);
    console.log(`Voice control API auth: ${VOICE_CONTROL_TOKEN ? 'enabled' : 'unavailable'}`);
    console.log(`Privileged action proxy: ${PRIVILEGED_ACTION_PROXY_ENABLED ? 'enabled' : 'disabled'}`);
    console.log(`Privileged action proxy auth: ${PRIVILEGED_ACTION_PROXY_ENABLED && PRIVILEGED_ACTION_API_TOKEN ? 'enabled' : 'unavailable'}`);
    console.log(`Approval capability verifier: ${approvalVerifier ? 'configured' : 'unavailable'}`);
    console.log(`Hardened agent worker: ${agentWorkerConfig.enabled ? 'configured' : 'unavailable'}`);
    console.log(`Worker session broker: ${workerSessionBoundaryStatus.ready ? 'ready' : 'not ready'}`);
    console.log(`Enabled providers: ${ENABLED_AGENT_PROVIDERS.join(', ')}`);
    console.log(`Executor task store: ${EXECUTOR_TASK_DB_PATH}`);
    if (SCOPED_AUTH_CONFIGURATION_VALID && workerSessionBoundaryStatus.ready) {
      console.log('\nReady to receive Claude and Codex queries from voice interface.\n');
    } else {
      console.warn('\nController is listening but not ready: scoped auth and the hardened worker boundary are required.\n');
    }
  } catch (error) {
    if (shutdownRequested) return;
    console.error(`Server startup failed: ${error.stack || error.message}`);
    await shutdown('startup failure', { exitCode: 1 });
  }
}

// Graceful shutdown stops new requests and executor claims before closing the
// shared SQLite store. Late task promises are fenced by dispatcher.shutdown().
function shutdown(signal, { exitCode = 0 } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownRequested = true;
  serverReady = false;
  if (workerSessionHealthTimer) {
    clearInterval(workerSessionHealthTimer);
    workerSessionHealthTimer = null;
  }
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  const httpDrain = beginHttpShutdown();
  shutdownPromise = (async () => {
    let finalExitCode = exitCode;
    let activeRequestsQuiesced = false;
    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown exceeded its hard deadline.');
      process.exit(1);
    }, 12000);
    if (typeof forceExit.unref === 'function') forceExit.unref();

    try {
      const dispatcher = await executorTaskDispatcher.shutdown({
        releaseLeases: true,
        timeoutMs: 5000,
      });
      if (dispatcher.timedOut) {
        console.warn(
          `Executor drain timed out; reconciled tasks=${dispatcher.releasedTaskIds.length + dispatcher.unknownTaskIds.length}`
        );
      }
    } catch (error) {
      finalExitCode = 1;
      console.error(`Executor shutdown failed: ${error.stack || error.message}`);
    }

    try {
      const activeDrain = await drainAllActiveRequests({
        reason: 'controller_shutdown',
        gracefulMs: 1500,
        forceMs: 1000,
      });
      activeRequestsQuiesced = activeDrain.quiesced;
      if (!activeDrain.quiesced) {
        finalExitCode = 1;
        console.error(
          `Agent request drain failed; unresolved count=${activeDrain.remainingRequestIds.length}`
        );
      } else if (activeDrain.requestedCount > 0) {
        console.log(
          `Agent request drain complete: requested=${activeDrain.requestedCount} forced=${activeDrain.forcedCount}`
        );
      }
    } catch (error) {
      finalExitCode = 1;
      console.error(`Agent request shutdown failed: ${error.stack || error.message}`);
    }

    let http = await settleWithin(httpDrain, 2500);
    if (!http.settled) {
      httpServer?.closeAllConnections?.();
      http = await settleWithin(httpDrain, 500);
    }
    if (!http.settled || !http.value?.closed) {
      finalExitCode = 1;
      console.error(`HTTP drain failed: ${http.value?.error?.message || 'deadline exceeded'}`);
    } else if (!activeRequestsQuiesced) {
      finalExitCode = 1;
      console.error('Executor task store remains open because active requests did not quiesce.');
    } else {
      try {
        closeExecutorTaskStore();
      } catch (error) {
        finalExitCode = 1;
        console.error(`Executor task store close failed: ${error.stack || error.message}`);
      }
    }

    clearTimeout(forceExit);
    process.exit(finalExitCode);
  })();
  return shutdownPromise;
}

void startServer();

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
