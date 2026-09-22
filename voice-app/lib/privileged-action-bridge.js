'use strict';

const axios = require('./controller-http-client');
const { isDeepStrictEqual } = require('node:util');
const { AGENT_API_URL } = require('./claude-api-config');
const { getRuntimeSecret } = require('./runtime-secrets');

function normalizePrivilegedActionApiToken(value) {
  const token = String(value || '');
  const byteLength = Buffer.byteLength(token, 'utf8');
  if (token !== token.trim() || byteLength < 32 || byteLength > 4096 ||
      /[\u0000-\u001F\u007F]/.test(token)) {
    return '';
  }
  return token;
}

function terminal(action) {
  return Boolean(action && ['completed', 'failed', 'canceled', 'outcome_unknown'].includes(action.state));
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

class PrivilegedActionBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrivilegedActionBridgeError';
    this.code = code;
    this.details = details;
  }
}

function bridgeError(code, message, details = {}) {
  return new PrivilegedActionBridgeError(code, message, details);
}

function submissionOutcomeIsAmbiguous(error) {
  if (!error?.response) return true;
  if (Number(error.response.status) >= 500) return true;
  if (Number(error.response.status) === 409) return true;
  return new Set([
    'PRIVILEGED_BROKER_UNAVAILABLE',
    'PRIVILEGED_BROKER_TIMEOUT',
    'PRIVILEGED_BROKER_INVALID_RESPONSE',
    'PRIVILEGED_BROKER_PROXY_FAILED',
  ]).has(String(error.response?.data?.code || ''));
}

function assertMatchingRecoveredAction(action, { idempotencyKey, jobId, callId, plan }) {
  if (!action || action.idempotencyKey !== idempotencyKey || action.jobId !== jobId ||
      action.callId !== callId || action.target !== plan?.target ||
      !isDeepStrictEqual(action.plan, plan)) {
    throw bridgeError(
      'PRIVILEGED_IDEMPOTENCY_CONFLICT',
      'The recovered privileged action does not match the exact approved submission.',
      { idempotencyKey }
    );
  }
  return action;
}

class PrivilegedActionBridge {
  constructor({
    apiUrl = AGENT_API_URL,
    apiToken = getRuntimeSecret('privilegedActionApiToken'),
    axiosClient = axios,
    pollIntervalMs = 500,
  } = {}) {
    if (apiUrl !== AGENT_API_URL) {
      throw bridgeError(
        'PRIVILEGED_ACTION_DESTINATION_INVALID',
        'Privileged action traffic is fixed to the loopback controller.'
      );
    }
    this.apiUrl = AGENT_API_URL;
    this.apiToken = normalizePrivilegedActionApiToken(apiToken);
    if (!this.apiToken) {
      throw bridgeError(
        'PRIVILEGED_ACTION_AUTH_NOT_CONFIGURED',
        'A dedicated privileged action API token of at least 32 bytes is required.'
      );
    }
    this.axios = axiosClient;
    this.pollIntervalMs = Math.max(25, Math.min(Number.parseInt(pollIntervalMs, 10) || 500, 5000));
  }

  _headers(extra = {}) {
    return {
      ...extra,
      Authorization: `Bearer ${this.apiToken}`,
    };
  }

  async getAction(actionId, { timeoutMs = 5000 } = {}) {
    const response = await this.axios.get(
      `${this.apiUrl}/privileged-actions/${encodeURIComponent(String(actionId || ''))}`,
      { timeout: timeoutMs, headers: this._headers(), maxRedirects: 0 }
    );
    return response.data?.action || null;
  }

  async getByIdempotencyKey(key, {
    timeoutMs = 5000,
    notFoundIsNull = false,
    expected = null,
  } = {}) {
    try {
      const response = await this.axios.get(
        `${this.apiUrl}/privileged-actions/by-idempotency/${encodeURIComponent(String(key || ''))}`,
        { timeout: timeoutMs, headers: this._headers(), maxRedirects: 0 }
      );
      const action = response.data?.action || null;
      return expected ? assertMatchingRecoveredAction(action, expected) : action;
    } catch (error) {
      if (notFoundIsNull && error.response?.status === 404) return null;
      throw error;
    }
  }

  async submit({ idempotencyKey, jobId, callId, plan, authorization } = {}) {
    const body = { idempotencyKey, jobId, callId, plan, authorization };
    try {
      const response = await this.axios.post(
        `${this.apiUrl}/privileged-actions`,
        body,
        {
          timeout: 10000,
          headers: this._headers({ 'Idempotency-Key': idempotencyKey }),
          maxRedirects: 0,
        }
      );
      return assertMatchingRecoveredAction(response.data?.action || null, {
        idempotencyKey, jobId, callId, plan,
      });
    } catch (error) {
      // A broker policy/auth/validation response is authoritative. A loopback
      // proxy response can still be ambiguous when the broker committed but its
      // Unix-socket response was lost. Recovery is GET-only in either transport
      // ambiguity case; the one-time capability is never POSTed a second time.
      if (!submissionOutcomeIsAmbiguous(error)) throw error;
      try {
        const recovered = await this.getByIdempotencyKey(idempotencyKey, {
          notFoundIsNull: true,
          expected: { idempotencyKey, jobId, callId, plan },
        });
        if (recovered) return recovered;
      } catch {
        // The explicit outcome-unknown error below retains the no-resubmit rule.
      }
      throw bridgeError(
        'PRIVILEGED_SUBMISSION_OUTCOME_UNKNOWN',
        'The privileged submission outcome is unknown. It was not resent.',
        { idempotencyKey }
      );
    }
  }

  async wait(actionId, { timeoutSeconds = 330, signal = null } = {}) {
    const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw bridgeError('PRIVILEGED_WAIT_CANCELED', 'Privileged action wait was canceled.');
      }
      const action = await this.getAction(actionId);
      if (terminal(action)) return action;
      await sleep(this.pollIntervalMs);
    }
    throw bridgeError(
      'PRIVILEGED_WAIT_TIMEOUT',
      'The privileged action remains durable, but its terminal result was not observed in time.',
      { actionId }
    );
  }

  async submitAndWait(input) {
    const action = await this.submit(input);
    if (!action?.id) {
      throw bridgeError('PRIVILEGED_INVALID_RESPONSE', 'The privileged broker did not return an action ID.');
    }
    if (terminal(action)) return action;
    return this.wait(action.id, { timeoutSeconds: (input.plan?.timeout_seconds || 300) + 30 });
  }

  async cancel(actionId, { reason = 'caller_pressed_star', expectedRevision = null } = {}) {
    const response = await this.axios.post(
      `${this.apiUrl}/privileged-actions/${encodeURIComponent(String(actionId || ''))}/cancel`,
      { reason, source: 'voice_controller', expectedRevision },
      { timeout: 5000, headers: this._headers(), maxRedirects: 0 }
    );
    return response.data;
  }

  async cancelByIdempotencyKey(idempotencyKey, jobId, {
    reason = 'caller_pressed_star',
  } = {}) {
    const response = await this.axios.post(
      `${this.apiUrl}/privileged-actions/by-idempotency/${encodeURIComponent(String(idempotencyKey || ''))}/cancel`,
      { jobId, reason, source: 'voice_controller' },
      { timeout: 5000, headers: this._headers(), maxRedirects: 0 }
    );
    return response.data;
  }

  async panic({ reason = 'voice_panic_stop', source = 'voice_controller' } = {}) {
    const response = await this.axios.post(
      `${this.apiUrl}/privileged-actions/panic`,
      { reason, source },
      { timeout: 5000, headers: this._headers(), maxRedirects: 0 }
    );
    return response.data;
  }
}

module.exports = {
  PrivilegedActionBridge,
  PrivilegedActionBridgeError,
  normalizePrivilegedActionApiToken,
  assertMatchingRecoveredAction,
  submissionOutcomeIsAmbiguous,
  terminal,
};
