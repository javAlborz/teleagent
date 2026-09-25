'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { admitLocalUnixRequest } = require('./local-control-request');

const CONTROL_SOCKET = '/run/teleagent-voice-control/control.sock';
const ALLOWED = new Set(['GET /api/realtime-health', 'POST /api/voice-control/stop']);

function need(value) {
  if (!value) throw new Error('isolated host control socket refused');
}

function createIsolatedControlHttp(app, { filename = CONTROL_SOCKET, io = fs,
  createServer = http.createServer, uid = process.getuid(), gid = process.getgid() } = {}) {
  need(typeof app === 'function' && typeof filename === 'string' && path.isAbsolute(filename) &&
    Number.isSafeInteger(uid) && uid > 0 && uid < 1000 &&
    Number.isSafeInteger(gid) && gid > 0 && gid < 1000);
  const directory = path.dirname(filename);
  const parent = io.lstatSync(directory);
  need(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === uid && parent.gid === gid &&
    (parent.mode & 0o7777) === 0o700 && parent.nlink === 2 &&
    io.realpathSync(directory) === directory && !io.existsSync(filename));
  let failed = false, closing = false, closePromise = null, rejectReady;
  let socketIdentity = null;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000,
    headersTimeout: 5000, keepAliveTimeout: 1000, maxRequestsPerSocket: 16 },
  (req, res) => {
    if (!ALLOWED.has(`${req.method} ${req.url}`) || req.headers?.upgrade || req.headers?.expect) {
      res.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
      res.end();
      return;
    }
    try { admitLocalUnixRequest(req); app(req, res); }
    catch { res.destroy(); }
  });
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 16;
  server.setTimeout(15000, (socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  const close = () => {
    closing = true;
    rejectReady?.(new Error('isolated host control socket closed'));
    if (!closePromise) closePromise = new Promise((resolve) => {
      server.closeAllConnections();
      server.close((error) => {
        try {
          const actual = io.lstatSync(filename);
          if (socketIdentity && actual.dev === socketIdentity.dev && actual.ino === socketIdentity.ino) {
            io.unlinkSync(filename);
          }
        } catch { /* the host owns final runtime cleanup */ }
        resolve(!error || error.code === 'ERR_SERVER_NOT_RUNNING');
      });
    });
    return closePromise;
  };
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    server.on('error', () => { failed = true; void close(); reject(new Error('isolated host control listener failed')); });
    server.once('listening', () => {
      try {
        io.chmodSync(filename, 0o600);
        const actual = io.lstatSync(filename);
        need(!failed && !closing && actual.isSocket() && actual.uid === uid && actual.gid === gid &&
          (actual.mode & 0o7777) === 0o600 && actual.nlink === 1 &&
          io.realpathSync(directory) === directory);
        socketIdentity = { dev: actual.dev, ino: actual.ino };
        resolve(true);
      } catch (error) { failed = true; void close(); reject(error); }
    });
    try { server.listen({ path: filename, exclusive: true, backlog: 8 }); }
    catch (error) { failed = true; void close(); reject(error); }
  });
  return Object.freeze({ server, ready, close, healthy() {
    try {
      const actual = io.lstatSync(filename);
      return !failed && !closing && server.listening && socketIdentity &&
        actual.dev === socketIdentity.dev && actual.ino === socketIdentity.ino &&
        actual.isSocket() && actual.uid === uid && actual.gid === gid &&
        (actual.mode & 0o7777) === 0o600;
    } catch { return false; }
  } });
}

module.exports = { CONTROL_SOCKET, createIsolatedControlHttp };
