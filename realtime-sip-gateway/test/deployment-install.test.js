import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDeploy = path.join(packageRoot, 'deploy');
const sourceAssets = [
  ['teleagent-realtime-sip-gateway.service', 0o644],
  ['teleagent-realtime-sip-gateway.sysusers', 0o644],
  ['teleagent-realtime-sip-gateway.tmpfiles', 0o644],
  ['verify-realtime-sip-gateway', 0o755],
  ['realtime-sip-gateway-install.manifest', 0o644],
  ['teleagent-realtime-sip-gateway-install', 0o755],
];

function executable(filename, contents) {
  writeFileSync(filename, contents, { mode: 0o700 });
  chmodSync(filename, 0o700);
}

function fixture(t, { normalized = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'teleagent-sip-gateway-install-test-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deploy = path.join(root, 'opt/teleagent/current/realtime-sip-gateway/deploy');
  mkdirSync(deploy, { recursive: true, mode: 0o700 });
  for (const [name, devMode] of sourceAssets) {
    const target = path.join(deploy, name);
    copyFileSync(path.join(sourceDeploy, name), target);
    chmodSync(target, normalized ? (devMode === 0o755 ? 0o555 : 0o444) : devMode);
  }
  const releaseNode = path.join(root, 'opt/teleagent/current/runtime/node/bin/node');
  mkdirSync(path.dirname(releaseNode), { recursive: true, mode: 0o700 });
  writeFileSync(releaseNode, `#!/bin/sh
set -eu
[ "\${2:-}" = --source-check ] || exit 2
printf 'SIP_GATEWAY_IDENTITY_SOURCE_OK\n'
`, { mode: normalized ? 0o555 : 0o755 });
  chmodSync(releaseNode, normalized ? 0o555 : 0o755);

  const bin = path.join(root, 'test-bin');
  mkdirSync(bin, { mode: 0o700 });
  executable(path.join(bin, 'systemctl'), `#!/bin/sh
set -eu
fixture=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
printf '%s\n' "$*" >> "$fixture/systemctl.calls"
installed="$fixture/etc/systemd/system/teleagent-realtime-sip-gateway.service"
if [ -e "$fixture/query-fail" ] && [ "\${1:-}" = show ]; then exit 1; fi
case "\${1:-}" in
  show)
    property=
    for argument in "$@"; do
      case "$argument" in --property=*) property=\${argument#--property=} ;; esac
    done
    case "$property" in
      LoadState) [ -f "$installed" ] && printf 'loaded\n' || printf 'not-found\n' ;;
      ActiveState) [ -e "$fixture/active" ] && printf 'active\n' || printf 'inactive\n' ;;
      SubState) [ -e "$fixture/active" ] && printf 'running\n' || printf 'dead\n' ;;
      UnitFileState) [ -f "$installed" ] && printf 'static\n' || printf '\n' ;;
      *) exit 2 ;;
    esac
    ;;
  is-enabled) [ -f "$installed" ] && exit 0 || exit 4 ;;
  daemon-reload) exit 0 ;;
  enable|disable|start|stop|restart|try-restart) exit 99 ;;
  *) exit 2 ;;
esac
`);
  executable(path.join(bin, 'sysusers'), `#!/bin/sh
set -eu
fixture=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
printf 'sysusers %s\n' "$*" >> "$fixture/install.calls"
`);
  executable(path.join(bin, 'tmpfiles'), `#!/bin/sh
set -eu
fixture=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
printf 'tmpfiles %s\n' "$*" >> "$fixture/install.calls"
`);
  executable(path.join(bin, 'identity'), `#!/bin/sh
set -eu
fixture=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
printf 'identity %s\n' "$*" >> "$fixture/install.calls"
case "\${1:-}" in
  --initialize-empty-state) printf 'SIP_GATEWAY_STATE_INITIALIZED_OK\n' ;;
  --installed-check) printf 'SIP_GATEWAY_IDENTITY_OK\n' ;;
  *) exit 2 ;;
esac
`);
  executable(path.join(bin, 'node'), `#!/bin/sh
set -eu
[ "\${2:-}" = --source-check ] || exit 2
printf 'SIP_GATEWAY_IDENTITY_SOURCE_OK\n'
`);

  const environment = {
    LC_ALL: 'C',
    TELEAGENT_SIP_GATEWAY_INSTALL_TEST_ONLY: '1',
    TELEAGENT_SIP_GATEWAY_INSTALL_TEST_ROOT: root,
    TELEAGENT_SIP_GATEWAY_INSTALL_TEST_SYSTEMCTL: path.join(bin, 'systemctl'),
    TELEAGENT_SIP_GATEWAY_INSTALL_TEST_SYSUSERS: path.join(bin, 'sysusers'),
    TELEAGENT_SIP_GATEWAY_INSTALL_TEST_TMPFILES: path.join(bin, 'tmpfiles'),
    TELEAGENT_SIP_GATEWAY_INSTALL_TEST_IDENTITY: path.join(bin, 'identity'),
    TELEAGENT_SIP_GATEWAY_INSTALL_TEST_NODE: path.join(bin, 'node'),
  };
  return {
    root,
    deploy,
    environment,
    installer: path.join(deploy, 'teleagent-realtime-sip-gateway-install'),
  };
}

function run(installer, environment, mode) {
  return spawnSync(installer, [mode], {
    encoding: 'utf8',
    env: environment,
    timeout: 10_000,
  });
}

function rebindServiceManifest(deploy) {
  const service = path.join(deploy, 'teleagent-realtime-sip-gateway.service');
  const digest = createHash('sha256').update(readFileSync(service)).digest('hex');
  const manifest = path.join(deploy, 'realtime-sip-gateway-install.manifest');
  const source = readFileSync(manifest, 'utf8');
  const rebound = source.replace(
    /^[a-f0-9]{64}(?= deploy\/teleagent-realtime-sip-gateway\.service )/mu,
    digest,
  );
  assert.notEqual(rebound, source);
  writeFileSync(manifest, rebound);
}

function assertSuccess(result, token) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${token}\n`);
  assert.equal(result.stderr, '');
}

test('offline installer source-checks, installs, and checks one static inactive closure', (t) => {
  const context = fixture(t);
  assertSuccess(run(context.installer, context.environment, '--source-check'), 'SIP_GATEWAY_SOURCE_OK');
  assertSuccess(
    run(context.installer, context.environment, '--install-disabled'),
    'SIP_GATEWAY_INSTALLED_DISABLED',
  );
  const installed = path.join(
    context.root,
    'usr/local/libexec/teleagent-realtime-sip-gateway-install',
  );
  assertSuccess(run(installed, context.environment, '--check'), 'SIP_GATEWAY_INSTALLED_DISABLED_OK');
  for (const mode of ['--source-check', '--install-disabled']) {
    const refused = run(installed, context.environment, mode);
    assert.equal(refused.status, 77);
    assert.match(refused.stderr, /installed entrypoint is check-only/u);
  }

  assert.equal(existsSync(path.join(
    context.root,
    'etc/teleagent/realtime-sip-gateway/ENABLE',
  )), false);
  assert.equal(existsSync(path.join(
    context.root,
    'etc/teleagent/realtime-sip-gateway/config.env',
  )), false);
  assert.equal(existsSync(path.join(context.root, 'etc/teleagent/credentials')), false);
  const systemctlCalls = readFileSync(path.join(context.root, 'systemctl.calls'), 'utf8');
  assert.doesNotMatch(systemctlCalls, /(^| )(enable|start|restart|try-restart)( |$)/mu);
  assert.match(systemctlCalls, /--property=SubState/u);
  assert.match(systemctlCalls, /--property=UnitFileState/u);
  const installCalls = readFileSync(path.join(context.root, 'install.calls'), 'utf8');
  assert.match(
    installCalls,
    /identity --initialize-empty-state\nidentity --installed-check/u,
  );
  assert.equal((installCalls.match(/identity --initialize-empty-state/gu) ?? []).length, 1);
});

test('source-check accepts immutable release normalization and rejects manifest drift', (t) => {
  const context = fixture(t, { normalized: true });
  assertSuccess(run(context.installer, context.environment, '--source-check'), 'SIP_GATEWAY_SOURCE_OK');
  const service = path.join(context.deploy, 'teleagent-realtime-sip-gateway.service');
  chmodSync(service, 0o644);
  writeFileSync(service, `${readFileSync(service, 'utf8')}\n# drift\n`);
  chmodSync(service, 0o444);
  const result = run(context.installer, context.environment, '--source-check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /manifest digest does not match/u);
});

test('source-check rejects unreviewed execution and credential directives after digest verification', (t) => {
  for (const injection of [
    'ExecStartPre=/usr/bin/false',
    'ExecStart=/usr/bin/false',
    'LoadCredential=unreviewed:/tmp/unreviewed',
    'LoadCredential=teleagent-release-gate:/run/teleagent-release-gate/verified.json',
    'LoadCredentialEncrypted=unreviewed:/tmp/unreviewed',
    'ImportCredential=unreviewed',
    'ImportCredentialEx=unreviewed',
    'SetCredential=unreviewed:not-secret',
    'SetCredentialEncrypted=unreviewed:not-encrypted',
    'ExecStartPost =/opt/teleagent/current/unreviewed-post',
    '\tExecStop=/opt/teleagent/current/unreviewed-stop',
    'LoadCredential =unreviewed:/tmp/unreviewed',
    'SetCredentialEncrypted =unreviewed:not-encrypted',
    '\tImportCredentialEx =unreviewed',
    'ExecStartPost\\\n =/opt/teleagent/current/unreviewed-continuation',
    'ExecStartPost\\\r\n =/opt/teleagent/current/unreviewed-crlf-continuation',
    'ExecStartPost=\0/opt/teleagent/current/unreviewed-control',
  ]) {
    const context = fixture(t);
    const service = path.join(context.deploy, 'teleagent-realtime-sip-gateway.service');
    writeFileSync(service, `${readFileSync(service, 'utf8')}${injection}\n`);
    rebindServiceManifest(context.deploy);
    const result = run(context.installer, context.environment, '--source-check');
    assert.equal(result.status, 77);
    assert.match(result.stderr,
      /start command closure|execution command closure|credential directive closure|resource or storage contract|noncanonical lifecycle or credential assignment whitespace|unsupported line continuation|forbidden control byte/u);
  }
});

test('source-check cannot select a caller-provided runtime override', () => {
  const result = spawnSync(
    path.join(sourceDeploy, 'teleagent-realtime-sip-gateway-install'),
    ['--source-check'],
    {
      encoding: 'utf8',
      env: { TELEAGENT_SIP_GATEWAY_INSTALL_TEST_NODE: '/tmp/caller-node' },
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 77);
  assert.match(result.stderr, /overrides require the isolated test lane/u);
});

test('production mutation requires a canonical immutable release entrypoint', () => {
  const result = spawnSync(
    path.join(sourceDeploy, 'teleagent-realtime-sip-gateway-install'),
    ['--install-disabled'],
    { encoding: 'utf8', env: { LC_ALL: 'C' }, timeout: 10_000 },
  );
  assert.equal(result.status, 77);
  assert.match(result.stderr, /requires an immutable release root/u);
});

test('source-check requires one exact release-Node verifier attestation', (t) => {
  const context = fixture(t);
  const releaseNode = path.join(context.root, 'opt/teleagent/current/runtime/node/bin/node');
  writeFileSync(releaseNode, `#!/bin/sh
printf 'SIP_GATEWAY_IDENTITY_SOURCE_OK\nextra-output\n'
`, { mode: 0o755 });
  chmodSync(releaseNode, 0o755);
  const result = run(context.installer, context.environment, '--source-check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /invalid SIP gateway attestation/u);
  assert.equal(result.stdout, '');
});

test('installer fails closed on active, transitional, or unavailable unit state', (t) => {
  for (const marker of ['active', 'query-fail']) {
    const context = fixture(t);
    writeFileSync(path.join(context.root, marker), '1');
    const result = run(context.installer, context.environment, '--install-disabled');
    assert.equal(result.status, 75);
    assert.equal(existsSync(path.join(
      context.root,
      'etc/systemd/system/teleagent-realtime-sip-gateway.service',
    )), false);
    assert.equal(existsSync(path.join(
      context.root,
      'etc/teleagent/realtime-sip-gateway/ENABLE',
    )), false);
  }
});

test('check rejects installed drift without activating or repairing it', (t) => {
  const context = fixture(t);
  assertSuccess(
    run(context.installer, context.environment, '--install-disabled'),
    'SIP_GATEWAY_INSTALLED_DISABLED',
  );
  const installedService = path.join(
    context.root,
    'etc/systemd/system/teleagent-realtime-sip-gateway.service',
  );
  chmodSync(installedService, 0o600);
  const installed = path.join(
    context.root,
    'usr/local/libexec/teleagent-realtime-sip-gateway-install',
  );
  const result = run(installed, context.environment, '--check');
  assert.equal(result.status, 77);
  assert.match(result.stderr, /unsafe metadata/u);
  assert.equal(existsSync(path.join(
    context.root,
    'etc/teleagent/realtime-sip-gateway/ENABLE',
  )), false);
});
