'use strict';

const os = require('os');
const { looksLikePhoneDeployRequest } = require('../lib/phone-deploy-intent');
const {
  normalizeCodexApprovalPolicy,
  normalizeCodexReasoningEffort,
  normalizeCodexSandbox,
} = require('./agent-cli');

const KNOWN_PROVIDERS = ['claude', 'codex'];
const CODEX_PRIVILEGED_PROFILE_REQUIRED = 'CODEX_PRIVILEGED_PROFILE_REQUIRED';
const AGENT_PRIVILEGED_PROFILE_REQUIRED = 'AGENT_PRIVILEGED_PROFILE_REQUIRED';

function parseListEnv(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseProviders(value) {
  const requested = parseListEnv(value).map(provider => provider.toLowerCase());
  const enabled = KNOWN_PROVIDERS.filter(provider => requested.includes(provider));
  return enabled.length > 0 ? enabled : [...KNOWN_PROVIDERS];
}

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

function isRestrictedCodexDeployRequest(sessionType, prompt = '', devicePrompt = '') {
  const normalized = normalizeSessionType(sessionType);
  return (
    ['phone-codex-luna', 'phone-codex-terra'].includes(normalized) &&
    looksLikePhoneDeployRequest(prompt, devicePrompt)
  );
}

function resolveEffectiveSessionType(sessionType, prompt = '', devicePrompt = '') {
  const normalized = normalizeSessionType(sessionType);

  if (!isPhoneSessionType(normalized) || !looksLikePhoneDeployRequest(prompt, devicePrompt)) {
    return normalized;
  }

  if (normalized === 'phone-codex-sol' || normalized === 'phone-codex-deploy') {
    return 'phone-codex-deploy';
  }

  if (normalized.startsWith('phone-codex-')) {
    // Luna and Terra are intentionally never escalated to a full-access profile.
    return normalized;
  }

  return 'phone-deploy';
}

function createAgentProfileConfig(env = process.env, homeDirectory = null) {
  const home = homeDirectory || env.HOME || os.homedir() || '/root';
  const claudeWorkingDirectory = env.CLAUDE_WORKING_DIR || home;
  const codexWorkingDirectory = env.CODEX_WORKING_DIR || claudeWorkingDirectory;
  const phoneClaudeModel = env.PHONE_CLAUDE_MODEL || 'haiku';
  const phoneClaudePermissionMode = env.PHONE_CLAUDE_PERMISSION_MODE || 'dontAsk';
  const phoneClaudeAllowedTools = parseListEnv(env.PHONE_CLAUDE_ALLOWED_TOOLS);
  const phoneClaudeTools = parseListEnv(env.PHONE_CLAUDE_TOOLS);
  const sonnetAllowedTools = parseListEnv(
    env.PHONE_SONNET_CLAUDE_ALLOWED_TOOLS || phoneClaudeAllowedTools.join(',')
  );
  const sonnetTools = parseListEnv(env.PHONE_SONNET_CLAUDE_TOOLS || phoneClaudeTools.join(','));
  const codexSolModel = env.PHONE_CODEX_SOL_MODEL || 'gpt-5.6-sol';
  const codexSolEffort = normalizeCodexReasoningEffort(
    env.PHONE_CODEX_SOL_REASONING_EFFORT,
    'high'
  );

  return {
    enabledProviders: parseProviders(env.AGENT_PROVIDERS),
    phoneDeployTimeoutSeconds: parsePositiveInteger(env.PHONE_DEPLOY_TIMEOUT_SECONDS, 900),
    profiles: {
      'phone-haiku': {
        provider: 'claude',
        sessionType: 'phone-haiku',
        model: env.PHONE_HAIKU_CLAUDE_MODEL || phoneClaudeModel,
        permissionMode: env.PHONE_HAIKU_CLAUDE_PERMISSION_MODE || phoneClaudePermissionMode,
        tools: parseListEnv(env.PHONE_HAIKU_CLAUDE_TOOLS || phoneClaudeTools.join(',')),
        allowedTools: parseListEnv(env.PHONE_HAIKU_CLAUDE_ALLOWED_TOOLS || phoneClaudeAllowedTools.join(',')),
        workingDirectory: claudeWorkingDirectory,
      },
      'phone-sonnet': {
        provider: 'claude',
        sessionType: 'phone-sonnet',
        model: env.PHONE_SONNET_CLAUDE_MODEL || env.CLAUDE_MODEL || 'sonnet',
        permissionMode: env.PHONE_SONNET_CLAUDE_PERMISSION_MODE || phoneClaudePermissionMode,
        tools: sonnetTools,
        allowedTools: sonnetAllowedTools,
        workingDirectory: claudeWorkingDirectory,
      },
      'phone-opus': {
        provider: 'claude',
        sessionType: 'phone-opus',
        model: env.PHONE_OPUS_CLAUDE_MODEL || 'opus',
        permissionMode: env.PHONE_OPUS_CLAUDE_PERMISSION_MODE || phoneClaudePermissionMode,
        tools: parseListEnv(env.PHONE_OPUS_CLAUDE_TOOLS || phoneClaudeTools.join(',')),
        allowedTools: parseListEnv(env.PHONE_OPUS_CLAUDE_ALLOWED_TOOLS || phoneClaudeAllowedTools.join(',')),
        workingDirectory: claudeWorkingDirectory,
      },
      'phone-deploy': {
        provider: 'claude',
        sessionType: 'phone-deploy',
        model: env.PHONE_DEPLOY_CLAUDE_MODEL || env.PHONE_SONNET_CLAUDE_MODEL || env.CLAUDE_MODEL || 'sonnet',
        permissionMode: env.PHONE_DEPLOY_CLAUDE_PERMISSION_MODE || env.PHONE_SONNET_CLAUDE_PERMISSION_MODE || phoneClaudePermissionMode,
        tools: parseListEnv(env.PHONE_DEPLOY_CLAUDE_TOOLS || 'Read,Write,Edit,Glob,Grep,Bash,Skill'),
        allowedTools: parseListEnv(
          env.PHONE_DEPLOY_CLAUDE_ALLOWED_TOOLS ||
          env.PHONE_SONNET_CLAUDE_ALLOWED_TOOLS ||
          env.PHONE_CLAUDE_ALLOWED_TOOLS
        ),
        workingDirectory: claudeWorkingDirectory,
      },
      'phone-codex-luna': {
        provider: 'codex',
        sessionType: 'phone-codex-luna',
        model: env.PHONE_CODEX_LUNA_MODEL || 'gpt-5.6-luna',
        reasoningEffort: normalizeCodexReasoningEffort(env.PHONE_CODEX_LUNA_REASONING_EFFORT, 'low'),
        sandbox: normalizeCodexSandbox(env.PHONE_CODEX_LUNA_SANDBOX, 'read-only'),
        approvalPolicy: normalizeCodexApprovalPolicy(env.PHONE_CODEX_APPROVAL_POLICY, 'never'),
        tools: [],
        allowedTools: [],
        workingDirectory: env.PHONE_CODEX_LUNA_WORKING_DIR || codexWorkingDirectory,
      },
      'phone-codex-terra': {
        provider: 'codex',
        sessionType: 'phone-codex-terra',
        model: env.PHONE_CODEX_TERRA_MODEL || 'gpt-5.6-terra',
        reasoningEffort: normalizeCodexReasoningEffort(env.PHONE_CODEX_TERRA_REASONING_EFFORT, 'medium'),
        sandbox: normalizeCodexSandbox(env.PHONE_CODEX_TERRA_SANDBOX, 'workspace-write'),
        approvalPolicy: normalizeCodexApprovalPolicy(env.PHONE_CODEX_APPROVAL_POLICY, 'never'),
        tools: [],
        allowedTools: [],
        workingDirectory: env.PHONE_CODEX_TERRA_WORKING_DIR || codexWorkingDirectory,
      },
      'phone-codex-sol': {
        provider: 'codex',
        sessionType: 'phone-codex-sol',
        model: codexSolModel,
        reasoningEffort: codexSolEffort,
        sandbox: normalizeCodexSandbox(env.PHONE_CODEX_SOL_SANDBOX, 'danger-full-access'),
        approvalPolicy: normalizeCodexApprovalPolicy(env.PHONE_CODEX_APPROVAL_POLICY, 'never'),
        tools: [],
        allowedTools: [],
        workingDirectory: env.PHONE_CODEX_SOL_WORKING_DIR || codexWorkingDirectory,
      },
      'phone-codex-deploy': {
        provider: 'codex',
        sessionType: 'phone-codex-deploy',
        model: env.PHONE_CODEX_DEPLOY_MODEL || codexSolModel,
        reasoningEffort: normalizeCodexReasoningEffort(
          env.PHONE_CODEX_DEPLOY_REASONING_EFFORT,
          codexSolEffort
        ),
        sandbox: normalizeCodexSandbox(env.PHONE_CODEX_DEPLOY_SANDBOX, 'danger-full-access'),
        approvalPolicy: normalizeCodexApprovalPolicy(env.PHONE_CODEX_APPROVAL_POLICY, 'never'),
        tools: [],
        allowedTools: [],
        workingDirectory: env.PHONE_CODEX_DEPLOY_WORKING_DIR || env.PHONE_CODEX_SOL_WORKING_DIR || codexWorkingDirectory,
      },
      default: {
        provider: 'claude',
        sessionType: 'default',
        model: env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        permissionMode: env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',
        tools: parseListEnv(env.CLAUDE_TOOLS),
        allowedTools: parseListEnv(env.CLAUDE_ALLOWED_TOOLS),
        workingDirectory: claudeWorkingDirectory,
      },
    }
  };
}

function resolveAgentProfile(config, sessionType, prompt = '', devicePrompt = '') {
  const effectiveType = resolveEffectiveSessionType(sessionType, prompt, devicePrompt);
  if (effectiveType === 'default' && !config.enabledProviders.includes('claude')) {
    return config.profiles['phone-codex-luna'];
  }
  return config.profiles[effectiveType] || config.profiles.default;
}

function resolveRequestTimeoutSeconds(
  config,
  sessionType,
  prompt = '',
  devicePrompt = '',
  requestedTimeoutSeconds = null
) {
  const requested = parsePositiveInteger(requestedTimeoutSeconds);
  if (isPhoneSessionType(sessionType) && looksLikePhoneDeployRequest(prompt, devicePrompt)) {
    return Math.max(requested || 0, config.phoneDeployTimeoutSeconds);
  }
  return requested;
}

function getDeploymentAuthorization(sessionType, prompt = '', devicePrompt = '') {
  if (!isRestrictedCodexDeployRequest(sessionType, prompt, devicePrompt)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: CODEX_PRIVILEGED_PROFILE_REQUIRED,
    agentCode: AGENT_PRIVILEGED_PROFILE_REQUIRED,
    message: 'That deployment needs the privileged Codex Sol profile. Please dial extension 6 and try again.',
  };
}

module.exports = {
  AGENT_PRIVILEGED_PROFILE_REQUIRED,
  CODEX_PRIVILEGED_PROFILE_REQUIRED,
  createAgentProfileConfig,
  getDeploymentAuthorization,
  isPhoneSessionType,
  isRestrictedCodexDeployRequest,
  normalizeSessionType,
  parseListEnv,
  parsePositiveInteger,
  resolveAgentProfile,
  resolveEffectiveSessionType,
  resolveRequestTimeoutSeconds,
};
