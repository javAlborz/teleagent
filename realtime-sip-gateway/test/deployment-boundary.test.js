import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectInstalledStorage,
  validateActivationGate,
  validateIdentityRecords,
  validateInstalledManifestAssets,
  validateRuntimeConfigurationSource,
  validateServiceSource,
  validateSysusersSource,
  validateTmpfilesSource,
  verifyInstalledModePolicy,
  verifyLoadedSystemdPolicy,
} from '../deploy/verify-realtime-sip-gateway';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deployRoot = path.join(packageRoot, 'deploy');
const GIB = 1024n * 1024n * 1024n;

function source(name) {
  return readFileSync(path.join(deployRoot, name), 'utf8');
}

function directory({ dev, ino, uid, gid, mode }) {
  return {
    dev: BigInt(dev),
    ino: BigInt(ino),
    uid: BigInt(uid),
    gid: BigInt(gid),
    mode: BigInt(mode),
    nlink: 2n,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function regularFile({ dev = 1, ino = 30, uid = 0, gid = 0, mode, size = 16, nlink = 1 }) {
  return {
    dev: BigInt(dev),
    ino: BigInt(ino),
    uid: BigInt(uid),
    gid: BigInt(gid),
    mode: BigInt(mode),
    size: BigInt(size),
    nlink: BigInt(nlink),
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

const validPasswd = [
  'root:x:0:0:root:/root:/bin/bash',
  'teleagent-sip-gateway:x:991:991:SIP:/var/lib/teleagent-sip-gateway:/usr/sbin/nologin',
  'operator:x:1000:1000:Operator:/home/operator:/bin/bash',
  '',
].join('\n');
const validGroup = [
  'root:x:0:',
  'teleagent-sip-gateway:x:991:',
  'operator:x:1000:',
  '',
].join('\n');

test('source policy is static, sentinel-gated, bounded, and creates no activation material', () => {
  assert.equal(validateServiceSource(source('teleagent-realtime-sip-gateway.service')), true);
  assert.equal(validateSysusersSource(source('teleagent-realtime-sip-gateway.sysusers')), true);
  assert.equal(validateTmpfilesSource(source('teleagent-realtime-sip-gateway.tmpfiles')), true);

  assert.throws(
    () => validateServiceSource(`${source('teleagent-realtime-sip-gateway.service')}\n[Install]\n`),
    /became enableable/u,
  );
  assert.throws(
    () => validateServiceSource(
      source('teleagent-realtime-sip-gateway.service').replace('MemoryMax=512M', 'MemoryMax=2G'),
    ),
    /memory cap/u,
  );
  assert.throws(
    () => validateServiceSource(
      source('teleagent-realtime-sip-gateway.service')
        .replace('InaccessiblePaths=/var/lib/teleagent-control\n', ''),
    ),
    /inaccessible path/u,
  );
  assert.throws(
    () => validateServiceSource(
      source('teleagent-realtime-sip-gateway.service')
        .replace('InaccessiblePaths=/var/lib/teleagent-control',
          'InaccessiblePaths=-/var/lib/teleagent-control'),
    ),
    /fail-open|inaccessible path/u,
  );
  for (const unsafeDirective of [
    'User=root',
    'MemoryMax=infinity',
    'ReadWritePaths=/',
    'ExecStart=',
    'ExecStart=/bin/sh -c id',
    'CapabilityBoundingSet=CAP_SYS_ADMIN',
    'Environment=NODE_OPTIONS=--require=/var/lib/teleagent-worker-state/hook.js',
  ]) {
    assert.throws(
      () => validateServiceSource(
        `${source('teleagent-realtime-sip-gateway.service')}\n${unsafeDirective}\n`,
      ),
      /reviewed|exactly once|credential/u,
    );
  }
  assert.throws(
    () => validateTmpfilesSource(`${source('teleagent-realtime-sip-gateway.tmpfiles')}
f /etc/teleagent/realtime-sip-gateway/ENABLE 0600 root root - enabled\n`),
    /creates activation/u,
  );
});

test('disabled and activation verification require opposite exact sentinel states', () => {
  const absent = () => {
    const error = new Error('absent');
    error.code = 'ENOENT';
    throw error;
  };
  assert.equal(validateActivationGate({ activation: false, lstat: absent }), true);
  assert.throws(
    () => validateActivationGate({
      activation: false,
      lstat: () => regularFile({ mode: 0o100600 }),
    }),
    /must remain absent/u,
  );

  const metadata = (filename) => {
    if (filename === '/etc/teleagent/credentials') {
      return directory({ dev: 1, ino: 40, uid: 0, gid: 0, mode: 0o40700 });
    }
    if (filename.endsWith('/ENABLE')) return regularFile({ mode: 0o100600, size: 0 });
    if (filename.endsWith('/config.env')) return regularFile({ mode: 0o100600, size: 64 });
    return regularFile({ mode: 0o100400, size: 48 });
  };
  assert.equal(validateActivationGate({
    activation: true,
    lstat: metadata,
    realpath: (filename) => filename,
    readConfiguration: () => 'SIP_GATEWAY_MODE=reject\n',
  }), true);
  assert.throws(() => validateActivationGate({
    activation: true,
    lstat: (filename) => filename.endsWith('/ENABLE')
      ? regularFile({ mode: 0o100644, size: 0 })
      : metadata(filename),
    realpath: (filename) => filename,
    readConfiguration: () => 'SIP_GATEWAY_MODE=reject\n',
  }), /unsafe metadata/u);
});

test('activation configuration accepts only unique reviewed non-secret settings', () => {
  assert.ok(validateRuntimeConfigurationSource(
    readFileSync(path.join(packageRoot, '.env.example'), 'utf8'),
  ).includes('SIP_GATEWAY_MODE'));
  assert.deepEqual(
    validateRuntimeConfigurationSource(
      '# Public-edge canary\nSIP_GATEWAY_MODE=reject\nSIP_MAX_ACTIVE_CALLS=1\n',
    ),
    ['SIP_GATEWAY_MODE', 'SIP_MAX_ACTIVE_CALLS'],
  );
  for (const configuration of [
    'NODE_OPTIONS=--require=/var/lib/teleagent-worker-state/hook.js\n',
    'LD_PRELOAD=/var/lib/teleagent-worker-state/hook.so\n',
    'OPENAI_API_KEY=direct-secret\n',
    'OPENAI_API_KEY_FILE=/tmp/override\n',
    'CREDENTIALS_DIRECTORY=/tmp/override\n',
    'TELEAGENT_SIP_STATE_BOUNDARY=disabled\n',
    'SIP_GATEWAY_MODE=reject\nSIP_GATEWAY_MODE=accept\n',
    ' SIP_GATEWAY_MODE=reject\n',
    'SIP_GATEWAY_MODE="reject"\n',
  ]) {
    assert.throws(() => validateRuntimeConfigurationSource(configuration));
  }
});

test('activation binds to the exact loaded static systemd fragment', () => {
  const safe = new Map([
    ['LoadState', 'loaded'],
    ['FragmentPath', '/etc/systemd/system/teleagent-realtime-sip-gateway.service'],
    ['NeedDaemonReload', 'no'],
    ['UnitFileState', 'static'],
    ['DropInPaths', ''],
    ['User', 'teleagent-sip-gateway'],
    ['Group', 'teleagent-sip-gateway'],
  ]);
  assert.equal(verifyLoadedSystemdPolicy({ queryProperty: (name) => safe.get(name) }), true);
  for (const [name, value] of [
    ['FragmentPath', '/run/systemd/transient/teleagent-realtime-sip-gateway.service'],
    ['NeedDaemonReload', 'yes'],
    ['UnitFileState', 'enabled'],
    ['DropInPaths', '/run/systemd/system/teleagent-realtime-sip-gateway.service.d/override.conf'],
    ['User', 'root'],
  ]) {
    assert.throws(() => verifyLoadedSystemdPolicy({
      queryProperty: (property) => property === name ? value : safe.get(property),
    }), /loaded systemd property/u);
  }
});

test('initialize and disabled checks reject a loaded drop-in before disk attestation', () => {
  for (const mode of [
    '--initialize-empty-state', '--installed-check', '--activation-check',
  ]) {
    let diskChecks = 0;
    assert.throws(() => verifyInstalledModePolicy(mode, {
      verifyLoadedPolicy: () => {
        throw new Error('loaded DropInPaths is nonempty');
      },
      verifyDiskPolicy: () => {
        diskChecks += 1;
      },
    }), /DropInPaths/u);
    assert.equal(diskChecks, 0);
  }
});

test('installed manifest pins every root-executed policy asset including installer', () => {
  const manifest = source('realtime-sip-gateway-install.manifest');
  assert.equal(validateInstalledManifestAssets(manifest, {
    readAsset: (record) => readFileSync(path.join(packageRoot, record.relative)),
  }), true);
  assert.throws(() => validateInstalledManifestAssets(
    manifest.replace(/^[a-f0-9]/u, '0'),
    { readAsset: (record) => readFileSync(path.join(packageRoot, record.relative)) },
  ), /digest verification/u);
});

test('the public-edge identity has unique numeric UID/GID and no supplementary groups', () => {
  assert.deepEqual(validateIdentityRecords(validPasswd, validGroup), { uid: 991, gid: 991 });
  assert.throws(
    () => validateIdentityRecords(
      validPasswd.replace('operator:x:1000:1000', 'operator:x:991:1000'),
      validGroup,
    ),
    /numeric identity is reused/u,
  );
  assert.throws(
    () => validateIdentityRecords(
      validPasswd.replace('operator:x:1000:1000', 'operator:x:1000:991'),
      validGroup,
    ),
    /numeric identity is reused/u,
  );
  assert.throws(
    () => validateIdentityRecords(
      validPasswd,
      validGroup.replace('operator:x:1000:', 'operator:x:991:'),
    ),
    /numeric identity is reused/u,
  );
  assert.throws(
    () => validateIdentityRecords(
      validPasswd,
      validGroup.replace('operator:x:1000:', 'operator:x:1000:teleagent-sip-gateway'),
    ),
    /supplementary group/u,
  );
});

test('installed verification accepts only the exact 1-4 GiB mount and admission reserve', () => {
  const parent = directory({ dev: 1, ino: 10, uid: 0, gid: 0, mode: 0o40755 });
  const root = directory({ dev: 2, ino: 20, uid: 991, gid: 991, mode: 0o40700 });
  const inspect = (overrides = {}) => inspectInstalledStorage({
    uid: 991,
    gid: 991,
    lstat: (filename) => filename === '/var/lib'
      ? parent
      : { ...root, ...overrides.root },
    realpath: (filename) => overrides.realpathDrift && filename !== '/var/lib'
      ? `${filename}-replacement`
      : filename,
    statfs: () => ({
      type: overrides.type ?? 0xef53n,
      bsize: 4096n,
      blocks: (overrides.capacity ?? (2n * GIB)) / 4096n,
      bavail: (overrides.free ?? (768n * 1024n * 1024n)) / 4096n,
    }),
  });
  assert.equal(inspect().capacity, 2n * GIB);
  for (const options of [
    { root: { dev: 1n } },
    { root: { uid: 0n } },
    { root: { mode: 0o40750n } },
    { realpathDrift: true },
    { type: 0x01021994n },
    { capacity: 512n * 1024n * 1024n },
    { capacity: 5n * GIB },
    { capacity: 4n * GIB, free: 800n * 1024n * 1024n },
  ]) assert.throws(() => inspect(options), /verification refused/u);
});

test('systemd accepts the static hardened unit in an offline fixture', {
  skip: !existsSync('/usr/bin/systemd-analyze'),
}, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'teleagent-sip-systemd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeDirectory = (relative) => mkdirSync(path.join(root, relative), {
    recursive: true,
    mode: 0o755,
  });
  for (const directoryName of [
    'etc/systemd/system',
    'etc/teleagent/realtime-sip-gateway',
    'usr/local/libexec',
    'opt/teleagent/current/realtime-sip-gateway/src',
    'var/lib/teleagent-sip-gateway',
  ]) makeDirectory(directoryName);
  copyFileSync(
    path.join(deployRoot, 'teleagent-realtime-sip-gateway.service'),
    path.join(root, 'etc/systemd/system/teleagent-realtime-sip-gateway.service'),
  );
  for (const targetName of [
    'basic.target',
    'local-fs.target',
    'network-online.target',
    'shutdown.target',
    'sysinit.target',
  ]) {
    writeFileSync(
      path.join(root, 'etc/systemd/system', targetName),
      `[Unit]\nDescription=Offline fixture ${targetName}\n`,
    );
  }
  for (const executableName of [
    'verify-realtime-sip-gateway', 'teleagent-node',
  ]) {
    const filename = path.join(root, 'usr/local/libexec', executableName);
    writeFileSync(filename, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(filename, 0o755);
  }
  writeFileSync(path.join(
    root,
    'opt/teleagent/current/realtime-sip-gateway/src/index.js',
  ), '');
  writeFileSync(path.join(root, 'etc/passwd'), [
    'root:x:0:0:root:/root:/bin/sh',
    'teleagent-sip-gateway:x:991:991:SIP:/var/lib/teleagent-sip-gateway:/usr/sbin/nologin',
    '',
  ].join('\n'));
  writeFileSync(path.join(root, 'etc/group'), 'root:x:0:\nteleagent-sip-gateway:x:991:\n');
  writeFileSync(path.join(root, 'etc/teleagent/realtime-sip-gateway/config.env'), 'SIP_GATEWAY_MODE=reject\n');

  const result = spawnSync('/usr/bin/systemd-analyze', [
    `--root=${root}`,
    'verify',
    'teleagent-realtime-sip-gateway.service',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
