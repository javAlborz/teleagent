'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'worker-session');
const INSTALLER = path.join(DEPLOY, 'teleagent-worker-session-install');
const RELEASE_START_GATE = 'ExecStartPre=+/usr/bin/env -i HOME=/var/empty ' +
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 ' +
  '/usr/local/libexec/verify-teleagent-release-closure --check-start-gate';

const EXECUTABLE_SOURCES = new Set([
  'teleagent-codex-cli-wrapper',
  'teleagent-provider-apparmor-install',
  'teleagent-provider-boundary',
  'teleagent-provider-boundary-runtime',
  'teleagent-provider-canary',
  'teleagent-provider-cli-check',
  'teleagent-provider-cli-install',
  'teleagent-provider-egress-credential-check',
  'teleagent-provider-libexec-install',
  'teleagent-provider-runtime',
  'teleagent-provider-supervisor-client',
  'teleagent-session-pane-entry',
  'teleagent-worker-session-create',
  'teleagent-worker-session-install',
  'verify-worker-session-boundary',
  'verify-worker-session-identity',
]);

function writeExecutable(filename, source) {
  fs.writeFileSync(filename, source, { mode: 0o700 });
  fs.chmodSync(filename, 0o700);
}

function makeFixture(t) {
  const fixture = fs.mkdtempSync('/tmp/teleagent-worker-session-install-test-');
  fs.chmodSync(fixture, 0o700);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const release = path.join(fixture, 'release');
  const deploy = path.join(release, 'deploy', 'worker-session');
  const apiServer = path.join(release, 'claude-api-server');
  fs.mkdirSync(path.dirname(deploy), { recursive: true, mode: 0o755 });
  fs.cpSync(DEPLOY, deploy, { recursive: true });
  fs.chmodSync(release, 0o755);
  fs.chmodSync(path.join(release, 'deploy'), 0o755);
  fs.chmodSync(deploy, 0o755);
  fs.mkdirSync(apiServer, { recursive: true, mode: 0o755 });
  fs.copyFileSync(
    path.join(ROOT, 'claude-api-server', 'provider-egress-shim.js'),
    path.join(apiServer, 'provider-egress-shim.js')
  );
  fs.chmodSync(path.join(apiServer, 'provider-egress-shim.js'), 0o755);
  for (const entry of fs.readdirSync(deploy, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const mode = EXECUTABLE_SOURCES.has(entry.name) ? 0o555 : 0o444;
    fs.chmodSync(path.join(deploy, entry.name), mode);
  }

  const currentParent = path.join(fixture, 'opt', 'teleagent');
  fs.mkdirSync(currentParent, { recursive: true, mode: 0o755 });
  fs.symlinkSync(release, path.join(currentParent, 'current'));

  const dependencyRoot = path.join(fixture, 'test-dependencies');
  fs.mkdirSync(dependencyRoot, { mode: 0o700 });
  const systemctl = path.join(dependencyRoot, 'systemctl');
  const sysusers = path.join(dependencyRoot, 'systemd-sysusers');
  const tmpfiles = path.join(dependencyRoot, 'systemd-tmpfiles');
  const visudo = path.join(dependencyRoot, 'visudo');
  const identity = path.join(dependencyRoot, 'identity');
  const storageAttestor = path.join(dependencyRoot, 'storage-attestor');
  writeExecutable(systemctl, `#!/bin/bash
set -u
printf '%s\\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
case "$1" in
  show)
    unit="$2"
    [ "$#" -eq 10 ] || exit 64
    [ "$3" = --no-pager ] || exit 64
    [ "$4" = --property=LoadState ] || exit 64
    [ "$5" = --property=ActiveState ] || exit 64
    [ "$6" = --property=SubState ] || exit 64
    [ "$7" = --property=UnitFileState ] || exit 64
    [ "$8" = --property=FragmentPath ] || exit 64
    [ "$9" = --property=NeedDaemonReload ] || exit 64
    [ "\${10}" = --property=DropInPaths ] || exit 64
    case "$unit" in
      teleagent-provider-supervisor@*.service) filename=teleagent-provider-supervisor@.service ;;
      teleagent-provider-supervisor@*.socket) filename=teleagent-provider-supervisor@.socket ;;
      teleagent-provider-egress@*.service) filename=teleagent-provider-egress@.service ;;
      teleagent-provider-egress@*.socket) filename=teleagent-provider-egress@.socket ;;
      teleagent-provider-egress-control@*.socket) filename=teleagent-provider-egress-control@.socket ;;
      *) filename="$unit" ;;
    esac
    [ "\${FAKE_STATE_QUERY_FAILURE:-}" = "$unit" ] && exit 1
    [ "\${FAKE_SHOW_DELAY_UNIT:-}" != "$unit" ] || /usr/bin/sleep 30
    installed=0
    [ -f "$TELEAGENT_WORKER_SESSION_INSTALL_TEST_ROOT/etc/systemd/system/$filename" ] && installed=1
    if [ "$installed" -eq 1 ]; then
      load_state=loaded
      unit_file_state=\${FAKE_UNIT_FILE_STATE:-static}
      fragment_path=\${FAKE_FRAGMENT_PATH:-$TELEAGENT_WORKER_SESSION_INSTALL_TEST_ROOT/etc/systemd/system/$filename}
      need_daemon_reload=\${FAKE_NEED_DAEMON_RELOAD:-no}
      drop_in_paths=\${FAKE_DROP_IN_PATHS:-}
    else
      load_state=not-found
      unit_file_state=
      fragment_path=
      need_daemon_reload=no
      drop_in_paths=
    fi
    [ "\${FAKE_ACTIVE_UNIT:-}" = "$unit" ] && active_state=active || active_state=inactive
    sub_state=\${FAKE_SUB_STATE:-dead}
    printf 'LoadState=%s\\n' "$load_state"
    printf 'ActiveState=%s\\n' "$active_state"
    [ "\${FAKE_SHOW_MODE:-}" = missing ] || printf 'SubState=%s\\n' "$sub_state"
    printf 'UnitFileState=%s\\n' "$unit_file_state"
    printf 'FragmentPath=%s\\n' "$fragment_path"
    printf 'NeedDaemonReload=%s\\n' "$need_daemon_reload"
    printf 'DropInPaths=%s\\n' "$drop_in_paths"
    case "\${FAKE_SHOW_MODE:-}" in
      duplicate) printf 'LoadState=%s\\n' "$load_state" ;;
      unknown) printf 'UnreviewedState=unsafe\\n' ;;
      oversize)
        printf 'UnreviewedState='
        /usr/bin/head -c 5000 /dev/zero | /usr/bin/tr '\\0' A
        printf '\\n'
        ;;
    esac
    ;;
  is-enabled) exit 4 ;;
  list-units) exit 0 ;;
  daemon-reload) exit 0 ;;
  *) exit 64 ;;
esac
`);
  for (const dependency of [sysusers, tmpfiles, visudo]) {
    writeExecutable(dependency, `#!/bin/bash
printf '%s %s\\n' "$(basename "$0")" "$*" >>"$FAKE_DEPENDENCY_LOG"
exit 0
`);
  }
  writeExecutable(identity, `#!/bin/bash
printf '%s %s\\n' "$(basename "$0")" "$*" >>"$FAKE_DEPENDENCY_LOG"
[ "$*" = --installed-check ] || exit 77
[ "\${FAKE_IDENTITY_FAILURE:-}" != 1 ] || exit 77
printf 'WORKER_SESSION_IDENTITY_OK\\n'
`);
  writeExecutable(storageAttestor, `#!/bin/bash
printf '%s %s\\n' "$(basename "$0")" "$*" >>"$FAKE_DEPENDENCY_LOG"
case "$*" in
  '--action attest-workspace-storage')
    [ "\${FAKE_WORKSPACE_STORAGE_FAILURE:-}" != 1 ] || exit 77
    printf '%s\\n' "\${FAKE_WORKSPACE_STORAGE_OUTPUT:-PROVIDER_WORKSPACE_STORAGE_OK}"
    ;;
  '--action attest-provider-plane-storage')
    [ "\${FAKE_PROVIDER_PLANE_STORAGE_FAILURE:-}" != 1 ] || exit 77
    printf '%s\\n' "\${FAKE_PROVIDER_PLANE_STORAGE_OUTPUT:-PROVIDER_PLANE_STORAGE_OK}"
    ;;
  *) exit 77 ;;
esac
`);

  const systemctlLog = path.join(fixture, 'systemctl.log');
  const dependencyLog = path.join(fixture, 'dependency.log');
  const environment = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_ONLY: '1',
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_ROOT: fixture,
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_SYSTEMCTL: systemctl,
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_SYSUSERS: sysusers,
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_TMPFILES: tmpfiles,
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_VISUDO: visudo,
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_IDENTITY: identity,
    TELEAGENT_WORKER_SESSION_INSTALL_TEST_STORAGE_ATTESTOR: storageAttestor,
    FAKE_SYSTEMCTL_LOG: systemctlLog,
    FAKE_DEPENDENCY_LOG: dependencyLog,
  };
  const run = (entrypoint, action, additions = {}) => spawnSync(entrypoint, [action], {
    cwd: '/',
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    env: { ...environment, ...additions },
  });
  return {
    fixture,
    release,
    deploy,
    sourceInstaller: path.join(deploy, 'teleagent-worker-session-install'),
    installedInstaller: path.join(fixture, 'usr', 'local', 'libexec',
      'teleagent-worker-session-install'),
    systemctlLog,
    dependencyLog,
    run,
  };
}

test('worker-session installer source is dormant and the activation verifier is valid shell', () => {
  const installer = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(installer, /--source-check\|--install-disabled\|--check/);
  assert.match(installer, /WORKER_SESSION_SOURCE_OK/);
  assert.match(installer, /WORKER_SESSION_INSTALLED_DISABLED/);
  assert.match(installer, /WORKER_SESSION_INSTALLED_DISABLED_OK/);
  assert.match(installer, /systemd-sysusers/);
  assert.match(installer, /systemd-tmpfiles/);
  assert.match(installer, /visudo/);
  for (const property of [
    'LoadState', 'ActiveState', 'SubState', 'UnitFileState',
    'FragmentPath', 'NeedDaemonReload', 'DropInPaths',
  ]) assert.match(installer, new RegExp(`--property=${property}`));
  assert.match(installer, /timeout --signal=TERM --kill-after=1s 10s/);
  assert.match(installer, /head -c 4097/);
  assert.match(installer, /is-enabled/);
  assert.match(installer, /teleagent-provider-launch-\*\.service/);
  assert.match(installer,
    /storage_attestor_bin.*--action attest-workspace-storage/s);
  assert.match(installer, /PROVIDER_WORKSPACE_STORAGE_OK/);
  assert.match(installer, /--action attest-provider-plane-storage/);
  assert.match(installer, /PROVIDER_PLANE_STORAGE_OK/);
  for (const unit of [
    'teleagent-worker-session.service',
    'teleagent-provider-supervisor@.service',
    'teleagent-provider-egress@.service',
    'teleagent-provider-libexec-install.service',
  ]) {
    const executionLines = fs.readFileSync(path.join(DEPLOY, unit), 'utf8')
      .split('\n').filter((line) => /^Exec(?:Condition|StartPre|Start)=/.test(line));
    assert.equal(executionLines.filter((line) => line === RELEASE_START_GATE).length, 1);
    assert.equal(executionLines[0], RELEASE_START_GATE);
    assert.doesNotMatch(fs.readFileSync(path.join(DEPLOY, unit), 'utf8'),
      /^\s*ExecCondition\s*=/m);
    assert.doesNotMatch(fs.readFileSync(path.join(DEPLOY, unit), 'utf8'),
      /^\s*ExecReload\s*=/m);
  }
  assert.doesNotMatch(installer, /"\$systemctl_bin"\s+(?:start|enable|restart)\b/);
  assert.doesNotMatch(installer, /provider-egress-(?:claude|codex)\.policy\.example/);
  assert.doesNotMatch(installer, /provider-egress-secrets\/(?:claude|codex)\.api-key/);
  assert.doesNotMatch(installer, /(?:touch|install|cp|mv)[^\n]*worker-session\/ENABLE/);

  const syntax = spawnSync('/bin/sh', ['-n', path.join(DEPLOY,
    'verify-worker-session-boundary')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('worker-session installer performs an offline transactional disabled install', (t) => {
  const fixture = makeFixture(t);
  let result = fixture.run(fixture.sourceInstaller, '--source-check');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WORKER_SESSION_SOURCE_OK\n');
  assert.equal(fs.existsSync(path.join(fixture.fixture, 'etc', 'systemd')), false);
  assert.equal(fs.statSync(path.join(
    fixture.deploy, 'teleagent-provider-boundary'
  )).mode & 0o777, 0o555);
  assert.equal(fs.statSync(path.join(
    fixture.deploy, 'teleagent-worker-session.service'
  )).mode & 0o777, 0o444);

  // A trusted development release may retain owner-write bits. Canonical
  // release staging removes them, but both safe source variants are admitted.
  fs.chmodSync(path.join(fixture.deploy, 'teleagent-provider-boundary'), 0o755);
  fs.chmodSync(path.join(fixture.deploy, 'teleagent-worker-session.service'), 0o644);
  fs.chmodSync(path.join(fixture.deploy, 'provider-libexec.manifest'), 0o644);
  result = fixture.run(fixture.sourceInstaller, '--source-check');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WORKER_SESSION_SOURCE_OK\n');
  assert.doesNotMatch(
    fs.readFileSync(fixture.dependencyLog, 'utf8'),
    /^storage-attestor /m
  );

  result = fixture.run(fixture.sourceInstaller, '--install-disabled');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WORKER_SESSION_INSTALLED_DISABLED\n');
  assert.equal(fs.existsSync(path.join(
    fixture.fixture, 'etc', 'teleagent', 'worker-session', 'ENABLE'
  )), false);

  result = fixture.run(fixture.installedInstaller, '--check');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WORKER_SESSION_INSTALLED_DISABLED_OK\n');

  const sudoers = path.join(
    fixture.fixture, 'etc', 'sudoers.d', 'teleagent-provider-supervisors'
  );
  const credentialCheck = path.join(
    fixture.fixture, 'usr', 'local', 'libexec',
    'teleagent-provider-egress-credential-check'
  );
  assert.equal(fs.statSync(sudoers).mode & 0o777, 0o440);
  assert.equal(fs.statSync(credentialCheck).mode & 0o777, 0o755);
  assert.equal(
    fs.readFileSync(credentialCheck, 'utf8'),
    fs.readFileSync(path.join(fixture.deploy,
      'teleagent-provider-egress-credential-check'), 'utf8')
  );

  const systemctlLog = fs.readFileSync(fixture.systemctlLog, 'utf8').trim().split('\n');
  const systemctlCalls = systemctlLog.map((line) => line.split(' ')[0]);
  assert.ok(systemctlCalls.length > 0);
  assert.deepEqual(
    [...new Set(systemctlCalls)].sort(),
    ['daemon-reload', 'is-enabled', 'list-units', 'show']
  );
  const showCalls = systemctlLog.filter((line) => line.startsWith('show '));
  assert.equal(showCalls.length, 48, 'each unit uses one snapshot in each of three checks');
  for (const call of showCalls) {
    for (const property of [
      'LoadState', 'ActiveState', 'SubState', 'UnitFileState',
      'FragmentPath', 'NeedDaemonReload', 'DropInPaths',
    ]) assert.match(call, new RegExp(`(?:^| )--property=${property}(?: |$)`));
  }
  const dependencyCalls = fs.readFileSync(fixture.dependencyLog, 'utf8');
  assert.match(dependencyCalls, /^systemd-sysusers /m);
  assert.match(dependencyCalls, /^systemd-tmpfiles --create /m);
  assert.match(dependencyCalls, /^visudo -cf /m);
  assert.match(dependencyCalls, /^identity --installed-check$/m);
  assert.equal(
    dependencyCalls.match(/^storage-attestor --action attest-workspace-storage$/gm)?.length,
    2
  );
  assert.equal(
    dependencyCalls.match(/^storage-attestor --action attest-provider-plane-storage$/gm)?.length,
    2
  );

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_WORKSPACE_STORAGE_FAILURE: '1',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /workspace storage boundary failed attestation/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_PROVIDER_PLANE_STORAGE_FAILURE: '1',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /provider plane storage boundary failed attestation/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_PROVIDER_PLANE_STORAGE_OUTPUT: 'PROVIDER_PLANE_STORAGE_OK extra',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /provider plane storage boundary failed attestation/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_WORKSPACE_STORAGE_OUTPUT: 'PROVIDER_WORKSPACE_STORAGE_OK extra',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /workspace storage boundary failed attestation/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_WORKSPACE_STORAGE_OUTPUT: 'PROVIDER_WORKSPACE_STORAGE_OK\nunreviewed output',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /workspace storage boundary failed attestation/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_ACTIVE_UNIT: 'teleagent-worker-session.service',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /a worker-session unit is active/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_STATE_QUERY_FAILURE: 'teleagent-worker-session.service',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unit state snapshot is unavailable/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_SUB_STATE: 'start-pre',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /substate is not exactly dead/);

  for (const [mode, message] of [
    ['duplicate', /state snapshot is duplicate/],
    ['missing', /state snapshot is incomplete/],
    ['unknown', /state snapshot contains an unknown property/],
    ['oversize', /output exceeded its fixed byte bound/],
  ]) {
    result = fixture.run(fixture.installedInstaller, '--check', {
      FAKE_SHOW_MODE: mode,
    });
    assert.equal(result.status, 75, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_SHOW_DELAY_UNIT: 'teleagent-worker-session.service',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unit state snapshot is unavailable/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_UNIT_FILE_STATE: 'enabled',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unit is not exactly static/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_FRAGMENT_PATH: '/etc/systemd/system/unsafe-worker.service',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /loaded an unreviewed fragment/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_NEED_DAEMON_RELOAD: 'yes',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /stale loaded policy/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_DROP_IN_PATHS: '/etc/systemd/system/teleagent-worker-session.service.d/override.conf',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unreviewed drop-in/);

  result = fixture.run(fixture.sourceInstaller, '--install-disabled', {
    FAKE_DROP_IN_PATHS: '/etc/systemd/system/teleagent-worker-session.service.d/override.conf',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unreviewed drop-in/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_IDENTITY_FAILURE: '1',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /numeric identities failed verification/);

  const sentinelDirectory = path.join(
    fixture.fixture, 'etc', 'teleagent', 'worker-session'
  );
  fs.mkdirSync(sentinelDirectory, { recursive: true, mode: 0o700 });
  const sentinel = path.join(sentinelDirectory, 'ENABLE');
  fs.writeFileSync(sentinel, 'forbidden\n', { mode: 0o600 });
  result = fixture.run(fixture.installedInstaller, '--check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /activation sentinel must remain absent/);
  fs.unlinkSync(sentinel);

  const brokerUnit = path.join(fixture.deploy, 'teleagent-worker-session.service');
  const brokerUnitSource = fs.readFileSync(brokerUnit, 'utf8');
  fs.writeFileSync(brokerUnit, brokerUnitSource.replace(
    '--action attest-workspace-storage',
    '--action assert-global-unlocked'
  ));
  result = fixture.run(fixture.sourceInstaller, '--source-check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /worker broker lost its workspace storage activation gate/);
  fs.writeFileSync(brokerUnit, brokerUnitSource);

  fs.writeFileSync(brokerUnit, brokerUnitSource.replace(
    RELEASE_START_GATE,
    `${RELEASE_START_GATE}\n${RELEASE_START_GATE}`
  ));
  result = fixture.run(fixture.sourceInstaller, '--source-check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /lost its exact start gate/);
  fs.writeFileSync(brokerUnit, brokerUnitSource);

  fs.writeFileSync(brokerUnit,
    `${brokerUnitSource}  ExecCondition =/opt/teleagent/current/unreviewed-condition\n`);
  result = fixture.run(fixture.sourceInstaller, '--source-check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /contains an ungated condition command/);
  fs.writeFileSync(brokerUnit, brokerUnitSource);

  fs.writeFileSync(brokerUnit,
    `${brokerUnitSource}\tExecReload =/opt/teleagent/current/reload\n`);
  result = fixture.run(fixture.sourceInstaller, '--source-check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /contains an ungated reload command/);
  fs.writeFileSync(brokerUnit, brokerUnitSource);

  const driftedRuntime = path.join(
    fixture.deploy, 'teleagent-provider-boundary-runtime'
  );
  fs.chmodSync(driftedRuntime, 0o755);
  fs.appendFileSync(driftedRuntime, '\n// unreviewed fixture drift\n');
  fs.chmodSync(driftedRuntime, 0o555);
  result = fixture.run(fixture.sourceInstaller, '--source-check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /provider libexec source digest is unreviewed/);
});

test('worker-session disabled install refuses before success when component storage is unsafe', (t) => {
  const fixture = makeFixture(t);
  const result = fixture.run(fixture.sourceInstaller, '--install-disabled', {
    FAKE_WORKSPACE_STORAGE_FAILURE: '1',
  });
  assert.equal(result.status, 77);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /workspace storage boundary failed attestation/);
  assert.equal(fs.existsSync(fixture.installedInstaller), false);

  const dependencyCalls = fs.readFileSync(fixture.dependencyLog, 'utf8');
  assert.equal(
    dependencyCalls.match(/^storage-attestor --action attest-workspace-storage$/gm)?.length,
    1
  );
  assert.doesNotMatch(dependencyCalls,
    /^storage-attestor --action attest-provider-plane-storage$/m);

  const providerFixture = makeFixture(t);
  const providerResult = providerFixture.run(providerFixture.sourceInstaller,
    '--install-disabled', {
      FAKE_PROVIDER_PLANE_STORAGE_FAILURE: '1',
    });
  assert.equal(providerResult.status, 77);
  assert.equal(providerResult.stdout, '');
  assert.match(providerResult.stderr, /provider plane storage boundary failed attestation/);
  assert.equal(fs.existsSync(providerFixture.installedInstaller), false);
  const providerDependencyCalls = fs.readFileSync(providerFixture.dependencyLog, 'utf8');
  assert.equal(
    providerDependencyCalls.match(/^storage-attestor --action attest-workspace-storage$/gm)?.length,
    1
  );
  assert.equal(
    providerDependencyCalls.match(/^storage-attestor --action attest-provider-plane-storage$/gm)?.length,
    1
  );
});
