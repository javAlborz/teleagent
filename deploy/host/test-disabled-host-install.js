'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SOURCE_INSTALLER = path.join(__dirname, 'teleagent-disabled-host-install');
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const BOOT_ID = '01234567-89ab-cdef-8123-456789abcdef';

function mkdir(filename, mode = 0o755) {
  fs.mkdirSync(filename, { recursive: true, mode });
  fs.chmodSync(filename, mode);
}

function writeFile(filename, contents, mode) {
  mkdir(path.dirname(filename));
  fs.writeFileSync(filename, contents, { mode });
  fs.chmodSync(filename, mode);
}

function commandLogger(log, label) {
  return [
    `log=${JSON.stringify(log)}`,
    `printf '%s' ${JSON.stringify(label)} >> "$log"`,
    'for argument in "$@"; do printf \'\\t%s\' "$argument" >> "$log"; done',
    'printf \'\\n\' >> "$log"',
  ].join('\n');
}

function installedProgram(log, label, token) {
  return `#!/bin/bash\nset -euo pipefail\n${commandLogger(log, label)}\n` +
    `[ "${'${1:-}'}" = --check ] && [ "$#" -eq 1 ] || exit 77\n` +
    `printf '%s\\n' ${JSON.stringify(token)}\n`;
}

function componentSource({
  log, label, sourceToken, installedTarget, installedToken, templates = [], postInstall = '',
}) {
  const installedTemplate = `${installedTarget}.fixture-template`;
  writeFile(installedTemplate, installedProgram(log, `${label}-installed`, installedToken), 0o600);
  for (const [target, contents] of templates) {
    writeFile(`${target}.fixture-template`, contents, 0o600);
  }
  const installs = [
    `[${JSON.stringify(installedTemplate)}, ${JSON.stringify(installedTarget)}]`,
    ...templates.map(([target]) =>
      `[${JSON.stringify(`${target}.fixture-template`)}, ${JSON.stringify(target)}]`),
  ];
  const installLines = installs.map((record) => {
    const [template, target] = JSON.parse(record);
    return `/usr/bin/install -d -m 0755 -- ${JSON.stringify(path.dirname(target))}\n` +
      `/usr/bin/install -m 0755 -- ${JSON.stringify(template)} ${JSON.stringify(target)}`;
  }).join('\n');
  return `#!/bin/bash\nset -euo pipefail\n${commandLogger(log, `${label}-source`)}\n` +
    `case "${'${1:-}'}:$#" in\n` +
    `  --source-check:1) printf '%s\\n' ${JSON.stringify(sourceToken)} ;;\n` +
    `  --install-disabled:1)\n${installLines.split('\n').map((line) => `    ${line}`).join('\n')}\n` +
    `${postInstall.split('\n').filter(Boolean).map((line) => `    ${line}`).join('\n')}\n` +
    `    printf '%s\\n' ${JSON.stringify(installedToken.replace(/_OK$/, ''))} ;;\n` +
    `  *) exit 77 ;;\n` +
    'esac\n';
}

function createFixture() {
  const root = fs.mkdtempSync('/tmp/teleagent-disabled-host-install-test-');
  fs.chmodSync(root, 0o700);
  const log = path.join(root, 'commands.log');
  fs.writeFileSync(log, '', { mode: 0o600 });

  for (const [directory, mode] of [
    ['run', 0o755], ['opt', 0o755], ['opt/teleagent', 0o755],
    ['opt/teleagent/releases', 0o755], ['usr', 0o755], ['usr/local', 0o755],
    ['usr/local/libexec', 0o755], ['var', 0o755], ['var/lib', 0o755],
    ['srv', 0o755], ['etc', 0o755], ['proc/sys/kernel/random', 0o755], ['test-bin', 0o700],
    ['test-assets', 0o700],
  ]) mkdir(path.join(root, directory), mode);

  const manifest = `${JSON.stringify({
    version: 2,
    application: 'teleagent',
    source: {
      repository: 'https://github.com/javAlborz/teleagent.git',
      revision: REVISION,
      tree: REVISION,
    },
    target: { os: 'linux', architecture: 'amd64' },
  })}\n`;
  const digest = crypto.createHash('sha256').update(manifest).digest('hex');
  const releaseId = `sha256-${digest}`;
  const releaseRoot = path.join(root, 'opt/teleagent/releases', releaseId);
  mkdir(releaseRoot, 0o755);

  const installed = (absolute) => path.join(root, absolute.slice(1));
  const workerInstalled = installed('/usr/local/libexec/teleagent-worker-session-install');
  const providerInstaller = installed('/usr/local/libexec/teleagent-provider-cli-install');
  const providerChecker = installed('/usr/local/libexec/teleagent-provider-cli-check');
  const controllerInstalled = installed('/usr/local/libexec/teleagent-control-plane-install');
  const sipInstalled = installed('/usr/local/libexec/teleagent-realtime-sip-gateway-install');
  const voiceInstalled = installed('/usr/local/libexec/teleagent-voice-stack-install');
  const installedRuntime = installed('/usr/local/libexec/teleagent-node');
  const runtimeInPlaceMarker = path.join(root, 'test-assets/runtime-in-place-tamper');
  const runtimeReplaceMarker = path.join(root, 'test-assets/runtime-replacement-tamper');
  const runtimeTamper = [
    `if [ -f ${JSON.stringify(runtimeInPlaceMarker)} ]; then`,
    `  /usr/bin/chmod 0755 -- ${JSON.stringify(installedRuntime)}`,
    `  /usr/bin/printf X | /usr/bin/dd of=${JSON.stringify(installedRuntime)} bs=1 seek=1 count=1 conv=notrunc status=none`,
    `  /usr/bin/chmod 0555 -- ${JSON.stringify(installedRuntime)}`,
    'fi',
    `if [ -f ${JSON.stringify(runtimeReplaceMarker)} ]; then`,
    `  /usr/bin/cp --preserve=mode,timestamps -- ${JSON.stringify(installedRuntime)} ${JSON.stringify(`${installedRuntime}.replacement`)}`,
    `  /usr/bin/mv -T -- ${JSON.stringify(`${installedRuntime}.replacement`)} ${JSON.stringify(installedRuntime)}`,
    'fi',
  ].join('\n');

  const providerPlaceholder = '# fixture provider script: interpreted by the fixed fixture Node\n';
  const sources = new Map([
    ['deploy/worker-session/teleagent-worker-session-install', componentSource({
      log,
      label: 'worker',
      sourceToken: 'WORKER_SESSION_SOURCE_OK',
      installedTarget: workerInstalled,
      installedToken: 'WORKER_SESSION_INSTALLED_DISABLED_OK',
      postInstall: runtimeTamper,
      templates: [
        [providerInstaller, providerPlaceholder],
        [providerChecker, providerPlaceholder],
      ],
    })],
    ['deploy/controller/teleagent-control-plane-install', componentSource({
      log,
      label: 'controller',
      sourceToken: 'TELEAGENT_CONTROL_PLANE_SOURCE_OK',
      installedTarget: controllerInstalled,
      installedToken: 'TELEAGENT_CONTROL_PLANE_INSTALLED_DISABLED_OK',
    })],
    ['realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway-install', componentSource({
      log,
      label: 'sip',
      sourceToken: 'SIP_GATEWAY_SOURCE_OK',
      installedTarget: sipInstalled,
      installedToken: 'SIP_GATEWAY_INSTALLED_DISABLED_OK',
    })],
    ['deploy/voice-stack/teleagent-voice-stack-install', componentSource({
      log,
      label: 'voice',
      sourceToken: 'VOICE_STACK_SOURCE_OK',
      installedTarget: voiceInstalled,
      installedToken: 'VOICE_STACK_INSTALLED_DISABLED_OK',
    })],
    ['deploy/voice-stack/teleagent-sip-local-peer-fence-install',
      `#!/bin/bash\nset -euo pipefail\n${commandLogger(log, 'fence-source')}\n` +
      '[ "${1:-}" = --source-check ] && [ "$#" -eq 1 ] || exit 77\n' +
      "printf '%s\\n' 'PASS Teleagent SIP fence source is exact and inactive'\n"],
    ['deploy/voice-stack/verify-voice-stack-identity', '# fixture voice verifier\n'],
    ['realtime-sip-gateway/deploy/verify-realtime-sip-gateway', '# fixture SIP verifier\n'],
    ['artifacts/provider-cli/claude', 'fixture claude bytes\n'],
    ['artifacts/provider-cli/codex-vendor', 'fixture codex bytes\n'],
  ]);
  for (const [relative, contents] of sources) {
    writeFile(path.join(releaseRoot, relative), contents, 0o555);
  }

  const nodeProgram = `#!/bin/bash\nset -euo pipefail\n${commandLogger(log, 'node')}\n` +
    'program=${1:-}\nshift || true\nbase=$(/usr/bin/basename -- "$program")\n' +
    'case "$base" in\n' +
    '  verify-voice-stack-identity)\n' +
    '    [ "$*" = --source-check ] || exit 77\n' +
    `    printf '%s\\n' VOICE_STACK_SOURCE_OK ;;\n` +
    '  verify-realtime-sip-gateway)\n' +
    '    [ "$*" = --source-check ] || exit 77\n' +
    `    printf '%s\\n' SIP_GATEWAY_IDENTITY_SOURCE_OK ;;\n` +
    '  teleagent-provider-cli-install)\n' +
    '    case "${1:-}:$#" in --install:5|--check:1) : ;; *) exit 77 ;; esac ;;\n' +
    '  teleagent-provider-cli-check)\n' +
    '    case "$*" in\n' +
    `      '--provider claude') printf '%s\\n' 'PROVIDER_CLI_OK claude' ;;\n` +
    `      '--provider codex') printf '%s\\n' 'PROVIDER_CLI_OK codex' ;;\n` +
    '      *) exit 77 ;;\n' +
    '    esac ;;\n' +
    '  *) exit 77 ;;\n' +
    'esac\n';
  writeFile(path.join(releaseRoot, 'runtime/node/bin/node'), nodeProgram, 0o555);
  writeFile(path.join(releaseRoot, 'teleagent-release.manifest.json'), manifest, 0o444);
  writeFile(path.join(releaseRoot, 'deploy/host/teleagent-disabled-host-install'),
    fs.readFileSync(SOURCE_INSTALLER), 0o555);

  const fenceInstalled = installed('/usr/local/libexec/teleagent-sip-local-peer-fence-install');
  writeFile(fenceInstalled,
    `#!/bin/bash\nset -euo pipefail\n${commandLogger(log, 'fence-installed')}\n` +
    '[ "${1:-}" = --check ] && [ "$#" -eq 1 ] || exit 77\n' +
    "printf '%s\\n' 'PASS Teleagent SIP fence is installed and exact'\n", 0o755);

  for (const stateRoot of [
    'var/lib/teleagent-worker-state',
    'var/lib/teleagent-provider-plane',
    'var/lib/teleagent-control',
    'var/lib/teleagent-privileged-action',
    'var/lib/teleagent-sip-gateway',
    'var/lib/teleagent-voice',
    'srv/teleagent-agent-workspaces',
  ]) mkdir(path.join(root, stateRoot), 0o700);

  const systemctl = path.join(root, 'test-bin/systemctl');
  const transientMarker = path.join(root, 'test-assets/transient-unit-present');
  const fragmentMarker = path.join(root, 'test-assets/fragment-drift');
  const daemonReloadMarker = path.join(root, 'test-assets/daemon-reload-needed');
  const systemctlOversizeMarker = path.join(root, 'test-assets/systemctl-oversized');
  const systemctlTimeoutMarker = path.join(root, 'test-assets/systemctl-timeout');
  const dropInPath = path.join(
    root,
    'etc/systemd/system/teleagent-worker-session.service.d/override.conf',
  );
  writeFile(systemctl,
    `#!/bin/bash\nset -euo pipefail\n${commandLogger(log, 'systemctl')}\n` +
    `if [ "${'${1:-}'}" = list-units ]; then\n` +
    `  [ "$*" = "list-units --all --plain --no-legend teleagent-provider-launch-*.service" ] || exit 77\n` +
    `  if [ -f ${JSON.stringify(transientMarker)} ]; then\n` +
    `    printf '%s\\n' 'teleagent-provider-launch-claude-0123456789abcdef0123456789abcdef.service loaded inactive dead fixture'\n` +
    '  fi\n' +
    '  exit 0\n' +
    'fi\n' +
    '[ "${1:-}" = show ] || exit 77\n' +
    '[ "$#" -eq 3 ] || exit 77\n' +
    '[ "$3" = --property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NeedDaemonReload,DropInPaths ] || exit 77\n' +
    `if [ -f ${JSON.stringify(systemctlTimeoutMarker)} ]; then while /usr/bin/sleep 1; do :; done; fi\n` +
    `if [ -f ${JSON.stringify(systemctlOversizeMarker)} ]; then /usr/bin/printf '%05000d' 0; exit 0; fi\n` +
    'unit=$2\n' +
    `fragment=${JSON.stringify(path.join(root, 'etc/systemd/system'))}/$unit\n` +
    'case "$unit" in\n' +
    `  teleagent-provider-supervisor@*.service) fragment=${JSON.stringify(path.join(root, 'etc/systemd/system/teleagent-provider-supervisor@.service'))} ;;\n` +
    `  teleagent-provider-supervisor@*.socket) fragment=${JSON.stringify(path.join(root, 'etc/systemd/system/teleagent-provider-supervisor@.socket'))} ;;\n` +
    `  teleagent-provider-egress@*.service) fragment=${JSON.stringify(path.join(root, 'etc/systemd/system/teleagent-provider-egress@.service'))} ;;\n` +
    `  teleagent-provider-egress@*.socket) fragment=${JSON.stringify(path.join(root, 'etc/systemd/system/teleagent-provider-egress@.socket'))} ;;\n` +
    `  teleagent-provider-egress-control@*.socket) fragment=${JSON.stringify(path.join(root, 'etc/systemd/system/teleagent-provider-egress-control@.socket'))} ;;\n` +
    'esac\n' +
    `if [ -f ${JSON.stringify(fragmentMarker)} ]; then fragment=/run/systemd/generator/teleagent-drift.service; fi\n` +
    'printf \'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nUnitFileState=static\\n\'\n' +
    'printf \'FragmentPath=%s\\n\' "$fragment"\n' +
    `if [ -f ${JSON.stringify(daemonReloadMarker)} ]; then printf 'NeedDaemonReload=yes\\n'; else printf 'NeedDaemonReload=no\\n'; fi\n` +
    `if [ -f ${JSON.stringify(dropInPath)} ]; then printf 'DropInPaths=%s\\n' ${JSON.stringify(dropInPath)}; else printf 'DropInPaths=\\n'; fi\n`, 0o700);
  const mountpoint = path.join(root, 'test-bin/mountpoint');
  writeFile(mountpoint,
    `#!/bin/bash\nset -euo pipefail\n${commandLogger(log, 'mountpoint')}\n` +
    '[ "${1:-}" = --quiet ] && [ "${2:-}" = -- ] && [ "$#" -eq 3 ] || exit 77\n', 0o700);

  const deviceMap = path.join(root, 'test-assets/device-map');
  writeFile(deviceMap, [
    '/var/lib 100',
    '/srv 101',
    '/var/lib/teleagent-worker-state 201',
    '/var/lib/teleagent-provider-plane 207',
    '/var/lib/teleagent-control 202',
    '/var/lib/teleagent-privileged-action 203',
    '/var/lib/teleagent-sip-gateway 204',
    '/var/lib/teleagent-voice 205',
    '/srv/teleagent-agent-workspaces 206',
    '',
  ].join('\n'), 0o600);

  writeFile(path.join(root, 'proc/sys/kernel/random/boot_id'), `${BOOT_ID}\n`, 0o444);
  fs.symlinkSync(`releases/${releaseId}`, path.join(root, 'opt/teleagent/current'));
  fs.chmodSync(releaseRoot, 0o555);
  const releaseMetadata = fs.statSync(releaseRoot, { bigint: true });
  const gate = `{"version":1,"application":"teleagent","releaseId":"${releaseId}",` +
    `"manifestSha256":"sha256:${digest}","sourceRevision":"${REVISION}",` +
    `"currentTarget":"/opt/teleagent/releases/${releaseId}",` +
    `"releaseDevice":${releaseMetadata.dev},"releaseInode":${releaseMetadata.ino},` +
    `"bootId":"${BOOT_ID}"}\n`;
  mkdir(path.join(root, 'run/teleagent-release-gate'), 0o700);
  writeFile(path.join(root, 'run/teleagent-release-gate/verified.json'), gate, 0o400);
  fs.chmodSync(path.join(root, 'run/teleagent-release-gate'), 0o700);

  const environment = {
    ...process.env,
    TELEAGENT_DISABLED_HOST_INSTALL_TEST_ONLY: '1',
    TELEAGENT_DISABLED_HOST_INSTALL_TEST_ROOT: root,
    TELEAGENT_DISABLED_HOST_INSTALL_TEST_SYSTEMCTL: systemctl,
    TELEAGENT_DISABLED_HOST_INSTALL_TEST_MOUNTPOINT: mountpoint,
    TELEAGENT_DISABLED_HOST_INSTALL_TEST_DEVICE_MAP: deviceMap,
  };
  const entrypoint = path.join(root, 'opt/teleagent/current/deploy/host/teleagent-disabled-host-install');

  return {
    root,
    log,
    releaseRoot,
    environment,
    entrypoint,
    deviceMap,
    transientMarker,
    fragmentMarker,
    daemonReloadMarker,
    systemctlOversizeMarker,
    systemctlTimeoutMarker,
    dropInPath,
    runtimeInPlaceMarker,
    runtimeReplaceMarker,
    installRuntime() {
      for (const target of [
        installed('/opt/teleagent/node/bin/node'),
        installed('/usr/local/libexec/teleagent-node'),
      ]) {
        mkdir(path.dirname(target));
        fs.copyFileSync(path.join(releaseRoot, 'runtime/node/bin/node'), target);
        fs.chmodSync(target, 0o555);
      }
    },
    installComponentFixtures() {
      for (const target of [
        workerInstalled,
        providerInstaller,
        providerChecker,
        controllerInstalled,
        sipInstalled,
        voiceInstalled,
      ]) {
        fs.copyFileSync(`${target}.fixture-template`, target);
        fs.chmodSync(target, 0o755);
      }
    },
    run(mode) {
      return spawnSync('/bin/bash', [entrypoint, mode], {
        encoding: 'utf8',
        env: environment,
        timeout: 120_000,
      });
    },
    lines() {
      return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    },
    clearLog() {
      fs.writeFileSync(log, '');
    },
    setDeviceMap(entries) {
      fs.writeFileSync(deviceMap, `${entries.join('\n')}\n`);
      fs.chmodSync(deviceMap, 0o600);
    },
    cleanup() {
      try { fs.chmodSync(releaseRoot, 0o700); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    },
    installed,
  };
}

function assertSuccess(result, token) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, `${token}\n`);
  assert.equal(result.stderr, '');
}

function assertRefusal(result) {
  assert.equal(result.status, 77, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.doesNotMatch(result.stdout, /TELEAGENT_HOST_.*(?:OK|DISABLED)/u);
}

test('source check consumes the boot gate before installed Node exists', () => {
  const fixture = createFixture();
  try {
    const result = fixture.run('--source-check');
    assertSuccess(result, 'TELEAGENT_HOST_SOURCE_OK');
    assert.deepEqual(fixture.lines().map((line) => line.split('\t')[0]), [
      'worker-source', 'controller-source', 'fence-source', 'node', 'sip-source', 'node',
    ]);
    assert.equal(fs.existsSync(fixture.installed('/opt/teleagent/node/bin/node')), false);
  } finally {
    fixture.cleanup();
  }
});

test('fresh disabled install follows the exact component order and never activates', () => {
  const fixture = createFixture();
  try {
    fixture.installRuntime();
    const result = fixture.run('--install-disabled');
    assertSuccess(result, 'TELEAGENT_HOST_INSTALLED_DISABLED');
    const lines = fixture.lines();
    const actions = lines.filter((line) => !/^(?:mountpoint|systemctl)\t/u.test(line));
    const labels = actions.map((line) => line.split('\t')[0])
      .filter((label) => label !== 'fence-installed');
    assert.deepEqual(labels, [
      'worker-source', 'controller-source', 'fence-source', 'node', 'sip-source', 'node',
      'worker-source', 'worker-installed',
      'node', 'node', 'node',
      'controller-source', 'controller-installed',
      'sip-source', 'sip-installed',
      'voice-source', 'voice-installed',
    ]);
    for (const line of lines.filter((entry) => entry.startsWith('systemctl\t'))) {
      assert.match(line,
        /^systemctl\t(?:show\t[^\t]+\t--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NeedDaemonReload,DropInPaths|list-units\t--all\t--plain\t--no-legend\tteleagent-provider-launch-\*\.service)$/u);
    }
    assert.equal(lines.some((line) => line.startsWith('fence-installed\t--install')), false);
    for (const sentinel of [
      'etc/teleagent/worker-session/ENABLE',
      'etc/teleagent/controller/ENABLE',
      'etc/teleagent/privileged-action/ENABLE',
      'etc/teleagent/realtime-sip-gateway/ENABLE',
    ]) assert.equal(fs.existsSync(path.join(fixture.root, sentinel)), false);
  } finally {
    fixture.cleanup();
  }
});

test('disabled install and installed check are idempotent', () => {
  const fixture = createFixture();
  try {
    fixture.installRuntime();
    assertSuccess(fixture.run('--install-disabled'), 'TELEAGENT_HOST_INSTALLED_DISABLED');
    fixture.clearLog();
    assertSuccess(fixture.run('--install-disabled'), 'TELEAGENT_HOST_INSTALLED_DISABLED');
    fixture.clearLog();
    assertSuccess(fixture.run('--check'), 'TELEAGENT_HOST_INSTALLED_DISABLED_OK');
  } finally {
    fixture.cleanup();
  }
});

test('missing gate and shared workload devices refuse before installation', () => {
  const missing = createFixture();
  try {
    fs.unlinkSync(path.join(missing.root, 'run/teleagent-release-gate/verified.json'));
    assertRefusal(missing.run('--source-check'));
    assert.deepEqual(missing.lines(), []);
  } finally {
    missing.cleanup();
  }

  const shared = createFixture();
  try {
    shared.installRuntime();
    shared.setDeviceMap([
      '/var/lib 100',
      '/srv 101',
      '/var/lib/teleagent-worker-state 201',
      '/var/lib/teleagent-provider-plane 207',
      '/var/lib/teleagent-control 201',
      '/var/lib/teleagent-privileged-action 203',
      '/var/lib/teleagent-sip-gateway 204',
      '/var/lib/teleagent-voice 205',
      '/srv/teleagent-agent-workspaces 206',
    ]);
    const result = shared.run('--install-disabled');
    assertRefusal(result);
    assert.equal(shared.lines().some((line) => line.includes('--install-disabled')), false);
  } finally {
    shared.cleanup();
  }

  for (const [scenario, workspaceDevice] of [
    ['shared-srv-parent', 101],
    ['shared-state-workspace', 201],
  ]) {
    const collision = createFixture();
    try {
      collision.installRuntime();
      collision.setDeviceMap([
        '/var/lib 100',
        '/srv 101',
        '/var/lib/teleagent-worker-state 201',
        '/var/lib/teleagent-provider-plane 207',
        '/var/lib/teleagent-control 202',
        '/var/lib/teleagent-privileged-action 203',
        '/var/lib/teleagent-sip-gateway 204',
        '/var/lib/teleagent-voice 205',
        `/srv/teleagent-agent-workspaces ${workspaceDevice}`,
      ]);
      const result = collision.run('--install-disabled');
      assertRefusal(result);
      assert.equal(collision.lines().some((line) => line.includes('--install-disabled')), false,
        scenario);
    } finally {
      collision.cleanup();
    }
  }

  const providerCollision = createFixture();
  try {
    providerCollision.installRuntime();
    providerCollision.setDeviceMap([
      '/var/lib 100',
      '/srv 101',
      '/var/lib/teleagent-worker-state 201',
      '/var/lib/teleagent-provider-plane 204',
      '/var/lib/teleagent-control 202',
      '/var/lib/teleagent-privileged-action 203',
      '/var/lib/teleagent-sip-gateway 204',
      '/var/lib/teleagent-voice 205',
      '/srv/teleagent-agent-workspaces 206',
    ]);
    const result = providerCollision.run('--install-disabled');
    assertRefusal(result);
    assert.equal(providerCollision.lines()
      .some((line) => line.includes('--install-disabled')), false);
  } finally {
    providerCollision.cleanup();
  }
});

test('runtime and installed-component tampering fail closed', () => {
  const aggregate = createFixture();
  try {
    fs.chmodSync(path.join(aggregate.releaseRoot,
      'deploy/host/teleagent-disabled-host-install'), 0o755);
    assertRefusal(aggregate.run('--source-check'));
    assert.deepEqual(aggregate.lines(), []);
  } finally {
    aggregate.cleanup();
  }

  const runtime = createFixture();
  try {
    runtime.installRuntime();
    const target = runtime.installed('/usr/local/libexec/teleagent-node');
    fs.chmodSync(target, 0o755);
    fs.appendFileSync(target, '# tampered\n');
    fs.chmodSync(target, 0o555);
    assertRefusal(runtime.run('--install-disabled'));
    assert.equal(runtime.lines().some((line) => line.includes('--install-disabled')), false);
  } finally {
    runtime.cleanup();
  }

  for (const markerName of ['runtimeInPlaceMarker', 'runtimeReplaceMarker']) {
    const duringHandoff = createFixture();
    try {
      duringHandoff.installRuntime();
      writeFile(duringHandoff[markerName], '', 0o600);
      assertRefusal(duringHandoff.run('--install-disabled'));
      const lines = duringHandoff.lines();
      assert.equal(lines.some((line) => line === 'worker-source\t--install-disabled'), true);
      assert.equal(lines.some((line) => /teleagent-provider-cli-install/u.test(line)), false);
    } finally {
      duringHandoff.cleanup();
    }
  }

  const component = createFixture();
  try {
    component.installRuntime();
    assertSuccess(component.run('--install-disabled'), 'TELEAGENT_HOST_INSTALLED_DISABLED');
    const worker = component.installed('/usr/local/libexec/teleagent-worker-session-install');
    writeFile(worker, '#!/bin/bash\nprintf \'WRONG\\n\'\n', 0o755);
    assertRefusal(component.run('--check'));
  } finally {
    component.cleanup();
  }
});

test('runtime bytes are compared only at entry and final with exact intermediate fingerprints', () => {
  const installer = fs.readFileSync(SOURCE_INSTALLER, 'utf8');
  assert.equal((installer.match(/^  assert_installed_runtimes_full(?: 1)?$/gmu) ?? []).length, 2);
  assert.equal((installer.match(/\/usr\/bin\/cmp -s -- "\$release_node" "\$target"/gu) ?? [])
    .length, 1);
  assert.match(installer, /'%d\|%i\|%s\|%u\|%g\|%a\|%h\|%y\|%z'/u);
  const guard = /mutation_guard\(\) \{([\s\S]*?)\n\}/u.exec(installer)?.[1] ?? '';
  assert.match(guard, /assert_runtime_fingerprints_unchanged/u);
  assert.doesNotMatch(guard, /assert_installed_runtimes_full/u);
});

test('an activation sentinel refuses both install and check', () => {
  const fixture = createFixture();
  try {
    fixture.installRuntime();
    const sentinel = path.join(fixture.root, 'etc/teleagent/controller/ENABLE');
    writeFile(sentinel, '', 0o600);
    assertRefusal(fixture.run('--install-disabled'));
    assert.equal(fixture.lines().some((line) => line.includes('--install-disabled')), false);
  } finally {
    fixture.cleanup();
  }
});

test('a transient provider launch refuses final dormant truth', () => {
  const fixture = createFixture();
  try {
    fixture.installRuntime();
    fixture.installComponentFixtures();
    writeFile(fixture.transientMarker, '', 0o600);
    assertRefusal(fixture.run('--check'));
    assert.equal(fixture.lines().some((line) =>
      line.startsWith('systemctl\tlist-units\t--all\t--plain\t--no-legend\t' +
        'teleagent-provider-launch-*.service')), true);
  } finally {
    fixture.cleanup();
  }
});

test('drop-in, fragment, and pending daemon reload drift refuse final dormant truth', () => {
  for (const scenario of ['drop-in', 'fragment', 'daemon-reload']) {
    const fixture = createFixture();
    try {
      fixture.installRuntime();
      fixture.installComponentFixtures();
      if (scenario === 'drop-in') writeFile(fixture.dropInPath, '[Service]\nEnvironment=DRIFT=1\n', 0o644);
      if (scenario === 'fragment') writeFile(fixture.fragmentMarker, '', 0o600);
      if (scenario === 'daemon-reload') writeFile(fixture.daemonReloadMarker, '', 0o600);
      assertRefusal(fixture.run('--check'));
      assert.equal(fixture.lines().some((line) =>
        line.startsWith('systemctl\tshow\tteleagent-worker-session.service\t' +
          '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,' +
          'NeedDaemonReload,DropInPaths')), true);
    } finally {
      fixture.cleanup();
    }
  }
});

test('dormant systemd truth is time- and output-bounded', () => {
  for (const [markerName, message] of [
    ['systemctlOversizeMarker', /exceeded its output limit/u],
    ['systemctlTimeoutMarker', /metadata query failed/u],
  ]) {
    const fixture = createFixture();
    try {
      fixture.installRuntime();
      fixture.installComponentFixtures();
      writeFile(fixture[markerName], '', 0o600);
      const started = Date.now();
      const result = fixture.run('--check');
      assertRefusal(result);
      assert.match(result.stderr, message);
      assert.ok(Date.now() - started < 15_000, markerName);
    } finally {
      fixture.cleanup();
    }
  }
});
