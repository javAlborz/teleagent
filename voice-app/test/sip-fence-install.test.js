'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const INSTALLER = path.join(ROOT, 'deploy', 'voice-stack',
  'teleagent-sip-local-peer-fence-install');

function makeDirectory(directory, mode = 0o755) {
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chmodSync(directory, mode);
}

function writeExecutable(filename, source) {
  fs.writeFileSync(filename, source, { mode: 0o700 });
  fs.chmodSync(filename, 0o700);
}

function digest(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function fakeFenceHelper(label) {
  return `#!/usr/bin/env bash
set -euo pipefail
# Installer-source contract markers for the isolated fake helper:
# teleagent-voice teleagent-drachtio teleagent-freeswitch teleagent-asterisk
# 5060 5070 5080 9022 8021 3001 30000-30100
root=\${TELEAGENT_SIP_FENCE_INSTALL_TEST_ROOT:?}
case "\${1:-}" in
  check)
    /usr/bin/touch "\${root}/${label}-check-observed"
    if [[ "${label}" == current && -e "\${root}/corrupt-bundle-on-current-check" ]]; then
      printf '%s\n' corrupt >"\${root}/var/lib/teleagent-sip-local-peer-fence-install/installed.bundle"
      /usr/bin/chmod 0600 "\${root}/var/lib/teleagent-sip-local-peer-fence-install/installed.bundle"
    fi
    [[ ! -e "\${root}/fail-check" && ! -e "\${root}/fail-check-${label}" ]]
    ;;
  reconcile)
    /usr/bin/touch "\${root}/${label}-reconcile-observed"
    [[ ! -e "\${root}/fail-reconcile-${label}" ]]
    ;;
  remove)
    /usr/bin/touch "\${root}/${label}-remove-observed"
    [[ ! -e "\${root}/fail-remove-${label}" ]] || exit 1
    if [[ -e "\${root}/lock-state-on-${label}-remove" ]]; then
      /usr/bin/chmod 0500 "\${root}/var/lib/teleagent-sip-local-peer-fence-install"
    fi
    ;;
  *) exit 64 ;;
esac
`;
}

function bundleDescriptor(version, helperSha, unitSha, legacyVersion, legacyHelperSha,
  legacyUnitSha) {
  return [
    'schema=1',
    `bundle_version=${version}`,
    `helper_sha256=${helperSha}`,
    `unit_sha256=${unitSha}`,
    `legacy_bundle_version=${legacyVersion}`,
    `legacy_helper_sha256=${legacyHelperSha}`,
    `legacy_unit_sha256=${legacyUnitSha}`,
    '',
  ].join('\n');
}

function installedDescriptor(version, helperSha, unitSha) {
  return [
    'schema=1',
    `bundle_version=${version}`,
    `helper_sha256=${helperSha}`,
    `unit_sha256=${unitSha}`,
    '',
  ].join('\n');
}

function fixture(t) {
  const directory = fs.mkdtempSync('/tmp/teleagent-sip-fence-install-test-');
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  for (const relative of [
    'bin',
    'etc/systemd/system',
    'opt/teleagent/current/deploy/voice-stack',
    'run',
    'usr/local',
    'var/lib',
    'systemctl-state',
  ]) {
    makeDirectory(path.join(directory, relative));
  }

  const sourceHelper = path.join(directory, 'opt/teleagent/current/deploy/voice-stack',
    'teleagent-sip-local-peer-fence');
  const currentHelperSource = fakeFenceHelper('current');
  const legacyHelperSource = fakeFenceHelper('legacy');
  writeExecutable(sourceHelper, currentHelperSource);

  const sourceUnit = path.join(directory, 'opt/teleagent/current/deploy/voice-stack',
    'teleagent-sip-local-peer-fence.service');
  fs.copyFileSync(path.join(ROOT, 'deploy', 'voice-stack',
    'teleagent-sip-local-peer-fence.service'), sourceUnit);
  fs.chmodSync(sourceUnit, 0o644);
  const currentUnitSource = fs.readFileSync(sourceUnit, 'utf8');
  const legacyUnitSource = `${currentUnitSource}# reviewed fixture legacy\n`;
  const currentHelperSha = digest(currentHelperSource);
  const currentUnitSha = digest(currentUnitSource);
  const legacyHelperSha = digest(legacyHelperSource);
  const legacyUnitSha = digest(legacyUnitSource);
  const sourceBundle = path.join(directory, 'opt/teleagent/current/deploy/voice-stack',
    'teleagent-sip-local-peer-fence.bundle');
  fs.writeFileSync(sourceBundle, bundleDescriptor(
    2, currentHelperSha, currentUnitSha, 1, legacyHelperSha, legacyUnitSha
  ));
  fs.chmodSync(sourceBundle, 0o644);

  const systemctl = path.join(directory, 'bin/systemctl');
  writeExecutable(systemctl, `#!/usr/bin/env bash
set -euo pipefail
root=\${TELEAGENT_SIP_FENCE_INSTALL_TEST_ROOT:?}
state=\${root}/systemctl-state
quiet=0
if [[ "\${1:-}" == --quiet ]]; then
  quiet=1
  shift
fi
command=\${1:-}
shift || true
service=\${!#:-}
if [[ -e "\${root}/systemctl-noisy-success" && "\${quiet}" == 0 ]]; then
  case "\${command}" in
    disable|enable|daemon-reload)
      printf '%s\\n' "fixture systemctl success chatter: \${command}"
      printf '%s\\n' "fixture systemctl success diagnostic: \${command}" >&2
      ;;
  esac
fi
if [[ "\${command}" == daemon-reload &&
      -e "\${root}/replace-helper-current-on-daemon-reload-error" ]]; then
  /usr/bin/mkdir -p "\${root}/usr/local/libexec"
  /usr/bin/cp "\${root}/opt/teleagent/current/deploy/voice-stack/teleagent-sip-local-peer-fence" \
    "\${root}/usr/local/libexec/teleagent-sip-local-peer-fence"
  /usr/bin/chmod 0755 "\${root}/usr/local/libexec/teleagent-sip-local-peer-fence"
  exit 70
fi
if [[ -e "\${root}/systemctl-error" || -e "\${root}/systemctl-error-\${command}" ]]; then
  exit 70
fi
if [[ -e "\${root}/systemctl-error-once-\${command}" ]]; then
  /usr/bin/rm -f "\${root}/systemctl-error-once-\${command}"
  exit 70
fi
case "\${command}" in
  is-active)
    if [[ -e "\${state}/\${service}.active" ]]; then
      printf '%s\\n' active
      exit 0
    fi
    printf '%s\\n' inactive
    [[ -e "\${root}/etc/systemd/system/\${service}" ]] && exit 3
    exit 4
    ;;
  is-enabled)
    if [[ -e "\${state}/\${service}.enabled" ]]; then
      printf '%s\\n' enabled
      exit 0
    fi
    if [[ -e "\${root}/etc/systemd/system/\${service}" ]]; then
      printf '%s\\n' disabled
      exit 1
    fi
    printf '%s\\n' not-found
    exit 4
    ;;
  show)
    [[ "$#" -eq 2 ]]
    [[ "\${1:-}" == '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NeedDaemonReload,DropInPaths,User,Group' ]]
    [[ "\${service}" == teleagent-sip-local-peer-fence.service ]]
    fragment="\${root}/etc/systemd/system/\${service}"
    reload=no
    dropins=
    user=root
    group=root
    [[ ! -e "\${root}/show-runtime-fragment" ]] || fragment="/run/systemd/generator/\${service}"
    [[ ! -e "\${root}/show-drop-in" ]] || dropins="\${root}/etc/systemd/system/\${service}.d/override.conf"
    [[ ! -e "\${root}/show-daemon-reload" ]] || reload=yes
    [[ ! -e "\${root}/show-wrong-user" ]] || user=teleagent
    [[ ! -e "\${root}/show-wrong-group" ]] || group=teleagent
    if [[ -e "\${root}/show-oversized" ]]; then
      /usr/bin/head -c 5000 /dev/zero | /usr/bin/tr '\\000' X
      exit 0
    fi
    printf '%s\\n' \
      'LoadState=loaded' \
      'ActiveState=active' \
      'SubState=running' \
      'UnitFileState=enabled' \
      "FragmentPath=\${fragment}" \
      "NeedDaemonReload=\${reload}" \
      "DropInPaths=\${dropins}" \
      "User=\${user}" \
      "Group=\${group}"
    ;;
  daemon-reload)
    if [[ -e "\${root}/systemctl-error-after-first-daemon-reload" ]]; then
      /usr/bin/rm -f "\${root}/systemctl-error-after-first-daemon-reload"
      /usr/bin/touch "\${root}/systemctl-error-daemon-reload"
    fi
    exit 0
    ;;
  start) /usr/bin/touch "\${state}/\${service}.active" ;;
  enable)
    /usr/bin/touch "\${state}/\${service}.enabled"
    if [[ " $* " == *' --now '* ]]; then
      /usr/bin/touch "\${state}/\${service}.active"
      /usr/bin/mkdir -p "\${root}/run/teleagent-sip-local-peer-fence"
      /usr/bin/chmod 0700 "\${root}/run/teleagent-sip-local-peer-fence"
      if [[ -e "\${root}/signal-parent-after-enable" ]]; then
        signal=$(/usr/bin/cat "\${root}/signal-parent-after-enable")
        [[ "\${signal}" =~ ^(TERM|INT|KILL)$ ]] || exit 65
        /usr/bin/rm -f "\${root}/signal-parent-after-enable"
        /usr/bin/touch "\${root}/enable-observed"
        kill "-\${signal}" "\${PPID}"
        exit 0
      fi
    fi
    ;;
  disable)
    /usr/bin/rm -f "\${state}/\${service}.enabled"
    if [[ " $* " == *' --now '* ]]; then
      /usr/bin/rm -f "\${state}/\${service}.active"
    fi
    ;;
  *) exit 64 ;;
esac
`);

  const environment = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C',
    TELEAGENT_SIP_FENCE_INSTALL_TEST_ONLY: '1',
    TELEAGENT_SIP_FENCE_INSTALL_TEST_ROOT: directory,
  };
  const run = (...args) => spawnSync(INSTALLER, args, {
    env: environment,
    encoding: 'utf8',
    timeout: 10000,
  });
  const installLegacy = ({ descriptor = true, active = true, enabled = true } = {}) => {
    const paths = managedPaths(directory);
    makeDirectory(path.dirname(paths.helper));
    fs.writeFileSync(paths.helper, legacyHelperSource, { mode: 0o755 });
    fs.chmodSync(paths.helper, 0o755);
    fs.writeFileSync(paths.unit, legacyUnitSource, { mode: 0o644 });
    fs.chmodSync(paths.unit, 0o644);
    if (descriptor) {
      makeDirectory(path.dirname(paths.bundle), 0o700);
      fs.writeFileSync(paths.bundle, installedDescriptor(1, legacyHelperSha, legacyUnitSha), {
        mode: 0o600,
      });
      fs.chmodSync(paths.bundle, 0o600);
    }
    if (active) fs.writeFileSync(paths.active, '1\n');
    if (enabled) fs.writeFileSync(paths.enabled, '1\n');
  };
  return {
    currentHelperSha,
    currentHelperSource,
    currentUnitSha,
    currentUnitSource,
    directory,
    environment,
    installLegacy,
    legacyHelperSha,
    legacyHelperSource,
    legacyUnitSha,
    legacyUnitSource,
    run,
  };
}

function managedPaths(directory) {
  return {
    active: path.join(directory, 'systemctl-state/teleagent-sip-local-peer-fence.service.active'),
    bundle: path.join(directory, 'var/lib/teleagent-sip-local-peer-fence-install/installed.bundle'),
    enabled: path.join(directory, 'systemctl-state/teleagent-sip-local-peer-fence.service.enabled'),
    helper: path.join(directory, 'usr/local/libexec/teleagent-sip-local-peer-fence'),
    marker: path.join(directory, 'var/lib/teleagent-sip-local-peer-fence-install/install.transaction'),
    unit: path.join(directory, 'etc/systemd/system/teleagent-sip-local-peer-fence.service'),
  };
}

test('SIP fence source assets are pinned beside the resolved installer entrypoint', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.doesNotMatch(source, /^app_root=\/opt\/teleagent\/current$/m);
  assert.match(source, /installer_self=\$\(readlink -f -- "\$\{BASH_SOURCE\[0\]\}"\)/);
  assert.match(source, /source_directory.*\$\{app_root\}\/deploy\/voice-stack/);
  for (const [variable, basename] of [
    ['source_helper', 'teleagent-sip-local-peer-fence'],
    ['source_unit', 'teleagent-sip-local-peer-fence.service'],
    ['source_bundle', 'teleagent-sip-local-peer-fence.bundle'],
  ]) {
    assert.equal(source.includes(`${variable}=\${source_directory}/${basename}`), true);
  }
});

test('SIP fence installer fails closed on indeterminate service-manager state', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'systemctl-error'), '1\n');
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not prove the voice stack state/);
  const paths = managedPaths(current.directory);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.helper), false);
  assert.equal(fs.existsSync(paths.unit), false);
});

test('SIP fence installer refuses indeterminate prior enablement before publishing a transaction', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'systemctl-error-is-enabled'), '1\n');
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not prove the SIP fence enablement state/);
  const paths = managedPaths(current.directory);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.helper), false);
  assert.equal(fs.existsSync(paths.unit), false);
});

test('SIP fence check rejects loaded-unit identity drift before checking nftables', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  for (const marker of [
    'show-runtime-fragment',
    'show-drop-in',
    'show-daemon-reload',
    'show-wrong-user',
    'show-wrong-group',
    'show-oversized',
  ]) {
    const current = fixture(t);
    const installed = current.run('--install');
    assert.equal(installed.status, 0, `${marker}: ${installed.stderr}`);
    const helperObserved = path.join(current.directory, 'current-check-observed');
    fs.rmSync(helperObserved);
    fs.writeFileSync(path.join(current.directory, marker), '1\n');

    const checked = current.run('--check');
    assert.notEqual(checked.status, 0, marker);
    assert.equal(fs.existsSync(helperObserved), false, marker);
  }
});

test('SIP fence installer rolls back an explicit post-enable check failure', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'fail-check'), '1\n');
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior bundle restored/);
  const paths = managedPaths(current.directory);
  for (const filename of Object.values(paths)) assert.equal(fs.existsSync(filename), false);
  assert.equal(fs.existsSync(path.join(current.directory, 'current-remove-observed')), true);
});

test('SIP fence installer traps TERM after enable and restores inactive state', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'signal-parent-after-enable'), 'TERM\n');
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(current.directory, 'enable-observed')), true);
  const paths = managedPaths(current.directory);
  for (const filename of Object.values(paths)) assert.equal(fs.existsSync(filename), false);
});

test('SIP fence installer traps INT after enable and restores inactive state', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'signal-parent-after-enable'), 'INT\n');
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(current.directory, 'enable-observed')), true);
  const paths = managedPaths(current.directory);
  for (const filename of Object.values(paths)) assert.equal(fs.existsSync(filename), false);
});

test('SIP fence upgrade rollback restores the exact legacy bundle and service state', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const paths = managedPaths(current.directory);
  current.installLegacy();
  fs.writeFileSync(path.join(current.directory, 'fail-check-current'), '1\n');

  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior bundle restored/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.active), true);
  assert.equal(fs.existsSync(paths.enabled), true);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.legacyHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.legacyUnitSource);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), installedDescriptor(
    1, current.legacyHelperSha, current.legacyUnitSha
  ));
  assert.equal(fs.existsSync(path.join(current.directory, 'legacy-reconcile-observed')), true);
});

test('SIP fence rollback never reactivates after reload or reconcile ambiguity', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  for (const failureMarker of [
    'systemctl-error-after-first-daemon-reload',
    'fail-reconcile-legacy',
  ]) {
    const current = fixture(t);
    const paths = managedPaths(current.directory);
    current.installLegacy();
    fs.writeFileSync(path.join(current.directory, 'fail-check-current'), '1\n');
    fs.writeFileSync(path.join(current.directory, failureMarker), '1\n');

    const result = current.run('--install');
    assert.notEqual(result.status, 0, failureMarker);
    assert.match(result.stderr, /rollback was incomplete/, failureMarker);
    assert.equal(fs.existsSync(paths.marker), true, failureMarker);
    assert.equal(fs.existsSync(paths.active), false, failureMarker);
    assert.equal(fs.existsSync(paths.enabled), false, failureMarker);
    assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.legacyHelperSource,
      failureMarker);
    assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.legacyUnitSource,
      failureMarker);
  }
});

test('SIP fence rollback refuses a concurrently replaced installed descriptor', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const paths = managedPaths(current.directory);
  current.installLegacy();
  fs.writeFileSync(path.join(current.directory, 'fail-check-current'), '1\n');
  fs.writeFileSync(path.join(current.directory, 'corrupt-bundle-on-current-check'), '1\n');

  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback was incomplete/);
  assert.equal(fs.existsSync(paths.marker), true);
  assert.equal(fs.existsSync(paths.active), false);
  assert.equal(fs.existsSync(paths.enabled), false);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), 'corrupt\n');
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.currentUnitSource);
});

test('SIP fence absent rollback retains the exact removal retry path', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const paths = managedPaths(current.directory);
  const failCheck = path.join(current.directory, 'fail-check-current');
  const failRemove = path.join(current.directory, 'fail-remove-current');
  fs.writeFileSync(failCheck, '1\n');
  fs.writeFileSync(failRemove, '1\n');

  const failed = current.run('--install');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /rollback was incomplete/);
  assert.equal(fs.existsSync(paths.marker), true);
  assert.equal(fs.existsSync(paths.active), false);
  assert.equal(fs.existsSync(paths.enabled), false);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.currentUnitSource);

  fs.rmSync(failCheck);
  fs.rmSync(failRemove);
  const recovered = current.run('--install');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, /recovered an interrupted fence operation/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.active), true);
  assert.equal(fs.existsSync(paths.enabled), true);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.currentUnitSource);
});

test('SIP fence absent rollback durably resumes after table removal', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const paths = managedPaths(current.directory);
  const failCheck = path.join(current.directory, 'fail-check-current');
  const armReloadFailure = path.join(
    current.directory, 'systemctl-error-after-first-daemon-reload'
  );
  const reloadFailure = path.join(current.directory, 'systemctl-error-daemon-reload');
  fs.writeFileSync(failCheck, '1\n');
  fs.writeFileSync(armReloadFailure, '1\n');

  const failed = current.run('--install');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /rollback was incomplete/);
  assert.equal(fs.existsSync(paths.marker), true);
  assert.match(fs.readFileSync(paths.marker, 'utf8'), /^phase=files$/m);
  assert.equal(fs.existsSync(paths.helper), false);
  assert.equal(fs.existsSync(paths.unit), false);
  assert.equal(fs.existsSync(paths.active), false);
  assert.equal(fs.existsSync(paths.enabled), false);

  fs.rmSync(failCheck);
  fs.rmSync(reloadFailure);
  const recovered = current.run('--install');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, /recovered an interrupted fence operation/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.active), true);
  assert.equal(fs.existsSync(paths.enabled), true);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.currentUnitSource);
});

test('SIP fence absent rollback stops before deleting its retry helper if phase persistence fails', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const paths = managedPaths(current.directory);
  fs.writeFileSync(path.join(current.directory, 'fail-check-current'), '1\n');
  fs.writeFileSync(path.join(current.directory, 'lock-state-on-current-remove'), '1\n');

  const result = current.run('--install');
  fs.chmodSync(path.dirname(paths.marker), 0o700);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback was incomplete/);
  assert.equal(fs.existsSync(paths.marker), true);
  assert.match(fs.readFileSync(paths.marker, 'utf8'), /^phase=activation$/m);
  assert.equal(fs.existsSync(paths.active), false);
  assert.equal(fs.existsSync(paths.enabled), false);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.currentUnitSource);
});

test('SIP fence installer recovers a durable SIGKILL upgrade on next install', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  current.installLegacy();
  fs.writeFileSync(path.join(current.directory, 'signal-parent-after-enable'), 'KILL\n');
  const interrupted = current.run('--install');
  assert.notEqual(interrupted.status, 0);
  assert.equal(fs.existsSync(path.join(current.directory, 'enable-observed')), true);

  const paths = managedPaths(current.directory);
  assert.equal(fs.existsSync(paths.marker), true);
  assert.equal(fs.existsSync(paths.active), true);
  const recovered = current.run('--install');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, /recovered an interrupted fence operation/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.active), true);
  assert.equal(fs.existsSync(paths.enabled), true);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.currentUnitSource);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), installedDescriptor(
    2, current.currentHelperSha, current.currentUnitSha
  ));
  assert.equal(fs.existsSync(path.join(current.directory, 'legacy-reconcile-observed')), true);
});

test('SIP fence installer commits a fixed current bundle descriptor', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const result = current.run('--install');
  assert.equal(result.status, 0, result.stderr);
  const paths = managedPaths(current.directory);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), installedDescriptor(
    2, current.currentHelperSha, current.currentUnitSha
  ));
});

test('SIP fence installer suppresses successful systemctl chatter for aggregate capture', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'systemctl-noisy-success'), '1\n');
  const result = current.run('--install');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const paths = managedPaths(current.directory);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), installedDescriptor(
    2, current.currentHelperSha, current.currentUnitSha
  ));
});

test('SIP fence installer adopts and upgrades only a descriptor-less known legacy pair', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  current.installLegacy({ descriptor: false });
  const result = current.run('--install');
  assert.equal(result.status, 0, result.stderr);
  const paths = managedPaths(current.directory);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), installedDescriptor(
    2, current.currentHelperSha, current.currentUnitSha
  ));
});

test('SIP fence installer refuses an unknown target before publishing state', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const paths = managedPaths(current.directory);
  makeDirectory(path.dirname(paths.helper));
  fs.writeFileSync(paths.helper, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(paths.helper, 0o755);
  fs.writeFileSync(paths.unit, '[Unit]\nDescription=unknown\n', { mode: 0o644 });
  fs.chmodSync(paths.unit, 0o644);
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite an unknown install target/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.bundle), false);
});

test('SIP fence installer refuses target drift against an installed descriptor', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  current.installLegacy();
  const paths = managedPaths(current.directory);
  fs.appendFileSync(paths.helper, '# drift\n');
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed fence helper digest drifted/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), installedDescriptor(
    1, current.legacyHelperSha, current.legacyUnitSha
  ));
});

test('SIP fence removal uses the installed legacy descriptor when source is newer', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  current.installLegacy();
  const paths = managedPaths(current.directory);
  const result = current.run('--remove');
  assert.equal(result.status, 0, result.stderr);
  for (const filename of Object.values(paths)) assert.equal(fs.existsSync(filename), false);
  assert.equal(fs.existsSync(path.join(current.directory, 'legacy-remove-observed')), true);
});

test('SIP fence removal failure restores the exact installed descriptor and table', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  current.installLegacy();
  const paths = managedPaths(current.directory);
  fs.writeFileSync(path.join(current.directory, 'systemctl-error-once-daemon-reload'), '1\n');
  const result = current.run('--remove');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior bundle restored/);
  assert.equal(fs.existsSync(paths.active), true);
  assert.equal(fs.existsSync(paths.enabled), true);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.legacyHelperSource);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), current.legacyUnitSource);
  assert.equal(fs.readFileSync(paths.bundle, 'utf8'), installedDescriptor(
    1, current.legacyHelperSha, current.legacyUnitSha
  ));
  assert.equal(fs.existsSync(path.join(current.directory, 'legacy-reconcile-observed')), true);
});

test('SIP fence removal rollback refuses current bytes injected into a legacy transaction', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  current.installLegacy();
  const paths = managedPaths(current.directory);
  fs.writeFileSync(
    path.join(current.directory, 'replace-helper-current-on-daemon-reload-error'),
    '1\n'
  );

  const result = current.run('--remove');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback was incomplete/);
  assert.equal(fs.existsSync(paths.marker), true);
  assert.equal(fs.existsSync(paths.active), false);
  assert.equal(fs.existsSync(paths.enabled), false);
  assert.equal(fs.readFileSync(paths.helper, 'utf8'), current.currentHelperSource);
  assert.equal(fs.existsSync(paths.unit), false);
  assert.equal(fs.existsSync(paths.bundle), false);
});
