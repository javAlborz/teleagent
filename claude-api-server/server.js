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
  normalizeCodexApprovalPolicy,
  normalizeCodexReasoningEffort,
  normalizeCodexSandbox,
  parseAgentStdout,
} = require('./agent-cli');

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
const BIND_HOST = process.env.CLAUDE_API_BIND_HOST || '0.0.0.0';
const CLAUDE_API_TOKEN = process.env.CLAUDE_API_TOKEN || '';
const CLAUDE_WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
const CODEX_WORKING_DIR = process.env.CODEX_WORKING_DIR || CLAUDE_WORKING_DIR;
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
const CLAUDE_LOG_SENSITIVE = /^(1|true|yes)$/i.test(process.env.CLAUDE_LOG_SENSITIVE || '');

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

function valuePresence(value) {
  return value ? 'yes' : 'no';
}

function logTextSummary(label, text, limit = 100) {
  const value = String(text || '');
  if (CLAUDE_LOG_SENSITIVE) {
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

function resolveEffectiveSessionType(sessionType, prompt = '', devicePrompt = '') {
  const normalized = normalizeSessionType(sessionType);

  if (!isPhoneSessionType(normalized)) {
    return normalized;
  }

  if (looksLikePhoneDeployRequest(prompt, devicePrompt)) {
    return normalized.startsWith('phone-codex-')
      ? 'phone-codex-deploy'
      : 'phone-deploy';
  }

  return normalized;
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
      };
    default:
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

  return env;
}

// Pre-build the environment once at startup
const claudeEnv = buildClaudeEnvironment();
const codexEnv = { ...claudeEnv };
delete codexEnv.CLAUDECODE;
delete codexEnv.CLAUDE_CODE_ENTRYPOINT;
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
// Active request storage: callId -> Map(requestId -> requestRecord)
const activeRequests = new Map();
// Deferred session expiry timers: sessionKey -> Timeout
const sessionExpiryTimers = new Map();
let activeRequestSequence = 0;

function resolveSessionKey(callId, sessionKey) {
  return sessionKey || callId || null;
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

function transitionActiveRequest(record, state, reason) {
  if (!record || record.state !== 'running') {
    return false;
  }

  record.state = state;
  record.reason = reason;

  if (record.killTimer) {
    clearTimeout(record.killTimer);
    record.killTimer = null;
  }

  killChildProcess(record, 'SIGTERM');

  if (record.forceKillTimer) {
    clearTimeout(record.forceKillTimer);
  }

  record.forceKillTimer = setTimeout(() => {
    if (record.state === state) {
      killChildProcess(record, 'SIGKILL');
    }
  }, 2000);

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

function buildAgentInvocation({
  fullPrompt,
  sessionKey,
  timestamp,
  profile,
}) {
  const provider = profile.provider || 'claude';
  const existingSessionId = getSessionIdForProvider(sessionKey, provider);

  if (sessionKey) {
    clearSessionExpiryTimer(sessionKey);
  }

  if (provider === 'codex') {
    const args = buildCodexArgs({
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvalPolicy,
      workingDirectory: CODEX_WORKING_DIR,
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
      cwd: CODEX_WORKING_DIR,
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
    command: 'claude',
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
  timestamp,
  profile,
  timeoutSeconds = null
}) {
  const startTime = Date.now();
  const resolvedTimeoutSeconds = parsePositiveInteger(timeoutSeconds);
  const requestId = nextRequestId();
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);
  const invocation = buildAgentInvocation({
    fullPrompt,
    sessionKey: resolvedSessionKey,
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
      detached: process.platform !== 'win32',
      state: 'running',
      reason: null,
      killTimer: null,
      forceKillTimer: null,
      startedAt: startTime,
    };

    if (callId) {
      registerActiveRequest(callId, requestRecord);
      console.log(`[${timestamp}] ACTIVE REQUEST STARTED: requestId=${requestId} callLinked=yes`);
    }

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
      if (requestRecord.forceKillTimer) {
        clearTimeout(requestRecord.forceKillTimer);
        requestRecord.forceKillTimer = null;
      }
      clearActiveRequest(callId, requestId);
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

app.use((req, res, next) => {
  if (!CLAUDE_API_TOKEN || req.path === '/' || req.path === '/health') {
    return next();
  }

  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = bearerMatch ? bearerMatch[1].trim() : (req.get('x-api-key') || '').trim();

  if (providedToken && providedToken === CLAUDE_API_TOKEN) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'unauthorized'
  });
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
  const { prompt, callId, sessionKey, devicePrompt, sessionType, timeoutSeconds } = req.body;
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

  // Check if we have an existing session for this call
  const existingSession = resolvedSessionKey ? sessions.get(resolvedSessionKey) : null;

  logTextSummary(`[${timestamp}] QUERY`, prompt);
  logAgentProfile(timestamp, profile);
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
    if (deployIntent) {
      fullPrompt += PHONE_DEPLOY_CONTEXT;
    }
    fullPrompt += prompt;

    const { code, stdout, stderr, duration_ms, provider } = await runAgentOnce({
      fullPrompt,
      callId,
      sessionKey: resolvedSessionKey,
      timestamp,
      profile,
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
    }
    if (error.reason) {
      payload.reason = error.reason;
    }

    res.json(payload);
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
  } = req.body || {};

  const timestamp = new Date().toISOString();
  const deployIntent = looksLikePhoneDeployRequest(prompt, devicePrompt);
  const profile = resolveAgentProfile(sessionType, prompt, devicePrompt);
  const resolvedTimeoutSeconds = resolveRequestTimeoutSeconds(sessionType, prompt, devicePrompt, timeoutSeconds);
  const resolvedSessionKey = resolveSessionKey(callId, sessionKey);

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt in request body' });
  }

  const queryContext = buildQueryContext({
    queryType: schema.queryType,
    requiredFields: schema.requiredFields,
    fieldGuidance: schema.fieldGuidance,
    allowExtraFields: schema.allowExtraFields !== false,
    example: schema.example,
  });

  let fullPrompt = buildStructuredPrompt({
    devicePrompt,
    queryContext: (includeVoiceContext ? VOICE_CONTEXT + (deployIntent ? PHONE_DEPLOY_CONTEXT : '') : '') + queryContext,
    userPrompt: prompt,
  });

  logTextSummary(`[${timestamp}] STRUCTURED QUERY`, prompt);
  logAgentProfile(timestamp, profile);
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
        profile,
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
        queryContext: includeVoiceContext ? VOICE_CONTEXT : '',
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
    }
    if (error.reason) {
      payload.reason = error.reason;
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
    providers: ['claude', 'codex'],
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
    providers: ['claude', 'codex'],
    endpoints: {
      'POST /ask': 'Send a prompt to the selected agent',
      'POST /ask-structured': 'Send a prompt and return validated JSON (n8n)',
      'POST /cancel-session': 'Cancel active agent work for a call',
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
  console.log(`Agent API auth: ${CLAUDE_API_TOKEN ? 'enabled' : 'disabled'}`);
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
