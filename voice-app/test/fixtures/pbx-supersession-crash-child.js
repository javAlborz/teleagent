'use strict';

// Synthetic state only. The parent creates a unique temporary fixture and
// distinguishes this deliberate self-kill from timeout/watchdog failures.
const Database = require('better-sqlite3');
const { writeSync } = require('node:fs');
const { createSqlitePbxApprovalAttesterStore } = require('../../../lib/pbx-approval-attester-store');
const [filename, boundary, previousJson, replacementJson] = process.argv.slice(2);
const previous = JSON.parse(previousJson);
const replacement = JSON.parse(replacementJson);
const db = new Database(filename, { fileMustExist: true });
db.pragma('synchronous = FULL');
function killAt(name) {
  if (boundary === name) {
    writeSync(1, `PBX_TEST_BOUNDARY:${name}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}
const wrapped = {
  get inTransaction() { return db.inTransaction; },
  exec(sql) {
    const result = db.exec(sql);
    if (sql === 'COMMIT') killAt('commit');
    return result;
  },
  prepare(sql) {
    const statement = db.prepare(sql);
    if (!/UPDATE main\./u.test(sql) && !/INSERT OR IGNORE INTO main\./u.test(sql)) return statement;
    return {
      run(...args) {
        const result = statement.run(...args);
        killAt(/UPDATE main\./u.test(sql) ? 'supersede' : 'claim');
        return result;
      },
    };
  },
};
const store = createSqlitePbxApprovalAttesterStore(wrapped);
store.supersedeArm({ previousArmSha256: previous.armSha256, replacement });
throw new Error('The requested kill boundary was not reached.');
