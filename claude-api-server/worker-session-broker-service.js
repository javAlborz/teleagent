'use strict';

const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const { TmuxAgentController } = require('./tmux-agent-controller');
const { createWorkerSessionBroker } = require('./worker-session-broker');
const { WorkerSessionOperationStore } = require('./worker-session-operation-store');
const { AttestedWorkerSessionInspector } = require('./worker-session-attested-inspector');
const { WorkerSessionPaneManager } = require('./worker-session-pane-manager');
const {
  FIXED_WORKER_STATE_ROOT,
  STATE_DIRECTORIES,
  createWorkerStateStorageGuard,
} = require('./worker-state-storage-boundary');
const {
  panicProviderPlaneRoot,
  panicProviderSupervisors,
  unlockProviderPlaneRoot,
  unlockProviderSupervisors,
} = require('./provider-supervisor-client');

const FIXED_BROKER_USER = 'teleagent-session-broker';
const FIXED_BROKER_HOME = STATE_DIRECTORIES['session-broker'];
const FIXED_PROVIDER_VIEW = `${FIXED_BROKER_HOME}/provider-view`;
const FIXED_WORKSPACE_ROOT = '/srv/teleagent-agent-workspaces';
const FIXED_BROKER_SOCKET = '/run/teleagent-worker-session/broker.sock';
const FIXED_TMUX_SOCKET = '/run/teleagent-worker-session/tmux.sock';
const FIXED_STATE_DB = `${FIXED_BROKER_HOME}/operations.sqlite`;
const FIXED_SINGLETON_DB = `${FIXED_BROKER_HOME}/lifetime-lock.sqlite`;
const FIXED_CONTROLLER_GROUP = 'teleagent-control';
const SINGLETON_BUSY_TIMEOUT_MS = 500;
const SENSITIVE_ENVIRONMENT_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|AUTH(?:ORIZATION)?)/i;

function fixedPath(value, expected, label) {
  const normalized = String(value || expected).trim();
  if (normalized !== expected) throw new Error(`${label} must be ${expected}.`);
  return normalized;
}

function withinOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseInspectionRoots(value, workspaceRoot = FIXED_WORKSPACE_ROOT) {
  const entries = String(value || workspaceRoot)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error('WORKER_SESSION_INSPECTION_ROOTS must contain 1-16 workspace roots.');
  }
  return entries.map((entry) => {
    if (!path.isAbsolute(entry) || path.normalize(entry) !== entry ||
        !withinOrEqual(workspaceRoot, entry)) {
      throw new Error('Every worker inspection root must be canonical and inside the fixed workspace root.');
    }
    return entry;
  });
}

function assertCredentialFreeEnvironment(environment = process.env) {
  const forbidden = Object.keys(environment).filter((name) => (
    SENSITIVE_ENVIRONMENT_NAME.test(name) ||
    ['NODE_OPTIONS', 'NODE_PATH'].includes(name) ||
    name.startsWith('LD_')
  ));
  if (forbidden.length > 0) {
    throw new Error(
      `Worker session broker refuses credential-bearing or loader environment names: ${forbidden.sort().join(', ')}.`
    );
  }
}

function inheritedSocketFd(environment = process.env, pid = process.pid) {
  if (String(environment.LISTEN_PID || '') !== String(pid) ||
      environment.LISTEN_FDS !== '1') {
    throw new Error('Worker session broker requires exactly one systemd-inherited socket.');
  }
  if (environment.LISTEN_FDNAMES && environment.LISTEN_FDNAMES !== 'worker-session-broker') {
    throw new Error('Worker session broker inherited an unexpected socket name.');
  }
  return 3;
}

function lookupSystemGroupGid(
  groupName = FIXED_CONTROLLER_GROUP,
  groupFile = '/etc/group',
  fileSystem = fs
) {
  const metadata = fileSystem.lstatSync(groupFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0) {
    throw new Error('The system group database is unsafe.');
  }
  const matches = fileSystem.readFileSync(groupFile, 'utf8').split('\n').filter((line) => {
    if (!line || line.startsWith('#')) return false;
    return line.split(':', 1)[0] === groupName;
  });
  if (matches.length !== 1) throw new Error(`Required system group ${groupName} is missing.`);
  const fields = matches[0].split(':');
  const gidText = fields[2];
  const gid = Number(gidText);
  if (fields.length !== 4 || !/^\d+$/.test(gidText) ||
      !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error(`${groupName} has an invalid GID.`);
  }
  return gid;
}

function socketPathForDescriptor(fd, procNetUnix = '/proc/net/unix') {
  const inode = String(fs.fstatSync(fd).ino);
  const matches = fs.readFileSync(procNetUnix, 'utf8').split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[6] === inode && fields.length >= 8 ? [fields.slice(7).join(' ')] : [];
  });
  if (matches.length !== 1 || !matches[0].startsWith('/')) {
    throw new Error('Worker session broker could not bind the inherited listener to one path.');
  }
  return path.resolve(matches[0]);
}

function acquireWorkerSessionSingletonLock(lockPath = FIXED_SINGLETON_DB, {
  expectedUid = typeof process.getuid === 'function' ? process.getuid() : null,
  allowTestPath = false,
} = {}) {
  const resolved = path.resolve(lockPath);
  if (resolved !== FIXED_SINGLETON_DB && !allowTestPath) {
    throw new Error(`Worker session singleton path must be ${FIXED_SINGLETON_DB}.`);
  }
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
  const metadata = fs.lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== expectedUid ||
      (metadata.mode & 0o077) !== 0) {
    throw new Error('Worker session singleton database ownership is unsafe.');
  }
  // Journal/schema initialization can briefly hold a read lock before any
  // lifetime owner exists. Bound each SQLite lock wait so concurrent startups
  // can finish that phase; a held EXCLUSIVE transaction still rejects its
  // contender. Failed acquisitions close promptly, including SQLite's
  // deadlock-avoidance SQLITE_BUSY path, before any store/recovery work.
  const database = new Database(resolved, { timeout: SINGLETON_BUSY_TIMEOUT_MS });
  try {
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.exec(`
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS worker_session_lifetime_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
      INSERT INTO worker_session_lifetime_lock (singleton) VALUES (1)
      ON CONFLICT(singleton) DO NOTHING;
    `);
  } catch (error) {
    database.close();
    if (String(error.code || '').startsWith('SQLITE_BUSY')) {
      throw new Error('Another worker session broker holds the lifetime lock.');
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

function assertInheritedSocketBoundary(
  fd,
  socketPath,
  expectedUid,
  expectedControllerGid,
  { allowTestPath = false } = {}
) {
  const descriptorMetadata = fs.fstatSync(fd);
  const resolved = path.resolve(String(socketPath || ''));
  if (!descriptorMetadata.isSocket() || (!allowTestPath && resolved !== FIXED_BROKER_SOCKET)) {
    throw new Error('Worker session broker inherited an unexpected listener.');
  }
  if (socketPathForDescriptor(fd) !== resolved) {
    throw new Error('Worker session broker inherited a listener for a different path.');
  }
  const pathMetadata = fs.lstatSync(resolved);
  if (!pathMetadata.isSocket() || pathMetadata.isSymbolicLink() ||
      pathMetadata.uid !== expectedUid || pathMetadata.gid !== expectedControllerGid ||
      (pathMetadata.mode & 0o777) !== 0o660) {
    throw new Error(
      'Worker session broker requires a broker-owned mode-0660 controller-group socket.'
    );
  }
}

function listenOnInheritedSocket(fd, expectedPath, Server = http.Server) {
  const server = new Server();
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen({ fd, exclusive: false }, () => {
      server.removeListener('error', onError);
      const address = server.address();
      // Node reports null for some already-listening descriptors inherited from
      // systemd. The kernel inode-to-path table remains authoritative then.
      const adoptedPath = typeof address === 'string'
        ? path.resolve(address)
        : socketPathForDescriptor(fd);
      if (adoptedPath !== expectedPath) {
        server.close(() => reject(new Error(
          'Worker session broker did not adopt the fixed systemd Unix socket.'
        )));
        return;
      }
      resolve(server);
    });
  });
}

function normalizeWorkerSessionServiceConfig(environment = process.env, {
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  gid = typeof process.getgid === 'function' ? process.getgid() : null,
  username = os.userInfo().username,
  pid = process.pid,
  controllerGid = lookupSystemGroupGid(),
} = {}) {
  assertCredentialFreeEnvironment(environment);
  if (!Number.isInteger(uid) || uid === 0 || !Number.isInteger(gid) || gid === 0 ||
      username !== FIXED_BROKER_USER) {
    throw new Error(`Worker session broker must run as the non-root ${FIXED_BROKER_USER} identity.`);
  }
  const home = fixedPath(environment.HOME, FIXED_BROKER_HOME, 'HOME');
  const providerView = fixedPath(
    environment.WORKER_SESSION_PROVIDER_VIEW,
    FIXED_PROVIDER_VIEW,
    'WORKER_SESSION_PROVIDER_VIEW'
  );
  const workspaceRoot = fixedPath(
    environment.WORKER_SESSION_WORKSPACE_ROOT,
    FIXED_WORKSPACE_ROOT,
    'WORKER_SESSION_WORKSPACE_ROOT'
  );
  return Object.freeze({
    uid,
    gid,
    controllerGid,
    home,
    providerView,
    workspaceRoot,
    inspectionRoots: Object.freeze(parseInspectionRoots(
      environment.WORKER_SESSION_INSPECTION_ROOTS,
      workspaceRoot
    )),
    brokerSocket: fixedPath(
      environment.WORKER_SESSION_BROKER_SOCKET_PATH,
      FIXED_BROKER_SOCKET,
      'WORKER_SESSION_BROKER_SOCKET_PATH'
    ),
    tmuxSocket: fixedPath(
      environment.WORKER_SESSION_TMUX_SOCKET_PATH,
      FIXED_TMUX_SOCKET,
      'WORKER_SESSION_TMUX_SOCKET_PATH'
    ),
    stateDb: fixedPath(
      environment.WORKER_SESSION_DB_PATH,
      FIXED_STATE_DB,
      'WORKER_SESSION_DB_PATH'
    ),
    listenFd: inheritedSocketFd(environment, pid),
    singletonDb: fixedPath(
      environment.WORKER_SESSION_SINGLETON_DB_PATH,
      FIXED_SINGLETON_DB,
      'WORKER_SESSION_SINGLETON_DB_PATH'
    ),
  });
}

async function startWorkerSessionBroker({
  config = normalizeWorkerSessionServiceConfig(),
  Inspector = AttestedWorkerSessionInspector,
  Controller = TmuxAgentController,
  Store = WorkerSessionOperationStore,
  PaneManager = WorkerSessionPaneManager,
  createBroker = createWorkerSessionBroker,
  acquireSingleton = acquireWorkerSessionSingletonLock,
  createStorageGuard = createWorkerStateStorageGuard,
  assertSocketBoundary = assertInheritedSocketBoundary,
  adoptInheritedSocket = listenOnInheritedSocket,
} = {}) {
  const storage = createStorageGuard({
    role: 'session-broker',
    expectedUid: config.uid,
    expectedGid: config.gid,
  });
  storage.assertNewWork();
  assertSocketBoundary(
    config.listenFd,
    config.brokerSocket,
    config.uid,
    config.controllerGid
  );
  const singletonLock = acquireSingleton(config.singletonDb, {
    expectedUid: config.uid,
  });
  let inheritedServer;
  try {
    inheritedServer = await adoptInheritedSocket(config.listenFd, config.brokerSocket);
  } catch (error) {
    singletonLock.release();
    throw error;
  }
  let store;
  try {
    store = new Store({
      dbPath: config.stateDb,
      expectedUid: config.uid,
      strictOwnership: true,
      admitNewWork: () => storage.assertNewWork(),
    });
  } catch (error) {
    if (inheritedServer.listening) {
      await new Promise((resolve) => inheritedServer.close(resolve));
    }
    singletonLock.release();
    throw error;
  }
  let broker;
  try {
    const paneManager = new PaneManager({
      store,
      tmuxSocketPath: config.tmuxSocket,
      workspaceRoot: config.workspaceRoot,
    });
    await paneManager.recover();
    const inspector = new Inspector({
      allowedRoots: config.inspectionRoots,
      providerView: config.providerView,
      tmuxSocketPath: config.tmuxSocket,
      store,
      workspaceRoot: config.workspaceRoot,
    });
    const controller = new Controller({
      inspector,
      tmuxSocketPath: config.tmuxSocket,
    });
    broker = createBroker({
      inspector,
      controller,
      store,
      workerHome: config.home,
      inspectionRoots: config.inspectionRoots,
      server: inheritedServer,
      paneManager,
      providerControl: {
        panic: panicProviderSupervisors,
        unlock: unlockProviderSupervisors,
        panicRoot: panicProviderPlaneRoot,
        unlockRoot: unlockProviderPlaneRoot,
      },
    });
  } catch (error) {
    if (broker?.close) await broker.close().catch(() => {});
    else if (inheritedServer.listening) {
      await new Promise((resolve) => inheritedServer.close(resolve));
    }
    store.close();
    singletonLock.release();
    throw error;
  }
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await broker.close();
      store.close();
      singletonLock.release();
    })();
    return shutdownPromise;
  };
  return { broker, store, storage, shutdown };
}

if (require.main === module) {
  let runtime;
  startWorkerSessionBroker().then((started) => {
    runtime = started;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => void runtime.shutdown().then(
        () => process.exit(0),
        () => process.exit(1)
      ));
    }
  }).catch((error) => {
    console.error(`Worker session broker startup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  FIXED_BROKER_HOME,
  FIXED_BROKER_USER,
  FIXED_BROKER_SOCKET,
  FIXED_CONTROLLER_GROUP,
  FIXED_PROVIDER_VIEW,
  FIXED_SINGLETON_DB,
  FIXED_STATE_DB,
  FIXED_TMUX_SOCKET,
  FIXED_WORKSPACE_ROOT,
  FIXED_WORKER_STATE_ROOT,
  acquireWorkerSessionSingletonLock,
  assertCredentialFreeEnvironment,
  assertInheritedSocketBoundary,
  inheritedSocketFd,
  listenOnInheritedSocket,
  lookupSystemGroupGid,
  normalizeWorkerSessionServiceConfig,
  parseInspectionRoots,
  socketPathForDescriptor,
  startWorkerSessionBroker,
};
