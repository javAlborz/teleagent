'use strict';

const http = require('node:http');
const { exact } = require('./owner-session-catalog');
const { sessionError } = require('./owner-session-endpoint');
const MAX_BODY = 32768;
const METHODS = new Set(['GET', 'POST']);

// Host-only handler. The reviewed service must pass a systemd-owned Unix
// listener. No TCP listener, bearer, CORS, or generic provider RPC is supplied.
function createOwnerSessionServer(broker) {
  const sockets = new Set();
  const server = http.createServer({ maxHeaderSize: 4096, requestTimeout: 10000,
    headersTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => {
    const reply = (status, payload) => {
      if (res.destroyed || res.writableEnded) return;
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body), connection: 'close' });
      res.end(body);
    };
    // Defense in depth: this handler is unusable if accidentally bound to TCP.
    if (req.socket.remoteAddress || !METHODS.has(req.method) || req.headers.upgrade ||
        req.headers['transfer-encoding'] || (req.method === 'POST' &&
        req.headers['content-type'] !== 'application/json')) {
      reply(400, { success: false, code: 'OWNER_BROKER_REQUEST_INVALID' }); return;
    }
    const length = req.headers['content-length'];
    if ((req.method === 'POST' && !/^\d{1,5}$/.test(length || '')) ||
        Number(length || 0) > MAX_BODY || (req.method === 'GET' && Number(length || 0) !== 0)) {
      reply(413, { success: false, code: 'OWNER_BROKER_BODY_LIMIT' }); return;
    }
    let bytes = 0; const chunks = [];
    const timer = setTimeout(() => req.destroy(), 10000);
    req.once('close', () => clearTimeout(timer));
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => {});
    req.on('end', async () => {
      clearTimeout(timer);
      try {
        const body = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        let result;
        if (req.method === 'GET' && req.url === '/v1/health') result = broker.health();
        else if (req.method === 'GET' && req.url === '/v1/sessions') result = broker.list();
        else if (req.method === 'POST' && req.url === '/v1/inspect') {
          exact(body, ['id', 'history', ...(Object.hasOwn(body, 'selection') ? ['selection'] : [])]);
          const selection = require('./owner-session-history').validateSelection(body.selection);
          if (selection && body.history !== true) throw sessionError('OWNER_HISTORY_SELECTION_INVALID');
          if (typeof body.history !== 'boolean') throw sessionError('OWNER_BROKER_REQUEST_INVALID');
          result = await broker.inspect(body.id, { history: body.history, selection });
        } else if (req.method === 'POST' && req.url === '/v1/reply') result = await broker.reply(body);
        else if (req.method === 'POST' && req.url === '/v1/prepare') result = await broker.prepare(body);
        else if (req.method === 'POST' && req.url === '/v1/deliver') result = await broker.deliver(body);
        else if (req.method === 'POST' && req.url === '/v1/forward') result = await broker.forward(body);
        else if (req.method === 'POST' && req.url === '/v1/result') result = broker.result(body);
        else if (req.method === 'POST' && req.url === '/v1/panic') {
          exact(body, []); result = broker.panic();
        } else { reply(404, { success: false, code: 'OWNER_BROKER_ROUTE_NOT_FOUND' }); return; }
        reply(200, { success: true, result });
      } catch (error) {
        // Provider/parser/filesystem messages never cross the controller API.
        const code = /^(?:OWNER_[A-Z_]+|TELECAP2_[A-Z_]+)$/.test(error.code || '')
          ? error.code : 'OWNER_BROKER_REQUEST_FAILED';
        reply(code === 'OWNER_BROKER_BUSY' ? 429 : 409, { success: false, code });
      }
    });
  });
  server.maxConnections = 8;
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  return { server, async close() {
    broker.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    // Caller must wait for admitted native requests to settle before closing
    // SQLite. Killing the service after its shutdown bound leaves durable unknown.
  } };
}
module.exports = { createOwnerSessionServer, MAX_BODY };
