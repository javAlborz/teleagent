'use strict';

const http = require('node:http');
const { sessionError } = require('./owner-session-endpoint');
const SOCKET_PATH = '/run/teleagent-owner-session/broker.sock';
const ROUTES = new Set(['/v1/inspect', '/v1/prepare', '/v1/deliver', '/v1/forward', '/v1/result', '/v1/panic']);

// Controller-only client. In particular, a lost /deliver response is not retried.
// The caller retains operationId+planHash and asks /result for durable evidence.
function createOwnerSessionProxy({ socketPath = SOCKET_PATH, timeoutMs = 15000 } = {}) {
  if (socketPath !== SOCKET_PATH) throw sessionError('OWNER_BROKER_SOCKET_INVALID');
  async function call(route, body) {
    if (!['/v1/sessions', '/v1/health'].includes(route) && !ROUTES.has(route)) throw sessionError('OWNER_BROKER_ROUTE_NOT_FOUND');
    const encoded = ['/v1/sessions', '/v1/health'].includes(route) ? null : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 32768) throw sessionError('OWNER_BROKER_BODY_LIMIT');
    return new Promise((resolve, reject) => {
      const uncertain = () => reject(sessionError(['/v1/deliver', '/v1/forward'].includes(route)
        ? 'OWNER_SESSION_DELIVERY_OUTCOME_UNKNOWN' : 'OWNER_BROKER_UNAVAILABLE'));
      const req = http.request({ socketPath, method: encoded ? 'POST' : 'GET', path: route,
        agent: false, headers: encoded ? { 'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded) } : {} });
      const timer = setTimeout(() => req.destroy(), Math.max(1000, Math.min(timeoutMs, 20000)));
      req.once('error', () => { clearTimeout(timer); uncertain(); });
      req.once('response', (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) { res.destroy(); return; }
          chunks.push(chunk);
        });
        res.once('error', () => { clearTimeout(timer); uncertain(); });
        res.once('end', () => {
          clearTimeout(timer);
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { uncertain(); return; }
          if (res.statusCode !== 200 || result?.success !== true) {
            reject(sessionError(/^(?:OWNER_[A-Z_]+|TELECAP2_[A-Z_]+)$/.test(result?.code || '')
              ? result.code : 'OWNER_BROKER_UNAVAILABLE'));
          } else resolve(result.result);
        });
      });
      req.end(encoded);
    });
  }
  return Object.freeze({ health: () => call('/v1/health'), list: () => call('/v1/sessions'),
    inspect: (id, history = false) => call('/v1/inspect', { id, history }),
    prepare: (input) => call('/v1/prepare', input), deliver: (input) => call('/v1/deliver', input),
    forward: (input) => call('/v1/forward', input),
    result: (operationId, planHash) => call('/v1/result', { operationId, planHash }),
    panic: () => call('/v1/panic', {}) });
}
module.exports = { createOwnerSessionProxy, SOCKET_PATH };
