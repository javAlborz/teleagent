'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'controller');
const RELEASE_START_GATE = 'ExecStartPre=+/usr/bin/env -i HOME=/var/empty ' +
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 ' +
  '/usr/local/libexec/verify-teleagent-release-closure --check-start-gate';
const RELEASE_START = 'ExecStart=!/usr/bin/python3 -I ' +
  '/usr/local/libexec/verify-teleagent-release-closure --supervise-component ' +
  'agent-controller ${CREDENTIALS_DIRECTORY}/teleagent-release-gate';
const RELEASE_GATE_CREDENTIAL = 'LoadCredential=teleagent-release-gate:' +
  '/run/teleagent-release-gate/verified.json';
const RETIRED_PHONE_AUTHORITY_ENVIRONMENT =
  'UnsetEnvironment=VOICE_APPROVAL_KEY_ID VOICE_APPROVAL_PUBLIC_KEY_FILE ' +
  'PRIVILEGED_ACTION_API_TOKEN PRIVILEGED_ACTION_PROXY_ENABLED ' +
  'PRIVILEGED_ACTION_PROXY_SOCKET_PATH PRIVILEGED_ACTION_PROXY_TIMEOUT_MS';

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
  assert.equal(service.split('\n').filter((line) => line === RELEASE_START_GATE).length, 1);
  assert.equal((service.match(/verify-teleagent-release-closure/gu) ?? []).length, 2);
  assert.equal(service.split('\n').filter((line) => /^ExecStart(?:Pre)?=/u.test(line))[0],
    RELEASE_START_GATE);
  assert.doesNotMatch(service, /^ExecCondition=|^ExecReload=/m);
  assert.ok(service.split('\n').includes(RELEASE_START));
  assert.ok(service.split('\n').includes(RELEASE_GATE_CREDENTIAL));
  assert.doesNotMatch(service, /^WorkingDirectory=\/opt\/teleagent\/current$/m);
  assert.match(service, /^Requires=.*teleagent-worker-session\.service/m);
  assert.doesNotMatch(service, /^Requires=.*teleagent-provider-supervisor@claude\.socket/m);
  assert.match(service, /^Requires=.*teleagent-provider-supervisor@codex\.socket/m);
  assert.match(service, /^CPUQuota=200%$/m);
  assert.match(service, /^Slice=teleagent\.slice$/m);
  assert.match(service, /^MemoryHigh=671088640$/m);
  assert.match(service, /^MemoryMax=805306368$/m);
  assert.match(service, /^MemorySwapMax=0$/m);
  assert.match(service, /^TasksMax=128$/m);
  assert.match(service, /^LimitFSIZE=8589934592$/m);
  assert.match(service, /^LimitCORE=0$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_KILL$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=yes$/m);
  assert.match(service, /^IPAddressDeny=any$/m);
  assert.doesNotMatch(service, /^IPAddressAllow=/m);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(service, /^Environment=AGENT_API_TRANSPORT=systemd-unix$/m);
  assert.match(service, /^Requires=.*teleagent-agent-controller\.socket/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/teleagent-control$/m);
  for (const inaccessible of [
    '/var/lib/teleagent-worker-state',
    '/var/lib/teleagent-privileged-action',
    '/var/lib/teleagent-voice',
    '/srv/teleagent-agent-workspaces',
    '/etc/teleagent/provider-egress-secrets',
    '/run/teleagent-privileged-action',
  ]) {
    assert.match(service, new RegExp(
      `^InaccessiblePaths=.*${inaccessible.replaceAll('/', '\\/')}`,
      'm',
    ));
  }
  assert.match(service, /^UnsetEnvironment=.*NODE_PATH/m);
  assert.match(service, /^UnsetEnvironment=.*LD_PRELOAD/m);
  assert.equal(
    service.split('\n').filter((line) => line === RETIRED_PHONE_AUTHORITY_ENVIRONMENT).length,
    1,
  );
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
