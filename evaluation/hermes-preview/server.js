#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { readLaunchToken, TOKEN_PATTERN } = require('./runtime-files');
const { sanitizeSnapshot } = require('./snapshot-schema');

const RUNTIME_SOCKET = '/run/teleagent-evaluation/facade.sock';
const TOKEN_HEADER = 'x-teleagent-evaluation-token';
const TOKEN_FILE = '/run/teleagent-evaluation-token';
const SNAPSHOT_FILE = '/snapshot/summary.json';
const STATIC_DIRECTORY = path.join(__dirname, 'static');
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 16;
const MAX_IN_FLIGHT = 4;
const MAX_REQUESTS_PER_MINUTE = 120;
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; media-src 'none'; object-src 'none'; manifest-src 'none'; worker-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function loadStaticAssets(staticDirectory = STATIC_DIRECTORY) {
  return new Map([
    ['/', { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(staticDirectory, 'index.html')) }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(staticDirectory, 'app.js')) }],
    ['/styles.css', { type: 'text/css; charset=utf-8', body: fs.readFileSync(path.join(staticDirectory, 'styles.css')) }],
  ]);
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || !TOKEN_PATTERN.test(candidate)) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function send(response, requestMethod, statusCode, body, contentType, extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': contentType,
    'Content-Length': payload.byteLength,
  });
  response.end(requestMethod === 'HEAD' ? undefined : payload);
}

function readComposedSnapshot(snapshotFile = SNAPSHOT_FILE, now = new Date()) {
  let descriptor;
  try {
    descriptor = fs.openSync(snapshotFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1 ||
        (metadata.mode & 0o777) !== 0o600 || metadata.size < 2 ||
        metadata.size > MAX_SNAPSHOT_BYTES) {
      throw new Error('unsafe snapshot');
    }
    const snapshot = sanitizeSnapshot(JSON.parse(fs.readFileSync(descriptor, 'utf8')));
    const current = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(current.getTime()) ||
        new Date(snapshot.generatedAt).getTime() > current.getTime() + 5000 ||
        new Date(snapshot.expiresAt).getTime() <= current.getTime()) {
      throw new Error('stale snapshot');
    }
    return snapshot;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function createDashboardServer({
  launchToken,
  staticAssets = loadStaticAssets(),
  snapshotReader = readComposedSnapshot,
  now = () => new Date(),
  rateNow = () => Date.now(),
} = {}) {
  if (!TOKEN_PATTERN.test(launchToken || '')) throw new Error('A valid launch token is required');

  let inFlight = 0;
  let windowOpenedAt = rateNow();
  let requestsInWindow = 0;
  const server = http.createServer({
    maxHeaderSize: 8192,
    requireHostHeader: true,
  }, (request, response) => {
    const requestTime = rateNow();
    if (requestTime - windowOpenedAt >= 60_000 || requestTime < windowOpenedAt) {
      windowOpenedAt = requestTime;
      requestsInWindow = 0;
    }
    requestsInWindow += 1;
    if (requestsInWindow > MAX_REQUESTS_PER_MINUTE) {
      send(response, request.method || '', 429, 'Request rate exceeded\n',
        'text/plain; charset=utf-8', { 'Retry-After': '60', Connection: 'close' });
      return;
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      send(response, request.method || '', 503, 'Facade busy\n',
        'text/plain; charset=utf-8', { 'Retry-After': '1', Connection: 'close' });
      return;
    }

    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    response.once('finish', release);
    response.once('close', release);

    const method = request.method || '';
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, method, 405, 'Method not allowed\n', 'text/plain; charset=utf-8', {
        Allow: 'GET, HEAD',
      });
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      send(response, method, 400, 'Bad request\n', 'text/plain; charset=utf-8');
      return;
    }

    const asset = staticAssets.get(pathname);
    if (asset) {
      send(response, method, 200, asset.body, asset.type);
      return;
    }

    if (pathname !== '/api/summary') {
      send(response, method, 404, 'Not found\n', 'text/plain; charset=utf-8');
      return;
    }

    if (!tokenMatches(request.headers[TOKEN_HEADER], launchToken)) {
      send(response, method, 401, '{"status":"authentication_required"}\n',
        'application/json; charset=utf-8');
      return;
    }

    try {
      const snapshot = snapshotReader(undefined, now());
      send(response, method, 200, `${JSON.stringify(snapshot)}\n`,
        'application/json; charset=utf-8');
    } catch {
      send(response, method, 503, '{"status":"snapshot_unavailable"}\n',
        'application/json; charset=utf-8', { 'Retry-After': '5' });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.timeout = 5000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 20;
  server.maxConnections = MAX_CONNECTIONS;
  server.dropMaxConnection = true;
  server.on('connection', (socket) => socket.setTimeout(5000));
  return server;
}

function main() {
  let launchToken;
  try {
    launchToken = readLaunchToken(TOKEN_FILE);
    readComposedSnapshot(SNAPSHOT_FILE);
  } catch {
    console.error('Hermes evaluation refused to start: runtime input unavailable or unsafe.');
    process.exitCode = 1;
    return;
  }
  try {
    fs.lstatSync(RUNTIME_SOCKET);
    throw new Error('socket path already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Hermes evaluation refused to start: runtime input unavailable or unsafe.');
      process.exitCode = 1;
      return;
    }
  }

  const server = createDashboardServer({ launchToken });
  server.on('error', () => {
    console.error('Hermes evaluation failed to bind its fixed Unix socket.');
    process.exitCode = 1;
  });
  server.listen(RUNTIME_SOCKET, () => {
    console.log('Hermes read-only evaluation facade is ready.');
  });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (require.main === module) main();

module.exports = {
  MAX_CONNECTIONS,
  MAX_IN_FLIGHT,
  MAX_REQUESTS_PER_MINUTE,
  MAX_SNAPSHOT_BYTES,
  RUNTIME_SOCKET,
  SECURITY_HEADERS,
  SNAPSHOT_FILE,
  TOKEN_FILE,
  TOKEN_HEADER,
  createDashboardServer,
  loadStaticAssets,
  readComposedSnapshot,
};
