'use strict';

const { classifyVoiceOperation } = require('./voice-operation-risk');

const PROFILE_BY_SESSION_TYPE = Object.freeze({
  'phone-haiku': 'claude-haiku',
  'phone-sonnet': 'claude-sonnet',
  'phone-opus': 'claude-opus',
  'phone-codex-luna': 'codex-luna',
  'phone-codex-terra': 'codex-terra',
  'phone-codex-sol': 'codex-sol',
});

function clean(value) {
  return String(value || '').trim();
}

function profileForSessionType(sessionType) {
  return PROFILE_BY_SESSION_TYPE[clean(sessionType)] || null;
}

function profileForTargetSession(provider, request) {
  const normalizedProvider = clean(provider).toLowerCase();
  if (!['claude', 'codex'].includes(normalizedProvider)) return null;
  const classification = classifyVoiceOperation(request);
  const admin = classification.capability === 'admin';
  return normalizedProvider === 'claude'
    ? (admin ? 'claude-opus' : 'claude-sonnet')
    : (admin ? 'codex-sol' : 'codex-terra');
}

function managedAgentTarget(sessionKey) {
  const normalized = clean(sessionKey);
  if (!normalized) throw new Error('A managed agent session key is required.');
  return `managed:${normalized}`;
}

function targetSessionOperationMarker(jobId) {
  const normalized = clean(jobId);
  if (!/^job_[A-Za-z0-9]+$/.test(normalized)) {
    throw new Error('A valid target-session operation job id is required.');
  }
  return `[teleagent-operation:${normalized}]`;
}

function buildStructuredAgentApprovalContext({
  schema = {},
  includeVoiceContext = false,
  maxRetries = 1,
} = {}) {
  const normalizedSchema = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : {};
  return {
    mode: 'structured',
    schema: normalizedSchema,
    include_voice_context: Boolean(includeVoiceContext),
    max_retries: Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 0,
  };
}

function buildManagedAgentApprovalPlan({
  jobId,
  request,
  sessionKey,
  sessionType,
  timeoutSeconds = null,
  devicePrompt = null,
  executionContext = null,
} = {}) {
  return {
    version: 1,
    kind: 'managed_agent_task',
    job_id: clean(jobId),
    request: clean(request),
    session_key: clean(sessionKey),
    session_type: clean(sessionType),
    timeout_seconds: Number.isFinite(Number(timeoutSeconds)) ? Number(timeoutSeconds) : null,
    device_prompt: clean(devicePrompt) || null,
    execution_context: executionContext || null,
  };
}

function buildTargetSessionApprovalPlan({
  jobId,
  target,
  message,
  sessionFingerprint,
  timeoutSeconds = null,
} = {}) {
  return {
    version: 1,
    kind: 'tmux_agent_message',
    job_id: clean(jobId),
    target: clean(target),
    message: clean(message),
    session_fingerprint: clean(sessionFingerprint),
    timeout_seconds: Number.isFinite(Number(timeoutSeconds)) ? Number(timeoutSeconds) : null,
    operation_marker: targetSessionOperationMarker(jobId),
  };
}

module.exports = {
  buildManagedAgentApprovalPlan,
  buildStructuredAgentApprovalContext,
  buildTargetSessionApprovalPlan,
  managedAgentTarget,
  profileForSessionType,
  profileForTargetSession,
  targetSessionOperationMarker,
};
