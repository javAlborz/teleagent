'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { clearImmediate, setImmediate } = require('node:timers');
const { extractVoiceLine } = require('./conversation-loop');
const {
  buildApprovalSummary,
  classifyVoiceOperation,
} = require('../../lib/voice-operation-risk');
const {
  hashApprovalPlan,
} = require('../../lib/voice-approval-capability');
const {
  buildManagedAgentApprovalPlan,
  buildTargetSessionApprovalPlan,
  managedAgentTarget,
  profileForTargetSession,
} = require('../../lib/voice-authorization-plan');
const {
  PRIVILEGED_ACTION_PROFILE,
  PRIVILEGED_ACTION_PROVIDER,
  buildPrivilegedActionApprovalPlan,
  buildPrivilegedActionPlan,
  canonicalPrivilegedActionJson,
  privilegedActionApprovalText,
  privilegedActionRequestHash,
} = require('../../lib/privileged-action-plan');

const PROFILE_DEFINITIONS = Object.freeze({
  'claude-haiku': {
    provider: 'claude',
    sessionType: 'phone-haiku',
    timeoutSeconds: 600,
    routingTier: 'read',
  },
  'claude-sonnet': {
    provider: 'claude',
    sessionType: 'phone-sonnet',
    timeoutSeconds: 1800,
    routingTier: 'write',
  },
  'claude-opus': {
    provider: 'claude',
    sessionType: 'phone-opus',
    timeoutSeconds: 3600,
    routingTier: 'admin',
  },
  'codex-luna': {
    provider: 'codex',
    sessionType: 'phone-codex-luna',
    timeoutSeconds: 600,
    routingTier: 'read',
  },
  'codex-terra': {
    provider: 'codex',
    sessionType: 'phone-codex-terra',
    timeoutSeconds: 1800,
    routingTier: 'write',
  },
  'codex-sol': {
    provider: 'codex',
    sessionType: 'phone-codex-sol',
    timeoutSeconds: 3600,
    routingTier: 'admin',
  },
});

const PROFILE_ALIASES = Object.freeze({
  haiku: 'claude-haiku',
  sonnet: 'claude-sonnet',
  opus: 'claude-opus',
  luna: 'codex-luna',
  terra: 'codex-terra',
  sol: 'codex-sol',
  'phone-haiku': 'claude-haiku',
  'phone-sonnet': 'claude-sonnet',
  'phone-opus': 'claude-opus',
  'phone-codex-luna': 'codex-luna',
  'phone-codex-terra': 'codex-terra',
  'phone-codex-sol': 'codex-sol',
});

const CAPABILITY_RANK = Object.freeze({ read: 1, write: 2, admin: 3 });
const TARGETED_SESSION_REQUEST = /(?:\b(?:send|deliver|type|paste|forward)\b.{0,100}\b(?:message|prompt|request)\b.{0,140}\b(?:tmux|pane|window|existing\s+(?:codex|claude)|same\s+(?:session|thread))\b|\b(?:tell|ask|direct|instruct)\b.{0,80}\b(?:existing|current|running|tmux-attached)\s+(?:codex|claude|agent|session|pane)\b|\b(?:continue|resume)\b.{0,80}\b(?:same|existing|current|tmux)\s+(?:session|thread|pane)\b)/i;

function normalizeProfile(profile, fallback = 'codex-terra') {
  const value = String(profile || fallback).trim().toLowerCase();
  const normalized = PROFILE_ALIASES[value] || value;
  return PROFILE_DEFINITIONS[normalized] ? normalized : null;
}

function needsApproval(request) {
  return classifyVoiceOperation(request).requiresApproval;
}

function refersToTargetedSession(request) {
  return TARGETED_SESSION_REQUEST.test(String(request || '').replaceAll(/\s+/g, ' '));
}

function profileCan(profile, capability) {
  const definition = PROFILE_DEFINITIONS[profile];
  return Boolean(definition && CAPABILITY_RANK[definition.routingTier] >= CAPABILITY_RANK[capability]);
}

function routedProfile({ requestedProfile, selectedProfile, request, capability }) {
  const explicitValue = String(requestedProfile || '').trim().toLowerCase();
  if (explicitValue && explicitValue !== 'auto') {
    const explicit = normalizeProfile(explicitValue, selectedProfile);
    return { profile: explicit, explicit: true };
  }

  const modelMention = String(request || '').match(/\b(?:claude\s+)?(haiku|sonnet|opus)|\bcodex\s+(luna|terra|sol)\b/i);
  if (modelMention) {
    const alias = (modelMention[1] || modelMention[2]).toLowerCase();
    return { profile: normalizeProfile(alias, selectedProfile), explicit: true };
  }

  const provider = String(selectedProfile || '').startsWith('claude-') ? 'claude' : 'codex';
  const complex = /\b(?:architecture|complex|deep|multi[- ]repo|refactor|security review|root cause)\b/i.test(String(request || ''));
  const tier = capability === 'admin' || complex
    ? 'admin'
    : (capability === 'write' ? 'write' : 'read');
  const profiles = provider === 'claude'
    ? { read: 'claude-haiku', write: 'claude-sonnet', admin: 'claude-opus' }
    : { read: 'codex-luna', write: 'codex-terra', admin: 'codex-sol' };
  return { profile: profiles[tier], explicit: false };
}

function clip(text, max = 240) {
  const value = String(text || '').replaceAll(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function privilegedOutputMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const sha256 = typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256)
    ? value.sha256.toLowerCase()
    : null;
  return {
    bytes: safeCount(value.bytes),
    captured_bytes: safeCount(value.captured_bytes),
    truncated: Boolean(value.truncated),
    redacted: Boolean(value.redacted),
    sha256,
  };
}

function privilegedExecutionMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    exit_code: Number.isSafeInteger(value.exit_code) ? value.exit_code : null,
    signal: typeof value.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(value.signal)
      ? value.signal
      : null,
    timed_out: Boolean(value.timed_out),
    aborted: Boolean(value.aborted),
    duration_ms: safeCount(value.duration_ms),
    stdout: privilegedOutputMetadata(value.stdout),
    stderr: privilegedOutputMetadata(value.stderr),
  };
}

function safePrivilegedResult(result, expected) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    success: Boolean(value.success),
    outcome_unknown: Boolean(value.outcome_unknown),
    cancellation_requested: Boolean(value.cancellation_requested),
    main_execution_succeeded: Boolean(value.main_execution_succeeded),
    argv_sha256: typeof value.argv_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.argv_sha256)
      ? value.argv_sha256.toLowerCase()
      : null,
    execution: privilegedExecutionMetadata(value.execution),
    observable: privilegedExecutionMetadata(value.observable),
    expected,
  };
}

function capitalize(value) {
  const text = String(value || '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function targetConversationLabel(operation = {}, provider = null) {
  const resolvedProvider = capitalize(provider || operation.provider || 'agent');
  const session = String(operation.displayTarget || operation.canonicalTarget || '')
    .split(':', 1)[0] || null;
  if (operation.conversationName && session) {
    return `${resolvedProvider} window ${operation.conversationName} in tmux ${session}`;
  }
  return `${resolvedProvider} at ${operation.displayTarget || operation.canonicalTarget || operation.target || 'the selected tmux pane'}`;
}

function targetedApprovalText(prepared, message) {
  const operation = {
    provider: prepared.provider,
    conversationName: prepared.conversation_name || null,
    displayTarget: prepared.named_target || prepared.target,
    canonicalTarget: prepared.target,
  };
  const label = targetConversationLabel(operation, prepared.provider);
  const spokenMessage = clip(message, 180);
  return {
    summary: `Send to ${label}: ${clip(message, 260)}`,
    spoken: `Approval needed. Send “${spokenMessage}” to ${label}. Press pound to approve or star to cancel.`,
  };
}

function voiceSafeJob(job) {
  if (!job) return null;
  return {
    job_id: job.id,
    job_kind: job.jobKind || 'managed_agent',
    profile: job.profile,
    status: job.status,
    request: clip(job.request, 160),
    result: job.voice_result || null,
    error: job.error ? clip(job.error, 180) : null,
    requires_confirmation: Boolean(job.requiresApproval && job.status === 'awaiting_approval'),
    risk: job.risk_level || 'read_only',
    approval_summary: job.approval_summary || null,
    created_at: job.created_at,
    completed_at: job.completed_at || null,
    notification_status: job.notification_status || 'pending',
    executor_task_id: job.executor_task_id || null,
    target: ['tmux_agent_message', 'privileged_action'].includes(job.jobKind)
      ? (job.operation?.displayTarget || job.operation?.canonicalTarget || job.operation?.target || null)
      : null,
    stable_target: job.jobKind === 'tmux_agent_message' ? (job.operation?.target || null) : null,
    conversation_name: job.jobKind === 'tmux_agent_message' ? (job.operation?.conversationName || null) : null,
    spoken_approval_prompt: ['tmux_agent_message', 'privileged_action'].includes(job.jobKind)
      ? (job.operation?.spokenApprovalPrompt || null)
      : null,
    approval_armed: Boolean(job.approval_armed_at),
  };
}

class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}

class AgentJobBroker extends EventEmitter {
  constructor({
    stateStore,
    agentBridge,
    callbackDispatcher = null,
    executionControl = null,
    approvalCapabilityIssuer = null,
    privilegedActionBridge = null,
    outboundControl = null,
    approvalTtlSeconds = 300,
    reconciliationBaseDelayMs = process.env.VOICE_JOB_RECONCILIATION_BASE_MS || 250,
    reconciliationMaxDelayMs = process.env.VOICE_JOB_RECONCILIATION_MAX_MS || 30000,
    reconciliationPollWindowMs = process.env.VOICE_JOB_RECONCILIATION_POLL_MS || 2000,
    callbackRetryBaseMs = process.env.VOICE_CALLBACK_RETRY_BASE_MS || 1000,
    callbackRetryMaxMs = process.env.VOICE_CALLBACK_RETRY_MAX_MS || 300000,
    callbackLeaseMs = process.env.VOICE_CALLBACK_LEASE_MS || 30000,
  } = {}) {
    super();
    if (!stateStore) throw new Error('AgentJobBroker requires stateStore');
    if (!agentBridge) throw new Error('AgentJobBroker requires agentBridge');
    this.stateStore = stateStore;
    this.agentBridge = agentBridge;
    this.callbackDispatcher = callbackDispatcher;
    this.executionControl = executionControl;
    this.approvalCapabilityIssuer = approvalCapabilityIssuer;
    this.privilegedActionBridge = privilegedActionBridge;
    this.outboundControl = outboundControl;
    this.workspaceMutex = new AsyncMutex();
    this.activeExecutions = new Map();
    this.executionImmediates = new Map();
    this.reconciliationTimers = new Map();
    this.callbackDeliveries = new Map();
    this.callbackWorkerId = `voice-callback-${crypto.randomUUID()}`;
    this.callbackRetryTimer = null;
    this.callbackRetryDueAt = null;
    this.panicRetryTimer = null;
    this.panicRetryAttempts = 0;
    this.closed = false;
    const persistedLock = executionControl?.getStatus?.() || { locked: false };
    this.executionLocked = Boolean(persistedLock.locked);
    this.executionLockReason = persistedLock.locked ? persistedLock.reason : null;
    this.approvalTtlMs = Math.max(
      30000,
      Math.min((Number.parseInt(approvalTtlSeconds, 10) || 300) * 1000, 15 * 60000)
    );
    this.reconciliationBaseDelayMs = Math.max(
      10,
      Math.min(Number.parseInt(reconciliationBaseDelayMs, 10) || 250, 5000)
    );
    this.reconciliationMaxDelayMs = Math.max(
      this.reconciliationBaseDelayMs,
      Math.min(Number.parseInt(reconciliationMaxDelayMs, 10) || 30000, 5 * 60000)
    );
    this.reconciliationPollWindowMs = Math.max(
      100,
      Math.min(Number.parseInt(reconciliationPollWindowMs, 10) || 2000, 30000)
    );
    this.callbackRetryBaseMs = Math.max(
      10,
      Math.min(Number.parseInt(callbackRetryBaseMs, 10) || 1000, 30000)
    );
    this.callbackRetryMaxMs = Math.max(
      this.callbackRetryBaseMs,
      Math.min(Number.parseInt(callbackRetryMaxMs, 10) || 300000, 15 * 60000)
    );
    this.callbackLeaseMs = Math.max(
      1000,
      Math.min(Number.parseInt(callbackLeaseMs, 10) || 30000, 5 * 60000)
    );
  }

  _buildCapabilityAuthorization(job, { plan, target }) {
    if (!job?.requiresApproval) return null;
    if (job.status !== 'running' || !job.approved_at) {
      throw Object.assign(new Error('The approved job is not in an executable state.'), {
        code: 'APPROVAL_STATE_INVALID',
      });
    }
    const approvedAt = Date.parse(job.approved_at);
    if (!Number.isFinite(approvedAt)
      || approvedAt > Date.now() + 5000
      || Date.now() - approvedAt > this.approvalTtlMs) {
      throw Object.assign(new Error('The approval expired before execution could begin.'), {
        code: 'APPROVAL_EXPIRED',
        userMessage: 'That approval expired before execution began. Please ask for the operation again.',
      });
    }
    if (!this.approvalCapabilityIssuer?.issue) {
      throw Object.assign(new Error('Signed approval capability issuance is unavailable.'), {
        code: 'APPROVAL_CAPABILITY_UNAVAILABLE',
      });
    }
    const capability = this.approvalCapabilityIssuer.issue({
      jobId: job.id,
      requestHash: job.request_hash,
      planHash: hashApprovalPlan(plan),
      target,
      provider: job.provider,
      profile: job.profile,
    });
    return {
      capability,
      scope: job.approval_summary || job.request,
      method: job.approval_method || 'dtmf-pound',
      approved_at: job.approved_at,
    };
  }

  _approvalCapabilityUnavailable() {
    return {
      accepted: false,
      code: 'APPROVAL_CAPABILITY_UNAVAILABLE',
      message: 'Production phone authority is read-only. Mutating and privileged work is unavailable.',
    };
  }

  _emitSafely(eventName, payload) {
    for (const listener of this.rawListeners(eventName)) {
      try {
        const result = listener.call(this, payload);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => this._reportListenerError(eventName, error));
        }
      } catch (error) {
        this._reportListenerError(eventName, error);
      }
    }
  }

  _reportListenerError(eventName, error) {
    try {
      super.emit('listener.error', { eventName, error });
    } catch {
      // Observer failures must never change durable job state.
    }
  }

  listProfiles() {
    return Object.keys(PROFILE_DEFINITIONS);
  }

  listProfileDetails() {
    return Object.entries(PROFILE_DEFINITIONS).map(([profile, definition]) => ({
      profile,
      provider: definition.provider,
      capability: 'read_only',
      authority: 'read_only',
      timeout_seconds: definition.timeoutSeconds,
    }));
  }

  _expireApprovals(voiceThreadId) {
    const expired = this.stateStore.expireAwaitingApprovals({
      threadId: voiceThreadId,
      maxAgeMs: this.approvalTtlMs,
    });
    for (const job of expired) {
      this._emitSafely('job.updated', job);
    }
    return expired;
  }

  async startAgentTask({
    voiceThreadId,
    realtimeSessionId,
    toolCallId,
    profile,
    request,
    freshSession = false,
    notificationMode = 'in_call',
  }) {
    if (this.getExecutionLock().locked) {
      return {
        accepted: false,
        code: 'VOICE_EXECUTION_LOCKED',
        message: 'Voice-started agent work is locked after an emergency stop. An operator must unlock it locally.',
      };
    }

    const thread = this.stateStore.getThread(voiceThreadId);
    if (!thread) {
      return { accepted: false, code: 'VOICE_THREAD_NOT_FOUND', message: 'The voice thread no longer exists.' };
    }
    this._expireApprovals(voiceThreadId);

    const normalizedRequest = String(request || '').trim();
    if (!normalizedRequest) {
      return { accepted: false, code: 'EMPTY_AGENT_REQUEST', message: 'Tell me what the agent should do.' };
    }

    if (refersToTargetedSession(normalizedRequest)) {
      return {
        accepted: false,
        code: 'TARGETED_SESSION_REQUIRED',
        message: 'Delivery to an existing tmux conversation is unavailable from production phone. Use bounded session inspection when a read-only answer is sufficient.',
      };
    }

    const classification = classifyVoiceOperation(normalizedRequest);
    const routing = routedProfile({
      requestedProfile: profile,
      selectedProfile: thread.selected_profile,
      request: normalizedRequest,
      capability: classification.capability,
    });
    const normalizedProfile = routing.profile;
    if (!normalizedProfile) {
      return {
        accepted: false,
        code: 'UNKNOWN_AGENT_PROFILE',
        message: `Choose one of: ${this.listProfiles().join(', ')}.`,
      };
    }

    if (classification.requiresApproval && !this.approvalCapabilityIssuer?.issue) {
      return this._approvalCapabilityUnavailable();
    }

    if (!profileCan(normalizedProfile, classification.capability)) {
      const suggested = routedProfile({
        requestedProfile: 'auto',
        selectedProfile: normalizedProfile,
        request: normalizedRequest,
        capability: classification.capability,
      }).profile;
      return {
        accepted: false,
        code: 'AGENT_PROFILE_CAPABILITY_REQUIRED',
        message: `The selected profile cannot satisfy this dormant classified test request. Use ${suggested}.`,
        suggested_profile: suggested,
        risk: classification.level,
      };
    }

    const safeNotificationMode = ['in_call', 'callback', 'resume'].includes(notificationMode)
      ? notificationMode
      : 'in_call';
    const definition = PROFILE_DEFINITIONS[normalizedProfile];
    const requiresApproval = classification.requiresApproval;
    const approvalSummary = requiresApproval
      ? buildApprovalSummary({ profile: normalizedProfile, request: normalizedRequest, classification })
      : null;
    const spokenApprovalPrompt = requiresApproval
      ? `Approval needed for ${normalizedProfile}: ${clip(normalizedRequest, 180)} Press pound to approve or star to cancel.`
      : null;
    const result = this.stateStore.createJob({
      voiceThreadId,
      realtimeSessionId,
      toolCallId,
      profile: normalizedProfile,
      provider: definition.provider,
      request: normalizedRequest,
      freshSession: Boolean(freshSession),
      requiresApproval,
      notificationMode: safeNotificationMode,
      riskLevel: classification.level,
      riskReasons: classification.reasons,
      requestHash: classification.requestHash,
      approvalSummary,
      jobKind: 'managed_agent',
      operation: requiresApproval ? { spokenApprovalPrompt } : null,
      approvalPrompt: spokenApprovalPrompt,
      auditAction: requiresApproval ? 'approval_requested' : 'job_queued',
      auditMetadata: {
        routing: routing.explicit ? 'explicit' : 'automatic',
        reasons: classification.reasons,
      },
      event: {
        role: 'user',
        kind: 'agent_request',
        content: `${normalizedProfile}: ${normalizedRequest}`,
      },
    });

    if (result.duplicate) {
      return {
        accepted: true,
        duplicate: true,
        ...voiceSafeJob(result.job),
      };
    }

    if (result.busy) {
      return {
        accepted: false,
        code: 'AGENT_PROFILE_BUSY',
        message: `${normalizedProfile} already has an active task. Check or cancel that job first.`,
        active_job: voiceSafeJob(result.job),
      };
    }

    if (result.approvalBusy) {
      return {
        accepted: false,
        code: 'APPROVAL_ALREADY_FOCUSED',
        message: 'Another operation is already waiting for pound or star. Approve or cancel it first.',
        active_job: voiceSafeJob(result.job),
      };
    }

    this.stateStore.setSelectedProfile(voiceThreadId, normalizedProfile);

    if (!requiresApproval) {
      this._scheduleExecution(result.job.id);
    }

    return {
      accepted: true,
      ...voiceSafeJob(result.job),
      confirmation_instruction: requiresApproval
        ? `Say exactly: ${JSON.stringify(spokenApprovalPrompt)}`
        : null,
      spoken_approval_prompt: spokenApprovalPrompt,
      risk: classification.level,
      routed_profile: normalizedProfile,
      routing: routing.explicit ? 'explicit' : 'automatic',
      response_behavior: requiresApproval ? 'approval_prompt' : 'earcon_then_quiet',
    };
  }

  async startTargetedSessionTask({
    voiceThreadId,
    realtimeSessionId,
    toolCallId,
    target,
    message,
    notificationMode = 'in_call',
  }) {
    if (this.getExecutionLock().locked) {
      return {
        accepted: false,
        code: 'VOICE_EXECUTION_LOCKED',
        message: 'Voice-started agent work is locked after an emergency stop. An operator must unlock it locally.',
      };
    }
    const thread = this.stateStore.getThread(voiceThreadId);
    if (!thread) {
      return { accepted: false, code: 'VOICE_THREAD_NOT_FOUND', message: 'The voice thread no longer exists.' };
    }
    this._expireApprovals(voiceThreadId);
    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
      return { accepted: false, code: 'EMPTY_AGENT_REQUEST', message: 'Tell me exactly what to send.' };
    }
    if (normalizedMessage.includes('\0') || normalizedMessage.length > 4000) {
      return {
        accepted: false,
        code: 'INVALID_TARGET_MESSAGE',
        message: 'The exact message must be plain text no longer than 4,000 characters.',
      };
    }
    if (!this.approvalCapabilityIssuer?.issue) {
      return this._approvalCapabilityUnavailable();
    }

    const preparedResponse = await this.agentBridge.prepareAgentSessionMessage(target);
    if (!preparedResponse?.success || !preparedResponse.result) {
      return {
        accepted: false,
        code: preparedResponse?.code || 'TARGET_SESSION_PREPARE_FAILED',
        message: preparedResponse?.userMessage || preparedResponse?.error || 'The exact tmux-attached agent session could not be resolved.',
      };
    }
    const prepared = preparedResponse.result;
    if (!['codex', 'claude'].includes(prepared.provider) ||
        !prepared.target || !prepared.session_fingerprint) {
      return {
        accepted: false,
        code: 'TARGET_SESSION_BINDING_MISSING',
        message: 'The bridge did not return a complete target-session binding.',
      };
    }
    const baseClassification = classifyVoiceOperation(normalizedMessage);
    const classification = baseClassification.level === 'read_only'
      ? {
        ...baseClassification,
        level: 'mutating',
        capability: 'write',
        requiresApproval: true,
        reasons: ['message delivery to existing provider session'],
      }
      : { ...baseClassification, requiresApproval: true };
    const profile = profileForTargetSession(prepared.provider, normalizedMessage);
    const safeNotificationMode = ['in_call', 'callback', 'resume'].includes(notificationMode)
      ? notificationMode
      : 'in_call';
    const stableTarget = prepared.stable_target || prepared.target;
    const displayTarget = prepared.named_target || prepared.target;
    const approvalText = targetedApprovalText(prepared, normalizedMessage);
    const approvalSummary = approvalText.summary;
    const result = this.stateStore.createJob({
      voiceThreadId,
      realtimeSessionId,
      toolCallId,
      profile,
      provider: prepared.provider,
      request: normalizedMessage,
      jobKind: 'tmux_agent_message',
      operation: {
        target: stableTarget,
        canonicalTarget: prepared.target,
        displayTarget,
        requestedTarget: String(target || '').trim(),
        provider: prepared.provider,
        conversationName: prepared.conversation_name || null,
        spokenApprovalPrompt: approvalText.spoken,
        sessionFingerprint: prepared.session_fingerprint,
        timeoutSeconds: PROFILE_DEFINITIONS[profile].timeoutSeconds,
      },
      requiresApproval: true,
      notificationMode: safeNotificationMode,
      riskLevel: classification.level,
      riskReasons: classification.reasons,
      requestHash: classification.requestHash,
      approvalSummary,
      approvalPrompt: approvalText.spoken,
      auditAction: 'target_session_approval_requested',
      auditMetadata: {
        target: prepared.target,
        stable_target: stableTarget,
        display_target: displayTarget,
        conversation_name: prepared.conversation_name || null,
        provider: prepared.provider,
        resolution: prepared.resolution || null,
        reasons: classification.reasons,
      },
      event: {
        role: 'user',
        kind: 'agent_request',
        content: `${prepared.provider} ${prepared.target}: ${normalizedMessage}`,
      },
    });

    if (result.duplicate) return { accepted: true, duplicate: true, ...voiceSafeJob(result.job) };
    if (result.busy) {
      return {
        accepted: false,
        code: 'AGENT_PROFILE_BUSY',
        message: `${profile} already has an active task. Check or cancel that job first.`,
        active_job: voiceSafeJob(result.job),
      };
    }
    if (result.approvalBusy) {
      return {
        accepted: false,
        code: 'APPROVAL_ALREADY_FOCUSED',
        message: 'Another operation is already waiting for pound or star. Approve or cancel it first.',
        active_job: voiceSafeJob(result.job),
      };
    }

    return {
      accepted: true,
      ...voiceSafeJob(result.job),
      confirmation_instruction: `Say exactly: ${JSON.stringify(approvalText.spoken)}`,
      spoken_approval_prompt: approvalText.spoken,
      response_behavior: 'approval_prompt',
      delivery_guarantee: 'Completion is reported only after exact provider-log verification.',
    };
  }

  async startPrivilegedAction({
    voiceThreadId,
    realtimeSessionId,
    toolCallId,
    action,
    notificationMode = 'in_call',
  }) {
    if (this.getExecutionLock().locked) {
      return {
        accepted: false,
        code: 'VOICE_EXECUTION_LOCKED',
        message: 'Voice-started privileged work is locked after an emergency stop.',
      };
    }
    const thread = this.stateStore.getThread(voiceThreadId);
    const realtimeSession = this.stateStore.getRealtimeSession(realtimeSessionId);
    if (!thread || !realtimeSession || realtimeSession.voice_thread_id !== voiceThreadId) {
      return { accepted: false, code: 'VOICE_THREAD_NOT_FOUND', message: 'The voice call is no longer active.' };
    }
    this._expireApprovals(voiceThreadId);
    if (!this.approvalCapabilityIssuer?.issue || !this.privilegedActionBridge) {
      return {
        accepted: false,
        code: 'PRIVILEGED_ACTION_UNAVAILABLE',
        message: 'The separate privileged action broker is not configured; no root action was created.',
      };
    }
    let plan;
    let approvalText;
    try {
      plan = buildPrivilegedActionPlan(action);
      // This call enforces the no-truncation speech ceiling before a durable,
      // focused approval can exist.
      approvalText = privilegedActionApprovalText(plan);
    } catch (error) {
      return {
        accepted: false,
        code: error.code || 'PRIVILEGED_PLAN_INVALID',
        message: error.message,
      };
    }
    const safeNotificationMode = ['in_call', 'callback', 'resume'].includes(notificationMode)
      ? notificationMode
      : 'in_call';
    const callId = String(realtimeSession.call_id || realtimeSessionId);
    const result = this.stateStore.createJob({
      voiceThreadId,
      realtimeSessionId,
      toolCallId,
      profile: PRIVILEGED_ACTION_PROFILE,
      provider: PRIVILEGED_ACTION_PROVIDER,
      request: canonicalPrivilegedActionJson(plan),
      jobKind: 'privileged_action',
      operation: {
        actionPlan: plan,
        callId,
        target: plan.target,
        displayTarget: plan.target,
        spokenApprovalPrompt: approvalText.spoken,
      },
      requiresApproval: true,
      notificationMode: safeNotificationMode,
      riskLevel: plan.risk.level,
      riskReasons: [plan.impact_summary, 'separate root broker exact argv'],
      requestHash: privilegedActionRequestHash(plan),
      approvalSummary: approvalText.summary,
      approvalPrompt: approvalText.spoken,
      auditAction: 'privileged_action_approval_requested',
      auditMetadata: { adapter: plan.adapter, target: plan.target, method: plan.method },
      event: {
        role: 'user',
        kind: 'privileged_action_request',
        content: approvalText.summary,
      },
    });
    if (result.duplicate) return { accepted: true, duplicate: true, ...voiceSafeJob(result.job) };
    if (result.busy || result.approvalBusy) {
      return {
        accepted: false,
        code: result.approvalBusy ? 'APPROVAL_ALREADY_FOCUSED' : 'PRIVILEGED_ACTION_BUSY',
        message: 'Another focused or privileged operation must finish first.',
        active_job: voiceSafeJob(result.job),
      };
    }
    return {
      accepted: true,
      ...voiceSafeJob(result.job),
      confirmation_instruction: `Say exactly: ${JSON.stringify(approvalText.spoken)}`,
      spoken_approval_prompt: approvalText.spoken,
      response_behavior: 'approval_prompt',
      execution_boundary: 'separate_root_broker',
    };
  }

  getAgentTask(voiceThreadId, jobId) {
    const job = this.stateStore.getJob(jobId);
    if (!job || job.voice_thread_id !== voiceThreadId) {
      return { found: false, code: 'JOB_NOT_FOUND', message: 'I could not find that job in this voice thread.' };
    }
    return { found: true, job: voiceSafeJob(job) };
  }

  listAgentTasks(voiceThreadId, { activeOnly = false } = {}) {
    return {
      jobs: this.stateStore
        .listJobs(voiceThreadId, { limit: 10, activeOnly })
        .map(voiceSafeJob),
    };
  }

  listAgentSessions(voiceThreadId) {
    return {
      sessions: this.stateStore.listAgentSessions(voiceThreadId).map((session) => ({
        profile: session.profile,
        provider: session.provider,
        resumable: false,
        updated_at: session.updated_at,
        latest_job_id: session.latest_job_id || null,
        latest_job_status: session.latest_job_status || null,
        latest_result: session.latest_voice_result || null,
      })),
    };
  }

  async handoffAgentTask({
    voiceThreadId,
    realtimeSessionId,
    toolCallId,
    fromProfile,
    toProfile,
    objective,
    freshSession = false,
    notificationMode = 'in_call',
    additionalContext = null,
  }) {
    const source = normalizeProfile(fromProfile);
    const target = normalizeProfile(toProfile);
    if (!source || !target || source === target) {
      return {
        accepted: false,
        code: 'INVALID_HANDOFF',
        message: 'Choose two different valid source and target profiles.',
      };
    }
    const sourceSession = this.stateStore.getAgentSession(voiceThreadId, source);
    const sourceJobs = this.stateStore.listJobs(voiceThreadId, { limit: 50 })
      .filter((job) => job.profile === source)
      .slice(0, 4)
      .reverse();
    if (!sourceSession && sourceJobs.length === 0 && !additionalContext) {
      return {
        accepted: false,
        code: 'HANDOFF_SOURCE_EMPTY',
        message: `${source} has no managed session or completed work to hand off.`,
      };
    }
    const brief = sourceJobs.map((job) => (
      `- Request: ${clip(job.request, 500)}\n  Status: ${job.status}\n  Result: ${clip(job.voice_result || job.error || 'No result', 800)}`
    )).join('\n');
    const request = `[CROSS-AGENT HANDOFF]\n` +
      `Source profile: ${source}\n` +
      `Target profile: ${target}\n` +
      `Objective: ${String(objective || 'Review and continue the source work').slice(0, 1200)}\n` +
      `Source managed session exists: ${sourceSession ? 'yes' : 'no'}\n` +
      `${brief ? `Recent source work:\n${brief}\n` : ''}` +
      `${additionalContext ? `Additional sanitized context:\n${String(additionalContext).slice(0, 8000)}\n` : ''}` +
      `Treat this brief as an explicit handoff, not shared hidden context. Inspect the current workspace state and return read-only findings only.\n` +
      `[END CROSS-AGENT HANDOFF]`;
    return this.startAgentTask({
      voiceThreadId,
      realtimeSessionId,
      toolCallId,
      profile: target,
      request,
      freshSession,
      notificationMode,
    });
  }

  async cancelAgentTask(voiceThreadId, jobId = null, reason = 'Canceled by caller') {
    const job = jobId ? this.stateStore.getJob(jobId) : this.stateStore.getFocusedJob(voiceThreadId);
    if (!job || job.voice_thread_id !== voiceThreadId) {
      return { canceled: false, code: 'JOB_NOT_FOUND', message: 'There is no active job to cancel.' };
    }

    if (['completed', 'failed', 'canceled', 'outcome_unknown'].includes(job.status)) {
      return { canceled: false, code: 'JOB_ALREADY_FINISHED', job: voiceSafeJob(job) };
    }
    const cancellation = this.stateStore.requestJobCancellation(job.id, reason, {
      auditMetadata: { source: 'voice_cancel' },
    });
    const canceled = cancellation.job;
    if (cancellation.changed && !cancellation.terminal) {
      this._emitSafely('job.updated', canceled);
    }
    if (cancellation.terminal) return { canceled: true, job: voiceSafeJob(canceled) };

    const session = this.stateStore.getAgentSession(voiceThreadId, job.profile);
    let remote;
    try {
      remote = job.jobKind === 'privileged_action'
        ? await this.privilegedActionBridge.cancelByIdempotencyKey(job.id, job.id, { reason })
        : await this.agentBridge.cancelSession(job.id, {
          idempotencyKey: job.id,
          sessionKey: job.jobKind === 'tmux_agent_message'
            ? job.id
            : (job.bridge_session_key || session?.bridge_session_key || job.id),
          resetSession: false,
          reason,
        });
    } catch (error) {
      remote = { success: false, error: error.message };
    }
    const execution = this.activeExecutions.get(job.id);
    if (remote?.success && execution) {
      let timer = null;
      await Promise.race([
        execution.catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.min(1000, this.reconciliationPollWindowMs));
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      const reconciled = this.stateStore.getJob(job.id);
      if (reconciled?.status === 'completed') {
        return {
          canceled: false,
          code: 'JOB_ALREADY_COMPLETED',
          message: reconciled.voice_result || 'The operation completed before cancellation could take effect.',
          job: voiceSafeJob(reconciled),
        };
      }
      if (reconciled?.status === 'canceled') {
        return { canceled: true, job: voiceSafeJob(reconciled) };
      }
      if (reconciled?.status === 'failed') {
        return {
          canceled: false,
          code: 'JOB_FINISHED_DURING_CANCELLATION',
          message: reconciled.error || 'The operation finished while cancellation was being reconciled.',
          job: voiceSafeJob(reconciled),
        };
      }
    }
    const pending = this._deferReconciliation(this.stateStore.getJob(job.id), {
      error: remote?.success
        ? 'Cancellation accepted by the executor; terminal outcome is pending.'
        : `Remote cancellation is unconfirmed: ${remote?.error || 'bridge unavailable'}`,
      delayMs: this.reconciliationBaseDelayMs,
    });
    this._scheduleReconciliation(pending);
    return {
      canceled: false,
      code: 'CANCEL_RECONCILIATION_PENDING',
      message: remote?.success
        ? 'Cancellation was requested. Delivery status is still being reconciled; do not retry yet.'
        : 'I could not confirm remote cancellation yet. The job remains tracked and cancellation will be retried.',
      job: voiceSafeJob(pending),
    };
  }

  cancelPendingApprovals(
    voiceThreadId,
    reason = 'Approval canceled before execution',
    source = 'voice_cancel'
  ) {
    const canceled = this.stateStore.cancelAwaitingApprovalsForThread(voiceThreadId, reason, {
      auditAction: 'approval_canceled',
      auditMetadata: { source },
    });
    for (const job of canceled) {
      this._emitSafely('job.updated', job);
    }
    return { canceled: canceled.length > 0, jobs: canceled.map(voiceSafeJob) };
  }

  approveNextJob(voiceThreadId, context = {}) {
    if (this.getExecutionLock().locked) {
      return {
        approved: false,
        code: 'VOICE_EXECUTION_LOCKED',
        message: 'Voice-started agent work is locked after an emergency stop.',
      };
    }

    const expired = this._expireApprovals(voiceThreadId);
    if (expired.length > 0) {
      return {
        approved: false,
        code: 'APPROVAL_EXPIRED',
        message: 'The pending approval expired. Ask for the operation again to create a fresh scope.',
      };
    }

    const focused = this.stateStore.getFocusedJob(voiceThreadId);
    if (focused?.status === 'awaiting_approval' && !this.approvalCapabilityIssuer?.issue) {
      return {
        approved: false,
        ...this._approvalCapabilityUnavailable(),
      };
    }

    const approval = this.stateStore.approveFocusedJobCas(voiceThreadId, {
      method: 'dtmf-pound',
      decidedBy: 'caller',
      metadata: { source: 'sip_dtmf' },
      callId: context.callId,
      realtimeSessionId: context.realtimeSessionId,
    });
    const job = approval.job;
    if (!approval.changed || !job) {
      if (['approval_not_armed', 'approval_session_mismatch'].includes(approval.reason)) {
        return {
          approved: false,
          code: 'APPROVAL_PROMPT_NOT_HEARD',
          message: 'The exact approval prompt has not finished playing. Wait for it to finish, then press pound.',
          job: voiceSafeJob(job),
        };
      }
      return { approved: false, code: 'NO_PENDING_APPROVAL', message: 'There is no task waiting for confirmation.' };
    }
    this._scheduleExecution(job.id);
    return { approved: true, job: voiceSafeJob(job) };
  }

  armFocusedApproval(voiceThreadId, details = {}) {
    const result = this.stateStore.armFocusedApproval(voiceThreadId, details);
    if (!result.changed || !result.job) return result;
    this._emitSafely('job.updated', result.job);
    return result;
  }

  recordApprovalPromptFailure(voiceThreadId, {
    reason = 'approval_prompt_not_verifiable',
    responseId = null,
  } = {}) {
    const result = this.stateStore.noteApprovalPromptFailure(voiceThreadId, {
      maxAttempts: 3,
      reason,
      responseId,
    });
    if (!result.changed || !result.job) return result;
    if (!result.exhausted) return result;
    const canceled = this.stateStore.cancelJobCas(
      result.job.id,
      'Approval prompt could not be verified after three exact replay attempts; no execution occurred.'
    );
    if (canceled.changed) this._emitCanceled(canceled.job, 'approval_prompt_unverifiable');
    return { ...result, job: canceled.job, canceled: canceled.changed };
  }

  _scheduleExecution(jobId) {
    if (!this._isOperational()) return Promise.resolve(null);
    if (this.activeExecutions.has(jobId)) return this.activeExecutions.get(jobId);
    const promise = new Promise((resolve) => {
      const immediate = setImmediate(() => {
        this.executionImmediates.delete(jobId);
        resolve(this._isOperational());
      });
      this.executionImmediates.set(jobId, { immediate, resolve });
    })
      .then((operational) => operational ? this._execute(jobId) : null)
      .finally(() => {
        this.executionImmediates.delete(jobId);
        this.activeExecutions.delete(jobId);
      });
    this.activeExecutions.set(jobId, promise);
    return promise;
  }

  _isOperational() {
    return !this.closed && this.stateStore?.db?.open !== false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { immediate, resolve } of this.executionImmediates.values()) {
      clearImmediate(immediate);
      resolve(false);
    }
    this.executionImmediates.clear();
    for (const timer of this.reconciliationTimers.values()) clearTimeout(timer);
    this.reconciliationTimers.clear();
    if (this.panicRetryTimer) clearTimeout(this.panicRetryTimer);
    this.panicRetryTimer = null;
    if (this.callbackRetryTimer) clearTimeout(this.callbackRetryTimer);
    this.callbackRetryTimer = null;
    this.callbackRetryDueAt = null;
  }

  async shutdown({ timeoutMs = 5000 } = {}) {
    this.close();
    const active = [
      ...this.activeExecutions.values(),
      ...this.callbackDeliveries.values(),
    ];
    if (active.length === 0) {
      return { drained: true, safeToClose: true, activeCount: 0 };
    }
    const boundedMs = Math.max(10, Math.min(Number(timeoutMs) || 5000, 60000));
    let timer = null;
    const settled = await Promise.race([
      Promise.allSettled(active).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), boundedMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    const activeCount = this.activeExecutions.size + this.callbackDeliveries.size;
    return {
      drained: settled === true && activeCount === 0,
      safeToClose: settled === true && activeCount === 0,
      activeCount,
    };
  }

  recoverDurableJobs() {
    if (!this._isOperational()) return 0;
    this._expireApprovals(null);
    if (!this.approvalCapabilityIssuer?.issue) {
      const canceled = this.stateStore.cancelAllAwaitingApprovals(
        'Production phone approval authority is disabled; the legacy approval was canceled before replay or execution.',
        {
          auditAction: 'approval_authority_retired',
          auditMetadata: { source: 'startup_recovery' },
        }
      );
      for (const job of canceled) this._emitSafely('job.updated', job);
    }
    this._drainPendingCallbacks();
    const lock = this.getExecutionLock();
    const recoverable = this.stateStore.listRecoverableJobs();
    if (lock.locked) {
      if (lock.remotePanicPending) this._scheduleRemotePanicRetry();
      for (const job of recoverable) {
        if (job.status !== 'queued') this._scheduleReconciliation(job);
      }
      return recoverable.filter((job) => job.status !== 'queued').length;
    }
    for (const job of recoverable) {
      if (job.status === 'queued') this._scheduleExecution(job.id);
      else this._scheduleReconciliation(job);
    }
    return recoverable.length;
  }

  _reconciliationDelay(job, requestedDelay = null) {
    if (Number.isFinite(requestedDelay) && requestedDelay >= 0) {
      return Math.max(10, Math.min(requestedDelay, this.reconciliationMaxDelayMs));
    }
    const attempts = Math.max(0, Number.parseInt(job?.reconcile_attempts, 10) || 0);
    return Math.min(
      this.reconciliationBaseDelayMs * (2 ** Math.min(attempts, 12)),
      this.reconciliationMaxDelayMs
    );
  }

  _deferReconciliation(job, { error, task = null, delayMs = null } = {}) {
    if (!job) return null;
    const deferred = this.stateStore.deferJobReconciliation({
      jobId: job.id,
      error,
      executorTaskId: task?.id || job.executor_task_id || null,
      delayMs: this._reconciliationDelay(job, delayMs),
    });
    if (deferred.changed) this._emitSafely('job.updated', deferred.job);
    return deferred.job;
  }

  _scheduleReconciliation(job) {
    if (!job || !['reconciling', 'cancel_requested'].includes(job.status)) return null;
    if (this.reconciliationTimers.has(job.id)) return this.reconciliationTimers.get(job.id);
    const reconcileAt = Date.parse(job.reconcile_after || '');
    const delayMs = Number.isFinite(reconcileAt)
      ? Math.max(10, Math.min(reconcileAt - Date.now(), this.reconciliationMaxDelayMs))
      : this._reconciliationDelay(job);
    const timer = setTimeout(() => {
      this.reconciliationTimers.delete(job.id);
      this._scheduleExecution(job.id);
    }, delayMs);
    timer.unref?.();
    this.reconciliationTimers.set(job.id, timer);
    return timer;
  }

  async _resumeExistingDurableTask(job, { interrupted = false, timeoutSeconds = null } = {}) {
    if (typeof this.agentBridge.getExecutorTaskByIdempotency !== 'function' ||
        typeof this.agentBridge.waitForExecutorTask !== 'function') {
      if (interrupted) {
        throw Object.assign(new Error('Durable executor recovery helpers are unavailable.'), {
          code: 'EXECUTOR_RECONCILIATION_UNAVAILABLE',
        });
      }
      return { found: false, result: null };
    }

    let existing;
    try {
      existing = await this.agentBridge.getExecutorTaskByIdempotency(job.id, {
        timeoutMs: 5000,
      });
    } catch (error) {
      if (!interrupted) return { found: false, result: null };
      throw Object.assign(
        new Error('The durable executor could not be reconciled after restart.'),
        {
          code: 'EXECUTOR_RECONCILIATION_UNAVAILABLE',
          userMessage: 'I could not safely determine whether that task already started, so I did not run it again.',
          cause: error,
        }
      );
    }

    if (!existing) return { found: false, result: null };
    this.stateStore.recordExecutorTask(job.id, existing);
    return {
      found: true,
      task: existing,
      result: await this.agentBridge.waitForExecutorTask(existing, { timeoutSeconds }),
    };
  }

  async _reconcileDurableJob(job) {
    if (!job || !['reconciling', 'cancel_requested'].includes(job.status)) return job;
    const isTarget = job.jobKind === 'tmux_agent_message';
    let existing;
    try {
      if (typeof this.agentBridge.getExecutorTaskByIdempotency !== 'function') {
        throw new Error('Durable executor lookup is unavailable.');
      }
      existing = await this.agentBridge.getExecutorTaskByIdempotency(job.id, { timeoutMs: 5000 });
    } catch (error) {
      const deferred = this._deferReconciliation(job, {
        error: `Durable executor lookup is pending: ${error.message}`,
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }

    if (!existing) {
      if (isTarget) {
        const unknown = this.stateStore.markJobOutcomeUnknown(
          job.id,
          'The voice service restarted before target-session delivery could be verified. The message was not resent.'
        );
        if (unknown.changed) this._emitTerminalOutcomeUnknown(unknown.job);
        return unknown.job;
      }
      if (job.status === 'cancel_requested') {
        const canceled = this.stateStore.cancelJobCas(job.id, job.error || 'Canceled by caller');
        if (canceled.changed) this._emitCanceled(canceled.job, 'executor_task_absent');
        return canceled.job;
      }
      // A managed job can crash after its local running transition but before
      // the executor accepted it. The original idempotency key makes this one
      // safe resubmission point.
      const rebound = this._ensureManagedJobBinding(job);
      const running = this.stateStore.markJobRunningAfterReconciliation?.(job.id) || null;
      const runnable = running || rebound.job || job;
      return this._submitManagedJob(runnable, { recoveredWithoutTask: true });
    }

    this.stateStore.recordExecutorTask(job.id, existing);
    if (!isTarget) this._adoptManagedTaskBinding(job, existing);
    if (job.status === 'cancel_requested') {
      const session = this.stateStore.getAgentSession(job.voice_thread_id, job.profile);
      let remote;
      try {
        remote = await this.agentBridge.cancelSession(job.id, {
          idempotencyKey: job.id,
          sessionKey: isTarget ? job.id : (job.bridge_session_key || session?.bridge_session_key || job.id),
          resetSession: false,
          reason: job.error || 'cancel_requested',
        });
      } catch (error) {
        remote = { success: false, error: error.message };
      }
      if (!remote?.success) {
        const deferred = this._deferReconciliation(job, {
          error: `Remote cancellation is still unconfirmed: ${remote?.error || 'bridge unavailable'}`,
          task: existing,
        });
        this._scheduleReconciliation(deferred);
        return deferred;
      }
    }

    const task = existing;
    if (!task.terminal) {
      try {
        const result = await this.agentBridge.waitForExecutorTask(task, {
          timeoutMs: this.reconciliationPollWindowMs,
          pollIntervalMs: Math.min(250, this.reconciliationPollWindowMs),
        });
        if (!result?.success && result?.agentCode === 'AGENT_TIMEOUT') {
          const deferred = this._deferReconciliation(job, {
            error: job.status === 'cancel_requested'
              ? 'Cancellation is accepted; waiting for executor terminal state.'
              : 'The executor task is still running; reconciliation will continue.',
            task,
          });
          this._scheduleReconciliation(deferred);
          return deferred;
        }
        return isTarget
          ? this._finalizeTargetResult(job, result)
          : this._finalizeManagedResult(job, result);
      } catch (error) {
        const deferred = this._deferReconciliation(job, {
          error: `Durable result polling is pending: ${error.message}`,
          task,
        });
        this._scheduleReconciliation(deferred);
        return deferred;
      }
    }

    try {
      const result = await this.agentBridge.waitForExecutorTask(task, { timeoutMs: 1000 });
      return isTarget
        ? this._finalizeTargetResult(job, result)
        : this._finalizeManagedResult(job, result);
    } catch (error) {
      const deferred = this._deferReconciliation(job, {
        error: `Terminal executor result retrieval is pending: ${error.message}`,
        task,
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
  }

  async _reconcilePrivilegedJob(job) {
    if (!job || !['reconciling', 'cancel_requested'].includes(job.status)) return job;
    if (!this.privilegedActionBridge) {
      const deferred = this._deferReconciliation(job, {
        error: 'The private root-broker client is not configured. The privileged action was not resent; GET-only reconciliation will resume after configuration is repaired.',
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
    let action;
    try {
      action = await this.privilegedActionBridge.getByIdempotencyKey(job.id, {
        timeoutMs: 5000,
        notFoundIsNull: true,
        expected: {
          idempotencyKey: job.id,
          jobId: job.id,
          callId: job.operation?.callId,
          plan: job.operation?.actionPlan,
        },
      });
    } catch (error) {
      const deferred = this._deferReconciliation(job, {
        error: `Privileged action lookup is pending: ${error.message}`,
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
    if (!action) {
      if (job.status === 'cancel_requested') {
        try {
          await this.privilegedActionBridge.cancelByIdempotencyKey(job.id, job.id, {
            reason: job.error || 'cancel_requested',
          });
          const canceled = this.stateStore.cancelJobCas(job.id, job.error || 'Canceled before root-broker submission');
          if (canceled.changed) this._emitCanceled(canceled.job, 'privileged_cancel_tombstone');
          return canceled.job;
        } catch (error) {
          const deferred = this._deferReconciliation(job, {
            error: `Privileged cancellation reservation is pending: ${error.message}`,
          });
          this._scheduleReconciliation(deferred);
          return deferred;
        }
      }
      const deferred = this._deferReconciliation(job, {
        error: 'No durable root-broker action is visible yet. The signed capability was not resent; GET-only reconciliation will continue.',
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
    this.stateStore.recordExecutorTask(job.id, { id: action.id });
    if (job.status === 'cancel_requested' && !action.terminal) {
      try {
        await this.privilegedActionBridge.cancelByIdempotencyKey(job.id, job.id, {
          reason: job.error || 'cancel_requested',
        });
      } catch (error) {
        const deferred = this._deferReconciliation(job, {
          error: `Privileged cancellation is pending: ${error.message}`,
          task: { id: action.id },
        });
        this._scheduleReconciliation(deferred);
        return deferred;
      }
    }
    if (!action.terminal) {
      try {
        action = await this.privilegedActionBridge.wait(action.id, {
          timeoutSeconds: Math.max(1, Math.ceil(this.reconciliationPollWindowMs / 1000)),
        });
      } catch {
        const deferred = this._deferReconciliation(job, {
          error: 'The root-broker action remains durable and is still being reconciled.',
          task: { id: action.id },
        });
        this._scheduleReconciliation(deferred);
        return deferred;
      }
    }
    return this._finalizePrivilegedAction(job, action);
  }

  async _execute(jobId) {
    const queuedJob = this.stateStore.getJob(jobId);
    if (!queuedJob) return null;
    if (['reconciling', 'cancel_requested'].includes(queuedJob.status)) {
      return queuedJob.jobKind === 'privileged_action'
        ? this._reconcilePrivilegedJob(queuedJob)
        : this._reconcileDurableJob(queuedJob);
    }
    if (this.getExecutionLock().locked) return queuedJob;
    if (queuedJob.status !== 'queued') return queuedJob;
    if (queuedJob.started_at) {
      const deferred = this._deferReconciliation(queuedJob, {
        error: 'An interrupted executor task must be reconciled before any resubmission.',
        delayMs: 10,
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }

    const run = () => {
      if (queuedJob.jobKind === 'tmux_agent_message') {
        return this._runTargetSessionMessage(queuedJob);
      }
      if (queuedJob.jobKind === 'privileged_action') {
        return this._runPrivilegedAction(queuedJob);
      }
      return this._runAgent(queuedJob);
    };
    return queuedJob.requiresApproval
      ? this.workspaceMutex.run(run)
      : run();
  }

  _ensureManagedJobBinding(job) {
    const definition = PROFILE_DEFINITIONS[job.profile];
    const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    return this.stateStore.bindJobAgentSession({
      jobId: job.id,
      provider: definition.provider,
      bridgeSessionKey: `${job.voice_thread_id}:${job.profile}:${nonce}`,
    });
  }

  _adoptManagedTaskBinding(job, task) {
    const ask = task?.request?.ask || task?.request || {};
    const bridgeSessionKey = ask.sessionKey || job.bridge_session_key || null;
    if (!bridgeSessionKey) return null;
    return this.stateStore.adoptExecutorJobBinding({
      jobId: job.id,
      bridgeSessionKey,
      provider: job.provider,
    });
  }

  _isCanceledResult(result) {
    return result?.agentCode === 'AGENT_CANCELED' ||
      ['CLAUDE_CANCELED', 'AGENT_CANCELED', 'TARGET_MESSAGE_CANCELED']
        .includes(result?.code);
  }

  _isUncertainResult(result) {
    return [
      'AGENT_TIMEOUT',
      'CLAUDE_TIMEOUT',
      'AGENT_API_UNAVAILABLE',
      'CLAUDE_API_UNAVAILABLE',
      'EXECUTOR_RECONCILIATION_UNAVAILABLE',
      'TARGET_RESPONSE_TIMEOUT',
      'TARGET_SESSION_MESSAGE_FAILED',
      'TARGET_DELIVERY_OUTCOME_UNKNOWN',
      'AGENT_TARGET_DELIVERY_OUTCOME_UNKNOWN',
      'EXECUTION_OUTCOME_UNKNOWN',
      'AGENT_EXECUTION_OUTCOME_UNKNOWN',
    ].includes(result?.agentCode || result?.code);
  }

  _emitCanceled(job) {
    if (!job) return;
    this._emitSafely('job.updated', job);
  }

  _emitTerminalOutcomeUnknown(job) {
    if (!job) return;
    this._emitSafely('job.completed', job);
    void this._dispatchCallbackIfRequested(job);
  }

  _finalizeManagedResult(originalJob, result, { terminalKnown = true } = {}) {
    const job = this.stateStore.getJob(originalJob.id) || originalJob;
    if (this._isCanceledResult(result)) {
      const canceled = this.stateStore.cancelJobCas(
        job.id,
        result?.reason || result?.error || job.error || 'Executor acknowledged cancellation',
        { auditMetadata: { source: 'executor_terminal' } }
      );
      if (canceled.changed) this._emitCanceled(canceled.job);
      return canceled.job;
    }
    if (!result?.success) {
      const resultCode = result?.agentCode || result?.code;
      if (['EXECUTION_OUTCOME_UNKNOWN', 'AGENT_EXECUTION_OUTCOME_UNKNOWN']
        .includes(resultCode)) {
        const reason = result?.error || result?.userMessage ||
          'The managed execution may have completed, but its outcome could not be verified.';
        const unknown = this.stateStore.markJobOutcomeUnknown(job.id, reason, {
          auditMetadata: { code: resultCode, provider: result?.provider || job.provider },
          event: {
            role: 'tool',
            kind: 'agent_error',
            content: `${job.profile} ${job.id}: ${reason}`,
          },
        });
        if (unknown.changed) this._emitTerminalOutcomeUnknown(unknown.job);
        return unknown.job;
      }
      if (!terminalKnown && this._isUncertainResult(result)) {
        const deferred = this._deferReconciliation(job, {
          error: result?.error || result?.userMessage || 'Executor result remains uncertain.',
          task: result?.executorTaskId ? { id: result.executorTaskId } : null,
        });
        this._scheduleReconciliation(deferred);
        return deferred;
      }
      const errorMessage = result?.userMessage || result?.error || 'Agent task failed';
      const failed = this.stateStore.failJobCas(job.id, errorMessage, {
        auditAction: 'job_failed',
        auditMetadata: { code: result?.agentCode || result?.code || null },
        event: {
          role: 'tool',
          kind: 'agent_error',
          content: `${job.profile} ${job.id}: ${errorMessage}`,
        },
      });
      if (!failed.changed) return failed.job;
      this._emitSafely('job.completed', failed.job);
      void this._dispatchCallbackIfRequested(failed.job);
      return failed.job;
    }

    const definition = PROFILE_DEFINITIONS[job.profile];
    const bridgeSessionKey = job.bridge_session_key ||
      this.stateStore.getAgentSession(job.voice_thread_id, job.profile)?.bridge_session_key;
    const voiceResult = clip(extractVoiceLine(result.response || 'Task completed.'), 500);
    const completed = this.stateStore.completeJobCas(job.id, {
      voiceResult,
      fullResult: {
        response: result.response,
        provider: result.provider,
        duration_ms: result.duration_ms,
      },
      agentSession: bridgeSessionKey ? {
        provider: definition.provider,
        bridgeSessionKey,
      } : null,
      auditAction: 'job_completed',
      auditMetadata: {
        duration_ms: result.duration_ms || null,
        provider: result.provider || definition.provider,
      },
      event: {
        role: 'tool',
        kind: 'agent_result',
        content: `${job.profile} ${job.id}: ${voiceResult}`,
      },
    });
    if (!completed.changed) return completed.job;
    this._emitSafely('job.completed', completed.job);
    void this._dispatchCallbackIfRequested(completed.job);
    return completed.job;
  }

  _finalizeTargetResult(originalJob, response, { terminalKnown = true } = {}) {
    const job = this.stateStore.getJob(originalJob.id) || originalJob;
    if (this._isCanceledResult(response)) {
      const canceled = this.stateStore.cancelJobCas(
        job.id,
        response?.error || job.error || 'Target delivery canceled before completion',
        { auditMetadata: { source: 'target_executor_terminal' } }
      );
      if (canceled.changed) this._emitCanceled(canceled.job, 'target_executor_terminal');
      return canceled.job;
    }
    if (!response?.success || !response.result) {
      const responseCode = response?.agentCode || response?.code;
      if (['TARGET_DELIVERY_OUTCOME_UNKNOWN', 'AGENT_TARGET_DELIVERY_OUTCOME_UNKNOWN']
        .includes(responseCode)) {
        const unknown = this.stateStore.markJobOutcomeUnknown(
          job.id,
          response?.error || response?.userMessage ||
            'Target delivery may have occurred but could not be verified.',
          {
            auditMetadata: {
              target: job.operation?.target || null,
              code: responseCode,
            },
            event: {
              role: 'tool',
              kind: 'agent_error',
              content: `${job.operation?.target || 'unknown target'} ${job.id}: ${
                response?.error || response?.userMessage || 'Target delivery outcome is unknown.'
              }`,
            },
          }
        );
        if (unknown.changed) this._emitTerminalOutcomeUnknown(unknown.job);
        return unknown.job;
      }
      if (!terminalKnown && this._isUncertainResult(response)) {
        if (response?.executorTaskId) {
          const deferred = this._deferReconciliation(job, {
            error: response.error || response.userMessage || 'Target delivery is still being reconciled.',
            task: { id: response.executorTaskId },
          });
          this._scheduleReconciliation(deferred);
          return deferred;
        }
        const unknown = this.stateStore.markJobOutcomeUnknown(
          job.id,
          response?.error || response?.userMessage ||
            'Target delivery may have occurred but could not be verified.',
          {
            auditMetadata: {
              target: job.operation?.target || null,
              code: responseCode || null,
            },
            event: {
              role: 'tool',
              kind: 'agent_error',
              content: `${job.operation?.target || 'unknown target'} ${job.id}: ${
                response?.error || response?.userMessage || 'Target delivery outcome is unknown.'
              }`,
            },
          }
        );
        if (unknown.changed) this._emitTerminalOutcomeUnknown(unknown.job);
        return unknown.job;
      }
      const errorMessage = response?.userMessage || response?.error ||
        'Target-session delivery failed.';
      const failed = this.stateStore.failJobCas(job.id, errorMessage, {
        auditAction: 'target_session_message_failed',
        auditMetadata: {
          target: job.operation?.target || null,
          provider: job.provider,
          code: response?.code || null,
        },
        event: {
          role: 'tool',
          kind: 'agent_error',
          content: `${job.operation?.target || 'unknown target'} ${job.id}: ${errorMessage}`,
        },
      });
      if (!failed.changed) return failed.job;
      this._emitSafely('job.completed', failed.job);
      void this._dispatchCallbackIfRequested(failed.job);
      return failed.job;
    }

    const result = response.result;
    if (!result.delivered) {
      return this._finalizeTargetResult(job, {
        success: false,
        code: 'TARGET_RESPONSE_UNVERIFIED',
        error: 'The provider did not verify exact target delivery.',
      }, { terminalKnown: true });
    }
    const deliveredWithoutResponse = Boolean(result.canceled_after_delivery && !result.response_verified);
    if (!deliveredWithoutResponse && (!result.response_verified || !result.response)) {
      return this._finalizeTargetResult(job, {
        success: false,
        code: 'TARGET_RESPONSE_UNVERIFIED',
        error: 'The provider did not verify a final response after delivery.',
      }, { terminalKnown: true });
    }
    const target = job.operation?.target;
    const targetLabel = targetConversationLabel(job.operation, job.provider);
    const voiceResult = deliveredWithoutResponse
      ? clip(`${targetLabel} received the message, but cancellation interrupted it before a final reply.`, 500)
      : clip(`${targetLabel} replied: ${result.response}`, 500);
    const completed = this.stateStore.completeJobCas(job.id, {
      voiceResult,
      fullResult: {
        target: result.target || job.operation?.canonicalTarget || target,
        stable_target: target,
        display_target: job.operation?.displayTarget || null,
        conversation_name: job.operation?.conversationName || null,
        provider: result.provider || job.provider,
        delivered: true,
        delivered_at: result.delivered_at || null,
        response_verified: Boolean(result.response_verified),
        response: result.response || null,
        response_at: result.response_at || null,
        canceled_after_delivery: deliveredWithoutResponse,
        cancellation_arrived_after_completion: Boolean(result.cancellation_arrived_after_completion),
        duration_ms: result.duration_ms || null,
      },
      auditAction: deliveredWithoutResponse
        ? 'target_session_message_delivered_then_canceled'
        : 'target_session_message_verified',
      auditMetadata: {
        target: result.target || job.operation?.canonicalTarget || target,
        stable_target: target,
        conversation_name: job.operation?.conversationName || null,
        provider: job.provider,
        duration_ms: result.duration_ms || null,
        cancellation_arrived_after_completion: Boolean(
          result.cancellation_arrived_after_completion
        ),
      },
      event: {
        role: 'tool',
        kind: 'agent_result',
        content: `${target} ${job.id}: ${voiceResult}`,
      },
    });
    if (!completed.changed) return completed.job;
    this._emitSafely('job.completed', completed.job);
    void this._dispatchCallbackIfRequested(completed.job);
    return completed.job;
  }

  _finalizePrivilegedAction(originalJob, action) {
    const job = this.stateStore.getJob(originalJob.id) || originalJob;
    if (!action) {
      const reason = 'The root-broker result could not be recovered; the exact action was not resent.';
      const unknown = this.stateStore.markJobOutcomeUnknown(
        job.id,
        reason,
        {
          auditMetadata: { target: job.operation?.target || null },
          event: {
            role: 'tool',
            kind: 'agent_error',
            content: `${job.operation?.target || 'privileged target'} ${job.id}: ${reason}`,
          },
        }
      );
      if (unknown.changed) this._emitTerminalOutcomeUnknown(unknown.job);
      return unknown.job;
    }
    if (action.state === 'outcome_unknown') {
      const reason = action.errorMessage ||
        'The privileged side effect may have occurred, but its outcome is unknown.';
      const unknown = this.stateStore.markJobOutcomeUnknown(
        job.id,
        reason,
        {
          auditMetadata: {
            action_id: action.id || null,
            target: job.operation?.target || null,
          },
          event: {
            role: 'tool',
            kind: 'agent_error',
            content: `${job.operation?.target || 'privileged target'} ${job.id}: ${reason}`,
          },
        }
      );
      if (unknown.changed) this._emitTerminalOutcomeUnknown(unknown.job);
      return unknown.job;
    }
    if (action.state === 'canceled') {
      const canceled = this.stateStore.cancelJobCas(
        job.id,
        action.cancelReason || 'The root broker canceled the action before execution.',
        { auditMetadata: { source: 'privileged_broker_terminal', action_id: action.id || null } }
      );
      if (canceled.changed) this._emitCanceled(canceled.job, 'privileged_broker_terminal');
      return canceled.job;
    }
    if (action.state === 'failed') {
      const partial = action.result?.execution ? ' Partial effects may remain.' : '';
      const errorMessage = `${action.errorMessage || 'The privileged action failed.'}${partial}`;
      const failed = this.stateStore.failJobCas(
        job.id,
        errorMessage,
        {
          auditAction: 'privileged_action_failed',
          auditMetadata: {
            action_id: action.id || null,
            target: job.operation?.target || null,
            partial_effects_possible: Boolean(action.result?.execution),
          },
          auditRiskLevel: job.risk_level || 'high',
          event: {
            role: 'tool',
            kind: 'privileged_action_error',
            content: `${job.operation?.target || 'privileged target'} ${job.id}: ${errorMessage}`,
          },
        }
      );
      if (failed.changed) {
        this._emitSafely('job.completed', failed.job);
        void this._dispatchCallbackIfRequested(failed.job);
      }
      return failed.job;
    }
    if (action.state !== 'completed' || !action.result?.success) {
      const deferred = this._deferReconciliation(job, {
        error: 'The root-broker action is not terminal yet.',
        task: { id: action.id },
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
    // Root-owned command output is intentionally never consumed here. Even a
    // future or older broker response containing a preview must not cross the
    // voice/OpenAI boundary; only the canonical, pre-approved expectation is
    // safe to speak.
    const expected = job.operation?.actionPlan?.expected_result?.description ||
      'The root broker recorded digest-only execution metadata.';
    const safeResult = safePrivilegedResult(action.result, expected);
    const voiceResult = clip(`Privileged action completed. ${expected}`, 500);
    const completed = this.stateStore.completeJobCas(job.id, {
      voiceResult,
      fullResult: {
        action_id: action.id,
        state: action.state,
        result: safeResult,
        completed_at: action.completedAt || null,
      },
      auditAction: 'privileged_action_completed',
      auditMetadata: { action_id: action.id, target: job.operation?.target || null },
      auditRiskLevel: job.risk_level || 'high',
      event: {
        role: 'tool',
        kind: 'privileged_action_result',
        content: `${job.operation?.target || 'privileged target'} ${job.id}: ${voiceResult}`,
      },
    });
    if (!completed.changed) return completed.job;
    this._emitSafely('job.completed', completed.job);
    void this._dispatchCallbackIfRequested(completed.job);
    return completed.job;
  }

  async _submitManagedJob(job, { recoveredWithoutTask = false } = {}) {
    const latest = this.stateStore.getJob(job.id) || job;
    const binding = latest.bridge_session_key
      ? {
        job: latest,
        session: this.stateStore.getAgentSession(latest.voice_thread_id, latest.profile),
      }
      : this._ensureManagedJobBinding(latest);
    const boundJob = binding.job || latest;
    const agentSession = binding.session || this.stateStore.getAgentSession(
      boundJob.voice_thread_id,
      boundJob.profile
    );
    const definition = PROFILE_DEFINITIONS[boundJob.profile];
    const approvalPlan = buildManagedAgentApprovalPlan({
      jobId: boundJob.id,
      request: boundJob.request,
      sessionKey: boundJob.bridge_session_key || agentSession.bridge_session_key,
      sessionType: definition.sessionType,
      timeoutSeconds: definition.timeoutSeconds,
    });
    try {
      const result = await this.agentBridge.queryDetailed(boundJob.request, {
        callId: boundJob.id,
        sessionKey: boundJob.bridge_session_key || agentSession.bridge_session_key,
        sessionType: definition.sessionType,
        timeout: definition.timeoutSeconds,
        authorization: this._buildCapabilityAuthorization(boundJob, {
          plan: approvalPlan,
          target: managedAgentTarget(boundJob.bridge_session_key || agentSession.bridge_session_key),
        }),
      });
      return this._finalizeManagedResult(boundJob, result, { terminalKnown: false });
    } catch (error) {
      if (['APPROVAL_EXPIRED', 'APPROVAL_CAPABILITY_UNAVAILABLE', 'APPROVAL_STATE_INVALID']
        .includes(error.code)) {
        return this._finalizeManagedResult(boundJob, {
          success: false,
          code: error.code,
          agentCode: error.code,
          error: error.userMessage || error.message,
        }, { terminalKnown: true });
      }
      const deferred = this._deferReconciliation(boundJob, {
        error: `${recoveredWithoutTask ? 'Recovered submission' : 'Executor submission'} remains uncertain: ${error.message}`,
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
  }

  async _runTargetSessionMessage(queuedJob) {
    if (this.getExecutionLock().locked) return this.stateStore.getJob(queuedJob.id);
    const job = this.stateStore.markJobRunning(queuedJob.id, {
      auditAction: 'target_session_message_started',
      auditMetadata: {
        target: queuedJob.operation?.target || null,
        provider: queuedJob.provider,
        approval_method: queuedJob.approval_method || null,
      },
      auditRiskLevel: queuedJob.risk_level || 'mutating',
    });
    if (!job) return this.stateStore.getJob(queuedJob.id);
    const target = job.operation?.target;
    this._emitSafely('job.updated', job);

    try {
      if (!target || !job.operation?.sessionFingerprint) {
        throw Object.assign(new Error('The approved target-session binding is unavailable.'), {
          code: 'TARGET_SESSION_BINDING_MISSING',
        });
      }
      const approvalPlan = buildTargetSessionApprovalPlan({
        jobId: job.id,
        target,
        message: job.request,
        sessionFingerprint: job.operation.sessionFingerprint,
        timeoutSeconds: job.operation.timeoutSeconds,
      });
      const response = await this.agentBridge.sendAgentSessionMessage({
        operationId: job.id,
        target,
        message: job.request,
        sessionFingerprint: job.operation.sessionFingerprint,
        timeoutSeconds: job.operation.timeoutSeconds,
        authorization: this._buildCapabilityAuthorization(job, {
          plan: approvalPlan,
          target,
        }),
      });
      if (response?.executorTaskId) {
        this.stateStore.recordExecutorTask(job.id, { id: response.executorTaskId });
      }
      return this._finalizeTargetResult(job, response, { terminalKnown: false });
    } catch (error) {
      if (error.code === 'TARGET_MESSAGE_CANCELED') {
        const canceled = this.stateStore.cancelJobCas(job.id, error.message);
        if (canceled.changed) this._emitCanceled(canceled.job, 'target_abort_acknowledged');
        return canceled.job;
      }
      return this._finalizeTargetResult(job, {
        success: false,
        code: error.code || 'TARGET_SESSION_MESSAGE_FAILED',
        error: error.userMessage || error.message,
      }, {
        terminalKnown: ['APPROVAL_EXPIRED', 'APPROVAL_CAPABILITY_UNAVAILABLE',
          'APPROVAL_STATE_INVALID', 'TARGET_SESSION_BINDING_MISSING']
          .includes(error.code),
      });
    }
  }

  async _runPrivilegedAction(queuedJob) {
    if (this.getExecutionLock().locked) return this.stateStore.getJob(queuedJob.id);
    const job = this.stateStore.markJobRunning(queuedJob.id, {
      auditAction: 'privileged_action_submission_started',
      auditMetadata: {
        target: queuedJob.operation?.target || null,
        method: queuedJob.approval_method || null,
      },
      auditRiskLevel: queuedJob.risk_level || 'high',
    });
    if (!job) return this.stateStore.getJob(queuedJob.id);
    this._emitSafely('job.updated', job);
    let acceptedActionId = null;
    try {
      const plan = job.operation?.actionPlan;
      const callId = job.operation?.callId;
      if (!plan || !callId || !this.privilegedActionBridge) {
        throw Object.assign(new Error('The privileged action binding is unavailable.'), {
          code: 'PRIVILEGED_ACTION_BINDING_MISSING',
        });
      }
      const approvalPlan = buildPrivilegedActionApprovalPlan({
        jobId: job.id,
        callId,
        actionPlan: plan,
      });
      const action = await this.privilegedActionBridge.submit({
        idempotencyKey: job.id,
        jobId: job.id,
        callId,
        plan,
        authorization: this._buildCapabilityAuthorization(job, {
          plan: approvalPlan,
          target: plan.target,
        }),
      });
      if (!action?.id) throw new Error('The root broker did not return an action ID.');
      acceptedActionId = action.id;
      this.stateStore.recordExecutorTask(job.id, { id: action.id });
      const terminalAction = action.terminal
        ? action
        : await this.privilegedActionBridge.wait(action.id, {
          timeoutSeconds: plan.timeout_seconds + 30,
        });
      return this._finalizePrivilegedAction(job, terminalAction);
    } catch (error) {
      const responseStatus = Number(error.response?.status);
      const explicitPreSubmitRejection = !acceptedActionId &&
        responseStatus >= 400 && responseStatus < 500 && responseStatus !== 409;
      if (['APPROVAL_EXPIRED', 'APPROVAL_CAPABILITY_UNAVAILABLE',
        'APPROVAL_STATE_INVALID', 'PRIVILEGED_ACTION_BINDING_MISSING',
        'PRIVILEGED_IDEMPOTENCY_CONFLICT']
        .includes(error.code) || explicitPreSubmitRejection) {
        const failed = this.stateStore.failJobCas(
          job.id,
          error.response?.data?.error || error.userMessage || error.message
        );
        if (failed.changed) this._emitSafely('job.completed', failed.job);
        return failed.job;
      }
      const deferred = this._deferReconciliation(job, {
        error: `Privileged submission or result remains uncertain: ${error.message}`,
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
  }

  async _runAgent(queuedJob) {
    if (this.getExecutionLock().locked) return this.stateStore.getJob(queuedJob.id);
    const binding = this._ensureManagedJobBinding(queuedJob);
    const boundQueuedJob = binding.job || queuedJob;
    const job = this.stateStore.markJobRunning(boundQueuedJob.id, {
      auditAction: 'job_started',
      auditMetadata: {
        approved: Boolean(boundQueuedJob.approved_at),
        approval_method: boundQueuedJob.approval_method || null,
      },
    });
    if (!job) return this.stateStore.getJob(queuedJob.id);

    this._emitSafely('job.updated', job);

    try {
      const recovered = await this._resumeExistingDurableTask(job, {
        interrupted: false,
        timeoutSeconds: PROFILE_DEFINITIONS[job.profile].timeoutSeconds,
      });
      if (recovered.found) {
        this._adoptManagedTaskBinding(job, recovered.task);
        return this._finalizeManagedResult(job, recovered.result, {
          terminalKnown: Boolean(recovered.task?.terminal),
        });
      }
      return this._submitManagedJob(this.stateStore.getJob(job.id));
    } catch (error) {
      const deferred = this._deferReconciliation(this.stateStore.getJob(job.id), {
        error: `Executor reconciliation is pending: ${error.message}`,
      });
      this._scheduleReconciliation(deferred);
      return deferred;
    }
  }

  async _dispatchCallbackIfRequested(job) {
    if (job.notification_mode !== 'callback' || typeof this.callbackDispatcher !== 'function') {
      return null;
    }
    if (!this._isOperational() || job.notification_status === 'delivered') return null;
    if (this.callbackDeliveries.has(job.id)) return this.callbackDeliveries.get(job.id);
    const promise = Promise.resolve().then(async () => {
      if (!this._isOperational()) return null;
      const delivery = this.stateStore.claimCallbackOutbox({
        jobId: job.id,
        workerId: this.callbackWorkerId,
        leaseMs: this.callbackLeaseMs,
      });
      if (!delivery) return this.stateStore.getJob(job.id);
      const current = delivery.job;
      try {
        const result = await this.callbackDispatcher(
          current,
          this.stateStore.getThread(current.voice_thread_id),
          {
            idempotencyKey: delivery.idempotencyKey,
            attempt: delivery.attempts,
          }
        );
        if (!this._isOperational()) return null;
        // The local outbound receiver correlates the callback outbox to its
        // durable call row in the same reservation transaction. Trust that
        // database handoff even if the HTTP response was lost or reports an
        // already-terminal exact retry.
        const persistedHandoff = this.stateStore.getCallbackOutbox(current.id);
        if (persistedHandoff?.outboundCallId &&
            !['pending', 'delivering'].includes(persistedHandoff.state)) {
          return this.stateStore.getJob(job.id);
        }
        if (result?.queued === true) {
          const handoff = this.stateStore.recordCallbackOutboundHandoff({
            idempotencyKey: delivery.idempotencyKey,
            leaseToken: delivery.leaseToken,
            callId: result.callId,
          });
          if (handoff.changed || handoff.outbox) return handoff.job;
          const error = new Error(
            handoff.reason || 'Outbound callback queue acceptance was not durably correlated'
          );
          this.stateStore.retryCallbackOutbox({
            idempotencyKey: delivery.idempotencyKey,
            leaseToken: delivery.leaseToken,
            error: error.message,
            backoffMs: this._callbackRetryDelay(delivery.attempts),
          });
          this._emitSafely('callback.error', { job: current, error });
          return this.stateStore.getJob(job.id);
        }
        const error = new Error(
          result?.reason || result?.error || 'Outbound callback was not durably queued'
        );
        this.stateStore.retryCallbackOutbox({
          idempotencyKey: delivery.idempotencyKey,
          leaseToken: delivery.leaseToken,
          error: error.message,
          backoffMs: this._callbackRetryDelay(delivery.attempts),
        });
        this._emitSafely('callback.error', { job: current, error });
        return this.stateStore.getJob(job.id);
      } catch (error) {
        if (!this._isOperational()) return null;
        const persistedHandoff = this.stateStore.getCallbackOutbox(current.id);
        if (persistedHandoff?.outboundCallId &&
            !['pending', 'delivering'].includes(persistedHandoff.state)) {
          return this.stateStore.getJob(job.id);
        }
        this.stateStore.retryCallbackOutbox({
          idempotencyKey: delivery.idempotencyKey,
          leaseToken: delivery.leaseToken,
          error: error.message,
          backoffMs: this._callbackRetryDelay(delivery.attempts),
        });
        this._emitSafely('callback.error', { job: current, error });
        return this.stateStore.getJob(job.id);
      }
    }).finally(() => {
      this.callbackDeliveries.delete(job.id);
      if (this._isOperational()) this._scheduleCallbackDrain();
    });
    this.callbackDeliveries.set(job.id, promise);
    return promise;
  }

  _callbackRetryDelay(attempts) {
    const exponent = Math.max(0, Math.min((Number(attempts) || 1) - 1, 12));
    return Math.min(this.callbackRetryBaseMs * (2 ** exponent), this.callbackRetryMaxMs);
  }

  _scheduleCallbackDrain(delayMs = null) {
    if (!this._isOperational() || typeof this.callbackDispatcher !== 'function') return null;
    const delay = delayMs === null
      ? this.stateStore.nextCallbackOutboxDelay({ maximumMs: this.callbackRetryMaxMs })
      : Math.max(10, Math.min(Number(delayMs) || 10, this.callbackRetryMaxMs));
    if (delay === null) return null;
    const dueAt = Date.now() + delay;
    if (this.callbackRetryTimer && this.callbackRetryDueAt <= dueAt) {
      return this.callbackRetryTimer;
    }
    if (this.callbackRetryTimer) clearTimeout(this.callbackRetryTimer);
    this.callbackRetryDueAt = dueAt;
    this.callbackRetryTimer = setTimeout(() => {
      this.callbackRetryTimer = null;
      this.callbackRetryDueAt = null;
      this._drainPendingCallbacks();
    }, delay);
    this.callbackRetryTimer.unref?.();
    return this.callbackRetryTimer;
  }

  _drainPendingCallbacks() {
    if (!this._isOperational() || typeof this.callbackDispatcher !== 'function') return 0;
    const pending = this.stateStore.listDueCallbackJobs({ limit: 100 });
    for (const job of pending) void this._dispatchCallbackIfRequested(job);
    this._scheduleCallbackDrain();
    return pending.length;
  }

  async _panicPrivilegedActions(activeJobs, reason, source) {
    const privilegedJobs = (activeJobs || []).filter(
      (job) => job?.jobKind === 'privileged_action'
    );
    if (!this.privilegedActionBridge) {
      return {
        success: privilegedJobs.length === 0,
        configured: false,
        quiesced: privilegedJobs.length === 0,
        reservations: privilegedJobs.map((job) => ({
          jobId: job.id,
          success: false,
          code: 'PRIVILEGED_ACTION_BRIDGE_UNAVAILABLE',
        })),
        error: privilegedJobs.length > 0
          ? 'The privileged root-broker client is unavailable.'
          : null,
      };
    }

    const reservationsPromise = Promise.allSettled(privilegedJobs.map((job) =>
      this.privilegedActionBridge.cancelByIdempotencyKey(job.id, job.id, { reason })
    ));
    const panicPromise = this.privilegedActionBridge.panic({ reason, source });
    const [settledReservations, settledPanic] = await Promise.all([
      reservationsPromise,
      Promise.resolve(panicPromise).then(
        (value) => ({ status: 'fulfilled', value }),
        (error) => ({ status: 'rejected', reason: error })
      ),
    ]);
    const reservations = settledReservations.map((entry, index) => ({
      jobId: privilegedJobs[index].id,
      success: entry.status === 'fulfilled' && entry.value?.success === true,
      code: entry.status === 'fulfilled'
        ? (entry.value?.code || null)
        : (entry.reason?.code || 'PRIVILEGED_CANCELLATION_RESERVATION_FAILED'),
    }));
    const panic = settledPanic.status === 'fulfilled'
      ? settledPanic.value
      : {
          success: false,
          quiesced: false,
          error: settledPanic.reason?.message || 'Privileged panic delivery failed.',
        };
    const reservationsPersisted = reservations.every((entry) => entry.success);
    const quiesced = panic?.success === true && panic?.quiesced === true;
    return {
      success: reservationsPersisted && quiesced,
      configured: true,
      quiesced,
      reservationsPersisted,
      reservations,
      panic,
    };
  }

  async _panicOutboundCalls(reason, source) {
    if (typeof this.outboundControl?.panicOutboundCalls !== 'function') {
      return { success: true, configured: false, persisted: true, quiesced: true };
    }
    try {
      const result = await this.outboundControl.panicOutboundCalls({ reason, source });
      return {
        ...result,
        configured: true,
        success: result?.success === true && result?.persisted === true &&
          result?.quiesced === true,
      };
    } catch (error) {
      return {
        success: false,
        configured: true,
        persisted: false,
        quiesced: false,
        error: error.message,
      };
    }
  }

  async panicStop(reason = 'Voice emergency stop', source = 'local_panic') {
    this.executionLocked = true;
    this.executionLockReason = String(reason || 'Voice emergency stop').slice(0, 1000);

    const persistentLock = this.executionControl?.lock?.({
      reason: this.executionLockReason,
      source,
      remotePanicPending: true,
    }) || {
      locked: true,
      persistent: false,
      reason: this.executionLockReason,
      error: 'No persistent execution control is configured',
    };

    const activeJobs = this.stateStore.listAllActiveJobs();
    const agentPanicPromise = (async () => {
      try {
        if (typeof this.agentBridge.panicStop === 'function') {
          return await this.agentBridge.panicStop({
            reason: this.executionLockReason,
            source,
          });
        }
        const bridgeCancellations = await Promise.allSettled(
          activeJobs.map((job) => {
            const session = this.stateStore.getAgentSession(job.voice_thread_id, job.profile);
            return this.agentBridge.cancelSession(job.id, {
              idempotencyKey: job.id,
              sessionKey: session?.bridge_session_key || job.id,
              resetSession: false,
              reason: this.executionLockReason,
            });
          })
        );
        return {
          success: bridgeCancellations.every((result) => result.status === 'fulfilled'),
          canceledCount: activeJobs.length,
          failures: bridgeCancellations.filter((result) => result.status === 'rejected').length,
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    })();
    const privilegedPanicPromise = this._panicPrivilegedActions(
      activeJobs,
      this.executionLockReason,
      source
    );
    const outboundPanicPromise = this._panicOutboundCalls(
      this.executionLockReason,
      source
    );
    const privilegedJobIds = activeJobs
      .filter((job) => job.jobKind === 'privileged_action')
      .map((job) => job.id);
    const cancellationResults = this.stateStore.requestAllJobCancellations(
      this.executionLockReason,
      // A privileged job stays nonterminal until the root broker confirms the
      // exact idempotency tombstone or returns the durable action's truth.
      {
        keepPendingJobIds: privilegedJobIds,
        auditMetadata: { source },
      }
    );
    const [bridgeResult, privilegedBridgeResult, outboundResult] = await Promise.all([
      agentPanicPromise,
      privilegedPanicPromise,
      outboundPanicPromise,
    ]);
    for (const cancellation of cancellationResults) {
      if (!cancellation.changed) continue;
      const job = cancellation.job;
      this._emitSafely('job.updated', job);
    }

    const remotePanicSucceeded = Boolean(
      bridgeResult?.success && privilegedBridgeResult?.success && outboundResult?.success
    );

    let confirmedLock = persistentLock;
    if (remotePanicSucceeded) {
      confirmedLock = this.executionControl?.confirmRemotePanic?.({ source }) || persistentLock;
      this.panicRetryAttempts = 0;
      if (this.panicRetryTimer) clearTimeout(this.panicRetryTimer);
      this.panicRetryTimer = null;
    } else {
      this.executionControl?.markRemotePanicPending?.({
        reason: this.executionLockReason,
        source,
      });
      this._scheduleRemotePanicRetry();
    }
    for (const cancellation of cancellationResults) {
      if (cancellation.job?.status === 'cancel_requested') {
        const deferred = this._deferReconciliation(cancellation.job, {
          error: remotePanicSucceeded
            ? 'Emergency-stop cancellation is awaiting executor terminal state.'
            : 'Emergency-stop delivery is unconfirmed; retry is pending.',
          delayMs: this.reconciliationBaseDelayMs,
        });
        this._scheduleReconciliation(deferred);
      }
    }

    const canceledJobs = cancellationResults
      .filter((entry) => entry.job?.status === 'canceled')
      .map((entry) => entry.job);
    const cancelRequestedJobs = cancellationResults
      .filter((entry) => entry.job?.status === 'cancel_requested')
      .map((entry) => entry.job);

    return {
      locked: true,
      reason: this.executionLockReason,
      canceledCount: canceledJobs.length,
      cancelRequestedCount: cancelRequestedJobs.length,
      runningCount: activeJobs.filter((job) => job.status !== 'awaiting_approval').length,
      persistent: Boolean(confirmedLock.persistent),
      persistentLock: confirmedLock,
      bridge: {
        success: remotePanicSucceeded,
        agent: bridgeResult,
        privileged: privilegedBridgeResult,
        outbound: outboundResult,
      },
      jobs: cancellationResults.map((entry) => voiceSafeJob(entry.job)),
    };
  }

  _scheduleRemotePanicRetry() {
    if (this.panicRetryTimer || !this.getExecutionLock().locked) return this.panicRetryTimer;
    const delayMs = Math.min(
      this.reconciliationBaseDelayMs * (2 ** Math.min(this.panicRetryAttempts, 12)),
      this.reconciliationMaxDelayMs
    );
    this.panicRetryTimer = setTimeout(async () => {
      this.panicRetryTimer = null;
      const lock = this.getExecutionLock();
      if (!lock.locked || !lock.remotePanicPending) return;
      this.panicRetryAttempts += 1;
      let result;
      try {
        const retryReason = lock.reason || this.executionLockReason || 'voice_panic_stop';
        const activeJobs = this.stateStore.listAllActiveJobs();
        const attempts = await Promise.allSettled([
          this.agentBridge.panicStop({
            reason: retryReason,
            source: 'voice_app_retry',
          }),
          this._panicPrivilegedActions(activeJobs, retryReason, 'voice_app_retry'),
          this._panicOutboundCalls(retryReason, 'voice_app_retry'),
        ]);
        result = {
          success: attempts.every((attempt) =>
            attempt.status === 'fulfilled' && attempt.value?.success
          ),
        };
      } catch (error) {
        result = { success: false, error: error.message };
      }
      if (result?.success) {
        this.executionControl?.confirmRemotePanic?.({ source: 'voice_app_retry' });
        this.panicRetryAttempts = 0;
      } else {
        this._scheduleRemotePanicRetry();
      }
    }, delayMs);
    this.panicRetryTimer.unref?.();
    return this.panicRetryTimer;
  }

  setExecutionLocked(locked, reason = null) {
    this.executionLocked = Boolean(locked);
    this.executionLockReason = this.executionLocked ? String(reason || 'Voice execution locked') : null;
    return {
      locked: this.executionLocked,
      reason: this.executionLockReason,
    };
  }

  getExecutionLock() {
    const persistedLock = this.executionControl?.getStatus?.();
    if (persistedLock?.locked) {
      this.executionLocked = true;
      this.executionLockReason = persistedLock.reason || this.executionLockReason;
    }
    let outbound = null;
    try {
      outbound = this.outboundControl?.getOutboundPlaneStatus?.() || null;
    } catch (error) {
      outbound = {
        configured: true,
        accepting: false,
        locked: true,
        quiesced: false,
        recoveryRequired: true,
        error: error.message,
      };
    }
    return {
      locked: this.executionLocked,
      reason: this.executionLockReason,
      persistent: persistedLock ? Boolean(persistedLock.persistent) : false,
      remotePanicPending: Boolean(persistedLock?.remotePanicPending),
      remotePanicConfirmedAt: persistedLock?.remotePanicConfirmedAt || null,
      error: persistedLock?.error || null,
      outbound,
    };
  }

  getUnlockReadiness() {
    if (typeof this.outboundControl?.getOutboundPlaneStatus !== 'function') {
      return { ready: true, outbound: null };
    }
    try {
      const outbound = this.outboundControl.getOutboundPlaneStatus();
      const ready = outbound?.quiesced === true && outbound?.recoveryRequired !== true;
      return {
        ready,
        outbound,
        error: ready ? null : (outbound?.error || 'outbound_quiescence_unconfirmed'),
      };
    } catch (error) {
      return {
        ready: false,
        outbound: null,
        error: error.message || 'outbound_status_unavailable',
      };
    }
  }

  unlockExecution(source = 'operator') {
    const persisted = this.executionControl?.getStatus?.();
    if (persisted?.remotePanicPending) {
      return this.executionControl.unlock({ source });
    }
    if (typeof this.outboundControl?.unlockOutboundCalls === 'function') {
      const outbound = this.outboundControl.unlockOutboundCalls({ source });
      if (outbound?.success !== true || outbound?.quiesced !== true) {
        return {
          locked: true,
          persistent: Boolean(persisted?.persistent),
          error: outbound?.error || 'outbound_quiescence_unconfirmed',
          outbound,
        };
      }
    }
    const result = this.executionControl?.unlock?.({ source }) || {
      locked: false,
      persistent: false,
      wasLocked: this.executionLocked,
    };
    if (result.locked === false) {
      this.executionLocked = false;
      this.executionLockReason = null;
      this.recoverDurableJobs();
    } else if (typeof this.outboundControl?.panicOutboundCalls === 'function') {
      void this.outboundControl.panicOutboundCalls({
        reason: result.error || 'Voice unlock was refused',
        source: 'voice_unlock_rollback',
      });
    }
    return result;
  }
}

module.exports = {
  AgentJobBroker,
  PROFILE_DEFINITIONS,
  needsApproval,
  normalizeProfile,
  profileCan,
  routedProfile,
  refersToTargetedSession,
  voiceSafeJob,
};
