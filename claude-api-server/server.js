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
const {
  buildQueryContext,
  buildStructuredPrompt,
  tryParseJsonFromText,
  validateRequiredFields,
  buildRepairPrompt,
} = require('./structured');
const { looksLikePhoneDeployRequest } = require('../lib/phone-deploy-intent');
const {
  buildCodexArgs,
  buildCodexEnvironment,
  normalizeCodexApprovalPolicy,
  normalizeCodexReasoningEffort,
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
const { OperatorInspector, parseRoots } = require('./operator-inspector');
const { TmuxAgentController } = require('./tmux-agent-controller');

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

// Load the project-level .env so the voice app and agent bridge can share bind/auth settings.
loadEnvFile(path.join(__dirname, '..', '.env'));

const HOME = process.env.HOME || os.homedir() || '/root';
const app = express();
const PORT = process.env.PORT || 3333;
const BIND_HOST = process.env.AGENT_API_BIND_HOST || process.env.CLAUDE_API_BIND_HOST || '0.0.0.0';
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN || process.env.CLAUDE_API_TOKEN || '';
const VOICE_EXECUTION_LOCK_FILE = process.env.VOICE_EXECUTION_LOCK_FILE ||
  path.join(__dirname, '..', 'voice-app', 'state', 'voice-execution.lock.json');
const voiceExecutionControl = new VoiceExecutionControl({ lockFile: VOICE_EXECUTION_LOCK_FILE });
const operatorInspector = new OperatorInspector({
  allowedRoots: parseRoots(process.env.VOICE_INSPECTION_ROOTS, HOME),
  home: HOME,
});
const tmuxAgentController = new TmuxAgentController({ inspector: operatorInspector });
const CLAUDE_WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
const CODEX_WORKING_DIR = process.env.CODEX_WORKING_DIR || CLAUDE_WORKING_DIR;
const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND || 'claude';
const CODEX_COMMAND = process.env.CODEX_COMMAND || 'codex';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
const PHONE_CLAUDE_MODEL = process.env.PHONE_CLAUDE_MODEL || 'haiku';
const PHONE_CLAUDE_PERMISSION_MODE = process.env.PHONE_CLAUDE_PERMISSION_MODE || 'dontAsk';
const PHONE_HAIKU_CLAUDE_MODEL = process.env.PHONE_HAIKU_CLAUDE_MODEL || PHONE_CLAUDE_MODEL;
const PHONE_SONNET_CLAUDE_MODEL = process.env.PHONE_SONNET_CLAUDE_MODEL || process.env.CLAUDE_MODEL || 'sonnet';
const PHONE_OPUS_CLAUDE_MODEL = process.env.PHONE_OPUS_CLAUDE_MODEL || 'opus';
const PHONE_DEPLOY_CLAUDE_MODEL = process.env.PHONE_DEPLOY_CLAUDE_MODEL || PHONE_SONNET_CLAUDE_MODEL;
const PHONE_HAIKU_CLAUDE_PERMISSION_MODE = process.env.PHONE_HAIKU_CLAUDE_PERMISSION_MODE || PHONE_CLAUDE_PERMISSION_MODE;
const PHONE_SONNET_CLAUDE_PERMISSION_MODE = process.env.PHONE_SONNET_CLAUDE_PERMISSION_MODE || PHONE_CLAUDE_PERMISSION_MODE;
const PHONE_OPUS_CLAUDE_PERMISSION_MODE = process.env.PHONE_OPUS_CLAUDE_PERMISSION_MODE || PHONE_CLAUDE_PERMISSION_MODE;
const PHONE_DEPLOY_CLAUDE_PERMISSION_MODE =
  process.env.PHONE_DEPLOY_CLAUDE_PERMISSION_MODE || PHONE_SONNET_CLAUDE_PERMISSION_MODE;
const PHONE_CODEX_LUNA_MODEL = process.env.PHONE_CODEX_LUNA_MODEL || 'gpt-5.6-luna';
const PHONE_CODEX_TERRA_MODEL = process.env.PHONE_CODEX_TERRA_MODEL || 'gpt-5.6-terra';
const PHONE_CODEX_SOL_MODEL = process.env.PHONE_CODEX_SOL_MODEL || 'gpt-5.6-sol';
const PHONE_CODEX_DEPLOY_MODEL = process.env.PHONE_CODEX_DEPLOY_MODEL || PHONE_CODEX_SOL_MODEL;
const PHONE_CODEX_LUNA_WORKING_DIR = process.env.PHONE_CODEX_LUNA_WORKING_DIR || CODEX_WORKING_DIR;
const PHONE_CODEX_TERRA_WORKING_DIR = process.env.PHONE_CODEX_TERRA_WORKING_DIR || CODEX_WORKING_DIR;
const PHONE_CODEX_SOL_WORKING_DIR = process.env.PHONE_CODEX_SOL_WORKING_DIR || CODEX_WORKING_DIR;
const PHONE_CODEX_DEPLOY_WORKING_DIR =
  process.env.PHONE_CODEX_DEPLOY_WORKING_DIR || PHONE_CODEX_SOL_WORKING_DIR;
const PHONE_CODEX_LUNA_REASONING_EFFORT = normalizeCodexReasoningEffort(
  process.env.PHONE_CODEX_LUNA_REASONING_EFFORT,
  'low'
);
const PHONE_CODEX_TERRA_REASONING_EFFORT = normalizeCodexReasoningEffort(
  process.env.PHONE_CODEX_TERRA_REASONING_EFFORT,
  'medium'
);
const PHONE_CODEX_SOL_REASONING_EFFORT = normalizeCodexReasoningEffort(
  process.env.PHONE_CODEX_SOL_REASONING_EFFORT,
  'high'
);
const PHONE_CODEX_DEPLOY_REASONING_EFFORT = normalizeCodexReasoningEffort(
  process.env.PHONE_CODEX_DEPLOY_REASONING_EFFORT,
  PHONE_CODEX_SOL_REASONING_EFFORT
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
const AGENT_LOG_SENSITIVE = /^(1|true|yes)$/i.test(
  process.env.AGENT_LOG_SENSITIVE || process.env.CLAUDE_LOG_SENSITIVE || ''
);

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

function logTextSummary(label, text, limit = 100) {
  const value = String(text || '');
  if (AGENT_LOG_SENSITIVE) {
    console.log(`${label}: "${value.substring(0, limit)}${value.length > limit ? '...' : ''}"`);
    return;
  }

  console.log(`${label}: chars=${value.length}`);
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

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateVoiceAuthorization({ profile, prompt, authorization }) {
  const classification = classifyVoiceOperation(prompt);
  const voiceOrigin = isPhoneSessionType(profile?.sessionType);
  if (!voiceOrigin || classification.level === RISK_LEVELS.READ_ONLY) {
    return { allowed: true, classification, authorization: null, voiceOrigin };
  }

  const approvedAt = Date.parse(authorization?.approved_at || '');
  const ageMs = Date.now() - approvedAt;
  const valid = authorization?.approved === true &&
    /^job_[A-Za-z0-9]+$/.test(String(authorization?.job_id || '')) &&
    authorization?.method === 'dtmf-pound' &&
    safeEqual(authorization?.request_sha256, requestHash(prompt)) &&
    Number.isFinite(approvedAt) &&
    ageMs >= -60000 &&
    ageMs <= 15 * 60000;

  if (!valid) {
    return {
      allowed: false,
      classification,
      authorization: null,
      code: 'VOICE_APPROVAL_REQUIRED',
      userMessage: 'That operation needs a job-specific approval. Call extension 7, review the spoken scope, and press pound to approve it.',
    };
  }

  return { allowed: true, classification, authorization, voiceOrigin };
}

function validateTargetSessionAuthorization({ operationId, target, message, sessionFingerprint, authorization }) {
  const approvedAt = Date.parse(authorization?.approved_at || '');
  const ageMs = Date.now() - approvedAt;
  const allowed = authorization?.approved === true &&
    /^job_[A-Za-z0-9]+$/.test(String(operationId || '')) &&
    authorization?.job_id === operationId &&
    authorization?.method === 'dtmf-pound' &&
    safeEqual(authorization?.request_sha256, requestHash(message)) &&
    safeEqual(authorization?.target, String(target || '')) &&
    safeEqual(authorization?.target_session_fingerprint, String(sessionFingerprint || '')) &&
    Number.isFinite(approvedAt) &&
    ageMs >= -60000 &&
    ageMs <= 15 * 60000;
  return {
    allowed,
    code: allowed ? null : 'VOICE_APPROVAL_REQUIRED',
  };
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
  const readOnlyTools = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill']);
  return {
    ...profile,
    tools: profile.tools.filter((tool) => readOnlyTools.has(tool)),
    allowedTools: profile.allowedTools.filter((tool) => readOnlyTools.has(tool)),
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
const claudeEnv = buildClaudeEnvironment();
const codexEnv = buildCodexEnvironment(claudeEnv);
console.log('[STARTUP] Loaded environment with', Object.keys(claudeEnv).length, 'variables');
console.log('[STARTUP] PATH includes:', claudeEnv.PATH.split(':').slice(0, 5).join(', '), '...');
console.log('[STARTUP] Claude working directory:', CLAUDE_WORKING_DIR);
console.log('[STARTUP] Codex working directory:', CODEX_WORKING_DIR);

// Log which API keys are available (without showing values)
const apiKeys = Object.keys(claudeEnv).filter(k =>
  k.includes('API_KEY') || k.includes('TOKEN') || k.includes('SECRET') || k === 'PAI_DIR'
);
console.log('[STARTUP] API keys loaded:', apiKeys.join(', '));

// Session storage: sessionKey -> { provider, sessionId }
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

function normalizeResumeSessionId(sessionId) {
  const value = String(sessionId || '').trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return null;
  return value;
}

function getSessionRecord(sessionKey) {
  if (!sessionKey) return null;

  const record = sessions.get(sessionKey);
  if (!record) return null;

  // Normalize records created by older in-memory bridge code during development.
  if (record === true) {
    return { provider: 'claude', sessionId: sessionKey };
  }
  if (typeof record === 'string') {
    return { provider: 'claude', sessionId: record };
  }
  return record;
}

function getSessionIdForProvider(sessionKey, provider) {
  const record = getSessionRecord(sessionKey);
  if (!record) return null;

  if (record.provider !== provider) {
    deleteSessionState(sessionKey);
    console.warn(
      `[${new Date().toISOString()}] SESSION PROVIDER CHANGED: previous=${record.provider} next=${provider}; starting fresh`
    );
    return null;
  }

  return record.sessionId || null;
}

function storeSessionState(sessionKey, provider, sessionId) {
  if (!sessionKey) return false;

  const existing = getSessionRecord(sessionKey);
  const effectiveSessionId = sessionId || existing?.sessionId || null;
  sessions.set(sessionKey, { provider, sessionId: effectiveSessionId });
  return !!effectiveSessionId;
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
  const bucket = getActiveRequestBucket(callId, true);
  if (!bucket) return;
  bucket.set(requestRecord.requestId, requestRecord);
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

function buildAgentInvocation({
  fullPrompt,
  sessionKey,
  resumeSessionId = null,
  timestamp,
  profile,
}) {
  const provider = profile.provider || 'claude';
  const restoredSessionId = normalizeResumeSessionId(resumeSessionId);
  const existingSessionId = restoredSessionId || getSessionIdForProvider(sessionKey, provider);

  if (restoredSessionId && sessionKey) {
    storeSessionState(sessionKey, provider, restoredSessionId);
  }

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

    if (sessionKey && !existingSessionId) {
      storeSessionState(sessionKey, provider, null);
    }

    console.log(
      `[${timestamp}] ${existingSessionId ? 'Resuming' : 'Starting'} Codex session`
    );

    return {
      command: CODEX_COMMAND,
      args,
      cwd: workingDirectory,
      env: codexEnv,
      stdinInput: fullPrompt,
      provider,
    };
  }

  const args = [
    '-p', fullPrompt,
    '--model', profile.model,
    '--permission-mode', profile.permissionMode
  ];

  if (profile.tools.length > 0) {
    args.push('--tools', profile.tools.join(','));
  }

  if (profile.allowedTools.length > 0) {
    args.push('--allowedTools', profile.allowedTools.join(','));
  }

  if (sessionKey) {
    if (existingSessionId) {
      args.push('--resume', existingSessionId);
      console.log(`[${timestamp}] Resuming Claude session`);
    } else {
      args.push('--session-id', sessionKey);
      storeSessionState(sessionKey, provider, sessionKey);
      console.log(`[${timestamp}] Starting Claude session`);
    }
  }

  return {
    command: CLAUDE_COMMAND,
    args,
    cwd: CLAUDE_WORKING_DIR,
    env: claudeEnv,
    stdinInput: '',
    provider,
  };
}

function runAgentOnce({
  fullPrompt,
  callId,
  sessionKey,
  resumeSessionId = null,
  timestamp,
  profile,
  timeoutSeconds = null
}) {
  const startTime = Date.now();
  const resolvedTimeoutSeconds = parsePositiveInteger(timeoutSeconds);
  const requestId = nextRequestId();
  const requestScopeKey = callId || requestId;
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);
  const voiceOrigin = isPhoneSessionType(profile?.sessionType);

  assertVoiceExecutionAllowed(profile);
  if (voiceOrigin && resolvedSessionKey) {
    voiceSessionKeys.add(resolvedSessionKey);
  }

  const invocation = buildAgentInvocation({
    fullPrompt,
    sessionKey: resolvedSessionKey,
    resumeSessionId,
    timestamp,
    profile,
  });
  const providerLabel = invocation.provider === 'codex' ? 'Codex' : 'Claude';

  return new Promise((resolve, reject) => {
    const agent = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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

    registerActiveRequest(requestScopeKey, requestRecord);
    console.log(`[${timestamp}] ACTIVE REQUEST STARTED: requestId=${requestId} callLinked=${callId ? 'yes' : 'no'}`);

    let stdout = '';
    let stderr = '';
    let settled = false;

    agent.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        console.warn(`[${new Date().toISOString()}] ${providerLabel} stdin error: ${error.message}`);
      }
    });
    agent.stdin.end(invocation.stdinInput);
    agent.stdout.on('data', (data) => { stdout += data.toString(); });
    agent.stderr.on('data', (data) => { stderr += data.toString(); });

    function cleanup() {
      if (requestRecord.killTimer) {
        clearTimeout(requestRecord.killTimer);
        requestRecord.killTimer = null;
      }
      if (requestRecord.forceKillTimer && requestRecord.state === 'running') {
        clearTimeout(requestRecord.forceKillTimer);
        requestRecord.forceKillTimer = null;
      }
      clearActiveRequest(requestScopeKey, requestId);
    }

    function settleWithError(error) {
      if (settled) return;
      settled = true;
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
      settleWithSuccess({
        code,
        stdout,
        stderr,
        duration_ms,
        provider: invocation.provider,
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

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

function hasValidApiToken(req) {
  if (!AGENT_API_TOKEN) return false;
  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = bearerMatch ? bearerMatch[1].trim() : (req.get('x-api-key') || '').trim();
  return providedToken === AGENT_API_TOKEN;
}

app.use((req, res, next) => {
  const localPanicStop = req.method === 'POST' &&
    req.path === '/voice-control/stop' &&
    isLoopbackRequest(req);

  if (!AGENT_API_TOKEN || req.path === '/' || req.path === '/health' || localPanicStop) {
    return next();
  }

  if (hasValidApiToken(req)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'unauthorized'
  });
});

app.post('/operator/inspect', async (req, res) => {
  const action = String(req.body?.action || '').trim();
  const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
  try {
    const result = await operatorInspector.execute(action, args);
    return res.json({ success: true, action, result });
  } catch (error) {
    const code = error.code || 'OPERATOR_INSPECTION_FAILED';
    const status = ['PATH_OUTSIDE_ROOTS', 'SENSITIVE_PATH'].includes(code) ? 403 : 400;
    return res.status(status).json({ success: false, code, error: error.message });
  }
});

app.post('/operator/session-message/prepare', async (req, res) => {
  const voiceExecution = voiceExecutionControl.getStatus();
  if (voiceExecution.locked) {
    return res.status(423).json(voiceExecutionLockedPayload(voiceExecution));
  }
  try {
    const result = await tmuxAgentController.prepare({ target: req.body?.target });
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
    const status = ['TMUX_TARGET_NOT_FOUND', 'AGENT_SESSION_NOT_FOUND', 'SESSION_HISTORY_UNRESOLVED']
      .includes(code) ? 404 : 400;
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
  const approval = validateTargetSessionAuthorization({
    operationId,
    target,
    message,
    sessionFingerprint,
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
  registerActiveRequest(operationId, requestRecord);

  try {
    const result = await tmuxAgentController.send({
      target,
      message,
      sessionFingerprint,
      timeoutMs: timeoutSeconds * 1000,
      signal: abortController.signal,
    });
    requestRecord.provider = result.provider;
    return res.json({ success: true, result });
  } catch (error) {
    const code = error.code || 'TARGET_SESSION_MESSAGE_FAILED';
    const status = ['TARGET_SESSION_CHANGED', 'TARGET_MESSAGE_CANCELED', 'TARGET_SESSION_LOG_CHANGED']
      .includes(code) ? 409
      : (['TARGET_IDLE_TIMEOUT', 'TARGET_DELIVERY_TIMEOUT', 'TARGET_RESPONSE_TIMEOUT'].includes(code) ? 504
        : (['TMUX_TARGET_NOT_FOUND', 'AGENT_SESSION_NOT_FOUND', 'SESSION_HISTORY_UNRESOLVED'].includes(code) ? 404 : 400));
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
 *   { "success": true, "response": "...", "duration_ms": 1234, "sessionId": "..." }
 *
 * Session Management:
 *   - If sessionKey is provided and we have a stored session, uses --resume
 *   - First query for a sessionKey captures the session_id for future turns
 *   - If sessionKey is omitted, callId is used as the session key for compatibility
 *   - This maintains conversation context across multiple turns in a phone call
 *
 * Device Prompts:
 *   - If devicePrompt is provided, it's prepended before VOICE_CONTEXT
 *   - This allows each device (NAS, Proxmox, etc.) to have its own identity and skills
 */
app.post('/ask', async (req, res) => {
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

  const voiceAuthorization = validateVoiceAuthorization({ profile, prompt, authorization });
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
  const executionProfile = applyVoiceExecutionBoundary(profile, voiceAuthorization);

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

    const { code, stdout, stderr, duration_ms, provider } = await runAgentOnce({
      fullPrompt,
      callId,
      sessionKey: resolvedSessionKey,
      resumeSessionId,
      timestamp,
      profile: executionProfile,
      timeoutSeconds: resolvedTimeoutSeconds
    });
    const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';

    if (code !== 0) {
      console.error(`[${new Date().toISOString()}] ERROR: ${providerLabel} CLI exited with code ${code}`);
      logTextSummary('STDERR', stderr, 500);
      logTextSummary('STDOUT', stdout, 500);
      const parsedFailure = parseAgentStdout(provider, stdout);
      const errorMsg = parsedFailure.error || stderr || parsedFailure.response || `Exit code ${code}`;
      return res.json({
        success: false,
        provider,
        code: 'AGENT_CLI_FAILED',
        agentCode: 'AGENT_CLI_FAILED',
        error: `${providerLabel} CLI failed: ${errorMsg}`,
        duration_ms,
      });
    }

    const { response, sessionId } = parseAgentStdout(provider, stdout);

    if (sessionId && resolvedSessionKey) {
      storeSessionState(resolvedSessionKey, provider, sessionId);
      console.log(`[${new Date().toISOString()}] SESSION STORED: provider=${provider} sessionKey=yes sessionId=yes`);
    }

    const effectiveSessionId = sessionId || getSessionRecord(resolvedSessionKey)?.sessionId || null;

    logTextSummary(`[${new Date().toISOString()}] RESPONSE (${duration_ms}ms)`, response);

    res.json({ success: true, response, sessionId: effectiveSessionId, provider, duration_ms });

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

    if (error.code === 'VOICE_EXECUTION_LOCKED') {
      payload.agentCode = error.agentCode || 'AGENT_VOICE_EXECUTION_LOCKED';
      payload.userMessage = voiceExecutionLockedPayload(error.voiceExecution).userMessage;
      payload.voiceExecution = error.voiceExecution;
      return res.status(423).json(payload);
    }

    return res.json(payload);
  }
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

  const voiceAuthorization = validateVoiceAuthorization({ profile, prompt, authorization });
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
  const executionProfile = applyVoiceExecutionBoundary(profile, voiceAuthorization);

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

  try {
    let lastRaw = '';
    let lastError = 'Unknown error';
    let totalDuration = 0;
    const retries = Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 0;
    let attemptsMade = 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      attemptsMade = attempt + 1;
      const { code, stdout, stderr, duration_ms, provider } = await runAgentOnce({
        fullPrompt,
        callId,
        sessionKey: resolvedSessionKey,
        timestamp,
        profile: executionProfile,
        timeoutSeconds: resolvedTimeoutSeconds
      });
      totalDuration += duration_ms;
      const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';

      if (code !== 0) {
        const parsedFailure = parseAgentStdout(provider, stdout);
        lastError = `${providerLabel} CLI failed: ${parsedFailure.error || stderr || parsedFailure.response || `exit code ${code}`}`;
        lastRaw = parsedFailure.response || '';
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

      const { response, sessionId } = parseAgentStdout(provider, stdout);
      lastRaw = response;

      if (sessionId && resolvedSessionKey) {
        storeSessionState(resolvedSessionKey, provider, sessionId);
      }

      const parsed = tryParseJsonFromText(response);
      if (!parsed.ok) {
        lastError = parsed.error || 'Failed to parse JSON';
      } else {
        const validation = validateRequiredFields(parsed.data, schema.requiredFields);
        if (validation.ok) {
          return res.json({
            success: true,
            provider,
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
    const payload = { success: false, provider: profile.provider, error: error.message };
    if (error.code) {
      payload.code = error.code;
      payload.agentCode = toAgentErrorCode(error.code);
    }
    if (error.reason) {
      payload.reason = error.reason;
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
app.post('/cancel-session', (req, res) => {
  const {
    callId,
    sessionKey,
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

  console.log(
    `[${timestamp}] SESSION CANCELED: callLinked=yes sessionKey=${valuePresence(resolvedSessionKey)} active=${result.active} canceled=${result.canceledCount} resetSession=${result.resetSession} reason=${reason}`
  );

  return res.json({
    success: true,
    callId,
    sessionKey: resolvedSessionKey,
    ...result,
  });
});

/**
 * POST /voice-control/stop
 *
 * Fail-closed emergency stop for every phone-originated agent request. Asterisk
 * may call this endpoint without the bearer token only over loopback. The stop
 * is persistent and idempotent; it does not affect ordinary terminal/API work.
 */
app.post('/voice-control/stop', (req, res) => {
  const timestamp = new Date().toISOString();
  const source = cleanLabel(req.body?.source || req.query?.source, 'loopback_panic');
  const reason = cleanLabel(req.body?.reason || req.query?.reason, 'voice_panic_stop');
  const lock = voiceExecutionControl.lock({ reason, source });
  const cancellation = cancelAllVoiceRequests({ reason });
  const success = lock.locked && lock.persistent;

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
  });
});

app.get('/voice-control/status', (req, res) => {
  const status = voiceExecutionControl.getStatus();
  return res.status(status.error ? 503 : 200).json({
    success: !status.error,
    voiceExecution: status,
  });
});

app.post('/voice-control/unlock', (req, res) => {
  if (!hasValidApiToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  const source = cleanLabel(req.body?.source || req.query?.source, 'operator');
  const result = voiceExecutionControl.unlock({ source });
  const success = result.locked === false;
  console.warn(
    `[${new Date().toISOString()}] VOICE EXECUTION UNLOCK: source=${source} success=${success} wasLocked=${result.wasLocked}`
  );
  return res.status(success ? 200 : 503).json({
    success,
    voiceExecution: result,
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
app.post('/end-session', (req, res) => {
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
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'claude-api-server',
    providers: ENABLED_AGENT_PROVIDERS,
    voiceExecution: voiceExecutionControl.getStatus(),
    timestamp: new Date().toISOString()
  });
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
      'POST /operator/session-message/prepare': 'Resolve and fingerprint an exact tmux-attached provider session',
      'POST /operator/session-message': 'Deliver an approved message to that exact tmux-attached provider session',
      'POST /cancel-session': 'Cancel active agent work for a call',
      'POST /voice-control/stop': 'Lock and terminate all phone-originated agent work',
      'GET /voice-control/status': 'Get the persistent phone execution lock state',
      'POST /voice-control/unlock': 'Unlock phone-originated execution with API authentication',
      'POST /end-session': 'Clean up session state for a call',
      'GET /health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, BIND_HOST, () => {
  console.log('='.repeat(64));
  console.log('Teleagent HTTP Agent Bridge');
  console.log('='.repeat(64));
  console.log(`\nListening on: http://${BIND_HOST}:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Agent API auth: ${AGENT_API_TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`Enabled providers: ${ENABLED_AGENT_PROVIDERS.join(', ')}`);
  console.log('\nReady to receive Claude and Codex queries from voice interface.\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});
