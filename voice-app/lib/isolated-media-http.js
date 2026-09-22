'use strict';

const http = require('node:http');
const { assertMediaReceiverRuntime } = require('../../lib/media-receiver-runtime');
const { canonicalMediaRoot, openConfinedMedia } = require('./http-server');

function exactSocket(req, endpoint) {
  const socket = req.socket;
  return socket && socket.remoteAddress === endpoint.allowedPeer && socket.localAddress === endpoint.host &&
    socket.localPort === endpoint.port && Number.isInteger(socket.remotePort) &&
    socket.remotePort >= 49152 && socket.remotePort <= 65535;
}
function mediaPath(url) {
  if (typeof url !== 'string' || url.length > 1024 || /[?#\\\0\r\n]/u.test(url) || !url.startsWith('/')) return null;
  // Reject encoded separators/dot components and double encoding rather than
  // normalizing them into a different request scope. Safe filenames are ASCII.
  if (/%/u.test(url)) return null;
  if (url.startsWith('/audio-files/')) return { kind: 'audio', value: url.slice(13), nested: false };
  if (url.startsWith('/static/')) return { kind: 'static', value: url.slice(8), nested: true };
  return null;
}
function failure(res, status) {
  res.writeHead(status, { 'Content-Length': '0', 'Cache-Control': 'no-store', Connection: 'close' });
  res.end();
}
function createMediaRequestHandler(runtime, { audioDir, staticDir }) {
  assertMediaReceiverRuntime(runtime);
  const roots = { audio: canonicalMediaRoot(audioDir, 'Generated media directory'),
    static: canonicalMediaRoot(staticDir, 'Static media directory') };
  return async (req, res) => {
    let endpoint;
    try { endpoint = assertMediaReceiverRuntime(runtime).privateHttpAudio; }
    catch { failure(res, 503); return; }
    // Never honor Host, Forwarded or X-Forwarded-* as identity. Verify each
    // request, including every request on a reused keep-alive connection.
    if (!exactSocket(req, endpoint)) { failure(res, 403); return; }
    if (!['GET', 'HEAD'].includes(req.method) || req.headers?.['transfer-encoding'] ||
        (req.headers?.['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
        req.headers?.upgrade || req.headers?.expect) { failure(res, 405); return; }
    const requested = mediaPath(req.url);
    if (!requested) { failure(res, 404); return; }
    const opened = await openConfinedMedia(roots[requested.kind], requested.value, { nested: requested.nested });
    if (!opened) { failure(res, 404); return; }
    try {
      assertMediaReceiverRuntime(runtime);
      if (req.destroyed || res.destroyed) { await opened.handle.close(); return; }
      if (!exactSocket(req, endpoint)) { await opened.handle.close(); failure(res, 403); return; }
      res.writeHead(200, { 'Content-Type': opened.contentType, 'Content-Length': String(opened.metadata.size),
        'Cache-Control': requested.kind === 'audio' ? 'no-store' : 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD' || opened.metadata.size === 0) { await opened.handle.close(); res.end(); return; }
      const stream = opened.handle.createReadStream({ start: 0, end: opened.metadata.size - 1, autoClose: true });
      stream.once('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      await opened.handle.close().catch(() => {});
      if (res.headersSent) res.destroy(); else failure(res, 503);
    }
  };
}

function createIsolatedMediaHttp(runtime, directories, { createServer = http.createServer } = {}) {
  const endpoint = assertMediaReceiverRuntime(runtime).privateHttpAudio;
  const handler = createMediaRequestHandler(runtime, directories);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000,
    keepAliveTimeout: 1000, maxRequestsPerSocket: 16 }, (req, res) => {
    void handler(req, res).catch(() => { if (res.headersSent) res.destroy(); else failure(res, 500); });
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 16;
  server.setTimeout(15000, (socket) => socket.destroy());
  server.on('checkContinue', (_req, res) => failure(res, 405));
  server.on('checkExpectation', (_req, res) => failure(res, 405));
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  const listenAbort = new AbortController();
  let failed = false, closing = false, closePromise, rejectReady;
  const close = () => {
    closing = true;
    listenAbort.abort();
    rejectReady?.(new Error('isolated media HTTP listener closed'));
    if (!closePromise) closePromise = new Promise((resolve) => {
      server.closeAllConnections();
      server.close((error) => resolve(!error || error.code === 'ERR_SERVER_NOT_RUNNING'));
    });
    return closePromise;
  };
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    server.on('error', () => {
      failed = true;
      void close();
      reject(new Error('isolated media HTTP listener failed'));
    });
    server.once('listening', () => {
      try {
        assertMediaReceiverRuntime(runtime);
        const actual = server.address();
        if (failed || closing || !actual || actual.address !== endpoint.host || actual.port !== endpoint.port || actual.family !== 'IPv4') {
          throw new Error('media HTTP listener differs from its admitted address');
        }
        resolve(true);
      } catch (error) { failed = true; void close(); reject(error); }
    });
    try { server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true, backlog: 32, signal: listenAbort.signal }); }
    catch (error) { failed = true; void close(); reject(error); }
  });
  return Object.freeze({ server, ready, close, healthy() {
    try { assertMediaReceiverRuntime(runtime); return !failed && !closing && server.listening; }
    catch { return false; }
  } });
}

function createMediaStartupFence() {
  let terminal = false, begun = false;
  const assertActive = () => { if (terminal) throw new Error('media startup was stopped'); };
  return Object.freeze({
    stop() { terminal = true; },
    async run(initialize, accept) {
      assertActive();
      if (begun) return false;
      begun = true;
      await initialize(assertActive);
      assertActive();
      // Admission is synchronous with this final fence check. Initializers
      // must also check after each await, before constructing more resources.
      accept();
      return true;
    },
  });
}

module.exports = { exactSocket, mediaPath, createMediaRequestHandler, createIsolatedMediaHttp, createMediaStartupFence };
