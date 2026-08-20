'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers');
const { extractVoiceLine } = require('./conversation-loop');
const {
  buildApprovalSummary,
  buildAuthorizationEnvelope,
  classifyVoiceOperation,
} = require('../../lib/voice-operation-risk');

const PROFILE_DEFINITIONS = Object.freeze({
  'claude-haiku': {
    provider: 'claude',
    sessionType: 'phone-haiku',
    timeoutSeconds: 600,
    capability: 'read',
  },
  'claude-sonnet': {
    provider: 'claude',
    sessionType: 'phone-sonnet',
    timeoutSeconds: 1800,
    capability: 'write',
  },
  'claude-opus': {
    provider: 'claude',
    sessionType: 'phone-opus',
    timeoutSeconds: 3600,
    capability: 'admin',
  },
  'codex-luna': {
    provider: 'codex',
    sessionType: 'phone-codex-luna',
    timeoutSeconds: 600,
    capability: 'read',
  },
  'codex-terra': {
    provider: 'codex',
    sessionType: 'phone-codex-terra',
    timeoutSeconds: 1800,
    capability: 'write',
  },
  'codex-sol': {
    provider: 'codex',
    sessionType: 'phone-codex-sol',
    timeoutSeconds: 3600,
    capability: 'admin',
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
  return Boolean(definition && CAPABILITY_RANK[definition.capability] >= CAPABILITY_RANK[capability]);
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
    target: job.jobKind === 'tmux_agent_message'
      ? (job.operation?.displayTarget || job.operation?.canonicalTarget || job.operation?.target || null)
      : null,
    stable_target: job.jobKind === 'tmux_agent_message' ? (job.operation?.target || null) : null,
    conversation_name: job.jobKind === 'tmux_agent_message' ? (job.operation?.conversationName || null) : null,
    spoken_approval_prompt: job.jobKind === 'tmux_agent_message'
      ? (job.operation?.spokenApprovalPrompt || null)
      : null,
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
  constructor({ stateStore, agentBridge, callbackDispatcher = null, executionControl = null } = {}) {
    super();
    if (!stateStore) throw new Error('AgentJobBroker requires stateStore');
    if (!agentBridge) throw new Error('AgentJobBroker requires agentBridge');
    this.stateStore = stateStore;
    this.agentBridge = agentBridge;
    this.callbackDispatcher = callbackDispatcher;
    this.executionControl = executionControl;
    this.workspaceMutex = new AsyncMutex();
    this.activeExecutions = new Map();
    const persistedLock = executionControl?.getStatus?.() || { locked: false };
    this.executionLocked = Boolean(persistedLock.locked);
    this.executionLockReason = persistedLock.locked ? persistedLock.reason : null;
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
      capability: definition.capability,
      timeout_seconds: definition.timeoutSeconds,
    }));
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

    const normalizedRequest = String(request || '').trim();
    if (!normalizedRequest) {
      return { accepted: false, code: 'EMPTY_AGENT_REQUEST', message: 'Tell me what the agent should do.' };
    }

    if (refersToTargetedSession(normalizedRequest)) {
      return {
        accepted: false,
        code: 'TARGETED_SESSION_REQUIRED',
        message: 'Use send_agent_session_message with an exact tmux target. This managed-session tool cannot claim delivery to an existing tmux conversation.',
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
        message: `${normalizedProfile} is ${PROFILE_DEFINITIONS[normalizedProfile].capability}-scope. Use ${suggested} for this ${classification.level} request.`,
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
    this.stateStore.appendEvent({
      voiceThreadId,
      realtimeSessionId,
      role: 'user',
      kind: 'agent_request',
      content: `${normalizedProfile}: ${normalizedRequest}`,
    });
    this.stateStore.appendAuditEvent({
      voiceThreadId,
      realtimeSessionId,
      jobId: result.job.id,
      callerId: thread.caller_id,
      action: requiresApproval ? 'approval_requested' : 'job_queued',
      riskLevel: classification.level,
      profile: normalizedProfile,
      requestHash: classification.requestHash,
      scopeText: approvalSummary || normalizedRequest,
      metadata: { routing: routing.explicit ? 'explicit' : 'automatic', reasons: classification.reasons },
    });

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
    const admin = classification.capability === 'admin';
    const profile = prepared.provider === 'claude'
      ? (admin ? 'claude-opus' : 'claude-sonnet')
      : (admin ? 'codex-sol' : 'codex-terra');
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

    this.stateStore.appendEvent({
      voiceThreadId,
      realtimeSessionId,
      role: 'user',
      kind: 'agent_request',
      content: `${prepared.provider} ${prepared.target}: ${normalizedMessage}`,
    });
    this.stateStore.appendAuditEvent({
      voiceThreadId,
      realtimeSessionId,
      jobId: result.job.id,
      callerId: thread.caller_id,
      action: 'target_session_approval_requested',
      riskLevel: classification.level,
      profile,
      requestHash: classification.requestHash,
      scopeText: approvalSummary,
      metadata: {
        target: prepared.target,
        stable_target: stableTarget,
        display_target: displayTarget,
        conversation_name: prepared.conversation_name || null,
        provider: prepared.provider,
        resolution: prepared.resolution || null,
        reasons: classification.reasons,
      },
    });
    return {
      accepted: true,
      ...voiceSafeJob(result.job),
      confirmation_instruction: `Say exactly: ${JSON.stringify(approvalText.spoken)}`,
      spoken_approval_prompt: approvalText.spoken,
      response_behavior: 'approval_prompt',
      delivery_guarantee: 'Completion is reported only after exact provider-log verification.',
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
        resumable: Boolean(session.provider_session_id),
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
      `Treat this brief as an explicit handoff, not shared hidden context. Validate the current workspace state before changing it.\n` +
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

    if (['completed', 'failed', 'canceled'].includes(job.status)) {
      return { canceled: false, code: 'JOB_ALREADY_FINISHED', job: voiceSafeJob(job) };
    }

    if (job.status === 'running' && job.jobKind === 'tmux_agent_message') {
      await this.agentBridge.cancelSession(job.id, {
        sessionKey: job.id,
        resetSession: false,
        reason,
      });
      const execution = this.activeExecutions.get(job.id);
      if (execution) {
        let settled = false;
        let reconciliationTimer = null;
        try {
          await Promise.race([
            execution.catch(() => null).then(() => { settled = true; }),
            new Promise((resolve) => {
              reconciliationTimer = setTimeout(resolve, 5000);
              reconciliationTimer.unref?.();
            }),
          ]);
        } finally {
          if (reconciliationTimer) clearTimeout(reconciliationTimer);
        }
        if (!settled) {
          return {
            canceled: false,
            code: 'CANCEL_RECONCILIATION_PENDING',
            message: 'Cancellation was requested. Delivery status is still being reconciled; do not retry yet.',
            job: voiceSafeJob(this.stateStore.getJob(job.id)),
          };
        }
      }
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
    } else if (job.status === 'running') {
      const session = this.stateStore.getAgentSession(voiceThreadId, job.profile);
      await this.agentBridge.cancelSession(job.id, {
        sessionKey: session?.bridge_session_key || job.id,
        resetSession: false,
        reason,
      });
    }

    const canceled = this.stateStore.cancelJob(job.id, reason);
    const thread = this.stateStore.getThread(voiceThreadId);
    this.stateStore.appendAuditEvent({
      voiceThreadId,
      realtimeSessionId: job.realtime_session_id,
      jobId: job.id,
      callerId: thread?.caller_id || 'unknown',
      action: 'job_canceled',
      riskLevel: job.risk_level || 'read_only',
      profile: job.profile,
      requestHash: job.request_hash,
      scopeText: job.approval_summary || job.request,
      metadata: { reason },
    });
    this._emitSafely('job.updated', canceled);
    return { canceled: true, job: voiceSafeJob(canceled) };
  }

  approveNextJob(voiceThreadId) {
    if (this.getExecutionLock().locked) {
      return {
        approved: false,
        code: 'VOICE_EXECUTION_LOCKED',
        message: 'Voice-started agent work is locked after an emergency stop.',
      };
    }

    const job = this.stateStore.approveFocusedJob(voiceThreadId, {
      method: 'dtmf-pound',
      decidedBy: 'caller',
      metadata: { source: 'sip_dtmf' },
    });
    if (!job) {
      return { approved: false, code: 'NO_PENDING_APPROVAL', message: 'There is no task waiting for confirmation.' };
    }
    const thread = this.stateStore.getThread(voiceThreadId);
    this.stateStore.appendAuditEvent({
      voiceThreadId,
      realtimeSessionId: job.realtime_session_id,
      jobId: job.id,
      callerId: thread?.caller_id || 'unknown',
      action: 'approval_granted',
      riskLevel: job.risk_level || 'mutating',
      profile: job.profile,
      requestHash: job.request_hash,
      scopeText: job.approval_summary || job.request,
      metadata: { method: 'dtmf-pound' },
    });
    this._scheduleExecution(job.id);
    return { approved: true, job: voiceSafeJob(job) };
  }

  _scheduleExecution(jobId) {
    if (this.activeExecutions.has(jobId)) return this.activeExecutions.get(jobId);
    const promise = new Promise((resolve) => setImmediate(resolve))
      .then(() => this._execute(jobId))
      .finally(() => this.activeExecutions.delete(jobId));
    this.activeExecutions.set(jobId, promise);
    return promise;
  }

  async _execute(jobId) {
    if (this.getExecutionLock().locked) return this.stateStore.getJob(jobId);
    const queuedJob = this.stateStore.getJob(jobId);
    if (!queuedJob || queuedJob.status !== 'queued') return queuedJob;

    const run = () => queuedJob.jobKind === 'tmux_agent_message'
      ? this._runTargetSessionMessage(queuedJob)
      : this._runAgent(queuedJob);
    return queuedJob.requiresApproval
      ? this.workspaceMutex.run(run)
      : run();
  }

  async _runTargetSessionMessage(queuedJob) {
    if (this.getExecutionLock().locked) return this.stateStore.getJob(queuedJob.id);
    const job = this.stateStore.markJobRunning(queuedJob.id);
    if (!job) return this.stateStore.getJob(queuedJob.id);
    const thread = this.stateStore.getThread(job.voice_thread_id);
    const target = job.operation?.target;
    const targetLabel = targetConversationLabel(job.operation, job.provider);
    this.stateStore.appendAuditEvent({
      voiceThreadId: job.voice_thread_id,
      realtimeSessionId: job.realtime_session_id,
      jobId: job.id,
      callerId: thread?.caller_id || 'unknown',
      action: 'target_session_message_started',
      riskLevel: job.risk_level || 'mutating',
      profile: job.profile,
      requestHash: job.request_hash,
      scopeText: job.approval_summary || job.request,
      metadata: { target, provider: job.provider, approval_method: job.approval_method || null },
    });
    this._emitSafely('job.updated', job);

    try {
      if (!target || !job.operation?.sessionFingerprint) {
        throw Object.assign(new Error('The approved target-session binding is unavailable.'), {
          code: 'TARGET_SESSION_BINDING_MISSING',
        });
      }
      const response = await this.agentBridge.sendAgentSessionMessage({
        operationId: job.id,
        target,
        message: job.request,
        sessionFingerprint: job.operation.sessionFingerprint,
        timeoutSeconds: job.operation.timeoutSeconds,
        authorization: buildAuthorizationEnvelope(job),
      });
      if (!response?.success || !response.result) {
        throw Object.assign(new Error(response?.error || response?.userMessage || 'Target-session delivery failed.'), {
          userMessage: response?.userMessage,
          code: response?.code,
        });
      }
      const result = response.result;
      if (!result.delivered) {
        throw Object.assign(new Error('The provider did not verify both exact delivery and a final response.'), {
          code: 'TARGET_RESPONSE_UNVERIFIED',
        });
      }
      const latest = this.stateStore.getJob(job.id);
      if (latest?.status === 'canceled') {
        this._emitSafely('job.updated', latest);
        return latest;
      }
      const deliveredWithoutResponse = Boolean(result.canceled_after_delivery && !result.response_verified);
      if (!deliveredWithoutResponse && (!result.response_verified || !result.response)) {
        throw Object.assign(new Error('The provider did not verify a final response after delivery.'), {
          code: 'TARGET_RESPONSE_UNVERIFIED',
        });
      }
      const voiceResult = deliveredWithoutResponse
        ? clip(`${targetLabel} received the message, but cancellation interrupted it before a final reply.`, 500)
        : clip(`${targetLabel} replied: ${result.response}`, 500);
      const completed = this.stateStore.markJobCompleted(job.id, {
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
      });
      if (completed.status !== 'completed') {
        this._emitSafely('job.updated', completed);
        return completed;
      }
      this.stateStore.appendEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        role: 'tool',
        kind: 'agent_result',
        content: `${target} ${job.id}: ${voiceResult}`,
      });
      this.stateStore.appendAuditEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        jobId: job.id,
        callerId: thread?.caller_id || 'unknown',
        action: deliveredWithoutResponse
          ? 'target_session_message_delivered_then_canceled'
          : 'target_session_message_verified',
        riskLevel: job.risk_level || 'mutating',
        profile: job.profile,
        requestHash: job.request_hash,
        scopeText: job.approval_summary || job.request,
        metadata: {
          target: result.target || job.operation?.canonicalTarget || target,
          stable_target: target,
          conversation_name: job.operation?.conversationName || null,
          provider: job.provider,
          duration_ms: result.duration_ms || null,
          cancellation_arrived_after_completion: Boolean(result.cancellation_arrived_after_completion),
        },
      });
      this._emitSafely('job.completed', completed);
      await this._dispatchCallbackIfRequested(completed);
      return completed;
    } catch (error) {
      if (error.code === 'TARGET_MESSAGE_CANCELED') {
        return this.stateStore.getJob(job.id);
      }
      const latest = this.stateStore.getJob(job.id);
      if (latest?.status === 'canceled') {
        this._emitSafely('job.updated', latest);
        return latest;
      }
      const failed = this.stateStore.markJobFailed(
        job.id,
        error.userMessage || error.message || 'Target-session delivery failed.'
      );
      this.stateStore.appendEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        role: 'tool',
        kind: 'agent_error',
        content: `${target || 'unknown target'} ${job.id}: ${failed.error}`,
      });
      this.stateStore.appendAuditEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        jobId: job.id,
        callerId: thread?.caller_id || 'unknown',
        action: 'target_session_message_failed',
        riskLevel: job.risk_level || 'mutating',
        profile: job.profile,
        requestHash: job.request_hash,
        scopeText: job.approval_summary || job.request,
        metadata: { target: target || null, provider: job.provider, code: error.code || null },
      });
      this._emitSafely('job.completed', failed);
      await this._dispatchCallbackIfRequested(failed);
      return failed;
    }
  }

  async _runAgent(queuedJob) {
    if (this.getExecutionLock().locked) return this.stateStore.getJob(queuedJob.id);
    const job = this.stateStore.markJobRunning(queuedJob.id);
    if (!job) return this.stateStore.getJob(queuedJob.id);
    const thread = this.stateStore.getThread(job.voice_thread_id);
    this.stateStore.appendAuditEvent({
      voiceThreadId: job.voice_thread_id,
      realtimeSessionId: job.realtime_session_id,
      jobId: job.id,
      callerId: thread?.caller_id || 'unknown',
      action: 'job_started',
      riskLevel: job.risk_level || 'read_only',
      profile: job.profile,
      requestHash: job.request_hash,
      scopeText: job.approval_summary || job.request,
      metadata: { approved: Boolean(job.approved_at), approval_method: job.approval_method || null },
    });

    const definition = PROFILE_DEFINITIONS[job.profile];
    let agentSession = this.stateStore.getAgentSession(job.voice_thread_id, job.profile);
    if (job.freshSession && agentSession) {
      this.stateStore.clearAgentSession(job.voice_thread_id, job.profile);
      agentSession = null;
    }

    if (!agentSession) {
      const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
      agentSession = this.stateStore.upsertAgentSession({
        voiceThreadId: job.voice_thread_id,
        profile: job.profile,
        provider: definition.provider,
        bridgeSessionKey: `${job.voice_thread_id}:${job.profile}:${nonce}`,
      });
    }

    this._emitSafely('job.updated', job);

    try {
      const result = await this.agentBridge.queryDetailed(job.request, {
        callId: job.id,
        sessionKey: agentSession.bridge_session_key,
        resumeSessionId: agentSession.provider_session_id || null,
        sessionType: definition.sessionType,
        timeout: definition.timeoutSeconds,
        authorization: buildAuthorizationEnvelope(job),
      });

      if (!result.success) {
        throw Object.assign(new Error(result.error || result.userMessage || 'Agent task failed'), {
          userMessage: result.userMessage,
          code: result.agentCode || result.code,
        });
      }

      const latest = this.stateStore.getJob(job.id);
      if (latest?.status === 'canceled') {
        this._emitSafely('job.updated', latest);
        return latest;
      }

      if (result.sessionId) {
        this.stateStore.upsertAgentSession({
          voiceThreadId: job.voice_thread_id,
          profile: job.profile,
          provider: definition.provider,
          bridgeSessionKey: agentSession.bridge_session_key,
          providerSessionId: result.sessionId,
        });
      }

      const voiceResult = clip(extractVoiceLine(result.response || 'Task completed.'), 500);
      const completed = this.stateStore.markJobCompleted(job.id, {
        voiceResult,
        fullResult: {
          response: result.response,
          provider: result.provider,
          duration_ms: result.duration_ms,
          session_id: result.sessionId || null,
        },
      });
      if (completed.status !== 'completed') {
        this._emitSafely('job.updated', completed);
        return completed;
      }
      this.stateStore.appendEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        role: 'tool',
        kind: 'agent_result',
        content: `${job.profile} ${job.id}: ${voiceResult}`,
      });
      this.stateStore.appendAuditEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        jobId: job.id,
        callerId: thread?.caller_id || 'unknown',
        action: 'job_completed',
        riskLevel: job.risk_level || 'read_only',
        profile: job.profile,
        requestHash: job.request_hash,
        scopeText: job.approval_summary || job.request,
        metadata: { duration_ms: result.duration_ms || null, provider: result.provider || definition.provider },
      });
      this._emitSafely('job.completed', completed);
      await this._dispatchCallbackIfRequested(completed);
      return completed;
    } catch (error) {
      const latest = this.stateStore.getJob(job.id);
      if (latest?.status === 'canceled') {
        this._emitSafely('job.updated', latest);
        return latest;
      }

      const failed = this.stateStore.markJobFailed(
        job.id,
        error.userMessage || error.message || 'Agent task failed'
      );
      this.stateStore.appendEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        role: 'tool',
        kind: 'agent_error',
        content: `${job.profile} ${job.id}: ${failed.error}`,
      });
      this.stateStore.appendAuditEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        jobId: job.id,
        callerId: thread?.caller_id || 'unknown',
        action: 'job_failed',
        riskLevel: job.risk_level || 'read_only',
        profile: job.profile,
        requestHash: job.request_hash,
        scopeText: job.approval_summary || job.request,
        metadata: { error: failed.error },
      });
      this._emitSafely('job.completed', failed);
      await this._dispatchCallbackIfRequested(failed);
      return failed;
    }
  }

  async _dispatchCallbackIfRequested(job) {
    if (job.notification_mode !== 'callback' || typeof this.callbackDispatcher !== 'function') {
      return;
    }
    try {
      await this.callbackDispatcher(job, this.stateStore.getThread(job.voice_thread_id));
    } catch (error) {
      this.emit('callback.error', { job, error });
    }
  }

  async panicStop(reason = 'Voice emergency stop', source = 'local_panic') {
    this.executionLocked = true;
    this.executionLockReason = String(reason || 'Voice emergency stop').slice(0, 1000);

    const persistentLock = this.executionControl?.lock?.({
      reason: this.executionLockReason,
      source,
    }) || {
      locked: true,
      persistent: false,
      reason: this.executionLockReason,
      error: 'No persistent execution control is configured',
    };

    const activeJobs = this.stateStore
      .listAllActiveJobs()
      .filter((job) => job.status === 'running');
    const canceledJobs = this.stateStore.cancelAllActiveJobs(this.executionLockReason);
    for (const job of canceledJobs) {
      const thread = this.stateStore.getThread(job.voice_thread_id);
      this.stateStore.appendAuditEvent({
        voiceThreadId: job.voice_thread_id,
        realtimeSessionId: job.realtime_session_id,
        jobId: job.id,
        callerId: thread?.caller_id || 'unknown',
        action: 'emergency_stop',
        riskLevel: job.risk_level || 'read_only',
        profile: job.profile,
        requestHash: job.request_hash,
        scopeText: job.approval_summary || job.request,
        metadata: { reason: this.executionLockReason, source },
      });
      this._emitSafely('job.updated', job);
    }

    let bridgeResult;
    try {
      if (typeof this.agentBridge.panicStop === 'function') {
        bridgeResult = await this.agentBridge.panicStop({
          reason: this.executionLockReason,
          source,
        });
      } else {
        const bridgeCancellations = await Promise.allSettled(
          activeJobs.map((job) => {
            const session = this.stateStore.getAgentSession(job.voice_thread_id, job.profile);
            return this.agentBridge.cancelSession(job.id, {
              sessionKey: session?.bridge_session_key || job.id,
              resetSession: false,
              reason: this.executionLockReason,
            });
          })
        );
        bridgeResult = {
          success: bridgeCancellations.every((result) => result.status === 'fulfilled'),
          canceledCount: activeJobs.length,
          failures: bridgeCancellations.filter((result) => result.status === 'rejected').length,
        };
      }
    } catch (error) {
      bridgeResult = { success: false, error: error.message };
    }

    return {
      locked: true,
      reason: this.executionLockReason,
      canceledCount: canceledJobs.length,
      runningCount: activeJobs.length,
      persistent: Boolean(persistentLock.persistent),
      persistentLock,
      bridge: bridgeResult,
      jobs: canceledJobs.map(voiceSafeJob),
    };
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
    return {
      locked: this.executionLocked,
      reason: this.executionLockReason,
      persistent: persistedLock ? Boolean(persistedLock.persistent) : false,
      error: persistedLock?.error || null,
    };
  }

  unlockExecution(source = 'operator') {
    const result = this.executionControl?.unlock?.({ source }) || {
      locked: false,
      persistent: false,
      wasLocked: this.executionLocked,
    };
    if (result.locked === false) {
      this.executionLocked = false;
      this.executionLockReason = null;
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
