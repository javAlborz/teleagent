'use strict';

const fs = require('node:fs');

const PBX_PANIC_SOCKET = '/run/teleagent-pbx-panic/panic.sock';
const PBX_PANIC_SOCKET_NAME = 'pbx-panic';
const CONTROLLER_SOCKET_NAME = 'agent-controller';
const STOP_TARGETS = new Set(['/voice-control/stop', '/voice-control/stop?response=plain']);

function refuse() {
  throw new Error('PBX panic requires its exact root-owned systemd Unix listener.');
}

function pbxPanicListenOptions({ environment = process.env, pid = process.pid,
  fileSystem = fs } = {}) {
  if (environment.LISTEN_PID !== String(pid) || environment.LISTEN_FDS !== '2') refuse();
  const names = String(environment.LISTEN_FDNAMES || '').split(':');
  if (names.length !== 2 || new Set(names).size !== 2 ||
      !names.includes(CONTROLLER_SOCKET_NAME) || !names.includes(PBX_PANIC_SOCKET_NAME)) refuse();
  for (const directory of ['/', '/run', '/run/teleagent-pbx-panic']) {
    const metadata = fileSystem.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 ||
        metadata.gid !== 0 || (metadata.mode & 0o022) !== 0) refuse();
  }
  const groups = fileSystem.lstatSync('/etc/group');
  if (!groups.isFile() || groups.isSymbolicLink() || groups.uid !== 0 ||
      groups.nlink !== 1 || (groups.mode & 0o022) !== 0 || groups.size > 1024 * 1024) refuse();
  const entries = fileSystem.readFileSync('/etc/group', 'utf8').split('\n')
    .map((line) => line.split(':')).filter((fields) => fields[0] === 'teleagent-asterisk');
  if (entries.length !== 1 || entries[0].length !== 4 || !/^[1-9][0-9]*$/.test(entries[0][2])) refuse();
  const pbxGid = Number(entries[0][2]);
  if (!Number.isSafeInteger(pbxGid)) refuse();
  const socket = fileSystem.lstatSync(PBX_PANIC_SOCKET);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0 ||
      socket.gid !== pbxGid || (socket.mode & 0o7777) !== 0o660) refuse();
  const fd = 3 + names.indexOf(PBX_PANIC_SOCKET_NAME);
  const descriptor = fileSystem.fstatSync(fd);
  if (!descriptor.isSocket()) refuse();
  const listeners = fileSystem.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1)
    .map((line) => line.trim().split(/\s+/)).filter((fields) => fields[6] === String(descriptor.ino));
  if (listeners.length !== 1 || listeners[0].length !== 8 ||
      listeners[0][3] !== '00010000' || listeners[0][4] !== '0001' ||
      listeners[0][5] !== '01' || listeners[0][7] !== PBX_PANIC_SOCKET) refuse();
  return { fd, exclusive: true };
}

function exactStopRequest(request) {
  return request?.method === 'POST' && STOP_TARGETS.has(request.url);
}

// Own the gate beside the HTTP server attached to the independently validated
// panic FD. Only this closure's dispatch can brand a request; headers, URL
// fields, caller properties and the general Unix listener cannot grant it.
function createPbxPanicRequestGate(handler) {
  if (typeof handler !== 'function') throw new TypeError('A panic request handler is required.');
  const admitted = new WeakSet();
  return Object.freeze({
    isPbxPanicRequest(request) {
      return admitted.has(request) && request.method === 'POST' &&
        STOP_TARGETS.has(request.originalUrl || request.url);
    },
    dispatch(request, response) {
      if (!exactStopRequest(request)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store', Connection: 'close' });
        response.end('PBX panic permits only the exact stop operation.\n');
        return;
      }
      admitted.add(request);
      const clear = () => {
        admitted.delete(request);
        response.removeListener('finish', clear);
        response.removeListener('close', clear);
      };
      response.once('finish', clear);
      response.once('close', clear);
      const failed = () => {
        clear();
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store', Connection: 'close' });
        response.end('PARTIAL');
      };
      try {
        Promise.resolve(handler(request, response)).catch(failed);
      } catch {
        failed();
      }
    },
  });
}

module.exports = { PBX_PANIC_SOCKET, PBX_PANIC_SOCKET_NAME,
  pbxPanicListenOptions, createPbxPanicRequestGate };
