'use strict';

const http = require('node:http');
const { sessionError } = require('./owner-session-endpoint');
const SOCKET_PATH = '/run/teleagent-pbx-attester/attester.sock';
const ROUTES = new Set(['/v1/health', '/v1/call', '/v1/validate-call', '/v1/attest', '/v1/panic']);
const MAX_BYTES = 40000;

function createPbxAttesterServer(api) {
  const server = http.createServer({ maxHeaderSize: 4096, requestTimeout: 10000,
    headersTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => {
    const reply = (status, payload) => {
      if (res.writableEnded || res.destroyed) return;
      const data = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'content-length': Buffer.byteLength(data), connection: 'close' }); res.end(data);
    };
    if (req.socket.remoteAddress || req.method !== 'POST' || !ROUTES.has(req.url) || req.headers['transfer-encoding'] ||
        req.headers['content-type'] !== 'application/json' || !/^\d{1,5}$/.test(req.headers['content-length'] || '') ||
        Number(req.headers['content-length']) > MAX_BYTES) {
      reply(400, { success: false, code: 'PBX_ATTESTER_REQUEST_INVALID' }); return;
    }
    const timer = setTimeout(() => req.destroy(), 10000);
    let bytes = 0; const chunks = [];
    req.once('close', () => clearTimeout(timer)); req.on('error', () => {});
    req.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_BYTES) req.destroy(); else chunks.push(chunk); });
    req.once('end', async () => {
      clearTimeout(timer);
      try { reply(200, { success: true, result: await api.handle(req.url, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }); }
      catch (error) {
        reply(409, { success: false, code: /^PBX_[A-Z_]+$/.test(error.code || '') ? error.code : 'PBX_ATTESTER_REQUEST_REFUSED' });
      }
    });
  });
  server.maxConnections = 8;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

function createPbxAttesterProxy() {
  const call = (route, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    if (!ROUTES.has(route) || Buffer.byteLength(data) > MAX_BYTES) {
      reject(sessionError('PBX_ATTESTER_REQUEST_INVALID')); return;
    }
    const req = http.request({ socketPath: SOCKET_PATH, method: 'POST', path: route, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } });
    // The approval lifetime bounds the operation, not the user's conversation.
    const timer = setTimeout(() => req.destroy(), route === '/v1/attest' ? 125000 : 10000);
    const fail = () => { clearTimeout(timer); reject(sessionError('PBX_ATTESTER_UNAVAILABLE')); };
    req.once('error', fail);
    req.once('response', (res) => {
      const chunks = []; let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_BYTES) res.destroy(); else chunks.push(chunk); });
      res.once('error', fail);
      res.once('end', () => {
        clearTimeout(timer);
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || payload.success !== true) {
            reject(sessionError(/^PBX_[A-Z_]+$/.test(payload?.code || '')
              ? payload.code : 'PBX_ATTESTER_UNAVAILABLE')); return;
          }
          resolve(payload.result);
        } catch { fail(); }
      });
    });
    req.end(data);
  });
  // No retries: the independent attester durably claims an arm before playback.
  return Object.freeze({ health: () => call('/v1/health', {}), resolveCall: (sipCallId) => call('/v1/call', { sipCallId }),
    validateCall: (sipCallId) => call('/v1/validate-call', { sipCallId }),
    attest: (armToken) => call('/v1/attest', { armToken }), panic: () => call('/v1/panic', {}) });
}
module.exports = { createPbxAttesterServer, createPbxAttesterProxy, SOCKET_PATH };
