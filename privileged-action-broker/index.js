#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { PrivilegedActionBroker } = require('./broker');
const { PrivilegedActionDispatcher } = require('./executor');
const { loadRootOwnedPolicy } = require('./policy');
const {
  acquireBrokerSingletonLock,
  assertSecureSocketDirectory,
  createPrivilegedActionServer,
} = require('./server');
const { PrivilegedActionStore } = require('./store');
const {
  normalizePrivilegedStateConfiguration,
} = require('./state-configuration');
const { createConfiguredPrivilegedActionVerifier } = require('./verifier');

const EXPECTED_SOCKET_PATH = '/run/teleagent-privileged-action/broker.sock';

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function absoluteEnvironment(name) {
  const value = requiredEnvironment(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

function numericEnvironment(name) {
  const value = Number.parseInt(requiredEnvironment(name), 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a numeric ID.`);
  return value;
}

function controllerGroupId(socketPath) {
  const configured = String(process.env.PRIVILEGED_ACTION_CONTROLLER_GID || '').trim();
  const gid = configured
    ? numericEnvironment('PRIVILEGED_ACTION_CONTROLLER_GID')
    : fs.lstatSync(path.dirname(socketPath)).gid;
  if (!Number.isInteger(gid) || gid <= 0) {
    throw new Error('The broker socket directory must use a dedicated non-root controller group.');
  }
  return gid;
}

async function main() {
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
    throw new Error('The privileged action broker must run as root.');
  }
  const socketPath = absoluteEnvironment('PRIVILEGED_ACTION_SOCKET_PATH');
  if (socketPath !== EXPECTED_SOCKET_PATH) {
    throw new Error(`PRIVILEGED_ACTION_SOCKET_PATH must be exactly ${EXPECTED_SOCKET_PATH}.`);
  }
  const state = normalizePrivilegedStateConfiguration(process.env);
  const dbPath = state.databasePath;
  const policyPath = absoluteEnvironment('PRIVILEGED_ACTION_POLICY_FILE');
  const controllerGid = controllerGroupId(socketPath);
  assertSecureSocketDirectory(socketPath, { expectedUid: 0, expectedGid: controllerGid });
  const singletonLock = acquireBrokerSingletonLock(`${socketPath}.lock.sqlite3`, {
    expectedUid: 0,
  });
  let store;
  let dispatcher;
  let socketServer;
  try {
    const policy = loadRootOwnedPolicy(policyPath, { expectedUid: 0 });
    store = new PrivilegedActionStore({
      dbPath,
      expectedUid: 0,
      expectedGid: 0,
      strictOwnership: true,
      assertStorageOpen: () => state.storage.assertOpen(),
      admitNewWork: () => state.storage.assertNewWork(),
    });
    const verifier = createConfiguredPrivilegedActionVerifier({
      environment: process.env,
      sqliteDatabase: store.db,
      expectedUid: 0,
    });
    dispatcher = new PrivilegedActionDispatcher({ store, policy, expectedUid: 0 });
    await dispatcher.recoverStartup();
    const broker = new PrivilegedActionBroker({ store, policy, verifier, dispatcher });
    socketServer = createPrivilegedActionServer({
      broker,
      store,
      socketPath,
      expectedUid: 0,
      controllerGid,
      readinessProvider: () => {
        const readiness = dispatcher.getReadiness();
        try {
          const storage = state.storage.inspect();
          return {
            ...readiness,
            ready: readiness.ready && storage.admitted,
            stateStorageAdmitted: storage.admitted,
          };
        } catch (error) {
          return {
            ...readiness,
            ready: false,
            stateStorageAdmitted: false,
            stateStorageError: error.code || 'state_boundary_unavailable',
          };
        }
      },
    });
    await socketServer.listen();
    dispatcher.start();
    process.stdout.write('Privileged action broker is listening on its private Unix socket.\n');
  } catch (error) {
    const closure = await dispatcher?.close();
    if (closure && !closure.safeToClose) {
      setInterval(() => {}, 60000);
      throw new Error(
        `Startup failed and privileged child quiescence remains unresolved: ${error.message}`
      );
    }
    store?.close();
    singletonLock.release();
    throw error;
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await socketServer.close();
    const closure = await dispatcher.close();
    if (!closure.safeToClose) {
      // Stay resident so systemd's KillMode=control-group remains a final
      // containment boundary. Never close SQLite or claim a clean shutdown
      // while a persisted privileged child identity remains unresolved.
      setInterval(() => {}, 60000);
      throw new Error('Privileged child quiescence is unresolved; shutdown remains blocked.');
    }
    store.close();
    singletonLock.release();
  };
  const handleSignal = () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(`Privileged action broker shutdown blocked: ${error.message}\n`);
        process.exitCode = 1;
      });
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Privileged action broker refused to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
