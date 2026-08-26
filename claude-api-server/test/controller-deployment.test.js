'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'controller');

function source(filename) {
  return fs.readFileSync(path.join(DEPLOY, filename), 'utf8');
}

test('controller unit is dormant, exact-path, resource-capped, and isolated', () => {
  const service = source('teleagent-agent-controller.service');
  const tmpfiles = source('teleagent-agent-controller.tmpfiles');
  assert.equal(
    service.match(/^ConditionPathExists=\/etc\/teleagent\/controller\/ENABLE$/gm)?.length,
    1,
  );
  assert.equal(
    service.match(/^ConditionPathExists=\/etc\/teleagent\/worker-session\/ENABLE$/gm)?.length,
    1,
  );
  assert.match(service, /^ConditionPathIsMountPoint=\/var\/lib\/teleagent-control$/m);
  assert.doesNotMatch(service, /^\[Install\]$/m);
  assert.match(service, /^User=teleagent-control$/m);
  assert.match(service, /^Group=teleagent-control$/m);
  assert.match(service, /^Environment=HOME=\/var\/lib\/teleagent-control$/m);
  assert.match(service,
    /^Environment=PATH=\/opt\/teleagent\/agent-tools:\/usr\/bin:\/bin$/m);
  assert.match(service, /^Environment=TELEAGENT_CONTROLLER_STATE_BOUNDARY=required$/m);
  assert.match(service,
    /^Environment=EXECUTOR_TASK_DB_PATH=\/var\/lib\/teleagent-control\/executor-tasks\.sqlite$/m);
  assert.match(service,
    /^Environment=VOICE_EXECUTION_LOCK_FILE=\/var\/lib\/teleagent-control\/voice-execution\.lock\.json$/m);
  assert.match(service,
    /^ExecStart=\/opt\/teleagent\/node\/bin\/node \/opt\/teleagent\/current\/claude-api-server\/server\.js$/m);
  assert.match(service, /^Requires=.*teleagent-worker-session\.service/m);
  assert.match(service, /^Requires=.*teleagent-provider-supervisor@claude\.socket/m);
  assert.match(service, /^Requires=.*teleagent-provider-supervisor@codex\.socket/m);
  assert.match(service, /^CPUQuota=200%$/m);
  assert.match(service, /^MemoryHigh=2G$/m);
  assert.match(service, /^MemoryMax=3G$/m);
  assert.match(service, /^MemorySwapMax=0$/m);
  assert.match(service, /^TasksMax=512$/m);
  assert.match(service, /^LimitFSIZE=8589934592$/m);
  assert.match(service, /^LimitCORE=0$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=yes$/m);
  assert.match(service, /^IPAddressDeny=any$/m);
  assert.match(service, /^IPAddressAllow=localhost$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/teleagent-control$/m);
  for (const inaccessible of [
    '/var/lib/teleagent-worker-state',
    '/var/lib/teleagent-privileged-action',
    '/var/lib/teleagent-voice',
    '/srv/teleagent-agent-workspaces',
    '/etc/teleagent/provider-egress-secrets',
  ]) {
    assert.match(service, new RegExp(
      `^InaccessiblePaths=.*${inaccessible.replaceAll('/', '\\/')}`,
      'm',
    ));
  }
  assert.match(service, /^UnsetEnvironment=.*NODE_PATH/m);
  assert.match(service, /^UnsetEnvironment=.*LD_PRELOAD/m);
  assert.doesNotMatch(service, /^StateDirectory=/m);
  assert.doesNotMatch(tmpfiles, /\/ENABLE/);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-control 0700 teleagent-control teleagent-control -$/m);
});

test('controller initializes exact state admission before lock and SQLite construction', () => {
  const server = fs.readFileSync(path.join(ROOT, 'claude-api-server', 'server.js'), 'utf8');
  const configuration = server.indexOf(
    'const controllerState = normalizeControllerStateConfiguration(process.env'
  );
  const lock = server.indexOf('const voiceExecutionControl = new VoiceExecutionControl');
  const sqlite = server.indexOf('const executorTaskStore = new ExecutorTaskStore');
  assert.ok(configuration >= 0);
  assert.ok(configuration < lock);
  assert.ok(lock < sqlite);
  assert.match(server, /strictOwnership: controllerState\.enforced/);
  assert.match(server, /controllerState\.storage\.assertOpen\(\)/);
  assert.match(server, /controllerState\.storage\.assertNewWork\(\)/);
  assert.match(server, /EXECUTOR_STATE_CAPACITY_EXHAUSTED' \? 507/);
  assert.match(server,
    /if \(voiceExecution\.locked !== false \|\| executor\.panic\.locked !== false\)/);
  assert.match(server, /compensateIncoherentVoiceUnlock\(\{/);
  assert.match(server, /workerSessionBoundaryStatus = Object\.freeze\(\{/);
});
