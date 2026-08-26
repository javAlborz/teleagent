'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'worker-session');
const INSTALLER = path.join(DEPLOY, 'teleagent-worker-session-install');

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
  writeExecutable(systemctl, `#!/bin/bash
set -u
printf '%s\\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
case "$1" in
  show)
    unit="$2"
    property="$3"
    case "$unit" in
      teleagent-provider-supervisor@*.service) filename=teleagent-provider-supervisor@.service ;;
      teleagent-provider-supervisor@*.socket) filename=teleagent-provider-supervisor@.socket ;;
      teleagent-provider-egress@*.service) filename=teleagent-provider-egress@.service ;;
      teleagent-provider-egress@*.socket) filename=teleagent-provider-egress@.socket ;;
      teleagent-provider-egress-control@*.socket) filename=teleagent-provider-egress-control@.socket ;;
      *) filename="$unit" ;;
    esac
    [ "\${FAKE_STATE_QUERY_FAILURE:-}" = "$unit" ] && exit 1
    installed=0
    [ -f "$TELEAGENT_WORKER_SESSION_INSTALL_TEST_ROOT/etc/systemd/system/$filename" ] && installed=1
    case "$property" in
      --property=LoadState)
        [ "$installed" -eq 1 ] && printf 'loaded\\n' || printf 'not-found\\n'
        ;;
      --property=ActiveState)
        [ "\${FAKE_ACTIVE_UNIT:-}" = "$unit" ] && printf 'active\\n' || printf 'inactive\\n'
        ;;
      --property=UnitFileState)
        [ "$installed" -eq 1 ] || exit 1
        printf '%s\\n' "\${FAKE_UNIT_FILE_STATE:-static}"
        ;;
      *) exit 64 ;;
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
  assert.match(installer, /--property=ActiveState --value/);
  assert.match(installer, /--property=LoadState --value/);
  assert.match(installer, /--property=UnitFileState --value/);
  assert.match(installer, /is-enabled/);
  assert.match(installer, /teleagent-provider-launch-\*\.service/);
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

  const systemctlCalls = fs.readFileSync(fixture.systemctlLog, 'utf8')
    .trim().split('\n').map((line) => line.split(' ')[0]);
  assert.ok(systemctlCalls.length > 0);
  assert.deepEqual(
    [...new Set(systemctlCalls)].sort(),
    ['daemon-reload', 'is-enabled', 'list-units', 'show']
  );
  const dependencyCalls = fs.readFileSync(fixture.dependencyLog, 'utf8');
  assert.match(dependencyCalls, /^systemd-sysusers /m);
  assert.match(dependencyCalls, /^systemd-tmpfiles --create /m);
  assert.match(dependencyCalls, /^visudo -cf /m);
  assert.match(dependencyCalls, /^identity --installed-check$/m);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_ACTIVE_UNIT: 'teleagent-worker-session.service',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /a worker-session unit is active/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_STATE_QUERY_FAILURE: 'teleagent-worker-session.service',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unit load state is unavailable/);

  result = fixture.run(fixture.installedInstaller, '--check', {
    FAKE_UNIT_FILE_STATE: 'enabled',
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /unit is not exactly static/);

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
