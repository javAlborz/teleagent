'use strict';

const path = require('node:path');
const {
  ROLE_SPECS,
  createDurableStateStorageGuard,
  inspectExactStateFile,
  requireExactStatePaths,
} = require('../lib/durable-state-storage-boundary');

const BOUNDARY_VARIABLE = 'TELEAGENT_CONTROLLER_STATE_BOUNDARY';

function normalizeControllerStateConfiguration(environment = process.env, {
  uid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  gid = typeof process.getegid === 'function' ? process.getegid() : null,
  legacyHome = null,
  legacyLockPath = null,
  createStorageGuard = createDurableStateStorageGuard,
  inspectStateFile = inspectExactStateFile,
} = {}) {
  const boundary = environment[BOUNDARY_VARIABLE];
  if (boundary === undefined || boundary === null || boundary === '') {
    const home = environment.HOME || legacyHome;
    return Object.freeze({
      enforced: false,
      root: home,
      databasePath: environment.EXECUTOR_TASK_DB_PATH ||
        path.join(home, '.local', 'state', 'teleagent', 'executor-tasks.sqlite'),
      lockPath: environment.VOICE_EXECUTION_LOCK_FILE || legacyLockPath,
      storage: null,
    });
  }
  if (boundary !== 'required') {
    throw new Error(`${BOUNDARY_VARIABLE} must be exactly required.`);
  }
  const spec = ROLE_SPECS.controller;
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0 ||
      environment.HOME !== spec.root) {
    throw new Error('The hardened controller must use its exact non-root state identity.');
  }
  const paths = requireExactStatePaths('controller', {
    databasePath: environment.EXECUTOR_TASK_DB_PATH,
    lockPath: environment.VOICE_EXECUTION_LOCK_FILE,
  });
  const storage = createStorageGuard({ role: 'controller', expectedUid: uid, expectedGid: gid });
  storage.assertOpen();
  inspectStateFile(paths.lockPath, {
    expectedUid: uid,
    expectedGid: gid,
    allowAbsent: false,
  });
  inspectStateFile(paths.databasePath, {
    expectedUid: uid,
    expectedGid: gid,
    allowAbsent: false,
  });
  return Object.freeze({ enforced: true, ...paths, storage });
}

module.exports = {
  BOUNDARY_VARIABLE,
  normalizeControllerStateConfiguration,
};
