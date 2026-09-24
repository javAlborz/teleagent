'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const Database = require('better-sqlite3');

const MAX_BODY_BYTES = 256 * 1024;

function jsonResponse(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('JSON body must be an object.');
        }
        resolve(value);
      } catch {
        reject(Object.assign(new Error('Request body is invalid JSON.'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function statusForError(error) {
  if (error.code === 'ACTION_NOT_FOUND') return 404;
  if (error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'CAS_MISMATCH' ||
      error.code === 'CAPABILITY_REPLAYED') return 409;
  if (error.code === 'PRIVILEGED_PANIC_LOCKED') return 423;
  if (error.code === 'PRIVILEGED_STATE_CAPACITY_EXHAUSTED') return 507;
  if (String(error.code || '').includes('APPROVAL') ||
      String(error.code || '').startsWith('CAPABILITY_')) return 403;
  if (String(error.code || '').includes('INVALID') ||
      String(error.code || '').includes('DENIED')) return 400;
  return 500;
}

function assertSecureSocketDirectory(socketPath, { expectedUid = 0, expectedGid } = {}) {
  const directory = path.dirname(path.resolve(socketPath));
  const before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() ||
      before.uid !== BigInt(expectedUid) || before.gid !== BigInt(expectedGid) ||
      (before.mode & 0o7777n) !== 0o750n || fs.realpathSync(directory) !== directory) {
    throw new Error('The broker socket directory must be exact 0750 root:controller storage.');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(directory, { bigint: true });
    for (const metadata of [opened, after]) {
      if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
          metadata.dev !== before.dev || metadata.ino !== before.ino ||
          metadata.uid !== before.uid || metadata.gid !== before.gid ||
          metadata.mode !== before.mode || fs.realpathSync(directory) !== directory) {
        throw new Error('The broker socket directory changed while it was inspected.');
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return directory;
}

function removeOwnedStaleSocket(socketPath, expectedUid, expectedGid = null) {
  if (!fs.existsSync(socketPath)) return;
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== expectedUid ||
      (expectedGid !== null && stat.gid !== expectedGid) || (stat.mode & 0o777) !== 0o660) {
    throw new Error('Refusing to replace an unsafe privileged broker socket path.');
  }
  fs.unlinkSync(socketPath);
}

function probeUnixSocket(socketPath, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out while checking for an existing privileged broker.'));
    }, timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

function acquireBrokerSingletonLock(lockPath, { expectedUid = 0 } = {}) {
  const resolved = path.resolve(lockPath);
  try {
    const descriptor = fs.openSync(
      resolved,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600
    );
    fs.closeSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid ||
      (stat.mode & 0o077) !== 0) {
    throw new Error('The privileged broker singleton lock database is unsafe.');
  }
  const database = new Database(resolved, { timeout: 250 });
  try {
    database.pragma('busy_timeout = 250');
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS broker_lifetime_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
      INSERT INTO broker_lifetime_lock (singleton) VALUES (1)
      ON CONFLICT(singleton) DO NOTHING;
    `);
  } catch (error) {
    database.close();
    if (String(error.code || '').startsWith('SQLITE_BUSY')) {
      throw new Error('Another privileged action broker holds the kernel-backed singleton lock.');
    }
    throw error;
  }
  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      try {
        database.exec('ROLLBACK');
      } finally {
        database.close();
      }
    },
  });
}

function createPrivilegedActionServer({
  broker,
  store,
  socketPath,
  expectedUid = 0,
  controllerGid,
  readinessProvider = null,
} = {}) {
  if (!broker || !store || !path.isAbsolute(String(socketPath || '')) ||
      !Number.isInteger(controllerGid) || controllerGid < 0) {
    throw new Error('A broker, store, absolute socket path, and controller GID are required.');
  }
  assertSecureSocketDirectory(socketPath, { expectedUid, expectedGid: controllerGid });
  const server = http.createServer(async (req, res) => {
    // Kernel Unix-socket mode 0660 is the mandatory admission boundary. If a
    // supported Node runtime exposes peer credentials, additionally reject any
    // primary UID/GID outside root and the private controller identity.
    if (typeof req.socket.getPeerCredentials === 'function') {
      const peer = req.socket.getPeerCredentials();
      if (peer?.uid !== 0 && peer?.gid !== controllerGid) {
        return jsonResponse(res, 403, { success: false, code: 'PEER_UNAUTHORIZED' });
      }
    }
    try {
      const url = new URL(req.url, 'http://unix');
      if (req.method === 'GET' && url.pathname === '/health') {
        const panic = store.getPanicStatus();
        const readiness = readinessProvider
          ? readinessProvider()
          : {
              ready: !panic.locked && !panic.recoveryBlocked,
              panicLocked: panic.locked,
              recoveryBlocked: Boolean(panic.recoveryBlocked),
            };
        return jsonResponse(res, readiness.ready ? 200 : 503, {
          success: readiness.ready,
          ready: readiness.ready,
          service: 'teleagent-privileged-action-broker',
          panic,
          recovery: readiness,
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/actions') {
        const body = await readJson(req);
        const result = broker.submit({
          idempotencyKey: body.idempotencyKey,
          jobId: body.jobId,
          callId: body.callId,
          plan: body.plan,
          authorization: body.authorization,
        });
        return jsonResponse(res, result.created ? 202 : 200, { success: true, ...result });
      }
      const byKey = url.pathname.match(/^\/v1\/actions\/by-idempotency\/([^/]+)$/);
      if (req.method === 'GET' && byKey) {
        const action = broker.getByIdempotencyKey(decodeURIComponent(byKey[1]));
        if (!action) return jsonResponse(res, 404, { success: false, code: 'ACTION_NOT_FOUND' });
        return jsonResponse(res, 200, { success: true, action });
      }
      const cancelByKey = url.pathname.match(
        /^\/v1\/actions\/by-idempotency\/([^/]+)\/cancel$/
      );
      if (req.method === 'POST' && cancelByKey) {
        const body = await readJson(req);
        const result = broker.cancelByIdempotency({
          idempotencyKey: decodeURIComponent(cancelByKey[1]),
          jobId: body.jobId,
          reason: body.reason,
          source: body.source || 'authenticated_host_controller',
        });
        return jsonResponse(res, 200, { success: true, ...result });
      }
      const actionPath = url.pathname.match(/^\/v1\/actions\/([^/]+)$/);
      if (req.method === 'GET' && actionPath) {
        const action = broker.getAction(decodeURIComponent(actionPath[1]));
        if (!action) return jsonResponse(res, 404, { success: false, code: 'ACTION_NOT_FOUND' });
        return jsonResponse(res, 200, { success: true, action });
      }
      const cancelPath = url.pathname.match(/^\/v1\/actions\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelPath) {
        const body = await readJson(req);
        const result = broker.cancel({
          actionId: decodeURIComponent(cancelPath[1]),
          reason: body.reason,
          source: body.source || 'authenticated_host_controller',
          expectedRevision: body.expectedRevision ?? null,
        });
        return jsonResponse(res, 200, { success: true, ...result });
      }
      if (req.method === 'POST' && url.pathname === '/v1/panic') {
        const body = await readJson(req);
        const result = broker.panic({
          reason: body.reason,
          source: body.source || 'authenticated_host_controller',
        });
        return jsonResponse(res, 200, { success: true, ...result });
      }
      return jsonResponse(res, 404, { success: false, code: 'NOT_FOUND' });
    } catch (error) {
      return jsonResponse(res, statusForError(error), {
        success: false,
        code: error.code || 'PRIVILEGED_BROKER_ERROR',
        error: error.message,
      });
    }
  });

  return Object.freeze({
    server,
    async listen() {
      assertSecureSocketDirectory(socketPath, { expectedUid, expectedGid: controllerGid });
      if (fs.existsSync(socketPath)) {
        if (await probeUnixSocket(socketPath)) {
          throw new Error('A privileged action broker is already listening; refusing to replace it.');
        }
        removeOwnedStaleSocket(socketPath, expectedUid, controllerGid);
      }
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          fs.chownSync(socketPath, expectedUid, controllerGid);
          fs.chmodSync(socketPath, 0o660);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          try {
            removeOwnedStaleSocket(socketPath, expectedUid, controllerGid);
          } catch {
            // A changed socket path must not be removed during shutdown.
          }
          resolve();
        });
      });
    },
  });
}

module.exports = {
  acquireBrokerSingletonLock,
  assertSecureSocketDirectory,
  createPrivilegedActionServer,
  readJson,
  probeUnixSocket,
  removeOwnedStaleSocket,
};
