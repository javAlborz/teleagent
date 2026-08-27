'use strict';

const http = require('node:http');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { targetSessionOperationMarker } = require('../lib/voice-authorization-plan');
const { requestHash } = require('./worker-session-operation-store');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FIXED_WORKER_SESSION_SOCKET_PATH = '/run/teleagent-worker-session/broker.sock';

function strictBoolean(value, name, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

function normalizeWorkerSessionProxyConfig(environment = process.env) {
  const enabled = strictBoolean(
    environment.WORKER_SESSION_BROKER_ENABLED,
    'WORKER_SESSION_BROKER_ENABLED',
    false
  );
  const socketPath = String(
    environment.WORKER_SESSION_BROKER_SOCKET_PATH || FIXED_WORKER_SESSION_SOCKET_PATH
  ).trim();
  if (socketPath !== FIXED_WORKER_SESSION_SOCKET_PATH) {
    throw new Error(
      `WORKER_SESSION_BROKER_SOCKET_PATH must be ${FIXED_WORKER_SESSION_SOCKET_PATH}.`
    );
  }
  const timeoutMs = Math.max(
    100,
    Math.min(Number.parseInt(environment.WORKER_SESSION_BROKER_TIMEOUT_MS, 10) || 10000, 60000)
  );
  const healthPollMs = Math.max(
    250,
    Math.min(Number.parseInt(environment.WORKER_SESSION_BROKER_HEALTH_POLL_MS, 10) || 2000, 60000)
  );
  return Object.freeze({ enabled, socketPath, timeoutMs, healthPollMs });
}

class WorkerSessionProxyError extends Error {
  constructor(code, message, { status = 502, payload = null, ambiguous = false } = {}) {
    super(message);
    this.name = 'WorkerSessionProxyError';
    this.code = code;
    this.status = status;
    this.payload = payload;
    this.ambiguous = ambiguous;
  }
}

function proxyError(code, message, options) {
  throw new WorkerSessionProxyError(code, message, options);
}

function createWorkerSessionHttpClient({ socketPath, timeoutMs = 10000 } = {}) {
  const resolvedSocketPath = String(socketPath || '').trim();
  if (!path.isAbsolute(resolvedSocketPath)) {
    proxyError(
      'WORKER_SESSION_BROKER_CONFIG_INVALID',
      'The worker session broker Unix socket path must be absolute.',
      { status: 503 }
    );
  }
  const defaultTimeout = Math.max(100, Math.min(Number.parseInt(timeoutMs, 10) || 10000, 60000));

  function request({ method, requestPath, body = null, requestTimeoutMs = defaultTimeout }) {
    return new Promise((resolve, reject) => {
      const encoded = body === null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath: resolvedSocketPath,
        path: requestPath,
        method,
        timeout: Math.max(100, Math.min(requestTimeoutMs, 3605000)),
        headers: encoded ? {
          'content-type': 'application/json',
          'content-length': encoded.length,
        } : {},
      });
      req.once('timeout', () => req.destroy(Object.assign(
        new Error('The worker session broker did not respond before timeout.'),
        { code: 'WORKER_SESSION_BROKER_TIMEOUT' }
      )));
      req.once('error', (error) => reject(new WorkerSessionProxyError(
        error.code === 'WORKER_SESSION_BROKER_TIMEOUT'
          ? error.code
          : 'WORKER_SESSION_BROKER_UNAVAILABLE',
        'The private worker session broker is unavailable.',
        { status: 503, ambiguous: method !== 'GET' }
      )));
      req.once('response', (response) => {
        let bytes = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Worker session broker response exceeded its bound.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () => reject(new WorkerSessionProxyError(
          'WORKER_SESSION_BROKER_INVALID_RESPONSE',
          'The private worker session broker returned an invalid response.',
          { ambiguous: method !== 'GET' }
        )));
        response.once('end', () => {
          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new WorkerSessionProxyError(
              'WORKER_SESSION_BROKER_INVALID_RESPONSE',
              'The private worker session broker returned invalid JSON.',
              { ambiguous: method !== 'GET' }
            ));
          }
          resolve({ status: response.statusCode || 502, payload });
        });
      });
      if (encoded) req.end(encoded);
      else req.end();
    });
  }

  return Object.freeze({ request, socketPath: resolvedSocketPath });
}

function requireSuccess(response, fallbackCode = 'WORKER_SESSION_BROKER_REJECTED') {
  if (response?.status >= 200 && response.status < 300 && response.payload?.success === true) {
    return response.payload;
  }
  const status = Number(response?.status) || 502;
  throw new WorkerSessionProxyError(
    String(response?.payload?.code || fallbackCode),
    String(response?.payload?.error || 'The worker session broker rejected the request.'),
    {
      status,
      payload: response?.payload || null,
      ambiguous: status >= 500,
    }
  );
}

function workerRequest({ target, message, sessionFingerprint, timeoutMs, operationId }) {
  return {
    operationId: String(operationId || ''),
    target: String(target || ''),
    message: String(message || ''),
    sessionFingerprint: String(sessionFingerprint || ''),
    timeoutMs: Math.max(30000, Math.min(Number.parseInt(timeoutMs, 10) || 1800000, 3600000)),
  };
}

function assertPreflightIdentity(payload, request) {
  const operation = payload?.operation;
  const prepared = payload?.prepared;
  const stableTarget = String(prepared?.stable_target || prepared?.target || '');
  const marker = targetSessionOperationMarker(request.operationId);
  if (!operation || !prepared || operation.operationId !== request.operationId ||
      operation.requestHash !== requestHash(request) || operation.target !== request.target ||
      operation.stableTarget !== stableTarget ||
      operation.sessionFingerprint !== request.sessionFingerprint ||
      prepared.session_fingerprint !== request.sessionFingerprint ||
      operation.operationMarker !== marker || prepared.operation_marker !== marker ||
      !['claude', 'codex'].includes(String(prepared.provider || '')) ||
      operation.provider !== prepared.provider) {
    proxyError(
      'WORKER_SESSION_PREFLIGHT_IDENTITY_INVALID',
      'The worker broker did not preserve the exact target-session identity.',
      { status: 409 }
    );
  }
  return { operation, prepared, stableTarget, marker };
}

function createWorkerSessionProxy({
  socketPath,
  timeoutMs = 10000,
  pollIntervalMs = 250,
} = {}) {
  const client = createWorkerSessionHttpClient({ socketPath, timeoutMs });
  const pollMs = Math.max(25, Math.min(Number.parseInt(pollIntervalMs, 10) || 250, 5000));

  const call = async (method, requestPath, body = null, requestTimeoutMs = undefined) => {
    const response = await client.request({ method, requestPath, body, requestTimeoutMs });
    return requireSuccess(response);
  };

  const inspector = Object.freeze({
    async execute(action, args = {}) {
      const payload = await call('POST', '/v1/inspect', { action, args });
      return payload.result;
    },
  });

  const controller = {
    async prepare({ target } = {}) {
      const payload = await call('POST', '/v1/session/prepare', { target });
      return payload.result;
    },

    async getOperation(operationId) {
      const encoded = encodeURIComponent(String(operationId || ''));
      const payload = await call('GET', `/v1/session/operations/${encoded}`);
      return payload.operation;
    },

    async reconcileOperation(input = {}) {
      const request = workerRequest({ ...input, timeoutMs: input.timeoutMs || 1800000 });
      const payload = await call('POST', '/v1/session/reconcile', request);
      return payload.outcome;
    },

    async _recoverAmbiguousCommit(request, deadline) {
      while (Date.now() < deadline) {
        let outcome;
        try {
          outcome = await this.reconcileOperation(request);
        } catch (error) {
          if (error.status >= 400 && error.status < 500) throw error;
          throw new WorkerSessionProxyError(
            'TARGET_DELIVERY_OUTCOME_UNKNOWN',
            'The worker delivery outcome is unavailable and the message was not resent.',
            { status: 409, ambiguous: true }
          );
        }
        if (outcome?.status === 'completed' && outcome.result) return outcome.result;
        if (outcome?.status === 'not_delivered') {
          throw new WorkerSessionProxyError(
            'TARGET_DELIVERY_OUTCOME_UNKNOWN',
            'The commit response was ambiguous; GET-only recovery found no crossed delivery boundary, but the message was not resent.',
            { status: 409, ambiguous: true }
          );
        }
        if (!['in_progress', 'pre_delivery_in_progress'].includes(outcome?.status)) {
          throw new WorkerSessionProxyError(
            'TARGET_DELIVERY_OUTCOME_UNKNOWN',
            'The exact worker-session marker could not be reconciled; the message was not resent.',
            { status: 409, ambiguous: true }
          );
        }
        await delay(pollMs);
      }
      throw new WorkerSessionProxyError(
        'TARGET_DELIVERY_OUTCOME_UNKNOWN',
        'The original worker-session deadline elapsed without exact terminal evidence; the message was not resent.',
        { status: 409, ambiguous: true }
      );
    },

    async send(input = {}) {
      const request = workerRequest(input);
      const deadline = Date.now() + request.timeoutMs;
      if (input.signal?.aborted) {
        proxyError('TARGET_MESSAGE_CANCELED', 'The worker-session request was canceled before preflight.', {
          status: 409,
        });
      }
      const preflightPayload = await call('POST', '/v1/session/send/preflight', request);
      const preflight = assertPreflightIdentity(preflightPayload, request);
      if (input.signal?.aborted) {
        proxyError('TARGET_MESSAGE_CANCELED', 'The worker-session request was canceled before delivery.', {
          status: 409,
        });
      }
      if (typeof input.onBeforeSubmit === 'function') {
        await input.onBeforeSubmit({
          stableTarget: preflight.stableTarget,
          provider: preflight.prepared.provider,
          operationMarker: preflight.marker,
        });
      }
      const abortHandler = () => {
        void this.interrupt(preflight.stableTarget, request.operationId).catch(() => {});
      };
      input.signal?.addEventListener('abort', abortHandler, { once: true });
      try {
        let response;
        try {
          response = await client.request({
            method: 'POST',
            requestPath: '/v1/session/send/commit',
            body: request,
            requestTimeoutMs: request.timeoutMs + 5000,
          });
        } catch (error) {
          if (!error.ambiguous) throw error;
          return await this._recoverAmbiguousCommit(request, deadline);
        }
        try {
          return requireSuccess(response).result;
        } catch (error) {
          if (!error.ambiguous && ![
            'WORKER_SESSION_OPERATION_IN_PROGRESS',
            'TARGET_DELIVERY_OUTCOME_UNKNOWN',
          ].includes(error.code)) throw error;
          return await this._recoverAmbiguousCommit(request, deadline);
        }
      } finally {
        input.signal?.removeEventListener('abort', abortHandler);
      }
    },

    async interrupt(target, operationId = null) {
      const payload = await call('POST', '/v1/session/interrupt', { target, operationId });
      return Boolean(payload.interrupted);
    },
  };

  return Object.freeze({
    inspector,
    controller: Object.freeze(controller),
    async panic({ reason = 'voice_panic', source = 'controller' } = {}) {
      const response = await client.request({
        method: 'POST',
        requestPath: '/v1/control/panic',
        body: {
          reason: String(reason).slice(0, 160),
          source: String(source).slice(0, 80),
        },
      });
      if (!response?.payload || typeof response.payload !== 'object') {
        proxyError(
          'WORKER_SESSION_PANIC_UNCONFIRMED',
          'The worker panic response was invalid.',
          { status: 503, ambiguous: true }
        );
      }
      return { status: response.status, payload: response.payload };
    },
    async unlock() {
      const payload = await call('POST', '/v1/control/unlock', {});
      return payload;
    },
    async health() {
      const payload = await call('GET', '/health');
      return payload;
    },
    socketPath: client.socketPath,
  });
}

module.exports = {
  FIXED_WORKER_SESSION_SOCKET_PATH,
  WorkerSessionProxyError,
  assertPreflightIdentity,
  createWorkerSessionHttpClient,
  createWorkerSessionProxy,
  normalizeWorkerSessionProxyConfig,
  workerRequest,
};
