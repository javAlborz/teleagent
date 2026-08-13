'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers');
const { extractVoiceLine } = require('./conversation-loop');

const PROFILE_DEFINITIONS = Object.freeze({
  'claude-haiku': {
    provider: 'claude',
    sessionType: 'phone-haiku',
    timeoutSeconds: 600,
  },
  'claude-sonnet': {
    provider: 'claude',
    sessionType: 'phone-sonnet',
    timeoutSeconds: 1800,
  },
  'claude-opus': {
    provider: 'claude',
    sessionType: 'phone-opus',
    timeoutSeconds: 3600,
  },
  'codex-luna': {
    provider: 'codex',
    sessionType: 'phone-codex-luna',
    timeoutSeconds: 600,
  },
  'codex-terra': {
    provider: 'codex',
    sessionType: 'phone-codex-terra',
    timeoutSeconds: 1800,
  },
  'codex-sol': {
    provider: 'codex',
    sessionType: 'phone-codex-sol',
    timeoutSeconds: 3600,
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

const MUTATING_REQUEST = /\b(?:apply|approve|archive|build|change|commit|configure|create|delete|deploy|disable|edit|enable|execute|fix|install|merge|modify|move|publish|push|reboot|remove|rename|replace|restart|restore|roll\s*out|run\s+(?:the\s+)?(?:deploy|migration|update|upgrade)|send|ship|start|stop|terminate|update|upgrade|write)\b/i;
const HIGH_RISK_REQUEST = /\b(?:deploy|publish|push|merge|delete|remove|reboot|restart|restore|upgrade|install|send|ship|production|prod)\b/i;

function normalizeProfile(profile, fallback = 'codex-terra') {
  const value = String(profile || fallback).trim().toLowerCase();
  const normalized = PROFILE_ALIASES[value] || value;
  return PROFILE_DEFINITIONS[normalized] ? normalized : null;
}

function needsApproval(request) {
  return MUTATING_REQUEST.test(String(request || ''));
}

function clip(text, max = 240) {
  const value = String(text || '').replaceAll(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function voiceSafeJob(job) {
  if (!job) return null;
  return {
    job_id: job.id,
    profile: job.profile,
    status: job.status,
    request: clip(job.request, 160),
    result: job.voice_result || null,
    error: job.error ? clip(job.error, 180) : null,
    requires_confirmation: Boolean(job.requiresApproval && job.status === 'awaiting_approval'),
    created_at: job.created_at,
    completed_at: job.completed_at || null,
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
  constructor({ stateStore, agentBridge, callbackDispatcher = null } = {}) {
    super();
    if (!stateStore) throw new Error('AgentJobBroker requires stateStore');
    if (!agentBridge) throw new Error('AgentJobBroker requires agentBridge');
    this.stateStore = stateStore;
    this.agentBridge = agentBridge;
    this.callbackDispatcher = callbackDispatcher;
    this.workspaceMutex = new AsyncMutex();
    this.activeExecutions = new Map();
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

  async startAgentTask({
    voiceThreadId,
    realtimeSessionId,
    toolCallId,
    profile,
    request,
    freshSession = false,
    notificationMode = 'in_call',
  }) {
    const thread = this.stateStore.getThread(voiceThreadId);
    if (!thread) {
      return { accepted: false, code: 'VOICE_THREAD_NOT_FOUND', message: 'The voice thread no longer exists.' };
    }

    const normalizedProfile = normalizeProfile(profile, thread.selected_profile);
    if (!normalizedProfile) {
      return {
        accepted: false,
        code: 'UNKNOWN_AGENT_PROFILE',
        message: `Choose one of: ${this.listProfiles().join(', ')}.`,
      };
    }

    const normalizedRequest = String(request || '').trim();
    if (!normalizedRequest) {
      return { accepted: false, code: 'EMPTY_AGENT_REQUEST', message: 'Tell me what the agent should do.' };
    }

    const safeNotificationMode = ['in_call', 'callback', 'resume'].includes(notificationMode)
      ? notificationMode
      : 'in_call';
    const definition = PROFILE_DEFINITIONS[normalizedProfile];
    const requiresApproval = needsApproval(normalizedRequest);
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

    this.stateStore.setSelectedProfile(voiceThreadId, normalizedProfile);
    this.stateStore.appendEvent({
      voiceThreadId,
      realtimeSessionId,
      role: 'user',
      kind: 'agent_request',
      content: `${normalizedProfile}: ${normalizedRequest}`,
    });

    if (!requiresApproval) {
      this._scheduleExecution(result.job.id);
    }

    return {
      accepted: true,
      ...voiceSafeJob(result.job),
      confirmation_instruction: requiresApproval
        ? 'Ask the caller to press pound to approve or star to cancel. Do not claim the task has started yet.'
        : null,
      risk: HIGH_RISK_REQUEST.test(normalizedRequest) ? 'high' : (requiresApproval ? 'mutating' : 'read_only'),
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

  async cancelAgentTask(voiceThreadId, jobId = null, reason = 'Canceled by caller') {
    const job = jobId ? this.stateStore.getJob(jobId) : this.stateStore.getFocusedJob(voiceThreadId);
    if (!job || job.voice_thread_id !== voiceThreadId) {
      return { canceled: false, code: 'JOB_NOT_FOUND', message: 'There is no active job to cancel.' };
    }

    if (['completed', 'failed', 'canceled'].includes(job.status)) {
      return { canceled: false, code: 'JOB_ALREADY_FINISHED', job: voiceSafeJob(job) };
    }

    if (job.status === 'running') {
      const session = this.stateStore.getAgentSession(voiceThreadId, job.profile);
      await this.agentBridge.cancelSession(job.id, {
        sessionKey: session?.bridge_session_key || job.id,
        resetSession: false,
        reason,
      });
    }

    const canceled = this.stateStore.cancelJob(job.id, reason);
    this._emitSafely('job.updated', canceled);
    return { canceled: true, job: voiceSafeJob(canceled) };
  }

  approveNextJob(voiceThreadId) {
    const job = this.stateStore.approveNextJob(voiceThreadId);
    if (!job) {
      return { approved: false, code: 'NO_PENDING_APPROVAL', message: 'There is no task waiting for confirmation.' };
    }
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
    const queuedJob = this.stateStore.getJob(jobId);
    if (!queuedJob || queuedJob.status !== 'queued') return queuedJob;

    const run = () => this._runAgent(queuedJob);
    return queuedJob.requiresApproval
      ? this.workspaceMutex.run(run)
      : run();
  }

  async _runAgent(queuedJob) {
    const job = this.stateStore.markJobRunning(queuedJob.id);
    if (!job) return this.stateStore.getJob(queuedJob.id);

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
}

module.exports = {
  AgentJobBroker,
  PROFILE_DEFINITIONS,
  needsApproval,
  normalizeProfile,
  voiceSafeJob,
};
