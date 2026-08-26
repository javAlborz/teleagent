/**
 * Teleagent HTTP Agent Bridge client
 * HTTP client for fresh Claude/Codex jobs with Teleagent-owned correlation
 */

const axios = require('axios');
const crypto = require('node:crypto');
const {
  AGENT_API_URL,
  buildExecutorApiHeaders,
  buildVoiceControlApiHeaders,
} = require('./claude-api-config');
const { looksLikePhoneDeployRequest } = require('../../lib/phone-deploy-intent');
const {
  assertSensitiveAgentLoggingDisabled,
  summarizeSensitiveText,
} = require('../../lib/safe-agent-logging');

const PHONE_DEPLOY_TIMEOUT_SECONDS = (() => {
  const parsed = Number.parseInt(process.env.PHONE_DEPLOY_TIMEOUT_SECONDS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 900;
})();
assertSensitiveAgentLoggingDisabled();

function summarizeText(text) {
  return summarizeSensitiveText(text);
}

function valuePresence(value) {
  return value ? 'yes' : 'no';
}

function buildFriendlyErrorMessage(code) {
  switch (code) {
    case 'AGENT_TIMEOUT':
    case 'CLAUDE_TIMEOUT':
      return `I'm sorry, that request took too long. This might mean the API server is slow or there's a network issue. Try asking something simpler, or check that claude-phone api-server is running.`;
    case 'AGENT_CANCELED':
    case 'CLAUDE_CANCELED':
      return 'Okay, I stopped that request.';
    case 'AGENT_API_UNAVAILABLE':
    case 'CLAUDE_API_UNAVAILABLE':
      return "I'm having trouble connecting to my brain right now. The API server may be offline or unreachable. Please try again later.";
    case 'AGENT_VOICE_EXECUTION_LOCKED':
    case 'VOICE_EXECUTION_LOCKED':
      return 'Voice-started agent work is locked after an emergency stop. An operator must unlock it locally before I can start another task.';
    case 'EXECUTION_OUTCOME_UNKNOWN':
    case 'AGENT_EXECUTION_OUTCOME_UNKNOWN':
      return 'That task may have completed, but the executor restarted before it could verify the result. I will not repeat it automatically.';
    default:
      return "I encountered an unexpected error. Please check that the API server is running claude-phone api-server and is on the same network.";
  }
}

function isPhoneSessionType(sessionType) {
  return /^phone(?:-|$)/i.test(String(sessionType || ''));
}

function durableExecutorEnabled(options = {}) {
  if (!isPhoneSessionType(options.sessionType)) return false;
  if (options.durableExecutor === false) return false;
  const configured = String(process.env.AGENT_DURABLE_EXECUTOR_ENABLED ?? 'true').trim();
  return !/^(?:0|false|no|off)$/i.test(configured);
}

function buildDurableIdempotencyKey(prompt, options = {}) {
  const explicit = options.idempotencyKey || options.executorIdempotencyKey || options.jobId;
  if (explicit) return String(explicit).trim().slice(0, 200);

  // AgentJobBroker uses its durable voice job id as callId. Preserve that
  // exact key so it can recover the executor task after a voice-app restart.
  const callId = String(options.callId || '').trim();
  if (/^job_[A-Za-z0-9]+$/.test(callId)) return callId;

  // Legacy phone calls have one call id but can ask several questions. Bind
  // retries to the exact managed request instead of conflating every turn.
  const canonical = JSON.stringify({
    callId,
    sessionKey: String(options.sessionKey || options.callId || ''),
    sessionType: String(options.sessionType || ''),
    devicePrompt: String(options.devicePrompt || ''),
    prompt: String(prompt || ''),
  });
  return `voice_${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

function normalizeAgentApiPayload(data = {}) {
  if (data.success) {
    return {
      success: true,
      response: data.response,
      provider: data.provider || null,
      duration_ms: data.duration_ms || null,
    };
  }

  const code = data.code || 'CLAUDE_ERROR';
  const agentCode = data.agentCode || code.replace(/^CLAUDE_/, 'AGENT_');
  const normalized = {
    success: false,
    code,
    agentCode,
    provider: data.provider || null,
    error: data.error || 'Agent API returned failure',
    reason: data.reason || null,
    duration_ms: data.duration_ms || null,
    userMessage: data.userMessage || buildFriendlyErrorMessage(agentCode),
  };
  if (data.response) normalized.response = String(data.response);
  if (data.execution_outcome_unknown === true) normalized.execution_outcome_unknown = true;
  if (data.reconciliation_required === true) normalized.reconciliation_required = true;
  if (data.recovered === true) normalized.recovered = true;
  if (data.processExit) normalized.processExit = String(data.processExit);
  return normalized;
}

function mapBridgeError(error, { timestamp, effectiveTimeout }) {
  if (error.response?.data) return normalizeAgentApiPayload(error.response.data);

  if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
    console.warn(`[${timestamp}] AGENT API server unreachable (${error.code})`);
    return {
      success: false,
      code: 'CLAUDE_API_UNAVAILABLE',
      agentCode: 'AGENT_API_UNAVAILABLE',
      error: error.message,
      duration_ms: null,
      userMessage: buildFriendlyErrorMessage('CLAUDE_API_UNAVAILABLE'),
    };
  }

  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    console.error(`[${timestamp}] AGENT Timeout after ${effectiveTimeout} seconds`);
    return {
      success: false,
      code: 'CLAUDE_TIMEOUT',
      agentCode: 'AGENT_TIMEOUT',
      error: error.message,
      duration_ms: null,
      userMessage: buildFriendlyErrorMessage('CLAUDE_TIMEOUT'),
    };
  }

  console.error(`[${timestamp}] AGENT Error: ${error.message}`);
  return {
    success: false,
    code: 'CLAUDE_ERROR',
    agentCode: 'AGENT_ERROR',
    error: error.message,
    duration_ms: null,
    userMessage: buildFriendlyErrorMessage('CLAUDE_ERROR'),
  };
}

function executorPollIntervalMs(options = {}) {
  const configured = Number.parseInt(
    options.pollIntervalMs || process.env.AGENT_DURABLE_EXECUTOR_POLL_MS || '',
    10
  );
  return Math.max(10, Math.min(Number.isInteger(configured) ? configured : 500, 5000));
}

function executorWaitTimeoutMs(options = {}) {
  const explicit = Number.parseInt(options.timeoutMs, 10);
  if (Number.isInteger(explicit) && explicit > 0) {
    return Math.max(10, Math.min(explicit, 2 * 60 * 60 * 1000));
  }
  const timeoutSeconds = Number.parseInt(options.timeoutSeconds, 10);
  const baseSeconds = Number.isInteger(timeoutSeconds) && timeoutSeconds > 0
    ? timeoutSeconds
    : 30;
  return Math.min((baseSeconds + 30) * 1000, 2 * 60 * 60 * 1000);
}

function canceledExecutorResponse(task, code = 'CLAUDE_CANCELED') {
  const persistedPayload = task?.result?.payload;
  if (task?.taskType === 'target_session_message' &&
      persistedPayload && typeof persistedPayload === 'object') {
    return {
      ...persistedPayload,
      executorTaskId: task.id || null,
      idempotencyKey: task.idempotencyKey || null,
    };
  }
  if (task?.taskType === 'managed_ask' && persistedPayload &&
      typeof persistedPayload === 'object' && (
        persistedPayload.success === true ||
        persistedPayload.code === 'EXECUTION_OUTCOME_UNKNOWN' ||
        persistedPayload.agentCode === 'EXECUTION_OUTCOME_UNKNOWN'
      )) {
    return {
      ...normalizeAgentApiPayload(persistedPayload),
      executorTaskId: task.id || null,
      idempotencyKey: task.idempotencyKey || null,
    };
  }
  return {
    success: false,
    code,
    agentCode: 'AGENT_CANCELED',
    provider: task?.result?.payload?.provider || null,
    error: task?.errorMessage || 'Agent request canceled',
    reason: task?.cancelReason || 'cancel_session',
    duration_ms: task?.result?.payload?.duration_ms || null,
    userMessage: buildFriendlyErrorMessage('AGENT_CANCELED'),
    executorTaskId: task?.id || null,
    idempotencyKey: task?.idempotencyKey || null,
  };
}

function mapExecutorTaskResult(task) {
  if (!task || !task.terminal) return null;
  if (task.state === 'canceled') return canceledExecutorResponse(task);

  const payload = task.result?.payload;
  if (payload && typeof payload === 'object') {
    const mapped = task.taskType === 'managed_ask'
      ? normalizeAgentApiPayload(payload)
      : payload;
    return {
      ...mapped,
      executorTaskId: task.id,
      idempotencyKey: task.idempotencyKey,
    };
  }

  if (task.state === 'completed') {
    return {
      success: true,
      result: task.result || null,
      executorTaskId: task.id,
      idempotencyKey: task.idempotencyKey,
    };
  }

  const code = task.errorCode || 'AGENT_EXECUTOR_FAILED';
  return {
    success: false,
    code,
    agentCode: code.replace(/^CLAUDE_/, 'AGENT_'),
    error: task.errorMessage || 'Durable agent execution failed',
    userMessage: buildFriendlyErrorMessage(code),
    executorTaskId: task.id,
    idempotencyKey: task.idempotencyKey,
  };
}

async function getExecutorTask(taskId, options = {}) {
  const response = await axios.get(
    `${AGENT_API_URL}/executor/tasks/${encodeURIComponent(String(taskId || ''))}`,
    {
      timeout: Math.max(100, Math.min(Number.parseInt(options.timeoutMs, 10) || 5000, 5000)),
      headers: buildExecutorApiHeaders(),
      maxRedirects: 0,
    }
  );
  return response.data?.task || null;
}

async function getExecutorTaskByIdempotency(idempotencyKey, options = {}) {
  try {
    const response = await axios.get(
      `${AGENT_API_URL}/executor/tasks/by-idempotency/${encodeURIComponent(String(idempotencyKey || ''))}`,
      {
        timeout: Math.max(100, Math.min(Number.parseInt(options.timeoutMs, 10) || 5000, 5000)),
        headers: buildExecutorApiHeaders(),
        maxRedirects: 0,
      }
    );
    return response.data?.task || null;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

function wait(milliseconds, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForExecutorTask(existingTaskOrId, options = {}) {
  let task = typeof existingTaskOrId === 'object' && existingTaskOrId
    ? existingTaskOrId
    : null;
  const taskId = task?.id || String(existingTaskOrId || '');
  if (!taskId) {
    return {
      success: false,
      code: 'EXECUTOR_TASK_ID_REQUIRED',
      agentCode: 'AGENT_EXECUTOR_TASK_ID_REQUIRED',
      error: 'A durable executor task id is required',
      userMessage: buildFriendlyErrorMessage('AGENT_EXECUTOR_TASK_ID_REQUIRED'),
    };
  }

  const timeoutMs = executorWaitTimeoutMs(options);
  const pollIntervalMs = executorPollIntervalMs(options);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    if (options.signal?.aborted) return canceledExecutorResponse(task);
    if (task?.terminal) return mapExecutorTaskResult(task);

    try {
      task = await getExecutorTask(taskId, {
        timeoutMs: Math.max(100, Math.min(5000, deadline - Date.now())),
      });
      lastError = null;
      if (task?.terminal) return mapExecutorTaskResult(task);
    } catch (error) {
      lastError = error;
      if (error.response?.status === 404) {
        return {
          success: false,
          code: 'EXECUTOR_TASK_NOT_FOUND',
          agentCode: 'AGENT_EXECUTOR_TASK_NOT_FOUND',
          error: `Durable executor task ${taskId} was not found`,
          userMessage: buildFriendlyErrorMessage('AGENT_EXECUTOR_TASK_NOT_FOUND'),
          executorTaskId: taskId,
        };
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining), options.signal);
  }

  return {
    success: false,
    code: 'CLAUDE_TIMEOUT',
    agentCode: 'AGENT_TIMEOUT',
    error: lastError?.message || `Timed out waiting for durable executor task ${taskId}`,
    duration_ms: null,
    userMessage: buildFriendlyErrorMessage('AGENT_TIMEOUT'),
    executorTaskId: taskId,
    idempotencyKey: task?.idempotencyKey || null,
  };
}

async function recoverAmbiguousExecutorSubmission(idempotencyKey, options = {}) {
  const attempts = Math.max(1, Math.min(Number.parseInt(options.attempts, 10) || 5, 20));
  const retryMs = Math.max(10, Math.min(Number.parseInt(options.retryMs, 10) || 100, 1000));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const task = await getExecutorTaskByIdempotency(idempotencyKey, { timeoutMs: 2000 });
      if (task) return task;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    }
    if (attempt < attempts - 1) await wait(retryMs, options.signal);
  }
  return null;
}

async function submitDurableManagedQuery(request, options = {}) {
  const idempotencyKey = buildDurableIdempotencyKey(request.prompt, options);
  const submitTimeoutMs = Math.max(
    1000,
    Math.min(
      Number.parseInt(process.env.AGENT_DURABLE_EXECUTOR_SUBMIT_TIMEOUT_MS || '', 10) || 10000,
      30000
    )
  );
  let task;
  try {
    const response = await axios.post(
      `${AGENT_API_URL}/executor/tasks`,
      {
        idempotencyKey,
        taskType: 'managed_ask',
        request,
        metadata: {
          source: 'voice_app',
          controllerJobId: /^job_[A-Za-z0-9]+$/.test(String(options.callId || ''))
            ? options.callId
            : undefined,
          profile: options.sessionType || undefined,
        },
      },
      {
        timeout: submitTimeoutMs,
        headers: buildExecutorApiHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        }),
        maxRedirects: 0,
      }
    );
    task = response.data?.task || null;
  } catch (error) {
    if (error.response) throw error;
    task = await recoverAmbiguousExecutorSubmission(idempotencyKey, {
      signal: options.signal,
    });
    if (!task) throw error;
  }

  if (!task?.id) {
    const error = new Error('Executor task submission returned no durable task id');
    error.code = 'EXECUTOR_TASK_ID_MISSING';
    throw error;
  }
  return waitForExecutorTask(task, {
    timeoutMs: options.durableWaitTimeoutMs,
    timeoutSeconds: options.timeoutSeconds,
    pollIntervalMs: options.durablePollIntervalMs,
    signal: options.signal,
  });
}

async function submitDurableTargetSessionMessage(request, options = {}) {
  const idempotencyKey = String(request?.operationId || '').trim();
  if (!/^job_[A-Za-z0-9]+$/.test(idempotencyKey)) {
    const error = new Error('A job-specific operationId is required for durable target delivery');
    error.code = 'OPERATION_ID_REQUIRED';
    throw error;
  }
  const submitTimeoutMs = Math.max(
    1000,
    Math.min(
      Number.parseInt(process.env.AGENT_DURABLE_EXECUTOR_SUBMIT_TIMEOUT_MS || '', 10) || 10000,
      30000
    )
  );
  let task;
  try {
    const response = await axios.post(
      `${AGENT_API_URL}/executor/tasks`,
      {
        idempotencyKey,
        taskType: 'target_session_message',
        request,
        metadata: {
          source: 'voice_app',
          controllerJobId: idempotencyKey,
          profile: options.profile || undefined,
        },
      },
      {
        timeout: submitTimeoutMs,
        headers: buildExecutorApiHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        }),
        maxRedirects: 0,
      }
    );
    task = response.data?.task || null;
  } catch (error) {
    if (error.response) throw error;
    // A no-response POST may have committed. Recover only by the exact
    // operation id; never resend the one-time approval capability.
    task = await recoverAmbiguousExecutorSubmission(idempotencyKey, {
      signal: options.signal,
    });
    if (!task) throw error;
  }

  if (!task?.id) {
    const error = new Error('Target executor submission returned no durable task id');
    error.code = 'EXECUTOR_TASK_ID_MISSING';
    throw error;
  }
  return waitForExecutorTask(task, {
    timeoutMs: options.durableWaitTimeoutMs,
    timeoutSeconds: request.timeoutSeconds,
    pollIntervalMs: options.durablePollIntervalMs,
    signal: options.signal,
  });
}

async function sendQuery(prompt, options = {}) {
  const {
    callId,
    sessionKey = callId,
    devicePrompt,
    timeout = 30,
    sessionType,
    authorization = null,
  } = options;
  const timestamp = new Date().toISOString();
  const deployIntent =
    String(sessionType || '').startsWith('phone') &&
    looksLikePhoneDeployRequest(prompt, devicePrompt);
  const effectiveTimeout = deployIntent ? Math.max(timeout, PHONE_DEPLOY_TIMEOUT_SECONDS) : timeout;

  if (!isPhoneSessionType(sessionType)) {
    return {
      success: false,
      code: 'VOICE_PHONE_SESSION_REQUIRED',
      agentCode: 'AGENT_PHONE_SESSION_REQUIRED',
      error: 'The voice bridge accepts only an explicit phone session profile.',
      userMessage: 'That request was blocked because it was not bound to a phone agent profile.',
    };
  }
  if (!durableExecutorEnabled(options)) {
    return {
      success: false,
      code: 'VOICE_DURABLE_EXECUTOR_REQUIRED',
      agentCode: 'AGENT_DURABLE_EXECUTOR_REQUIRED',
      error: 'Phone agent requests require the durable executor.',
      userMessage: 'Phone agent execution is unavailable because its durable executor is disabled.',
    };
  }

  try {
    console.log(`[${timestamp}] AGENT Sending query to ${AGENT_API_URL}...`);
    console.log(
      `[${timestamp}] AGENT Query meta: prompt=${summarizeText(prompt)} callLinked=${valuePresence(callId)} sessionKey=${valuePresence(sessionKey && sessionKey !== callId ? sessionKey : '')} devicePrompt=${valuePresence(devicePrompt)}`
    );
    console.log(`[${timestamp}] AGENT Deploy intent: ${deployIntent}`);
    console.log(`[${timestamp}] AGENT Timeout: ${effectiveTimeout}s`);

    const request = {
      prompt,
      callId,
      sessionKey,
      devicePrompt,
      sessionType,
      timeoutSeconds: effectiveTimeout,
      authorization,
    };

    const result = await submitDurableManagedQuery(request, {
      ...options,
      callId,
      sessionKey,
      devicePrompt,
      sessionType,
      timeoutSeconds: effectiveTimeout,
    });
    if (result.success) {
      console.log(`[${timestamp}] AGENT Durable response received: provider=${result.provider || 'claude'} duration=${result.duration_ms}ms`);
    }
    return result;

  } catch (error) {
    return mapBridgeError(error, { timestamp, effectiveTimeout });
  }
}

/**
 * Query the configured agent via HTTP API with session support
 * @param {string} prompt - The prompt/question to send to the agent
 * @param {Object} options - Options including callId for session management
 * @param {string} options.callId - Call UUID for active request cancellation
 * @param {string} [options.sessionKey] - Stable Teleagent correlation key; never a provider session ID
 * @param {string} options.devicePrompt - Device-specific personality prompt
 * @param {number} options.timeout - Timeout in seconds (default: 30, AC27)
 * @returns {Promise<string>} Agent response
 */
async function query(prompt, options = {}) {
  const result = await sendQuery(prompt, options);
  if (result.success) {
    return result.response;
  }
  return result.userMessage;
}

async function queryDetailed(prompt, options = {}) {
  return sendQuery(prompt, options);
}

async function cancelSession(callId, options = {}) {
  if (!callId) return { success: false, error: 'Missing callId' };

  const timestamp = new Date().toISOString();
  const {
    sessionKey = callId,
    idempotencyKey = callId,
    resetSession = false,
    reason = 'cancel_session'
  } = options;

  try {
    const response = await axios.post(
      `${AGENT_API_URL}/voice-control/session/cancel`,
      { callId, sessionKey, idempotencyKey, resetSession, reason },
      {
        timeout: 5000,
        headers: buildVoiceControlApiHeaders({ 'Content-Type': 'application/json' }),
        maxRedirects: 0,
      }
    );

    console.log(
      `[${timestamp}] AGENT Session cancel requested: callLinked=yes active=${response.data.active} canceled=${response.data.canceledCount}`
    );
    return response.data;
  } catch (error) {
    console.warn(`[${timestamp}] AGENT Failed to cancel session: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}

async function panicStop(options = {}) {
  const timestamp = new Date().toISOString();
  const {
    reason = 'voice_panic_stop',
    source = 'voice_app',
  } = options;

  try {
    const response = await axios.post(
      `${AGENT_API_URL}/voice-control/stop`,
      { reason, source },
      {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
        maxRedirects: 0,
      }
    );
    console.warn(
      `[${timestamp}] AGENT Voice panic stop: success=${response.data.success} canceled=${response.data.canceledCount || 0}`
    );
    return response.data;
  } catch (error) {
    console.error(`[${timestamp}] AGENT Voice panic stop failed: ${error.message}`);
    return {
      success: false,
      error: error.response?.data?.error || error.message,
    };
  }
}

async function getVoiceExecutionStatus() {
  try {
    const response = await axios.get(`${AGENT_API_URL}/voice-control/status`, {
      timeout: 5000,
      headers: buildVoiceControlApiHeaders(),
      maxRedirects: 0,
    });
    return response.data;
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.error || error.message,
    };
  }
}

async function unlockVoiceExecution(source = 'operator') {
  try {
    const response = await axios.post(
      `${AGENT_API_URL}/voice-control/unlock`,
      { source },
      {
        timeout: 5000,
        headers: buildVoiceControlApiHeaders({ 'Content-Type': 'application/json' }),
        maxRedirects: 0,
      }
    );
    return response.data;
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.error || error.message,
    };
  }
}

async function inspectOperator(action, args = {}) {
  try {
    const response = await axios.post(
      `${AGENT_API_URL}/operator/inspect`,
      { action, args },
      {
        timeout: 10000,
        headers: buildVoiceControlApiHeaders({ 'Content-Type': 'application/json' }),
        maxRedirects: 0,
      }
    );
    return response.data;
  } catch (error) {
    return {
      success: false,
      code: error.response?.data?.code || 'OPERATOR_INSPECTION_FAILED',
      error: error.response?.data?.error || error.message,
    };
  }
}

async function prepareAgentSessionMessage(target) {
  try {
    const response = await axios.post(
      `${AGENT_API_URL}/operator/session-message/prepare`,
      { target },
      {
        timeout: 10000,
        headers: buildVoiceControlApiHeaders({ 'Content-Type': 'application/json' }),
        maxRedirects: 0,
      }
    );
    return response.data;
  } catch (error) {
    return {
      success: false,
      code: error.response?.data?.code || 'TARGET_SESSION_PREPARE_FAILED',
      error: error.response?.data?.error || error.message,
      userMessage: error.response?.data?.userMessage || null,
    };
  }
}

async function sendAgentSessionMessage({
  operationId,
  target,
  message,
  sessionFingerprint,
  timeoutSeconds = 1800,
  authorization = null,
  durableExecutor = true,
  durableWaitTimeoutMs = null,
  durablePollIntervalMs = null,
  signal = null,
  profile = null,
} = {}) {
  const safeTimeoutSeconds = Math.max(30, Math.min(Number.parseInt(timeoutSeconds, 10) || 1800, 3600));
  const request = {
    operationId,
    target,
    message,
    sessionFingerprint,
    timeoutSeconds: safeTimeoutSeconds,
    authorization,
  };
  try {
    if (durableExecutor !== false) {
      return await submitDurableTargetSessionMessage(request, {
        durableWaitTimeoutMs,
        durablePollIntervalMs,
        signal,
        profile,
      });
    }
    const response = await axios.post(
      `${AGENT_API_URL}/operator/session-message`,
      request,
      {
        timeout: (safeTimeoutSeconds + 10) * 1000,
        headers: buildVoiceControlApiHeaders({ 'Content-Type': 'application/json' }),
        maxRedirects: 0,
      }
    );
    return response.data;
  } catch (error) {
    return {
      success: false,
      code: error.response?.data?.code || (
        ['ETIMEDOUT', 'ECONNABORTED'].includes(error.code)
          ? 'TARGET_RESPONSE_TIMEOUT'
          : 'TARGET_SESSION_MESSAGE_FAILED'
      ),
      error: error.response?.data?.error || error.message,
      userMessage: error.response?.data?.userMessage || null,
    };
  }
}

/**
 * End an agent session when a call ends
 * @param {string} callId - The call UUID to end the session for
 * @param {Object} options - Session end options
 * @param {string} [options.sessionKey] - Stable agent session UUID
 * @param {number} [options.preserveForSeconds=0] - Keep session resumable for this many seconds
 */
async function endSession(callId, options = {}) {
  if (!callId) return;

  const {
    sessionKey = callId,
    preserveForSeconds = 0
  } = options;
  
  const timestamp = new Date().toISOString();
  
  try {
    const response = await axios.post(
      `${AGENT_API_URL}/voice-control/session/end`,
      { callId, sessionKey, preserveForSeconds },
      { 
        timeout: 5000,
        headers: buildVoiceControlApiHeaders({ 'Content-Type': 'application/json' }),
        maxRedirects: 0,
      }
    );
    console.log(
      `[${timestamp}] AGENT Session ended: callLinked=yes sessionKey=${valuePresence(sessionKey)} preserved=${response.data.preserved}`
    );
    return response.data;
  } catch (error) {
    // Non-critical, just log
    console.warn(`[${timestamp}] AGENT Failed to end session: ${error.message}`);
    return {
      success: false,
      error: error.message,
      callId,
      sessionKey,
      preserved: false,
      hadSession: false,
    };
  }
}

/**
 * Check if the agent API is available
 * @returns {Promise<boolean>} True if API is reachable
 */
async function isAvailable() {
  try {
    await axios.get(`${AGENT_API_URL}/health`, {
      timeout: 5000,
      maxRedirects: 0,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  query,
  queryDetailed,
  buildDurableIdempotencyKey,
  durableExecutorEnabled,
  getExecutorTask,
  getExecutorTaskByIdempotency,
  waitForExecutorTask,
  mapExecutorTaskResult,
  submitDurableManagedQuery,
  submitDurableTargetSessionMessage,
  cancelSession,
  panicStop,
  getVoiceExecutionStatus,
  unlockVoiceExecution,
  inspectOperator,
  prepareAgentSessionMessage,
  sendAgentSessionMessage,
  endSession,
  isAvailable
};
