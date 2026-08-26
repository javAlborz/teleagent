'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  REVIEWED_ASSETS,
  inspectPath,
  inspectSourceAsset,
  resolveSourceBundle,
  sourceCheck,
  validateIdentityRecords,
} = require('../../deploy/voice-stack/verify-voice-stack-identity');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'voice-stack');
const VOICE_INSTALLER = path.join(DEPLOY, 'teleagent-voice-stack-install');
const RELEASE_START_GATE = 'ExecStartPre=+/usr/bin/env -i HOME=/var/empty ' +
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 ' +
  '/usr/local/libexec/verify-teleagent-release-closure --check-start-gate';

function voiceInstallerFixture(t) {
  const directory = fs.mkdtempSync('/tmp/teleagent-voice-install-test-');
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const systemd = path.join(directory, 'etc/systemd/system');
  const libexec = path.join(directory, 'usr/local/libexec');
  const runtimeRoot = path.join(directory, 'run/teleagent-voice-stack');
  fs.mkdirSync(systemd, { recursive: true, mode: 0o755 });
  fs.mkdirSync(libexec, { recursive: true, mode: 0o755 });
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeRoot, 0o700);
  for (const unit of ['teleagent-voice-stack.service', 'teleagent-voice-containers.slice']) {
    fs.writeFileSync(path.join(systemd, unit), '[Unit]\n', { mode: 0o644 });
  }
  const calls = path.join(directory, 'systemctl.calls');
  const systemctl = path.join(directory, 'systemctl');
  fs.writeFileSync(systemctl, [
    '#!/bin/bash',
    'set -euo pipefail',
    'printf \'%s\\n\' "$*" >>"$FAKE_SYSTEMCTL_LOG"',
    '[ "${1:-}" = show ] && [ "$#" -eq 3 ] || exit 64',
    'unit=$2',
    'root=$TELEAGENT_VOICE_INSTALL_TEST_ROOT',
    '[ "${FAKE_QUERY_FAILURE:-}" != "$unit" ] || exit 70',
    'service_properties=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NeedDaemonReload,DropInPaths,User,Group',
    'slice_properties=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NeedDaemonReload,DropInPaths',
    'case "$unit:$3" in',
    '  teleagent-voice-stack.service:--property=$service_properties) kind=service ;;',
    '  teleagent-voice-containers.slice:--property=$slice_properties) kind=slice ;;',
    '  *) exit 64 ;;',
    'esac',
    'active=inactive; sub=dead; fragment="$root/etc/systemd/system/$unit"',
    'reload=no; dropins=; user=root; group=root',
    '[ "${FAKE_TRANSITIONAL_UNIT:-}" != "$unit" ] || { active=activating; sub=start-pre; }',
    '[ "${FAKE_FRAGMENT_UNIT:-}" != "$unit" ] || fragment="/run/systemd/generator/$unit"',
    '[ "${FAKE_RUNTIME_FRAGMENT_UNIT:-}" != "$unit" ] || fragment="/run/systemd/transient/$unit"',
    '[ "${FAKE_RELOAD_UNIT:-}" != "$unit" ] || reload=yes',
    '[ "${FAKE_DROPIN_UNIT:-}" != "$unit" ] || dropins="/run/systemd/system/$unit.d/override.conf"',
    '[ "${FAKE_WRONG_USER_UNIT:-}" != "$unit" ] || user=teleagent-voice',
    '[ "${FAKE_WRONG_GROUP_UNIT:-}" != "$unit" ] || group=teleagent-voice',
    'if [ "${FAKE_OVERSIZED_UNIT:-}" = "$unit" ]; then',
    '  /usr/bin/printf \'%05000d\' 0',
    '  exit 0',
    'fi',
    'if [ "${FAKE_UNFRAMED_UNIT:-}" = "$unit" ]; then',
    '  printf \'LoadState=loaded\\nActiveState=%s\\nSubState=%s\\nUnitFileState=static\\n\' "$active" "$sub"',
    '  if [ "$kind" = service ]; then',
    '    printf \'FragmentPath=%s\\nNeedDaemonReload=%s\\nDropInPaths=%s\\nUser=%s\\nGroup=%s\' "$fragment" "$reload" "$dropins" "$user" "$group"',
    '  else',
    '    printf \'FragmentPath=%s\\nNeedDaemonReload=%s\\nDropInPaths=%s\' "$fragment" "$reload" "$dropins"',
    '  fi',
    '  exit 0',
    'fi',
    'if [ "${FAKE_CONTROL_BYTE_UNIT:-}" = "$unit" ]; then',
    '  printf \'LoadState=loaded\\nActiveState=%s\\nSubState=%s\\nUnitFileState=static\\n\' "$active" "$sub"',
    '  printf \'FragmentPath=%s\\nNeedDaemonReload=%s\\nDropInPaths=\\001\\n\' "$fragment" "$reload"',
    '  [ "$kind" != service ] || printf \'User=%s\\nGroup=%s\\n\' "$user" "$group"',
    '  exit 0',
    'fi',
    'printf \'LoadState=loaded\\nActiveState=%s\\nSubState=%s\\nUnitFileState=static\\n\' "$active" "$sub"',
    'printf \'FragmentPath=%s\\nNeedDaemonReload=%s\\nDropInPaths=%s\\n\' "$fragment" "$reload" "$dropins"',
    'if [ "$kind" = service ]; then',
    '  printf \'User=%s\\n\' "$user"',
    '  [ "${FAKE_MISSING_UNIT:-}" = "$unit" ] || printf \'Group=%s\\n\' "$group"',
    'fi',
    '[ "${FAKE_DUPLICATE_UNIT:-}" != "$unit" ] || printf \'LoadState=loaded\\n\'',
    '[ "${FAKE_MALFORMED_UNIT:-}" != "$unit" ] || printf \'Unexpected=value\\n\'',
    '',
  ].join('\n'), { mode: 0o700 });
  fs.chmodSync(systemctl, 0o700);
  const verifier = path.join(libexec, 'verify-voice-stack-identity');
  fs.writeFileSync(verifier, [
    '#!/bin/bash',
    'set -euo pipefail',
    '[ "$*" = --installed-check ]',
    'touch "$TELEAGENT_VOICE_INSTALL_TEST_ROOT/verifier-observed"',
    'printf \'VOICE_STACK_IDENTITY_OK\\n\'',
    '',
  ].join('\n'), { mode: 0o700 });
  fs.chmodSync(verifier, 0o700);
  const dockerCalls = path.join(directory, 'docker.calls');
  const dockerState = path.join(directory, 'docker.state');
  const docker = path.join(directory, 'docker');
  fs.writeFileSync(docker, [
    '#!/bin/bash',
    'set -euo pipefail',
    'printf \'%s\\n\' "$*" >>"$FAKE_DOCKER_LOG"',
    'if [ "$*" = "container ls --all --no-trunc --quiet --filter label=com.docker.compose.project=teleagent-voice" ]; then',
    '  [ "${FAKE_DOCKER_LIST_FAILURE:-0}" = 0 ] || exit 70',
    '  if [ "${FAKE_DOCKER_OVERSIZED:-0}" = 1 ]; then /usr/bin/printf \'%09000d\' 0; exit 0; fi',
    '  if [ "${FAKE_DOCKER_INVALID:-0}" = 1 ]; then printf \'not-a-container-id\\n\'; exit 0; fi',
    '  [ -s "$FAKE_DOCKER_STATE" ] && /usr/bin/cat -- "$FAKE_DOCKER_STATE" || true',
    '  exit 0',
    'fi',
    '[ "${1:-} ${2:-} ${3:-}" = "container rm --force" ] || exit 64',
    '[ "${FAKE_DOCKER_REMOVE_FAILURE:-0}" = 0 ] || exit 71',
    'shift 3',
    '[ "$#" -ge 1 ] || exit 64',
    'for identifier in "$@"; do /usr/bin/grep -Fqx -- "$identifier" "$FAKE_DOCKER_STATE" || exit 64; done',
    'printf \'%s\\n\' "$@"',
    '[ "${FAKE_DOCKER_KEEP_AFTER_REMOVE:-0}" = 0 ] || exit 0',
    ': >"$FAKE_DOCKER_STATE"',
    '',
  ].join('\n'), { mode: 0o700 });
  fs.chmodSync(docker, 0o700);
  const environment = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TELEAGENT_VOICE_INSTALL_TEST_ONLY: '1',
    TELEAGENT_VOICE_INSTALL_TEST_ROOT: directory,
    TELEAGENT_VOICE_INSTALL_TEST_SYSTEMCTL: systemctl,
    FAKE_SYSTEMCTL_LOG: calls,
  };
  return {
    calls,
    directory,
    dockerCalls,
    dockerState,
    runtimeRoot,
    run: (additions = {}) => spawnSync(VOICE_INSTALLER, ['--check'], {
      cwd: '/',
      encoding: 'utf8',
      env: { ...environment, ...additions },
      timeout: 10_000,
    }),
    runEmergency: (additions = {}) => spawnSync(VOICE_INSTALLER, ['--emergency-cleanup'], {
      cwd: '/',
      encoding: 'utf8',
      env: {
        ...environment,
        TELEAGENT_VOICE_INSTALL_TEST_DOCKER: docker,
        FAKE_DOCKER_LOG: dockerCalls,
        FAKE_DOCKER_STATE: dockerState,
        ...additions,
      },
      timeout: 25_000,
    }),
  };
}

function identityFixture({
  voiceUser = 'teleagent-voice:x:991:991:Teleagent:/var/lib/teleagent-voice:/usr/sbin/nologin',
  voiceGroup = 'teleagent-voice:x:991:',
  extraPasswd = [],
  extraGroups = [],
} = {}) {
  return {
    passwd: [
      'root:x:0:0:root:/root:/bin/bash',
      voiceUser,
      'teleagent-control:x:992:992:Control:/var/lib/teleagent-control:/usr/sbin/nologin',
      ...extraPasswd,
      '',
    ].join('\n'),
    group: [
      'root:x:0:',
      voiceGroup,
      'teleagent-control:x:992:',
      ...extraGroups,
      '',
    ].join('\n'),
  };
}

test('voice deployment source is dormant and contains only the reviewed identity topology', () => {
  assert.equal(sourceCheck(DEPLOY, {
    sourceUid: process.getuid(),
    sourceGid: process.getgid(),
  }), true);
  const unit = fs.readFileSync(path.join(DEPLOY, 'teleagent-voice-stack.service'), 'utf8');
  assert.equal(unit.split('\n').filter((line) => line === RELEASE_START_GATE).length, 1);
  assert.equal((unit.match(/verify-teleagent-release-closure/gu) ?? []).length, 1);
  assert.equal(unit.split('\n').filter((line) => /^ExecStart(?:Pre)?=/u.test(line))[0],
    RELEASE_START_GATE);
  assert.doesNotMatch(unit, /^ExecCondition=|^ExecReload=/m);
  assert.match(unit,
    /^ExecStartPre=\/usr\/local\/libexec\/verify-voice-stack-identity --installed-check$/m);
  assert.match(unit,
    /^ExecStopPost=\/usr\/local\/libexec\/teleagent-voice-stack-install --emergency-cleanup$/m);
  assert.doesNotMatch(unit, /^\[Install\]$/m);
  assert.doesNotMatch(unit, /^Environment=.*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)=/mi);
});

test('voice source assets accept only installed or immutable read-only modes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-source-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source-asset');
  fs.writeFileSync(source, 'reviewed\n', { mode: 0o644 });
  const metadata = fs.statSync(source);
  const expected = { uid: metadata.uid, gid: metadata.gid };

  for (const [targetMode, acceptedModes] of [
    [0o644, [0o644, 0o444]],
    [0o755, [0o755, 0o555]],
  ]) {
    for (const acceptedMode of acceptedModes) {
      fs.chmodSync(source, acceptedMode);
      assert.doesNotThrow(() => inspectSourceAsset(source, {
        ...expected,
        mode: targetMode,
      }));
    }
  }

  for (const [targetMode, rejectedMode] of [
    [0o644, 0o600],
    [0o644, 0o640],
    [0o644, 0o440],
    [0o644, 0o755],
    [0o755, 0o700],
    [0o755, 0o750],
    [0o755, 0o775],
    [0o755, 0o4755],
    [0o755, 0o644],
  ]) {
    fs.chmodSync(source, rejectedMode);
    assert.throws(() => inspectSourceAsset(source, {
      ...expected,
      mode: targetMode,
    }), /unsafe metadata/);
  }
  assert.throws(() => inspectSourceAsset(source, {
    ...expected,
    mode: 0o700,
  }), /unsupported target mode/);
  fs.chmodSync(source, 0o644);
  assert.throws(() => inspectSourceAsset(source, {
    uid: metadata.uid + 1,
    gid: metadata.gid,
    mode: 0o644,
  }), /unsafe metadata/);

  const hardlink = path.join(directory, 'hardlink');
  fs.linkSync(source, hardlink);
  assert.throws(() => inspectSourceAsset(source, {
    ...expected,
    mode: 0o644,
  }), /unsafe metadata/);
});

test('voice source check resolves current once to one stable immutable release', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-release-symlink-'));
  const releaseParent = path.join(directory, 'releases');
  const releaseIds = [
    `sha256-${'a'.repeat(64)}`,
    `sha256-${'b'.repeat(64)}`,
  ];
  const releaseRoots = releaseIds.map((id) => path.join(releaseParent, id));
  const voiceRoots = [];
  fs.mkdirSync(releaseParent, { recursive: true, mode: 0o755 });
  for (const releaseRoot of releaseRoots) {
    const voiceRoot = path.join(releaseRoot, 'deploy', 'voice-stack');
    fs.mkdirSync(voiceRoot, { recursive: true, mode: 0o755 });
    for (const [sourceName, , mode] of REVIEWED_ASSETS) {
      fs.copyFileSync(path.join(DEPLOY, sourceName), path.join(voiceRoot, sourceName));
      fs.chmodSync(path.join(voiceRoot, sourceName), mode & 0o555);
    }
    fs.copyFileSync(
      path.join(ROOT, 'docker-compose.yml'),
      path.join(releaseRoot, 'docker-compose.yml'),
    );
    fs.chmodSync(path.join(releaseRoot, 'docker-compose.yml'), 0o444);
    fs.chmodSync(voiceRoot, 0o555);
    fs.chmodSync(path.join(releaseRoot, 'deploy'), 0o555);
    fs.chmodSync(releaseRoot, 0o555);
    voiceRoots.push(voiceRoot);
  }
  t.after(() => {
    for (const releaseRoot of releaseRoots) {
      fs.chmodSync(releaseRoot, 0o755);
      fs.chmodSync(path.join(releaseRoot, 'deploy'), 0o755);
      fs.chmodSync(path.join(releaseRoot, 'deploy', 'voice-stack'), 0o755);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const current = path.join(directory, 'current');
  fs.symlinkSync(releaseRoots[0], current);
  const sourceRoot = path.join(current, 'deploy', 'voice-stack');
  const identity = { sourceUid: process.getuid(), sourceGid: process.getgid() };
  const resolved = resolveSourceBundle(sourceRoot, { releaseParent, ...identity });
  assert.deepEqual(resolved, {
    sourceRoot: voiceRoots[0],
    verifierPath: path.join(voiceRoots[0], 'verify-voice-stack-identity'),
    releaseRoot: releaseRoots[0],
  });
  assert.equal(sourceCheck(resolved.sourceRoot, identity), true);

  fs.unlinkSync(current);
  fs.symlinkSync(releaseRoots[0], current);
  let switched = false;
  assert.throws(() => resolveSourceBundle(sourceRoot, {
    releaseParent,
    ...identity,
    realpath: (filename) => {
      const result = fs.realpathSync(filename);
      if (filename === sourceRoot && !switched) {
        switched = true;
        fs.unlinkSync(current);
        fs.symlinkSync(releaseRoots[1], current);
      }
      return result;
    },
  }), /changed or resolved outside/);

  fs.unlinkSync(current);
  const chained = path.join(directory, 'chained-release');
  fs.symlinkSync(releaseRoots[0], chained);
  fs.symlinkSync(chained, current);
  assert.throws(() => resolveSourceBundle(sourceRoot, {
    releaseParent,
    ...identity,
  }), /changed or resolved outside/);
});

test('voice identity accepts one private nologin account with no ID reuse or supplementary group', () => {
  const fixture = identityFixture();
  assert.deepEqual(validateIdentityRecords(fixture.passwd, fixture.group), { uid: 991, gid: 991 });
});

test('voice identity rejects duplicate, reused, login-capable, and supplementary identities', () => {
  const invalid = [
    identityFixture({ extraPasswd: [
      'teleagent-voice:x:993:993:Duplicate:/var/lib/teleagent-voice:/usr/sbin/nologin',
    ] }),
    identityFixture({ extraPasswd: [
      'intruder:x:991:993:Reuse:/nonexistent:/usr/sbin/nologin',
    ] }),
    identityFixture({ extraPasswd: [
      'intruder:x:993:991:Reuse:/nonexistent:/usr/sbin/nologin',
    ] }),
    identityFixture({ extraGroups: ['intruder:x:991:'] }),
    identityFixture({ extraGroups: ['docker:x:999:teleagent-voice'] }),
    identityFixture({
      voiceUser: 'teleagent-voice:x:991:991:Teleagent:/var/lib/teleagent-voice:/bin/bash',
    }),
    identityFixture({
      voiceUser: 'teleagent-voice:x:991:991:Teleagent:/home/teleagent-voice:/usr/sbin/nologin',
    }),
    identityFixture({ voiceGroup: 'teleagent-voice:x:991:teleagent-voice' }),
  ];
  for (const fixture of invalid) {
    assert.throws(() => validateIdentityRecords(fixture.passwd, fixture.group),
      /Voice identity verification refused/);
  }
});

test('metadata verifier rejects symlink, hardlink, and mode substitution', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-identity-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const regular = path.join(directory, 'reviewed');
  const linked = path.join(directory, 'linked');
  const symlink = path.join(directory, 'symlink');
  fs.writeFileSync(regular, 'reviewed\n', { mode: 0o600 });
  const metadata = fs.statSync(regular);
  assert.doesNotThrow(() => inspectPath(regular, {
    type: 'file', uid: metadata.uid, gid: metadata.gid, mode: 0o600, nlink: 1,
  }));
  fs.chmodSync(regular, 0o620);
  assert.throws(() => inspectPath(regular, {
    type: 'file', uid: metadata.uid, gid: metadata.gid, mode: 0o600, nlink: 1,
  }), /unsafe metadata/);
  fs.chmodSync(regular, 0o600);
  fs.linkSync(regular, linked);
  assert.throws(() => inspectPath(regular, {
    type: 'file', uid: metadata.uid, gid: metadata.gid, mode: 0o600, nlink: 1,
  }), /unsafe metadata/);
  fs.symlinkSync(regular, symlink);
  assert.throws(() => inspectPath(symlink, {
    type: 'file', uid: metadata.uid, gid: metadata.gid, mode: 0o600, nlink: 1,
  }), /unsafe metadata/);
});

test('voice installer can only install or check a disabled stack and never provisions secrets', () => {
  const installer = fs.readFileSync(path.join(DEPLOY, 'teleagent-voice-stack-install'), 'utf8');
  assert.match(installer, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\nexport PATH$/m);
  assert.match(installer, /^umask 077$/m);
  const scrubbed = new Set((/^unset ([\s\S]*?)\numask 077$/mu.exec(installer)?.[1] ?? '')
    .replaceAll('\\\n', ' ')
    .trim()
    .split(/\s+/u));
  for (const variable of [
    'ENV', 'BASH_ENV', 'CDPATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
    'GCONV_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY', 'PYTHONPATH', 'PERL5LIB',
    'RUBYOPT', 'SSLKEYLOGFILE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY',
    'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'no_proxy', 'OPENAI_API_KEY', 'OPENAI_WEBHOOK_SECRET', 'SIP_PBX_AUTH_SECRET',
    'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'CLAUDE_API_TOKEN', 'CODEX_API_KEY',
    'API_KEY', 'API_TOKEN', 'AUTH_TOKEN', 'ACCESS_TOKEN', 'PROVIDER_TOKEN',
    'PROVIDER_SECRET', 'OPENAI_API_KEY_FILE', 'OPENAI_WEBHOOK_SECRET_FILE',
    'SIP_PBX_AUTH_SECRET_FILE',
  ]) assert.equal(scrubbed.has(variable), true, variable);
  assert.equal(scrubbed.has('TELEAGENT_VOICE_INSTALL_TEST_ONLY'), false);
  assert.equal(scrubbed.has('FAKE_SYSTEMCTL_LOG'), false);
  assert.match(installer, /--source-check\|--install-disabled\|--check\|--emergency-cleanup/);
  assert.match(installer, /systemd-sysusers/);
  assert.match(installer, /systemd-tmpfiles/);
  assert.match(installer, /^slice_unit=teleagent-voice-containers\.slice$/m);
  assert.doesNotMatch(installer, /is-active --quiet/);
  assert.match(installer, /^service_unit_properties=.*FragmentPath,NeedDaemonReload,DropInPaths,User,Group$/m);
  assert.match(installer, /^slice_unit_properties=.*FragmentPath,NeedDaemonReload,DropInPaths$/m);
  assert.match(installer, /assert_unit_truth "\$unit" "\$target_unit" service installed/);
  assert.match(installer, /assert_unit_truth "\$slice_unit" "\$target_slice" slice installed/);
  assert.match(installer, /\/usr\/bin\/timeout --signal=TERM --kill-after=1s 5s/);
  assert.match(installer,
    /\/usr\/bin\/env -i HOME=\/var\/empty PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.match(installer, /response has unsafe framing/);
  assert.match(installer, /not-found:pre\)/);
  assert.match(installer, /loaded:pre\|loaded:installed/);
  assert.match(installer, /inactive:dead/);
  assert.match(installer, /\[ "\$unit_file_state" = static \]/);
  assert.match(installer,
    /an absent voice unit conflicts with an installed unit file/);
  assert.match(installer, /assert_slice_inactive_or_absent/);
  assert.match(installer, /assert_slice_installed_dormant/);
  assert.doesNotMatch(installer, /is-enabled(?:\s|$)/);
  assert.doesNotMatch(installer, /"\$systemctl_bin"\s+(?:start|enable|restart)\b/);
  assert.match(installer, /capture_docker 'voice project enumeration'/);
  assert.match(installer, /container rm --force/);
  assert.match(installer, /label=com\.docker\.compose\.project=teleagent-voice/);
  assert.match(installer, /emergency cleanup requires the fixed host-owned entrypoint/);
  const installBody = /install_disabled\(\) \{([\s\S]*?)\n\}/u.exec(installer)?.[1] ?? '';
  const checkBody = /check_installed\(\) \{([\s\S]*?)\n\}/u.exec(installer)?.[1] ?? '';
  assert.doesNotMatch(installBody, /capture_docker|container (?:ls|rm)/u);
  assert.doesNotMatch(checkBody, /capture_docker|container (?:ls|rm)/u);
  assert.doesNotMatch(installer, /\/etc\/teleagent-voice\/credentials\//);
  assert.doesNotMatch(installer, /activation-state\.json/);
  assert.doesNotMatch(installer, /\/var\/lib\/teleagent-voice-stack\/(?:\*|[^'" ]+)/);
  assert.doesNotMatch(installer, /(?:generate|rotate).*(?:secret|credential|key)/i);
  assert.match(installer, /644\) immutable_mode=444/);
  assert.match(installer, /755\) immutable_mode=555/);
  assert.match(installer, /"0:0:\$\{mode\}:1"\|"0:0:\$\{immutable_mode\}:1"/);
  assert.match(installer, /rollback\(\)/);
});

test('voice installed check rejects stale loaded service and slice policy before identity check',
  (t) => {
    if (process.getuid() === 0) return t.skip('the isolated installer lane rejects root');
    const healthy = voiceInstallerFixture(t);
    let result = healthy.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'VOICE_STACK_INSTALLED_DISABLED_OK\n');
    assert.equal(fs.existsSync(path.join(healthy.directory, 'verifier-observed')), true);
    const calls = fs.readFileSync(healthy.calls, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.equal(calls.every((line) => /^show teleagent-voice-(?:stack\.service|containers\.slice) --property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NeedDaemonReload,DropInPaths(?:,User,Group)?$/u
      .test(line)), true);

    for (const [variable, unit] of [
      ['FAKE_TRANSITIONAL_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_FRAGMENT_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_FRAGMENT_UNIT', 'teleagent-voice-containers.slice'],
      ['FAKE_RUNTIME_FRAGMENT_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_DROPIN_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_DROPIN_UNIT', 'teleagent-voice-containers.slice'],
      ['FAKE_RELOAD_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_RELOAD_UNIT', 'teleagent-voice-containers.slice'],
      ['FAKE_WRONG_USER_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_WRONG_GROUP_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_MALFORMED_UNIT', 'teleagent-voice-containers.slice'],
      ['FAKE_DUPLICATE_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_MISSING_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_UNFRAMED_UNIT', 'teleagent-voice-containers.slice'],
      ['FAKE_CONTROL_BYTE_UNIT', 'teleagent-voice-stack.service'],
      ['FAKE_OVERSIZED_UNIT', 'teleagent-voice-containers.slice'],
    ]) {
      const drifted = voiceInstallerFixture(t);
      result = drifted.run({ [variable]: unit });
      assert.equal(result.status, 77, `${variable}:${unit} ${result.stderr}`);
      assert.equal(fs.existsSync(path.join(drifted.directory, 'verifier-observed')), false);
    }
  });

test('host-owned emergency cleanup is exact, bounded, and independent of release Node', (t) => {
  if (process.getuid() === 0) return t.skip('the isolated installer lane rejects root');
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const prepare = (fixture) => {
    fs.writeFileSync(fixture.dockerState, `${first}\n${second}\n`, { mode: 0o600 });
    for (const directory of ['voice-secrets', 'voice-secrets.new-123']) {
      const target = path.join(fixture.runtimeRoot, directory);
      fs.mkdirSync(target, { mode: 0o700 });
      fs.writeFileSync(path.join(target, 'secret'), 'not-a-real-secret\n', { mode: 0o600 });
    }
    for (const filename of [
      'drachtio.conf.xml',
      'drachtio.conf.xml.new-123',
      'freeswitch-event-socket.conf.xml',
      'freeswitch-event-socket.conf.xml.new-123',
    ]) fs.writeFileSync(path.join(fixture.runtimeRoot, filename), 'fixture\n', { mode: 0o600 });
  };

  const healthy = voiceInstallerFixture(t);
  prepare(healthy);
  let result = healthy.runEmergency();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'VOICE_STACK_EMERGENCY_CLEANUP_OK\n');
  assert.equal(fs.readFileSync(healthy.dockerState, 'utf8'), '');
  assert.deepEqual(
    fs.readdirSync(healthy.runtimeRoot).filter((name) =>
      name.startsWith('voice-secrets') || name.includes('.conf.xml')),
    [],
  );
  assert.deepEqual(fs.readFileSync(healthy.dockerCalls, 'utf8').trim().split('\n'), [
    'container ls --all --no-trunc --quiet --filter label=com.docker.compose.project=teleagent-voice',
    `container rm --force ${first} ${second}`,
    'container ls --all --no-trunc --quiet --filter label=com.docker.compose.project=teleagent-voice',
  ]);

  for (const [environment, message] of [
    [{ FAKE_DOCKER_INVALID: '1' }, /invalid container identity/u],
    [{ FAKE_DOCKER_OVERSIZED: '1' }, /exceeded its fixed byte bound/u],
    [{ FAKE_DOCKER_LIST_FAILURE: '1' }, /failed or timed out/u],
    [{ FAKE_DOCKER_REMOVE_FAILURE: '1' }, /failed or timed out/u],
    [{ FAKE_DOCKER_KEEP_AFTER_REMOVE: '1' }, /could not prove the voice project quiescent/u],
  ]) {
    const refused = voiceInstallerFixture(t);
    prepare(refused);
    result = refused.runEmergency(environment);
    assert.equal(result.status, 77, `${JSON.stringify(environment)} ${result.stderr}`);
    assert.match(result.stderr, message);
    assert.equal(fs.existsSync(path.join(refused.runtimeRoot, 'voice-secrets/secret')), true);
  }
});

test('SIP fence atomically reconciles, detects drift, and removes through a non-root fake nft', (t) => {
  if (process.getuid() === 0) {
    t.skip('the production helper deliberately forbids its fake nft lane for root');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-fence-fake-nft-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fakeNft = path.join(directory, 'nft');
  const state = path.join(directory, 'state');
  const capture = path.join(directory, 'capture');
  const lock = path.join(directory, 'operation.lock');
  fs.writeFileSync(fakeNft, `#!/bin/bash
set -euo pipefail
if [[ "$*" == "-nnnnn list table inet teleagent_sip_local_peer_fence" ]]; then
  [[ -f "$FAKE_NFT_STATE" ]] || exit 1
  /bin/cat "$FAKE_NFT_STATE"
  exit 0
fi
[[ "$*" == "-f -" ]] || exit 64
input=$(/bin/cat)
/usr/bin/printf '%s\\n---BATCH---\\n' "$input" >>"$FAKE_NFT_CAPTURE"
if /usr/bin/grep -q '^add table inet teleagent_sip_local_peer_fence$' <<<"$input"; then
  /usr/bin/printf '%s\\n' \\
    'table inet teleagent_sip_local_peer_fence {' \\
    'chain output {' \\
    'type filter hook output priority -200; policy accept;' \\
    'ip daddr 127.0.0.1 udp dport 5060 meta skuid != 0 reject with icmp 3 comment "teleagent-voice-only"' \\
    'ip daddr 127.0.0.1 udp dport 5070 meta skuid != 0 reject with icmp 3 comment "teleagent-pbx-only"' \\
    '}' '}' >"$FAKE_NFT_STATE"
else
  /bin/rm -f "$FAKE_NFT_STATE"
fi
`, { mode: 0o700 });
  const helper = path.join(DEPLOY, 'teleagent-sip-local-peer-fence');
  const environment = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C',
    TELEAGENT_SIP_FENCE_TEST_ONLY: '1',
    TELEAGENT_SIP_FENCE_TEST_NFT: fakeNft,
    TELEAGENT_SIP_FENCE_TEST_LOCK: lock,
    FAKE_NFT_STATE: state,
    FAKE_NFT_CAPTURE: capture,
  };
  const run = (action) => spawnSync(helper, [action], { env: environment, encoding: 'utf8' });
  assert.equal(run('reconcile').status, 0);
  assert.equal(run('check').status, 0);
  const firstBatch = fs.readFileSync(capture, 'utf8');
  assert.match(firstBatch, /^add table inet teleagent_sip_local_peer_fence/m);
  assert.doesNotMatch(firstBatch, /^delete table/m);

  fs.writeFileSync(state, 'table inet teleagent_sip_local_peer_fence { drifted }\n');
  assert.notEqual(run('check').status, 0);
  assert.equal(run('reconcile').status, 0);
  const repairedBatches = fs.readFileSync(capture, 'utf8');
  assert.match(repairedBatches,
    /delete table inet teleagent_sip_local_peer_fence[\s\S]*add table inet teleagent_sip_local_peer_fence/);
  assert.equal(run('check').status, 0);
  assert.equal(run('remove').status, 0);
  assert.equal(fs.existsSync(state), false);
  assert.notEqual(run('check').status, 0);
});
