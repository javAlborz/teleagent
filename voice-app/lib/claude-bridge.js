/**
 * Claude HTTP API Bridge
 * HTTP client for Claude API server with session management
 */

const axios = require('axios');
const { CLAUDE_API_URL, buildClaudeApiHeaders } = require('./claude-api-config');
const { looksLikePhoneDeployRequest } = require('../../lib/phone-deploy-intent');

const PHONE_DEPLOY_TIMEOUT_SECONDS = (() => {
  const parsed = Number.parseInt(process.env.PHONE_DEPLOY_TIMEOUT_SECONDS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 900;
})();

function buildFriendlyErrorMessage(code) {
  switch (code) {
    case 'CLAUDE_TIMEOUT':
      return `I'm sorry, that request took too long. This might mean the API server is slow or there's a network issue. Try asking something simpler, or check that claude-phone api-server is running.`;
    case 'CLAUDE_CANCELED':
      return 'Okay, I stopped that request.';
    case 'CLAUDE_API_UNAVAILABLE':
      return "I'm having trouble connecting to my brain right now. The API server may be offline or unreachable. Please try again later.";
    default:
      return "I encountered an unexpected error. Please check that the API server is running claude-phone api-server and is on the same network.";
  }
}

async function sendQuery(prompt, options = {}) {
  const {
    callId,
    sessionKey = callId,
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
    console.log(`[${timestamp}] CLAUDE Sending query to ${CLAUDE_API_URL}...`);
    if (callId) {
      console.log(`[${timestamp}] CLAUDE Session: ${callId}`);
    }
    if (sessionKey && sessionKey !== callId) {
      console.log(`[${timestamp}] CLAUDE Session key: ${sessionKey}`);
    }
    if (devicePrompt) {
      console.log(`[${timestamp}] CLAUDE Device prompt: ${devicePrompt.substring(0, 50)}...`);
    }
    console.log(`[${timestamp}] CLAUDE Deploy intent: ${deployIntent}`);
    console.log(`[${timestamp}] CLAUDE Timeout: ${effectiveTimeout}s`);

    const response = await axios.post(
      `${CLAUDE_API_URL}/ask`,
      { prompt, callId, sessionKey, devicePrompt, sessionType, timeoutSeconds: effectiveTimeout },
      {
        timeout: effectiveTimeout * 1000,
        headers: buildClaudeApiHeaders({ 'Content-Type': 'application/json' })
      }
    );

    if (response.data.success) {
      console.log(`[${timestamp}] CLAUDE Response received (${response.data.duration_ms}ms)`);
      if (response.data.sessionId) {
        console.log(`[${timestamp}] CLAUDE Session ID: ${response.data.sessionId}`);
      }

      return {
        success: true,
        response: response.data.response,
        sessionId: response.data.sessionId || null,
        duration_ms: response.data.duration_ms || null,
      };
    }

    const code = response.data.code || 'CLAUDE_ERROR';
    return {
      success: false,
      code,
      error: response.data.error || 'Claude API returned failure',
      reason: response.data.reason || null,
      duration_ms: response.data.duration_ms || null,
      userMessage: buildFriendlyErrorMessage(code),
    };

  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
      console.warn(`[${timestamp}] CLAUDE API server unreachable (${error.code})`);
      return {
        success: false,
        code: 'CLAUDE_API_UNAVAILABLE',
        error: error.message,
        duration_ms: null,
        userMessage: buildFriendlyErrorMessage('CLAUDE_API_UNAVAILABLE'),
      };
    }

    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      console.error(`[${timestamp}] CLAUDE Timeout after ${effectiveTimeout} seconds`);
      return {
        success: false,
        code: 'CLAUDE_TIMEOUT',
        error: error.message,
        duration_ms: null,
        userMessage: buildFriendlyErrorMessage('CLAUDE_TIMEOUT'),
      };
    }

    console.error(`[${timestamp}] CLAUDE Error:`, error.message);
    return {
      success: false,
      code: 'CLAUDE_ERROR',
      error: error.message,
      duration_ms: null,
      userMessage: buildFriendlyErrorMessage('CLAUDE_ERROR'),
    };
  }
}

/**
 * Query Claude via HTTP API with session support
 * @param {string} prompt - The prompt/question to send to Claude
 * @param {Object} options - Options including callId for session management
 * @param {string} options.callId - Call UUID for active request cancellation
 * @param {string} [options.sessionKey] - Stable Claude session UUID for resumable context
 * @param {string} options.devicePrompt - Device-specific personality prompt
 * @param {number} options.timeout - Timeout in seconds (default: 30, AC27)
 * @returns {Promise<string>} Claude's response
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
      `${CLAUDE_API_URL}/cancel-session`,
      { callId, sessionKey, resetSession, reason },
      {
        timeout: 5000,
        headers: buildClaudeApiHeaders({ 'Content-Type': 'application/json' })
      }
    );

    console.log(
      `[${timestamp}] CLAUDE Session cancel requested: ${callId} active=${response.data.active} canceled=${response.data.canceledCount}`
    );
    return response.data;
  } catch (error) {
    console.warn(`[${timestamp}] CLAUDE Failed to cancel session: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * End a Claude session when a call ends
 * @param {string} callId - The call UUID to end the session for
 * @param {Object} options - Session end options
 * @param {string} [options.sessionKey] - Stable Claude session UUID
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
      `${CLAUDE_API_URL}/end-session`,
      { callId, sessionKey, preserveForSeconds },
      { 
        timeout: 5000,
        headers: buildClaudeApiHeaders({ 'Content-Type': 'application/json' })
      }
    );
    console.log(
      `[${timestamp}] CLAUDE Session ended: ${callId} sessionKey=${sessionKey} preserved=${response.data.preserved}`
    );
    return response.data;
  } catch (error) {
    // Non-critical, just log
    console.warn(`[${timestamp}] CLAUDE Failed to end session: ${error.message}`);
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
 * Check if Claude API is available
 * @returns {Promise<boolean>} True if API is reachable
 */
async function isAvailable() {
  try {
    await axios.get(`${CLAUDE_API_URL}/health`, {
      timeout: 5000,
      headers: buildClaudeApiHeaders()
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
  endSession,
  isAvailable
};
