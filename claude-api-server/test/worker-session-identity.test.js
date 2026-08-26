'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  SHARED_GROUP_MEMBERS,
  USERS,
  validateIdentityRecords,
  validateSysusersSource,
} = require('../../deploy/worker-session/verify-worker-session-identity');

const DEPLOY = path.join(__dirname, '..', '..', 'deploy', 'worker-session');

function identityFixture({ mutatePasswd = (rows) => rows, mutateGroups = (rows) => rows } = {}) {
  const privateIds = Object.fromEntries(USERS.map(([name], index) => [name, 2001 + index]));
  const sharedIds = Object.fromEntries(
    Object.keys(SHARED_GROUP_MEMBERS).map((name, index) => [name, 2101 + index])
  );
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    ...USERS.map(([name, home]) => {
      const id = privateIds[name];
      return `${name}:x:${id}:${id}:${name}:${home}:/usr/sbin/nologin`;
    }),
  ];
  const groups = [
    'root:x:0:',
    ...USERS.map(([name]) => `${name}:x:${privateIds[name]}:`),
    ...Object.entries(SHARED_GROUP_MEMBERS).map(([name, members]) => (
      `${name}:x:${sharedIds[name]}:${members.join(',')}`
    )),
  ];
  return {
    passwd: `${mutatePasswd(passwd).join('\n')}\n`,
    group: `${mutateGroups(groups).join('\n')}\n`,
  };
}

test('worker-session sysusers source is the exact split identity topology', () => {
  const source = fs.readFileSync(
    path.join(DEPLOY, 'teleagent-worker-session.sysusers'), 'utf8'
  );
  assert.equal(validateSysusersSource(source), true);
});

test('worker identity checks accept an explicit canonical component source pin', () => {
  const verifier = fs.readFileSync(
    path.join(DEPLOY, 'verify-worker-session-identity'), 'utf8'
  );
  const installer = fs.readFileSync(
    path.join(DEPLOY, 'teleagent-worker-session-install'), 'utf8'
  );
  assert.match(verifier, /--source-root ABSOLUTE_COMPONENT_ROOT/);
  assert.match(verifier, /fs\.realpathSync\(sourceRoot\) !== sourceRoot/);
  assert.match(verifier, /path\.basename\(sourceRoot\) !== 'worker-session'/);
  assert.equal(
    (installer.match(/--installed-check --source-root "\$source_root"/g) || []).length,
    2
  );
});

test('worker-session identity verifier accepts unique private and shared numeric identities', () => {
  const fixture = identityFixture();
  const result = validateIdentityRecords(fixture.passwd, fixture.group);
  assert.equal(result['teleagent-control'].uid, 2001);
  assert.equal(result['teleagent-control'].gid, 2001);
  assert.equal(result['teleagent-provider-launch'].gid, 2102);
});

test('worker-session identity verifier rejects UID, GID, primary, and supplementary collisions', () => {
  const fixtures = [
    identityFixture({
      mutatePasswd: (rows) => [...rows, 'intruder:x:2001:3001:alias:/nonexistent:/usr/sbin/nologin'],
    }),
    identityFixture({
      mutateGroups: (rows) => [...rows, 'docker:x:2001:'],
    }),
    identityFixture({
      mutatePasswd: (rows) => [...rows, 'intruder:x:3001:2001:alias:/nonexistent:/usr/sbin/nologin'],
    }),
    identityFixture({
      mutatePasswd: (rows) => [...rows, 'intruder:x:3001:2102:alias:/nonexistent:/usr/sbin/nologin'],
    }),
    identityFixture({
      mutateGroups: (rows) => rows.map((row) => row === 'root:x:0:'
        ? 'root:x:0:teleagent-control' : row),
    }),
    identityFixture({
      mutatePasswd: (rows) => rows.map((row) => row.startsWith('teleagent-control:')
        ? row.replace('/usr/sbin/nologin', '/bin/bash') : row),
    }),
    identityFixture({
      mutateGroups: (rows) => rows.map((row) => row.startsWith('teleagent-provider-launch:')
        ? 'teleagent-provider-launch:x:2102:teleagent-control' : row),
    }),
  ];
  for (const fixture of fixtures) {
    assert.throws(
      () => validateIdentityRecords(fixture.passwd, fixture.group),
      /Worker-session identity verification refused/
    );
  }
});
