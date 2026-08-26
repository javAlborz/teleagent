'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTROLLER_DEPLOY = path.join(ROOT, 'deploy', 'controller');
const PRIVILEGED_DEPLOY = path.join(ROOT, 'deploy', 'privileged-action');
const EXECUTABLES = new Set([
  'teleagent-control-plane-install',
  'verify-teleagent-control-plane',
]);

function writeExecutable(filename, source) {
  fs.writeFileSync(filename, source, { mode: 0o700 });
  fs.chmodSync(filename, 0o700);
}

function makeFixture(t) {
  const fixture = fs.mkdtempSync('/tmp/teleagent-control-plane-install-');
  fs.chmodSync(fixture, 0o700);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const release = path.join(fixture, 'release');
  const deployRoot = path.join(release, 'deploy');
  const controllerDeploy = path.join(deployRoot, 'controller');
  const privilegedDeploy = path.join(deployRoot, 'privileged-action');
  fs.mkdirSync(deployRoot, { recursive: true, mode: 0o755 });
  fs.cpSync(CONTROLLER_DEPLOY, controllerDeploy, { recursive: true });
  fs.cpSync(PRIVILEGED_DEPLOY, privilegedDeploy, { recursive: true });
  fs.chmodSync(release, 0o755);
  fs.chmodSync(deployRoot, 0o755);
  for (const directory of [controllerDeploy, privilegedDeploy]) {
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      fs.chmodSync(
        path.join(directory, entry.name),
        EXECUTABLES.has(entry.name) ? 0o555 : 0o444,
      );
    }
  }

  const systemdDirectory = path.join(fixture, 'etc', 'systemd', 'system');
  fs.mkdirSync(systemdDirectory, { recursive: true, mode: 0o755 });
  for (const unit of [
    'teleagent-worker-session.service',
    'teleagent-provider-model-apparmor.service',
    'teleagent-provider-supervisor@.socket',
  ]) {
    fs.writeFileSync(path.join(systemdDirectory, unit), '[Unit]\n', { mode: 0o644 });
  }
  fs.mkdirSync(path.join(fixture, 'run'), { mode: 0o755 });

  const dependencyRoot = path.join(fixture, 'test-dependencies');
  fs.mkdirSync(dependencyRoot, { mode: 0o700 });
  const systemctl = path.join(dependencyRoot, 'systemctl');
  const sysusers = path.join(dependencyRoot, 'systemd-sysusers');
  const tmpfiles = path.join(dependencyRoot, 'systemd-tmpfiles');
  const id = path.join(dependencyRoot, 'id');
  const getent = path.join(dependencyRoot, 'getent');
  writeExecutable(systemctl, `#!/bin/bash
set -u
printf '%s\\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
case "$1" in
  show)
    unit="$2"
    property="$3"
    case "$unit" in
      teleagent-provider-supervisor@*.socket) filename=teleagent-provider-supervisor@.socket ;;
      *) filename="$unit" ;;
    esac
    [ "\${FAKE_STATE_QUERY_FAILURE:-}" = "$unit" ] && exit 1
    installed=0
    [ -f "$TELEAGENT_CONTROL_PLANE_INSTALL_TEST_ROOT/etc/systemd/system/$filename" ] && installed=1
    case "$property" in
      --property=LoadState)
        [ "$installed" -eq 1 ] && printf 'loaded\\n' || printf 'not-found\\n' ;;
      --property=ActiveState)
        [ "\${FAKE_ACTIVE_UNIT:-}" = "$unit" ] && printf 'active\\n' || printf 'inactive\\n' ;;
      --property=SubState)
        [ "\${FAKE_ACTIVE_UNIT:-}" = "$unit" ] && printf 'running\\n' || printf 'dead\\n' ;;
      --property=UnitFileState)
        [ "$installed" -eq 1 ] || exit 1
        printf '%s\\n' "\${FAKE_UNIT_FILE_STATE:-static}" ;;
      *) exit 64 ;;
    esac
    ;;
  is-enabled) exit 4 ;;
  daemon-reload)
    [ "\${FAKE_DAEMON_RELOAD_FAILURE:-}" != 1 ] || exit 1
    exit 0 ;;
  *) exit 64 ;;
esac
`);
  writeExecutable(sysusers, `#!/bin/bash
printf 'systemd-sysusers %s\\n' "$*" >>"$FAKE_DEPENDENCY_LOG"
[ "\${FAKE_SYSUSERS_FAILURE:-}" != 1 ]
`);
  writeExecutable(tmpfiles, `#!/bin/bash
printf 'systemd-tmpfiles %s\\n' "$*" >>"$FAKE_DEPENDENCY_LOG"
[ "\${FAKE_TMPFILES_FAILURE:-}" != 1 ] || exit 1
root="$TELEAGENT_CONTROL_PLANE_INSTALL_TEST_ROOT"
mkdir -p "$root/etc/teleagent/controller" "$root/etc/teleagent/privileged-action" \\
  "$root/var/lib/teleagent-control" "$root/var/lib/teleagent-privileged-action" \\
  "$root/run/teleagent-privileged-action"
chmod 0755 "$root/var" "$root/var/lib"
chmod 0700 "$root/etc/teleagent/controller" "$root/etc/teleagent/privileged-action" \\
  "$root/var/lib/teleagent-control" "$root/var/lib/teleagent-privileged-action"
chmod 0750 "$root/run/teleagent-privileged-action"
`);
  writeExecutable(id, `#!/bin/bash
case "$1:$2" in
  -u:teleagent-control) /usr/bin/id -u ;;
  -g:teleagent-control) /usr/bin/id -g ;;
  *) exit 64 ;;
esac
`);
  writeExecutable(getent, `#!/bin/bash
[ "$1:$2" = group:teleagent-control ] || exit 64
printf 'teleagent-control:x:%s:\\n' "$(/usr/bin/id -g)"
`);

  const systemctlLog = path.join(fixture, 'systemctl.log');
  const dependencyLog = path.join(fixture, 'dependency.log');
  const environment = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_ONLY: '1',
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_ROOT: fixture,
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_SYSTEMCTL: systemctl,
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_SYSUSERS: sysusers,
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_TMPFILES: tmpfiles,
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_ID: id,
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_GETENT: getent,
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_SOURCE_ROOT: controllerDeploy,
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_STATE_MOUNT: '1',
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_STATE_CAPACITY_BYTES: String(4 * 1024 ** 3),
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_STATE_FREE_BYTES: String(1024 ** 3),
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_CONTROLLER_STATE_DEVICE: '1001',
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_PRIVILEGED_STATE_DEVICE: '1002',
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
    controllerDeploy,
    dependencyLog,
    fixture,
    installedInstaller: path.join(
      fixture, 'usr', 'local', 'libexec', 'teleagent-control-plane-install'
    ),
    installedVerifier: path.join(
      fixture, 'usr', 'local', 'libexec', 'verify-teleagent-control-plane'
    ),
    release,
    run,
    sourceInstaller: path.join(controllerDeploy, 'teleagent-control-plane-install'),
    sourceVerifier: path.join(controllerDeploy, 'verify-teleagent-control-plane'),
    systemctlLog,
  };
}

test('control-plane installer source has exact disabled activation truth', () => {
  const installer = fs.readFileSync(
    path.join(CONTROLLER_DEPLOY, 'teleagent-control-plane-install'),
    'utf8',
  );
  assert.match(installer, /--source-check\|--install-disabled\|--check/);
  assert.match(installer, /--property=LoadState --value/);
  assert.match(installer, /--property=ActiveState --value/);
  assert.match(installer, /--property=SubState --value/);
  assert.match(installer, /--property=UnitFileState --value/);
  assert.doesNotMatch(installer, /"\$systemctl_bin"\s+(?:start|enable|restart)\b/);
  assert.doesNotMatch(installer, /(?:touch|install|cp|mv)[^\n]*\/ENABLE/);
});

test('control-plane installer intentionally initializes fresh state unlocked and remains disabled', (t) => {
  const fixture = makeFixture(t);
  let result = fixture.run(fixture.sourceVerifier, '--source-check');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'TELEAGENT_CONTROL_PLANE_SOURCE_OK\n');

  result = fixture.run(fixture.sourceInstaller, '--install-disabled');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'TELEAGENT_CONTROL_PLANE_INSTALLED_DISABLED\n');
  for (const sentinel of [
    ['controller', 'ENABLE'],
    ['privileged-action', 'ENABLE'],
    ['worker-session', 'ENABLE'],
  ]) {
    assert.equal(fs.existsSync(path.join(fixture.fixture, 'etc', 'teleagent', ...sentinel)), false);
  }
  const stateFile = path.join(
    fixture.fixture, 'var', 'lib', 'teleagent-control', 'voice-execution.lock.json'
  );
  const marker = path.join(
    fixture.fixture, 'etc', 'teleagent', 'controller', 'STATE_INITIALIZED'
  );
  const controllerDatabase = path.join(
    fixture.fixture, 'var', 'lib', 'teleagent-control', 'executor-tasks.sqlite'
  );
  const privilegedDatabase = path.join(
    fixture.fixture, 'var', 'lib', 'teleagent-privileged-action', 'actions.sqlite'
  );
  const privilegedMarker = path.join(
    fixture.fixture, 'etc', 'teleagent', 'privileged-action', 'STATE_INITIALIZED'
  );
  assert.equal(fs.readFileSync(stateFile, 'utf8'), `${JSON.stringify({
    version: 1,
    locked: false,
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
    lockedAt: null,
    unlockedAt: '1970-01-01T00:00:00.000Z',
    reason: null,
    source: 'disabled_installer_initialization',
    remotePanicPending: false,
    remotePanicConfirmedAt: null,
  })}\n`);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(stateFile).nlink, 1);
  assert.equal(fs.statSync(marker).mode & 0o777, 0o400);
  assert.equal(fs.statSync(controllerDatabase).size, 0);
  assert.equal(fs.statSync(controllerDatabase).mode & 0o777, 0o600);
  assert.equal(fs.statSync(privilegedDatabase).size, 0);
  assert.equal(fs.statSync(privilegedDatabase).mode & 0o777, 0o600);
  assert.equal(fs.statSync(privilegedMarker).mode & 0o777, 0o400);

  result = fixture.run(fixture.installedVerifier, '--installed-check');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'TELEAGENT_CONTROL_PLANE_INSTALLED_DISABLED_OK\n');
  const calls = fs.readFileSync(fixture.systemctlLog, 'utf8');
  assert.match(calls, /^show teleagent-agent-controller\.service --property=SubState --value$/m);
  assert.match(calls, /^show teleagent-privileged-action\.service --property=UnitFileState --value$/m);
  assert.doesNotMatch(calls, /^(?:start|enable|restart) /m);
  const dependencies = fs.readFileSync(fixture.dependencyLog, 'utf8');
  assert.match(dependencies, /^systemd-sysusers /m);
  assert.match(dependencies, /^systemd-tmpfiles --create /m);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_ACTIVE_UNIT: 'teleagent-agent-controller.service',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unit is active, failed, or transitional/);

  fs.unlinkSync(stateFile);
  result = fixture.run(fixture.installedInstaller, '--install-disabled');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /explicit controller lock state is absent/);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.existsSync(marker), true);

  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    locked: false,
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
    lockedAt: null,
    unlockedAt: '1970-01-01T00:00:00.000Z',
    reason: null,
    source: 'disabled_installer_initialization',
    remotePanicPending: true,
    remotePanicConfirmedAt: null,
  })}\n`, { mode: 0o600 });
  result = fixture.run(fixture.installedInstaller, '--check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /lock state schema is not exact canonical JSON/);

  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    locked: false,
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
    lockedAt: null,
    unlockedAt: '1970-01-01T00:00:00.000Z',
    reason: null,
    source: 'disabled_installer_initialization',
    remotePanicPending: false,
    remotePanicConfirmedAt: null,
  })}\n`, { mode: 0o600 });
  fs.unlinkSync(privilegedDatabase);
  result = fixture.run(fixture.installedInstaller, '--install-disabled');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /initialized durable database is absent/);
  assert.equal(fs.existsSync(privilegedDatabase), false);
  assert.equal(fs.existsSync(privilegedMarker), true);
});

test('control-plane installer rolls back all owned bytes after a post-copy failure', (t) => {
  const fixture = makeFixture(t);
  const result = fixture.run(fixture.sourceInstaller, '--install-disabled', {
    FAKE_TMPFILES_FAILURE: '1',
  });
  assert.equal(result.status, 1);
  for (const filename of [
    path.join(fixture.fixture, 'etc', 'systemd', 'system',
      'teleagent-agent-controller.service'),
    path.join(fixture.fixture, 'etc', 'systemd', 'system',
      'teleagent-privileged-action.service'),
    path.join(fixture.fixture, 'usr', 'local', 'libexec',
      'teleagent-control-plane-install'),
  ]) {
    assert.equal(fs.existsSync(filename), false, filename);
  }
  const residue = [];
  for (const root of [path.join(fixture.fixture, 'etc'), path.join(fixture.fixture, 'usr')]) {
    for (const entry of fs.readdirSync(root, { recursive: true })) {
      if (/\.(?:new|rollback)-[0-9]+$/.test(entry)) residue.push(entry);
    }
  }
  assert.deepEqual(residue, []);
});

test('control-plane installer refuses ordinary var-lib directories as state mounts', (t) => {
  const fixture = makeFixture(t);
  const result = fixture.run(fixture.sourceInstaller, '--install-disabled', {
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_STATE_MOUNT: '0',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /exact dedicated controller state mount is absent/);
  assert.equal(fs.existsSync(path.join(
    fixture.fixture, 'etc', 'systemd', 'system', 'teleagent-agent-controller.service'
  )), false);
  assert.equal(fs.existsSync(path.join(
    fixture.fixture, 'etc', 'teleagent', 'controller', 'STATE_INITIALIZED'
  )), false);
});

test('control-plane installer refuses controller and privileged roots on one filesystem', (t) => {
  const fixture = makeFixture(t);
  const result = fixture.run(fixture.sourceInstaller, '--install-disabled', {
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_CONTROLLER_STATE_DEVICE: '1001',
    TELEAGENT_CONTROL_PLANE_INSTALL_TEST_PRIVILEGED_STATE_DEVICE: '1001',
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /must use distinct dedicated filesystems/);
  for (const filename of [
    path.join(fixture.fixture, 'var', 'lib', 'teleagent-control', 'voice-execution.lock.json'),
    path.join(fixture.fixture, 'var', 'lib', 'teleagent-control', 'executor-tasks.sqlite'),
    path.join(fixture.fixture, 'var', 'lib', 'teleagent-privileged-action', 'actions.sqlite'),
  ]) {
    assert.equal(fs.existsSync(filename), false, filename);
  }
});
