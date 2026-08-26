'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'privileged-action');

function source(filename) {
  return fs.readFileSync(path.join(DEPLOY, filename), 'utf8');
}

test('root broker unit is dormant, bounded, package-local, and least-privileged', () => {
  const service = source('teleagent-privileged-action.service');
  const tmpfiles = source('teleagent-privileged-action.tmpfiles');
  assert.equal(
    service.match(/^ConditionPathExists=\/etc\/teleagent\/privileged-action\/ENABLE$/gm)?.length,
    1,
  );
  assert.match(service,
    /^ConditionPathIsMountPoint=\/var\/lib\/teleagent-privileged-action$/m);
  assert.doesNotMatch(service, /^\[Install\]$/m);
  assert.match(service, /^User=root$/m);
  assert.match(service, /^Group=root$/m);
  assert.match(service, /^SupplementaryGroups=teleagent-control$/m);
  assert.doesNotMatch(service, /^RuntimeDirectory=/m);
  assert.doesNotMatch(service, /^RuntimeDirectoryMode=/m);
  assert.match(service, /^Environment=TELEAGENT_PRIVILEGED_STATE_BOUNDARY=required$/m);
  assert.match(service,
    /^Environment=PRIVILEGED_ACTION_DB_PATH=\/var\/lib\/teleagent-privileged-action\/actions\.sqlite$/m);
  assert.match(service,
    /^ExecStart=\/opt\/teleagent\/node\/bin\/node --jitless \/opt\/teleagent\/current\/privileged-action-broker\/index\.js$/m);
  assert.match(service, /^UnsetEnvironment=.*NODE_PATH/m);
  assert.doesNotMatch(service, /^Environment=NODE_PATH=/m);
  assert.match(service, /^CPUQuota=100%$/m);
  assert.match(service, /^MemoryHigh=512M$/m);
  assert.match(service, /^MemoryMax=768M$/m);
  assert.match(service, /^MemorySwapMax=0$/m);
  assert.match(service, /^TasksMax=256$/m);
  assert.match(service, /^LimitFSIZE=8589934592$/m);
  assert.match(service, /^LimitCORE=0$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
  assert.match(service, /^AmbientCapabilities=$/m);
  assert.match(service, /^MemoryDenyWriteExecute=yes$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=read-only$/m);
  assert.match(service,
    /^ReadWritePaths=\/var\/lib\/teleagent-privileged-action \/run\/teleagent-privileged-action$/m);
  for (const inaccessible of [
    '/var/lib/teleagent-control',
    '/var/lib/teleagent-worker-state',
    '/var/lib/teleagent-voice',
    '/srv/teleagent-agent-workspaces',
    '/run/docker.sock',
  ]) {
    assert.match(service, new RegExp(
      `^InaccessiblePaths=.*${inaccessible.replaceAll('/', '\\/')}`,
      'm',
    ));
  }
  assert.doesNotMatch(service, /^StateDirectory=/m);
  assert.doesNotMatch(tmpfiles, /\/ENABLE/);
  assert.match(tmpfiles,
    /^d \/run\/teleagent-privileged-action 0750 root teleagent-control -$/m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-privileged-action 0700 root root -$/m);

  const packageDefinition = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'privileged-action-broker', 'package.json'),
    'utf8',
  ));
  assert.equal(packageDefinition.dependencies['better-sqlite3'], '12.11.1');
});

test('broker verifies exact state before singleton acquisition and SQLite construction', () => {
  const entrypoint = fs.readFileSync(
    path.join(ROOT, 'privileged-action-broker', 'index.js'),
    'utf8',
  );
  const configuration = entrypoint.indexOf(
    'const state = normalizePrivilegedStateConfiguration(process.env)'
  );
  const singleton = entrypoint.indexOf('const singletonLock = acquireBrokerSingletonLock');
  const sqlite = entrypoint.indexOf('store = new PrivilegedActionStore');
  assert.ok(configuration >= 0);
  assert.ok(configuration < singleton);
  assert.ok(singleton < sqlite);
  assert.match(entrypoint, /state\.storage\.assertOpen\(\)/);
  assert.match(entrypoint, /state\.storage\.assertNewWork\(\)/);
});
