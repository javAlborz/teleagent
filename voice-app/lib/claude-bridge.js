/**
 * Teleagent HTTP Agent Bridge client
 * HTTP client for the Claude/Codex API server with session management
 */

const axios = require('axios');
const { AGENT_API_URL, buildAgentApiHeaders } = require('./claude-api-config');
const { looksLikePhoneDeployRequest } = require('../../lib/phone-deploy-intent');

const PHONE_DEPLOY_TIMEOUT_SECONDS = (() => {
  const parsed = Number.parseInt(process.env.PHONE_DEPLOY_TIMEOUT_SECONDS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 900;
})();
const AGENT_LOG_SENSITIVE = /^(1|true|yes)$/i.test(
  process.env.AGENT_LOG_SENSITIVE || process.env.CLAUDE_LOG_SENSITIVE || ''
);

function summarizeText(text, limit = 100) {
  const value = String(text || '');
  if (AGENT_LOG_SENSITIVE) {
    return `"${value.substring(0, limit)}${value.length > limit ? '...' : ''}"`;
  }
  return `chars=${value.length}`;
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
    default:
      return "I encountered an unexpected error. Please check that the API server is running claude-phone api-server and is on the same network.";
  }
}

async function sendQuery(prompt, options = {}) {
  const {
    callId,
    sessionKey = callId,
    resumeSessionId = null,
    devicePrompt,
    timeout = 30,
    sessionType
  } = options;
  const timestamp = new Date().toISOString();
  const deployIntent =
    String(sessionType || '').startsWith('phone') &&
    looksLikePhoneDeployRequest(prompt, devicePrompt);
  const effectiveTimeout = deployIntent ? Math.max(timeout, PHONE_DEPLOY_TIMEOUT_SECONDS) : timeout;

  try {
    console.log(`[${timestamp}] AGENT Sending query to ${AGENT_API_URL}...`);
    console.log(
      `[${timestamp}] AGENT Query meta: prompt=${summarizeText(prompt)} callLinked=${valuePresence(callId)} sessionKey=${valuePresence(sessionKey && sessionKey !== callId ? sessionKey : '')} devicePrompt=${valuePresence(devicePrompt)}`
    );
    console.log(`[${timestamp}] AGENT Deploy intent: ${deployIntent}`);
    console.log(`[${timestamp}] AGENT Timeout: ${effectiveTimeout}s`);

    const response = await axios.post(
      `${AGENT_API_URL}/ask`,
      {
        prompt,
        callId,
        sessionKey,
        resumeSessionId,
        devicePrompt,
        sessionType,
        timeoutSeconds: effectiveTimeout,
      },
      {
        timeout: effectiveTimeout * 1000,
        headers: buildAgentApiHeaders({ 'Content-Type': 'application/json' })
      }
    );

    if (response.data.success) {
      console.log(`[${timestamp}] AGENT Response received: provider=${response.data.provider || 'claude'} duration=${response.data.duration_ms}ms`);
      console.log(`[${timestamp}] AGENT Session updated: ${valuePresence(response.data.sessionId)}`);

      return {
        success: true,
        response: response.data.response,
        sessionId: response.data.sessionId || null,
        provider: response.data.provider || null,
        duration_ms: response.data.duration_ms || null,
      };
    }

    const code = response.data.code || 'CLAUDE_ERROR';
    const agentCode = response.data.agentCode || code.replace(/^CLAUDE_/, 'AGENT_');
    return {
      success: false,
      code,
      agentCode,
      provider: response.data.provider || null,
      error: response.data.error || 'Agent API returned failure',
      reason: response.data.reason || null,
      duration_ms: response.data.duration_ms || null,
      userMessage: response.data.userMessage || buildFriendlyErrorMessage(agentCode),
    };

  } catch (error) {
    if (error.response?.data) {
      const apiFailure = error.response.data;
      const code = apiFailure.code || 'CLAUDE_ERROR';
      const agentCode = apiFailure.agentCode || code.replace(/^CLAUDE_/, 'AGENT_');
      return {
        success: false,
        code,
        agentCode,
        provider: apiFailure.provider || null,
        error: apiFailure.error || error.message,
        reason: apiFailure.reason || null,
        duration_ms: apiFailure.duration_ms || null,
        userMessage: apiFailure.userMessage || buildFriendlyErrorMessage(agentCode),
      };
    }

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

    console.error(`[${timestamp}] AGENT Error:`, error.message);
    return {
      success: false,
      code: 'CLAUDE_ERROR',
      agentCode: 'AGENT_ERROR',
      error: error.message,
      duration_ms: null,
      userMessage: buildFriendlyErrorMessage('CLAUDE_ERROR'),
    };
  }
}

/**
 * Query the configured agent via HTTP API with session support
 * @param {string} prompt - The prompt/question to send to the agent
 * @param {Object} options - Options including callId for session management
 * @param {string} options.callId - Call UUID for active request cancellation
 * @param {string} [options.sessionKey] - Stable agent session UUID for resumable context
 * @param {string} [options.resumeSessionId] - Durable provider session ID restored by the voice state store
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
    resetSession = false,
    reason = 'cancel_session'
  } = options;

  try {
    const response = await axios.post(
      `${AGENT_API_URL}/cancel-session`,
      { callId, sessionKey, resetSession, reason },
      {
        timeout: 5000,
        headers: buildAgentApiHeaders({ 'Content-Type': 'application/json' })
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
        headers: buildAgentApiHeaders({ 'Content-Type': 'application/json' }),
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
      headers: buildAgentApiHeaders(),
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
        headers: buildAgentApiHeaders({ 'Content-Type': 'application/json' }),
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
      `${AGENT_API_URL}/end-session`,
      { callId, sessionKey, preserveForSeconds },
      { 
        timeout: 5000,
        headers: buildAgentApiHeaders({ 'Content-Type': 'application/json' })
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
      headers: buildAgentApiHeaders()
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  query,
  queryDetailed,
  cancelSession,
  panicStop,
  getVoiceExecutionStatus,
  unlockVoiceExecution,
  endSession,
  isAvailable
};
