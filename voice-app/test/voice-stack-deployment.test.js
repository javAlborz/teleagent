'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  inspectPath,
  sourceCheck,
  validateIdentityRecords,
} = require('../../deploy/voice-stack/verify-voice-stack-identity');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'voice-stack');

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
  assert.equal(sourceCheck(DEPLOY), true);
  const unit = fs.readFileSync(path.join(DEPLOY, 'teleagent-voice-stack.service'), 'utf8');
  assert.match(unit,
    /^ExecStartPre=\/usr\/local\/libexec\/verify-voice-stack-identity --installed-check$/m);
  assert.match(unit,
    /^ExecStopPost=\/usr\/local\/libexec\/teleagent-voice-stack-launch cleanup$/m);
  assert.doesNotMatch(unit, /^\[Install\]$/m);
  assert.doesNotMatch(unit, /^Environment=.*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)=/mi);
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
  assert.match(installer, /--source-check\|--install-disabled\|--check/);
  assert.match(installer, /systemd-sysusers/);
  assert.match(installer, /systemd-tmpfiles/);
  assert.match(installer, /^slice_unit=teleagent-voice-containers\.slice$/m);
  assert.doesNotMatch(installer, /is-active --quiet/);
  assert.match(installer, /--property=LoadState --value/);
  assert.match(installer, /--property=ActiveState --value/);
  assert.match(installer, /--property=UnitFileState --value/);
  assert.match(installer,
    /load_state=\$\("\$systemctl_bin" show[^\n]+--property=LoadState --value\) \|\|\n\s+fail/);
  assert.match(installer,
    /active_state=\$\("\$systemctl_bin" show[^\n]+--property=ActiveState --value\) \|\|\n\s+fail/);
  assert.match(installer, /not-found\)[\s\S]*teleagent-voice-stack\.service/);
  assert.match(installer, /\[ "\$load_state" = loaded \]/);
  assert.match(installer, /\[ "\$active_state" = inactive \]/);
  assert.match(installer, /\[ "\$unit_file_state" = static \]/);
  assert.match(installer,
    /installed voice container slice must be loaded, static, and inactive/);
  assert.match(installer,
    /absent voice container slice conflicts with an installed unit file/);
  assert.match(installer, /assert_slice_inactive_or_absent/);
  assert.match(installer, /assert_slice_installed_dormant/);
  assert.doesNotMatch(installer, /is-enabled(?:\s|$)/);
  assert.doesNotMatch(installer, /"\$systemctl_bin"\s+(?:start|enable|restart)\b/);
  assert.doesNotMatch(installer, /\/usr\/bin\/(?:docker|nft)\b/);
  assert.doesNotMatch(installer, /\/etc\/teleagent-voice\/credentials\//);
  assert.doesNotMatch(installer, /activation-state\.json/);
  assert.doesNotMatch(installer, /\/var\/lib\/teleagent-voice-stack\/(?:\*|[^'" ]+)/);
  assert.doesNotMatch(installer, /(?:generate|rotate).*(?:secret|credential|key)/i);
  assert.match(installer, /rollback\(\)/);
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
