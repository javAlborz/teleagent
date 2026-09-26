'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

// Explicit global.gc() runs inside a JS context and misses the ObjectWrap
// cleanup failure. Allocate unreachable statements until V8 collects naturally.
const probe = `
  const Database = require(process.argv[1]);
  const db = new Database(':memory:');
  let retained = [];
  for (let index = 0; index < 100000; index += 1) {
    db.prepare('SELECT 1').get();
    retained.push({ index });
    if (retained.length > 1000) retained = [];
  }
  db.close();
  process.stdout.write('SQLITE_ALLOCATION_GC_PASSED\\n');
`;

for (const component of [
  'claude-api-server', 'voice-app', 'privileged-action-broker', 'realtime-sip-gateway',
]) {
  test(`${component} SQLite survives allocation-driven garbage collection`, () => {
    const dependency = path.resolve(__dirname, '../..', component, 'node_modules/better-sqlite3');
    const result = spawnSync(process.execPath, ['-e', probe, dependency], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'SQLITE_ALLOCATION_GC_PASSED\n');
  });
}
