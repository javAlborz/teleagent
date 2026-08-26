'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
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
  writeExecutable(sourceHelper, `#!/usr/bin/env bash
set -euo pipefail
root=\${TELEAGENT_SIP_FENCE_INSTALL_TEST_ROOT:?}
case "\${1:-}" in
  check) [[ ! -e "\${root}/fail-check" ]] ;;
  remove) /usr/bin/touch "\${root}/remove-observed" ;;
  *) exit 64 ;;
esac
`);

  const sourceUnit = path.join(directory, 'opt/teleagent/current/deploy/voice-stack',
    'teleagent-sip-local-peer-fence.service');
  fs.copyFileSync(path.join(ROOT, 'deploy', 'voice-stack',
    'teleagent-sip-local-peer-fence.service'), sourceUnit);
  fs.chmodSync(sourceUnit, 0o644);

  const systemctl = path.join(directory, 'bin/systemctl');
  writeExecutable(systemctl, `#!/usr/bin/env bash
set -euo pipefail
root=\${TELEAGENT_SIP_FENCE_INSTALL_TEST_ROOT:?}
state=\${root}/systemctl-state
command=\${1:-}
shift || true
service=\${!#:-}
if [[ -e "\${root}/systemctl-error" || -e "\${root}/systemctl-error-\${command}" ]]; then
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
  daemon-reload) exit 0 ;;
  enable)
    /usr/bin/touch "\${state}/\${service}.enabled"
    if [[ " $* " == *' --now '* ]]; then
      /usr/bin/touch "\${state}/\${service}.active"
      /usr/bin/mkdir -p "\${root}/run/teleagent-sip-local-peer-fence"
      /usr/bin/chmod 0700 "\${root}/run/teleagent-sip-local-peer-fence"
      if [[ -e "\${root}/pause-after-enable" ]]; then
        /usr/bin/rm -f "\${root}/pause-after-enable"
        /usr/bin/touch "\${root}/enable-observed"
        while /usr/bin/sleep 1; do :; done
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
  return { directory, environment, run };
}

function managedPaths(directory) {
  return {
    active: path.join(directory, 'systemctl-state/teleagent-sip-local-peer-fence.service.active'),
    enabled: path.join(directory, 'systemctl-state/teleagent-sip-local-peer-fence.service.enabled'),
    helper: path.join(directory, 'usr/local/libexec/teleagent-sip-local-peer-fence'),
    marker: path.join(directory, 'var/lib/teleagent-sip-local-peer-fence-install/install.transaction'),
    unit: path.join(directory, 'etc/systemd/system/teleagent-sip-local-peer-fence.service'),
  };
}

async function waitForPath(filename) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(filename)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${filename}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

test('SIP fence installer rolls back an explicit post-enable check failure', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'fail-check'), '1\n');
  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior inactive state restored/);
  const paths = managedPaths(current.directory);
  for (const filename of Object.values(paths)) assert.equal(fs.existsSync(filename), false);
  assert.equal(fs.existsSync(path.join(current.directory, 'remove-observed')), true);
});

test('SIP fence installer traps TERM after enable and restores inactive state', async (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'pause-after-enable'), '1\n');
  const child = spawn(INSTALLER, ['--install'], {
    detached: true,
    env: current.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  await waitForPath(path.join(current.directory, 'enable-observed'));
  process.kill(-child.pid, 'SIGTERM');
  const [code] = await exited;
  assert.notEqual(code, 0);
  const paths = managedPaths(current.directory);
  for (const filename of Object.values(paths)) assert.equal(fs.existsSync(filename), false);
});

test('SIP fence installer traps INT after enable and restores inactive state', async (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'pause-after-enable'), '1\n');
  const child = spawn(INSTALLER, ['--install'], {
    detached: true,
    env: current.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  await waitForPath(path.join(current.directory, 'enable-observed'));
  process.kill(-child.pid, 'SIGINT');
  const [code] = await exited;
  assert.notEqual(code, 0);
  const paths = managedPaths(current.directory);
  for (const filename of Object.values(paths)) assert.equal(fs.existsSync(filename), false);
});

test('SIP fence rollback preserves a prior enabled but inactive exact installation', (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  const paths = managedPaths(current.directory);
  makeDirectory(path.dirname(paths.helper));
  fs.copyFileSync(path.join(current.directory,
    'opt/teleagent/current/deploy/voice-stack/teleagent-sip-local-peer-fence'), paths.helper);
  fs.chmodSync(paths.helper, 0o755);
  fs.copyFileSync(path.join(current.directory,
    'opt/teleagent/current/deploy/voice-stack/teleagent-sip-local-peer-fence.service'), paths.unit);
  fs.chmodSync(paths.unit, 0o644);
  fs.writeFileSync(paths.enabled, '1\n');
  fs.writeFileSync(path.join(current.directory, 'fail-check'), '1\n');

  const result = current.run('--install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior inactive state restored/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.active), false);
  assert.equal(fs.existsSync(paths.enabled), true);
  assert.equal(fs.existsSync(paths.helper), true);
  assert.equal(fs.existsSync(paths.unit), true);
});

test('SIP fence installer recovers a durable SIGKILL transaction on next install', async (t) => {
  if (process.getuid() === 0) return t.skip('the installer fake lane rejects root');
  const current = fixture(t);
  fs.writeFileSync(path.join(current.directory, 'pause-after-enable'), '1\n');
  const child = spawn(INSTALLER, ['--install'], {
    detached: true,
    env: current.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  await waitForPath(path.join(current.directory, 'enable-observed'));
  process.kill(-child.pid, 'SIGKILL');
  await exited;

  const paths = managedPaths(current.directory);
  assert.equal(fs.existsSync(paths.marker), true);
  assert.equal(fs.existsSync(paths.active), true);
  const recovered = current.run('--install');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, /recovered an interrupted activation/);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.equal(fs.existsSync(paths.active), true);
  assert.equal(fs.existsSync(paths.enabled), true);
  assert.equal(fs.existsSync(paths.helper), true);
  assert.equal(fs.existsSync(paths.unit), true);
});
