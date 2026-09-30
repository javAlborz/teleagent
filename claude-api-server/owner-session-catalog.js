'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sessionError, assertSameIdentity } = require('./owner-session-endpoint');
const { hash } = require('./owner-session-delivery');

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw sessionError('OWNER_CATALOG_INVALID');
  }
}

function canonicalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      /[\x00-\x1f\x7f]/u.test(value)) throw sessionError('OWNER_CATALOG_INVALID');
  return value;
}

function executableIdentity(pid) {
  const filename = fs.readlinkSync(`/proc/${pid}/exe`);
  const stat = fs.statSync(`/proc/${pid}/exe`);
  return { path: filename, dev: String(stat.dev), ino: String(stat.ino), size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs), ctimeMs: Math.floor(stat.ctimeMs) };
}

// The catalog is trusted operator configuration, never provider/model output.
// Exact enrollment is intentionally separate from native daemon discovery.
function validateCatalog(input) {
  const catalog = JSON.parse(JSON.stringify(input));
  exact(catalog, ['version', 'ownerUid', 'excludedRoots', 'sessions']);
  if (catalog.version !== 1 || !Number.isSafeInteger(catalog.ownerUid) || catalog.ownerUid < 1 ||
      !Array.isArray(catalog.excludedRoots) || catalog.excludedRoots.length < 1 ||
      !Array.isArray(catalog.sessions) || catalog.sessions.length > 32) {
    throw sessionError('OWNER_CATALOG_INVALID');
  }
  catalog.excludedRoots.forEach(canonicalPath);
  const ids = new Set(); const targets = new Set();
  for (const entry of catalog.sessions) {
    exact(entry, ['id', 'label', 'provider', 'sessionId', 'cwd', 'endpoint', 'identity',
      'executable', 'registryRoot', 'socketRoot']);
    if (!/^os_[a-zA-Z0-9]{1,64}$/.test(entry.id) || ids.has(entry.id) ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(entry.label) ||
        !['codex', 'claude'].includes(entry.provider) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.sessionId)) {
      throw sessionError('OWNER_CATALOG_INVALID');
    }
    const target = `${entry.provider}:${entry.sessionId}`;
    if (targets.has(target)) throw sessionError('OWNER_CATALOG_INVALID');
    targets.add(target); ids.add(entry.id);
    canonicalPath(entry.cwd);
    // Exclude bridge work even when an operator accidentally enrolls it.
    if (entry.cwd === '/home/alborz/ufst' || entry.cwd.startsWith('/home/alborz/ufst/') ||
        catalog.excludedRoots.some((root) => entry.cwd === root || entry.cwd.startsWith(`${root}/`))) {
      throw sessionError('OWNER_CATALOG_WORK_BRIDGE_DENIED');
    }
    exact(entry.endpoint, ['socketPath', 'pid', 'uid']);
    canonicalPath(entry.endpoint.socketPath);
    if (entry.endpoint.uid !== catalog.ownerUid || !Number.isSafeInteger(entry.endpoint.pid) ||
        entry.endpoint.pid <= 0) throw sessionError('OWNER_CATALOG_INVALID');
    exact(entry.identity, ['socket', 'process', 'boot']);
    exact(entry.identity.socket, ['path', 'dev', 'ino', 'uid']);
    exact(entry.identity.process, ['pid', 'start']);
    if (entry.identity.socket.path !== entry.endpoint.socketPath ||
        entry.identity.socket.uid !== catalog.ownerUid || entry.identity.process.pid !== entry.endpoint.pid ||
        !/^\d+$/.test(entry.identity.process.start) ||
        !/^[a-f0-9-]{36}$/.test(entry.identity.boot) ||
        !/^\d+$/.test(entry.identity.socket.dev) || !/^\d+$/.test(entry.identity.socket.ino)) {
      throw sessionError('OWNER_CATALOG_INVALID');
    }
    exact(entry.executable, ['path', 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']);
    canonicalPath(entry.executable.path);
    if (!/^\d+$/.test(entry.executable.dev) || !/^\d+$/.test(entry.executable.ino) ||
        !Number.isSafeInteger(entry.executable.size) || entry.executable.size <= 0 ||
        !Number.isSafeInteger(entry.executable.mtimeMs) || !Number.isSafeInteger(entry.executable.ctimeMs)) throw sessionError('OWNER_CATALOG_INVALID');
    if (entry.provider === 'claude') {
      canonicalPath(entry.registryRoot); canonicalPath(entry.socketRoot);
      if (entry.endpoint.socketPath !== path.join(entry.socketRoot, `${entry.endpoint.pid}.sock`)) {
        throw sessionError('OWNER_CATALOG_INVALID');
      }
    } else if (entry.registryRoot !== null || entry.socketRoot !== null) {
      throw sessionError('OWNER_CATALOG_INVALID');
    }
  }
  return catalog;
}

function readCatalog(filename, ownerUid = 0) {
  canonicalPath(filename);
  let directory = path.dirname(filename);
  while (directory !== '/') {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== ownerUid || (stat.mode & 0o022)) {
      throw sessionError('OWNER_CATALOG_UNSAFE');
    }
    directory = path.dirname(directory);
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o022) ||
        stat.nlink !== 1 || stat.size > 128 * 1024) throw sessionError('OWNER_CATALOG_UNSAFE');
    const buffer = Buffer.alloc(128 * 1024 + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 128 * 1024) throw sessionError('OWNER_CATALOG_UNSAFE');
    return validateCatalog(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
  } finally { fs.closeSync(fd); }
}

class OwnerSessionCatalog {
  constructor(catalog, { assertCurrent = () => {} } = {}) {
    this.catalog = validateCatalog(catalog);
    this.digest = hash(this.catalog);
    this.assertCurrent = assertCurrent;
  }
  static load(filename) {
    const catalog = readCatalog(filename);
    const digest = hash(catalog);
    return new OwnerSessionCatalog(catalog, { assertCurrent: () => {
      if (hash(readCatalog(filename)) !== digest) throw sessionError('OWNER_CATALOG_CHANGED');
    } });
  }
  entries() { this.assertCurrent(); return structuredClone(this.catalog.sessions); }
  get(id) {
    this.assertCurrent();
    const entry = this.catalog.sessions.find((candidate) => candidate.id === id);
    if (!entry) throw sessionError('OWNER_SESSION_NOT_ENROLLED');
    return structuredClone(entry);
  }
  assertEntry(entry, client, session) {
    this.assertCurrent();
    assertSameIdentity(entry.identity, client.identity);
    assertSameIdentity(entry.executable, executableIdentity(entry.endpoint.pid));
    if (session.sessionId !== entry.sessionId || session.cwd !== entry.cwd ||
        fs.realpathSync(entry.cwd) !== entry.cwd) throw sessionError('OWNER_SESSION_IDENTITY_CHANGED');
    client.assertIdentity();
  }
}

module.exports = { OwnerSessionCatalog, validateCatalog, readCatalog, executableIdentity, exact };
