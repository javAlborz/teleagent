'use strict';

// Host-only primitives. Never expose these paths or the owner's sockets to a
// phone container or worker. Endpoint configuration comes from the operator.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sessionError(code) {
  return Object.assign(new Error(code), { code });
}

function processIdentity(pid, uid, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0) {
    throw sessionError('OWNER_SESSION_IDENTITY_INVALID');
  }
  const root = path.join(procRoot, String(pid));
  const stat = fs.readFileSync(path.join(root, 'stat'), 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (fs.statSync(root).uid !== uid || !/^\d+$/.test(fields[19]) ||
      ['Z', 'X'].includes(fields[0])) throw sessionError('OWNER_SESSION_PROCESS_CHANGED');
  return { pid, start: fields[19] };
}

function socketIdentity(socketPath, uid) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) ||
      path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 103) {
    throw sessionError('OWNER_SESSION_SOCKET_UNSAFE');
  }
  const parts = socketPath.split('/').filter(Boolean);
  let current = '/';
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)) {
      throw sessionError('OWNER_SESSION_SOCKET_UNSAFE');
    }
    if (last) {
      if (!stat.isSocket() || stat.uid !== uid || (stat.mode & 0o022)) {
        throw sessionError('OWNER_SESSION_SOCKET_UNSAFE');
      }
      return { path: socketPath, dev: String(stat.dev), ino: String(stat.ino), uid };
    }
    // Only root-owned sticky ancestors such as /tmp may be shared. The direct
    // parent must be private against other users replacing the socket.
    if (!stat.isDirectory() || ((stat.mode & 0o022) &&
        !(stat.uid === 0 && (stat.mode & 0o1000) && index < parts.length - 2))) {
      throw sessionError('OWNER_SESSION_SOCKET_UNSAFE');
    }
  }
  throw sessionError('OWNER_SESSION_SOCKET_UNSAFE');
}

function endpointIdentity({ socketPath, pid, uid, procRoot = '/proc' }) {
  const ownerProcess = processIdentity(pid, uid, procRoot);
  const entries = fs.readFileSync(path.join(procRoot, 'net/unix'), 'utf8')
    .split('\n').map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 8 && fields[7] === socketPath && fields[3] === '00010000');
  if (entries.length !== 1) throw sessionError('OWNER_SESSION_LISTENER_CHANGED');
  const descriptors = fs.readdirSync(path.join(procRoot, String(pid), 'fd'));
  if (descriptors.length > 4096 || !descriptors.some((fd) => {
    try {
      return fs.readlinkSync(path.join(procRoot, String(pid), 'fd', fd)) === `socket:[${entries[0][6]}]`;
    } catch { return false; }
  })) throw sessionError('OWNER_SESSION_LISTENER_CHANGED');
  return {
    socket: socketIdentity(socketPath, uid),
    process: ownerProcess,
    boot: fs.readFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim(),
  };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertSameIdentity(expected, actual) {
  if (fingerprint(expected) !== fingerprint(actual)) {
    throw sessionError('OWNER_SESSION_IDENTITY_CHANGED');
  }
}

module.exports = {
  sessionError, processIdentity, socketIdentity, endpointIdentity,
  fingerprint, assertSameIdentity,
};
