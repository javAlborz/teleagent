'use strict';

const http = require('node:http');
const path = require('node:path');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class PrivilegedActionProxyError extends Error {
  constructor(code, message, { status = 502, payload = null } = {}) {
    super(message);
    this.name = 'PrivilegedActionProxyError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

function createPrivilegedActionProxy({ socketPath, timeoutMs = 10000 } = {}) {
  const resolvedSocketPath = String(socketPath || '').trim();
  if (!path.isAbsolute(resolvedSocketPath)) {
    throw new PrivilegedActionProxyError(
      'PRIVILEGED_BROKER_CONFIG_INVALID',
      'The privileged broker Unix socket path must be absolute.',
      { status: 503 }
    );
  }
  const boundedTimeout = Math.max(100, Math.min(Number.parseInt(timeoutMs, 10) || 10000, 60000));

  function request({ method, requestPath, body = null }) {
    return new Promise((resolve, reject) => {
      const encoded = body === null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath: resolvedSocketPath,
        path: requestPath,
        method,
        timeout: boundedTimeout,
        headers: encoded ? {
          'content-type': 'application/json',
          'content-length': encoded.length,
        } : {},
      });
      req.once('timeout', () => req.destroy(Object.assign(
        new Error('The privileged broker did not respond before the proxy timeout.'),
        { code: 'PRIVILEGED_BROKER_TIMEOUT' }
      )));
      req.once('error', (error) => reject(new PrivilegedActionProxyError(
        error.code === 'PRIVILEGED_BROKER_TIMEOUT'
          ? error.code
          : 'PRIVILEGED_BROKER_UNAVAILABLE',
        'The private privileged action broker is unavailable.',
        { status: 503 }
      )));
      req.once('response', (response) => {
        let length = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Privileged broker response is too large.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () => reject(new PrivilegedActionProxyError(
          'PRIVILEGED_BROKER_INVALID_RESPONSE',
          'The private privileged broker returned an invalid response.'
        )));
        response.once('end', () => {
          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new PrivilegedActionProxyError(
              'PRIVILEGED_BROKER_INVALID_RESPONSE',
              'The private privileged broker returned invalid JSON.'
            ));
          }
          resolve({ status: response.statusCode || 502, payload });
        });
      });
      if (encoded) req.end(encoded);
      else req.end();
    });
  }

  return Object.freeze({
    submit(body) {
      return request({ method: 'POST', requestPath: '/v1/actions', body });
    },
    get(actionId) {
      return request({
        method: 'GET',
        requestPath: `/v1/actions/${encodeURIComponent(String(actionId || ''))}`,
      });
    },
    getByIdempotencyKey(key) {
      return request({
        method: 'GET',
        requestPath: `/v1/actions/by-idempotency/${encodeURIComponent(String(key || ''))}`,
      });
    },
    cancel(actionId, body) {
      return request({
        method: 'POST',
        requestPath: `/v1/actions/${encodeURIComponent(String(actionId || ''))}/cancel`,
        body,
      });
    },
    cancelByIdempotencyKey(key, body) {
      return request({
        method: 'POST',
        requestPath: `/v1/actions/by-idempotency/${encodeURIComponent(String(key || ''))}/cancel`,
        body,
      });
    },
    panic(body) {
      return request({ method: 'POST', requestPath: '/v1/panic', body });
    },
    health() {
      return request({ method: 'GET', requestPath: '/health' });
    },
  });
}

module.exports = {
  PrivilegedActionProxyError,
  createPrivilegedActionProxy,
};
