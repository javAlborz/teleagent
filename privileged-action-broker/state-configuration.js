'use strict';

const {
  createDurableStateStorageGuard,
  inspectExactStateFile,
  requireExactStatePaths,
} = require('../lib/durable-state-storage-boundary');

const BOUNDARY_VARIABLE = 'TELEAGENT_PRIVILEGED_STATE_BOUNDARY';

function normalizePrivilegedStateConfiguration(environment = process.env, {
  uid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  gid = typeof process.getegid === 'function' ? process.getegid() : null,
  createStorageGuard = createDurableStateStorageGuard,
  inspectStateFile = inspectExactStateFile,
} = {}) {
  if (environment[BOUNDARY_VARIABLE] !== 'required') {
    throw new Error(`${BOUNDARY_VARIABLE} must be exactly required.`);
  }
  if (uid !== 0 || gid !== 0) {
    throw new Error('The privileged durable-state boundary requires the root identity.');
  }
  const paths = requireExactStatePaths('privileged', {
    databasePath: environment.PRIVILEGED_ACTION_DB_PATH,
  });
  const storage = createStorageGuard({ role: 'privileged', expectedUid: 0, expectedGid: 0 });
  storage.assertOpen();
  inspectStateFile(paths.databasePath, {
    expectedUid: 0,
    expectedGid: 0,
    allowAbsent: false,
  });
  return Object.freeze({ ...paths, storage });
}

module.exports = {
  BOUNDARY_VARIABLE,
  normalizePrivilegedStateConfiguration,
};
