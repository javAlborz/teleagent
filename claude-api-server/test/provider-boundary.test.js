'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const boundary = require('../../deploy/worker-session/teleagent-provider-boundary');
const { observeChildExit } = require('../provider-child-lifecycle');

function launchArgs(workspace) {
  return [
    '--action', 'launch',
    '--provider', 'claude',
    '--launch-id', 'launch_11111111111111111111111111111111',
    '--mode', 'managed',
    '--access-mode', 'read-only',
    '--workspace', workspace,
    '--task-id', 'job_boundary',
    '--', '-p', '--model', 'claude-sonnet-5',
  ];
}

const LOCK_PUBLISHER_CHILD = String.raw`
'use strict';
const fs = require('node:fs');
const boundary = require(process.argv[1]);
const directory = process.argv[2];
const phase = process.argv[3];
const marker = process.argv[4];
const launchId = 'launch_33333333333333333333333333333333';
const writeDescriptor = (descriptor, buffer, offset, length, position) =>
  fs.writeSync(
    descriptor,
    buffer,
    offset,
    phase === 'partial-write' ? Math.min(1, length) : length,
    position,
  );
boundary.createGlobalLaunchLock(launchId, {
  directory,
  uid: process.getuid(),
  gid: process.getgid(),
  writeDescriptor,
  phaseHook: (current) => {
    if (current !== phase) return;
    fs.writeFileSync(marker, current, { mode: 0o600 });
    const descriptor = fs.openSync(marker, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    process.kill(process.pid, 'SIGSTOP');
  },
});
`;

async function killLockPublisherAtPhase(directory, phase) {
  const marker = path.join(directory, `.reached-${phase}`);
  const boundaryPath = path.join(
    __dirname, '../../deploy/worker-session/teleagent-provider-boundary'
  );
  const child = spawn(process.execPath, [
    '-e', LOCK_PUBLISHER_CHILD, boundaryPath, directory, phase, marker,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let outcome = null;
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      outcome = { code, signal };
      resolve(outcome);
    });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`lock publisher did not reach ${phase}`));
    }, 5000);
    const poll = setInterval(() => {
      if (fs.existsSync(marker)) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      } else if (outcome !== null) {
        clearTimeout(timeout);
        clearInterval(poll);
        reject(new Error(`lock publisher exited before ${phase}: ${JSON.stringify(outcome)}`));
      }
    }, 10);
  });
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
}

test('boundary invocation creates a private, bounded, credential-fed transient cgroup', () => {
  const input = {
    provider: 'claude',
    launchId: 'launch_11111111111111111111111111111111',
    mode: 'managed',
    accessMode: 'read-only',
    workspace: '/srv/teleagent-agent-workspaces/phone',
    taskId: 'job_boundary',
    sessionId: null,
    providerArgs: ['-p'],
    spec: boundary.PROVIDERS.claude,
    credentialPath: '/run/teleagent-provider-capabilities/launch_11111111111111111111111111111111.credential',
    readinessPath: '/run/teleagent-provider-capabilities/claude.launch_11111111111111111111111111111111.provider-readiness.jsonl',
  };
  const invocation = boundary.buildSystemdRunInvocation(input);
  const joined = invocation.args.join('\n');
  assert.equal(invocation.command, '/usr/bin/systemd-run');
  assert.match(joined, /PrivateNetwork=yes/);
  assert.match(joined, /PrivateIPC=yes/);
  assert.match(joined, /KeyringMode=private/);
  assert.match(joined,
    /BindsTo=teleagent-provider-supervisor@claude\.service teleagent-provider-egress@claude\.service/);
  assert.match(joined, /TemporaryFileSystem=\/run:ro,nodev,nosuid,noexec/);
  assert.match(joined,
    /TemporaryFileSystem=\/tmp:rw,nodev,nosuid,noexec,size=512M,mode=1777/);
  assert.match(joined, /TemporaryFileSystem=\/srv\/teleagent-agent-workspaces:ro,nodev,nosuid/);
  assert.match(joined,
    /BindReadOnlyPaths=\/run\/teleagent-provider-egress\/claude\.sock:\/run\/teleagent-provider-egress\/claude\.sock/);
  assert.match(joined, /InaccessiblePaths=.*\/var\/run/);
  assert.match(joined, /-\/srv\/teleagent-agent-workspaces\/phone\/\.codex/);
  assert.match(joined, /-\/srv\/teleagent-agent-workspaces\/phone\/\.claude/);
  assert.doesNotMatch(joined, /ReadOnlyPaths=.*\/run\/teleagent-provider-egress(?:\s|$)/);
  assert.match(joined, /KillMode=control-group/);
  assert.match(joined, /Slice=teleagent-provider-model\.slice/);
  assert.match(joined, /TasksMax=384/);
  assert.match(joined, /MemoryHigh=2G/);
  assert.match(joined, /MemoryMax=3G/);
  assert.match(joined, /MemorySwapMax=0/);
  assert.match(joined, /CPUQuota=150%/);
  assert.match(joined, /IOAccounting=yes/);
  assert.match(joined, /IOWeight=25/);
  assert.match(joined, /LimitFSIZE=268435456/);
  assert.match(joined, /LimitCORE=0/);
  assert.match(joined, /CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_KILL/);
  assert.match(joined, /SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register/);
  assert.doesNotMatch(joined, /CAP_CHOWN/);
  assert.match(joined, /LoadCredential=provider-launch-capability:/);
  assert.match(joined, /BindPaths=.*provider-readiness\.jsonl/);
  assert.match(joined, /teleagent-provider-boundary-runtime/);
  assert.match(joined, /--launch-id/);
  assert.match(joined, /--access-mode\nread-only/);
  assert.match(joined,
    /BindReadOnlyPaths=\/srv\/teleagent-agent-workspaces\/phone:\/srv\/teleagent-agent-workspaces\/phone/);
  assert.match(joined,
    /InaccessiblePaths=.*-\/var\/lib\/teleagent-claude-worker.*-\/var\/lib\/teleagent-codex-worker/);
  assert.doesNotMatch(joined, /ReadWritePaths=.*teleagent-agent-workspaces\/phone/);
  assert.doesNotMatch(joined, /[a-f0-9]{64}/, 'the raw capability must never enter argv');
});

test('workspace storage must be a bounded dedicated filesystem with a free-space floor', () => {
  const gib = 1024n * 1024n * 1024n;
  const inspect = (overrides = {}) => boundary.validateWorkspaceStorageBoundary(
    '/srv/teleagent-agent-workspaces',
    {
      stat: (filename) => ({
        dev: filename === '/srv/teleagent-agent-workspaces'
          ? (overrides.dev ?? 2n)
          : (overrides.parentDev ?? 1n),
      }),
      statfs: () => ({
        bsize: 4096n,
        blocks: (overrides.total ?? (32n * gib)) / 4096n,
        bavail: (overrides.free ?? (8n * gib)) / 4096n,
      }),
    },
  );
  assert.deepEqual(inspect(), { totalBytes: 32n * gib, freeBytes: 8n * gib, device: 2n });
  assert.throws(() => inspect({ parentDev: 2n }), /dedicated filesystem mountpoint/);
  assert.throws(() => inspect({ total: 2n * gib }), /size or free-space/);
  assert.throws(() => inspect({ total: 65n * gib }), /size or free-space/);
  assert.throws(() => inspect({ free: 1n * gib }), /size or free-space/);
  assert.throws(
    () => boundary.validateWorkspaceStorageBoundary('/srv'),
    /exact dedicated mountpoint/
  );

  const inspected = [];
  assert.equal(boundary.attestWorkspaceStorageBoundary({
    validateStorage: (directory) => inspected.push(directory),
  }), 'PROVIDER_WORKSPACE_STORAGE_OK');
  assert.deepEqual(inspected, ['/srv/teleagent-agent-workspaces']);
  assert.throws(
    () => boundary.attestWorkspaceStorageBoundary({
      validateStorage: () => { throw new Error('unsafe storage fixture'); },
    }),
    /unsafe storage fixture/
  );
});

test('supervisor admission proves workload storage isolation before panic state', () => {
  const order = [];
  boundary.assertSupervisorStartAdmitted({
    validateStorageIsolation: () => order.push('storage-isolation'),
    panicLocked: () => {
      order.push('panic');
      return false;
    },
    recoveryPending: () => assert.fail('an unlocked plane needs no recovery lookup'),
  });
  assert.deepEqual(order, ['storage-isolation', 'panic']);

  assert.throws(
    () => boundary.assertSupervisorStartAdmitted({
      validateStorageIsolation: () => { throw new Error('storage refused'); },
      panicLocked: () => assert.fail('panic state must not precede storage attestation'),
    }),
    /storage refused/
  );
});

test('provider plane storage is a bounded dedicated mount with private supervisor homes', () => {
  const root = '/var/lib/teleagent-provider-plane';
  const parent = '/var/lib';
  const homes = {
    claude: `${root}/claude-supervisor`,
    codex: `${root}/codex-supervisor`,
  };
  const identities = {
    claude: { uid: 991, gid: 992 },
    codex: { uid: 993, gid: 994 },
  };
  const metadata = ({ uid, gid, mode }) => ({
    uid,
    gid,
    mode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  const inspect = (overrides = {}) => boundary.validateProviderPlaneStorageBoundary({
    requireReserve: overrides.requireReserve ?? true,
    requireHomes: overrides.requireHomes ?? true,
    identities,
    lstat: (filename) => {
      if (filename === parent) return metadata({ uid: 0, gid: 0, mode: 0o40755 });
      if (filename === root) {
        return metadata({ uid: 0, gid: 0, mode: overrides.rootMode ?? 0o40751 });
      }
      const provider = Object.entries(homes).find(([, home]) => home === filename)?.[0];
      assert.ok(provider);
      return metadata({
        uid: overrides.provider === provider ? (overrides.uid ?? identities[provider].uid) : identities[provider].uid,
        gid: identities[provider].gid,
        mode: 0o40700,
      });
    },
    realpath: (filename) => filename,
    stat: (filename) => ({
      dev: filename === parent
        ? 1n
        : filename === root
          ? (overrides.rootDev ?? 2n)
          : (overrides.homeDev?.[filename] ?? 2n),
    }),
    statfs: () => ({
      type: overrides.filesystemType ?? 0xef53n,
      bsize: 4096n,
      blocks: (overrides.capacity ?? (2n * 1024n * 1024n * 1024n)) / 4096n,
      bavail: (overrides.free ?? (768n * 1024n * 1024n)) / 4096n,
    }),
  });
  const healthy = inspect();
  assert.equal(healthy.root, root);
  assert.equal(healthy.requiredFreeBytes, 512n * 1024n * 1024n);
  assert.equal(healthy.admitted, true);
  assert.throws(() => inspect({ rootDev: 1n }), /dedicated mountpoint/);
  assert.throws(() => inspect({ rootMode: 0o40771 }), /dedicated mountpoint/);
  assert.throws(() => inspect({ provider: 'claude', uid: 995 }), /private storage boundary/);
  assert.throws(() => inspect({ homeDev: { [homes.codex]: 3n } }), /private storage boundary/);
  assert.throws(
    () => inspect({ capacity: 5n * 1024n * 1024n * 1024n }),
    /1-4 GiB/
  );
  assert.throws(
    () => inspect({ free: 511n * 1024n * 1024n }),
    /reserve is exhausted/
  );
  assert.throws(
    () => inspect({ filesystemType: 0x01021994n }),
    /durable local filesystem/
  );
  assert.throws(
    () => inspect({ filesystemType: 0x6969n }),
    /durable local filesystem/
  );
  for (const filesystemType of [
    0xef53n,
    0x58465342n,
    BigInt.asIntN(32, 0x9123683en),
    BigInt.asIntN(32, 0xf2f52010n),
    0x2fc12fc1n,
  ]) {
    assert.doesNotThrow(() => inspect({ filesystemType }));
  }
  assert.equal(inspect({
    free: 511n * 1024n * 1024n,
    requireReserve: false,
  }).admitted, false, 'recovery inspection preserves writes below the admission reserve');
  assert.doesNotThrow(() => inspect({
    free: 511n * 1024n * 1024n,
    requireReserve: false,
    requireHomes: false,
    provider: 'claude',
    uid: 995,
  }), 'panic persistence depends on the exact mount, not mutable supervisor homes');

  const options = [];
  assert.equal(boundary.attestProviderPlaneStorageBoundary({
    validateStorage: (input) => options.push(input),
  }), 'PROVIDER_PLANE_STORAGE_OK');
  assert.deepEqual(options, [{ requireReserve: true }]);

  const workspace = { device: 2n };
  const providerPlane = { device: 3n };
  const anchors = [];
  assert.deepEqual(boundary.validateProviderStorageIsolation({
    validateWorkspace: (directory) => anchors.push(directory),
    validateWorkspaceStorage: (directory) => {
      assert.equal(directory, '/srv/teleagent-agent-workspaces');
      return workspace;
    },
    validateProviderPlaneStorage: (input) => {
      assert.deepEqual(input, { requireReserve: true });
      return providerPlane;
    },
  }), { workspace, providerPlane });
  assert.deepEqual(anchors, ['/srv/teleagent-agent-workspaces/phone']);
  assert.throws(() => boundary.validateProviderStorageIsolation({
    validateWorkspace: () => {},
    validateWorkspaceStorage: () => ({ device: 7n }),
    validateProviderPlaneStorage: () => ({ device: 7n }),
  }), /require distinct filesystems/);
  assert.throws(() => boundary.validateProviderStorageIsolation({
    validateWorkspace: () => { throw new Error('replaceable workspace anchor'); },
    validateWorkspaceStorage: () => assert.fail('storage must follow anchor validation'),
    validateProviderPlaneStorage: () => assert.fail('provider storage must follow anchor validation'),
  }), /replaceable workspace anchor/);
  assert.equal(boundary.attestWorkerStorageBoundary({
    validateStorage: () => ({ workspace, providerPlane }),
  }), 'PROVIDER_WORKER_STORAGE_OK');
});

test('root provider preflights require bundled Node and the retained exact lock', () => {
  const releaseRoot = `/opt/teleagent/releases/sha256-${'b'.repeat(64)}`;
  const fixture = () => {
    const environment = {
      TELEAGENT_RELEASE_ROOT: releaseRoot,
      TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD: '19',
    };
    const lock = {
      dev: 8,
      ino: 13,
      uid: 0,
      gid: 0,
      mode: 0o40700,
      isDirectory: () => true,
    };
    return {
      environment,
      filesystem: {
        realpathSync: (filename) => filename,
        fstatSync: () => ({ ...lock }),
        lstatSync: () => ({ ...lock }),
      },
      executable: `${releaseRoot}/runtime/node/bin/node`,
      invokedScript: `${releaseRoot}/deploy/worker-session/teleagent-provider-boundary`,
      execArguments: [],
      uid: 0,
    };
  };
  const valid = fixture();
  assert.equal(boundary.requireImmutablePreflight(valid), 19);
  assert.equal(valid.environment.TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD, undefined);

  for (const mutate of [
    (input) => { input.executable = '/usr/local/libexec/teleagent-node'; },
    (input) => { input.invokedScript = '/usr/local/libexec/teleagent-provider-boundary'; },
    (input) => { input.environment.TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD = '1'; },
    (input) => { input.uid = 1000; },
    (input) => {
      const metadata = input.filesystem.lstatSync();
      input.filesystem.lstatSync = () => ({ ...metadata, mode: 0o40755 });
    },
    (input) => {
      input.filesystem = {
        ...input.filesystem,
        lstatSync: () => ({
          dev: 8, ino: 14, uid: 0, gid: 0, mode: 0o40755, isDirectory: () => true,
        }),
      };
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => boundary.requireImmutablePreflight(input),
      /immutable release|retained lock|escaped|lock identity/u,
    );
  }
});

test('worker storage main route requires immutable preflight before attestation', async () => {
  const calls = [];
  await assert.rejects(
    boundary.main([], { FIXTURE: 'value' }, {
      parseInput: () => ({
        action: 'attest-worker-storage',
        provider: null,
        launchId: null,
        spec: null,
      }),
      requirePreflight: ({ environment }) => {
        assert.deepEqual(environment, { FIXTURE: 'value' });
        calls.push('preflight');
        throw new Error('stop-before-storage');
      },
      attestWorkerStorage: () => {
        calls.push('storage');
        return 'PROVIDER_WORKER_STORAGE_OK';
      },
    }),
    /stop-before-storage/u,
  );
  assert.deepEqual(calls, ['preflight']);
});

test('workspace mounts use one non-replaceable root anchor and one global launch lock', () => {
  const fixed = '/srv/teleagent-agent-workspaces/phone';
  const metadata = (mode) => ({
    uid: 0,
    gid: 991,
    mode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  assert.deepEqual(boundary.validateWorkspaceAnchor(fixed, {
    lstat: (filename) => metadata(filename === fixed ? 0o42770 : 0o40751),
    realpath: (filename) => filename,
    expectedGid: 991,
  }), { workspace: fixed, gid: 991 });
  assert.throws(
    () => boundary.validateWorkspaceAnchor(`${fixed}/nested`),
    /exact root-provisioned workspace anchor/
  );
  assert.throws(
    () => boundary.validateWorkspaceAnchor(fixed, {
      lstat: (filename) => metadata(filename === fixed ? 0o42770 : 0o40771),
      realpath: (filename) => filename,
      expectedGid: 991,
    }),
    /replaceable or unsafe/
  );
  assert.throws(
    () => boundary.validateWorkspaceAnchor(fixed, {
      lstat: (filename) => ({
        ...metadata(filename === fixed ? 0o42770 : 0o40751),
        gid: 992,
      }),
      realpath: (filename) => filename,
      expectedGid: 991,
    }),
    /replaceable or unsafe/
  );
  const boundarySource = fs.readFileSync(
    path.join(__dirname, '../../deploy/worker-session/teleagent-provider-boundary'), 'utf8'
  );
  assert.match(boundarySource,
    /getent'[\s\S]*teleagent-agent-workspace[\s\S]*resolveWorkspaceGroupGid\(\)/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-global-launch-lock-'));
  fs.chmodSync(directory, 0o700);
  const launchId = 'launch_11111111111111111111111111111111';
  const options = { directory, uid: process.getuid(), gid: process.getgid() };
  try {
    const filename = boundary.createGlobalLaunchLock(launchId, options);
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(Object.keys(record), ['version', 'launchId', 'pid', 'startTime']);
    assert.equal(record.version, 1);
    assert.equal(record.launchId, launchId);
    assert.equal(record.pid, process.pid);
    assert.match(record.startTime, /^[1-9][0-9]*$/);
    assert.throws(
      () => boundary.createGlobalLaunchLock(
        'launch_22222222222222222222222222222222', options
      ),
      /global workspace lock/
    );
    assert.throws(
      () => boundary.clearStaleGlobalLaunchLockAfterQuiescence({
        ...options, quiesced: true,
      }),
      /owner remains live/
    );
    boundary.removeGlobalLaunchLock(filename, launchId, options);
    assert.equal(fs.existsSync(filename), false);

    const stale = {
      version: 1,
      launchId: 'launch_22222222222222222222222222222222',
      pid: 999999999,
      startTime: '1',
    };
    fs.writeFileSync(filename, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
    assert.throws(
      () => boundary.clearStaleGlobalLaunchLockAfterQuiescence({
        ...options, quiesced: false, readStartTime: () => null,
      }),
      /requires quiescence/
    );
    assert.deepEqual(boundary.clearStaleGlobalLaunchLockAfterQuiescence({
      ...options, quiesced: true, readStartTime: () => null,
    }), {
      proved: true,
      removed: true,
      launchId: stale.launchId,
      orphanCount: 0,
    });
    assert.equal(fs.existsSync(filename), false);

    let partialWrites = 0;
    for (const injected of [
      { writeDescriptor: () => { throw new Error('injected write failure'); } },
      { writeDescriptor: () => 0 },
      { writeDescriptor: () => {
        partialWrites += 1;
        if (partialWrites === 1) return 1;
        throw new Error('injected failure after partial write');
      } },
      { fsyncDescriptor: () => { throw new Error('injected fsync failure'); } },
      { syncPublishedDirectory: () => { throw new Error('injected directory fsync failure'); } },
      { inspectLock: () => { throw new Error('injected inspect failure'); } },
    ]) {
      assert.throws(
        () => boundary.createGlobalLaunchLock(launchId, { ...options, ...injected })
      );
      assert.equal(fs.existsSync(filename), false,
        'a failed construction must not strand the final lock pathname');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('global launch lock publication is crash-atomic at every commit phase', async () => {
  const launchId = 'launch_33333333333333333333333333333333';
  for (const phase of [
    'pre-write', 'partial-write', 'pre-fsync', 'pre-publish', 'post-publish',
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `provider-lock-${phase}-`));
    fs.chmodSync(directory, 0o700);
    const options = { directory, uid: process.getuid(), gid: process.getgid() };
    const filename = path.join(directory, '.global-provider-launch.lock');
    try {
      await killLockPublisherAtPhase(directory, phase);
      if (phase !== 'post-publish') {
        assert.equal(fs.existsSync(filename), false,
          `${phase} must not expose an incomplete final lock`);
        const replacement = boundary.createGlobalLaunchLock(launchId, options);
        boundary.removeGlobalLaunchLock(replacement, launchId, options);
        assert.equal(fs.existsSync(filename), false);
        assert.deepEqual(boundary.clearStaleGlobalLaunchLockAfterQuiescence({
          ...options,
          quiesced: true,
          readStartTime: () => null,
        }), { proved: true, removed: false, orphanCount: 1 });
      } else {
        const metadata = fs.lstatSync(filename);
        assert.equal(metadata.isFile(), true);
        assert.equal(metadata.nlink, 2,
          'the crash window may retain only the exact private publication companion');
        assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).launchId, launchId);
        assert.deepEqual(boundary.clearStaleGlobalLaunchLockAfterQuiescence({
          ...options,
          quiesced: true,
          readStartTime: () => null,
        }), {
          proved: true,
          removed: true,
          launchId,
          orphanCount: 0,
        });
        assert.equal(fs.existsSync(filename), false);
        assert.deepEqual(
          fs.readdirSync(directory).filter((entry) =>
            entry.startsWith('.global-provider-launch.lock.tmp.')),
          [],
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

function launchTransactionFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-transaction-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { directory, uid: process.getuid(), gid: process.getgid() };
  const lockPath = path.join(directory, '.global-provider-launch.lock');
  const calls = [];
  const launchIds = {
    claude: 'launch_11111111111111111111111111111111',
    codex: 'launch_22222222222222222222222222222222',
  };
  const defaultControl = async (frame) => frame.action === 'register'
    ? { registered: true }
    : { persisted: true, quiesced: true };
  const defaultSpawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const run = (provider, {
    control = defaultControl,
    spawnImpl = defaultSpawn,
    operations = {},
  } = {}) => {
    const launchId = launchIds[provider];
    return boundary.main([], {}, {
      parseInput: () => ({
        action: 'launch', provider, launchId, mode: 'managed', accessMode: 'read-only',
        workspace: '/srv/teleagent-agent-workspaces/phone', taskId: 'job_boundary',
        model: provider === 'claude' ? 'claude-sonnet-5' : 'gpt-5.6-luna',
        reasoningEffort: provider === 'claude' ? 'high' : 'low',
        routeKinds: ['inference'],
      }),
      randomCapability: () => 'a'.repeat(64),
      control: (frame) => {
        calls.push({ provider, action: frame.action, reason: frame.reason });
        return control(frame);
      },
      spawnImpl: (...args) => {
        calls.push({ provider, action: 'spawn' });
        return spawnImpl(...args);
      },
      checkProviderCli: () => {},
      launchOperations: {
        hasCancellationTombstone: () => false,
        assertProviderEnabled: () => {},
        createGlobalLaunchLock: (id) => boundary.createGlobalLaunchLock(id, options),
        assertResourceAdmission: async () => {},
        validateProviderStorageIsolation: () => {},
        assertGlobalProviderLaunchUnlocked: () => {},
        validateWorkspaceAnchor: () => {},
        validateProviderWorkspace: () => {},
        createCapabilityFile: (id) => {
          const filename = path.join(directory, `${id}.credential`);
          fs.writeFileSync(filename, 'fixture-not-a-credential', { flag: 'wx', mode: 0o600 });
          return filename;
        },
        createReadinessFile: (name, id) => {
          const filename = path.join(directory, `${name}.${id}.provider-readiness.jsonl`);
          fs.writeFileSync(filename, `${JSON.stringify({
            version: 1, type: 'provider_planned', provider: name, launchId: id,
          })}\n`, { flag: 'wx', mode: 0o600 });
          return filename;
        },
        buildSystemdRunInvocation: () => ({
          command: 'fixture-not-an-executable', args: [], unit: boundary.unitName(provider, launchId),
        }),
        waitQuiesced: async () => {
          calls.push({ provider, action: 'cgroup-quiesced' });
          return { quiesced: true };
        },
        removeCapabilityFile: (filename) => {
          if (filename !== null) fs.unlinkSync(filename);
        },
        removeGlobalLaunchLock: (filename, id) => {
          calls.push({ provider, action: 'release-lock' });
          boundary.removeGlobalLaunchLock(filename, id, options);
        },
        ...operations,
      },
    });
  };
  return { directory, options, lockPath, calls, launchIds, run, defaultControl };
}

test('resource refusal releases a never-started fence without registering a capability', async (t) => {
  const fixture = launchTransactionFixture(t);
  await assert.rejects(fixture.run('claude', {
    operations: { assertResourceAdmission: async () => { throw new Error('RESOURCE_HOST_HEADROOM'); } },
  }), /RESOURCE_HOST_HEADROOM/);
  assert.deepEqual(fixture.calls.map((call) => call.action), ['release-lock']);
  assert.equal(fs.existsSync(fixture.lockPath), false);
});

test('pressure appearing during registration revokes before releasing the global fence', async (t) => {
  const fixture = launchTransactionFixture(t);
  let observations = 0;
  await assert.rejects(fixture.run('claude', {
    operations: { assertResourceAdmission: async () => {
      assert.equal(fs.existsSync(fixture.lockPath), true);
      observations += 1;
      if (observations === 2) throw new Error('RESOURCE_MEMORY_PRESSURE');
    } },
  }), /RESOURCE_MEMORY_PRESSURE/);
  assert.equal(observations, 2);
  assert.deepEqual(fixture.calls.map((call) => call.action), ['register', 'revoke', 'release-lock']);
  assert.equal(fs.existsSync(fixture.lockPath), false);
});

test('resource refusal with ambiguous capability cleanup keeps both providers fenced', async (t) => {
  const fixture = launchTransactionFixture(t);
  let observations = 0;
  await assert.rejects(fixture.run('claude', {
    control: async (frame) => frame.action === 'register'
      ? { registered: true } : { persisted: true, quiesced: false },
    operations: { assertResourceAdmission: async () => {
      observations += 1;
      if (observations === 2) throw new Error('RESOURCE_MEMORY_PRESSURE');
    } },
  }), /RESOURCE_MEMORY_PRESSURE/);
  assert.equal(fs.existsSync(fixture.lockPath), true);
  await assert.rejects(fixture.run('codex'), /global workspace lock/);
  assert.deepEqual(fixture.calls.map((call) => call.action), ['register', 'revoke']);
});

test('cancellation during the final resource observation refuses model start', async (t) => {
  const fixture = launchTransactionFixture(t);
  let observations = 0;
  let canceled = false;
  await assert.rejects(fixture.run('claude', {
    operations: {
      assertResourceAdmission: async () => {
        observations += 1;
        if (observations === 2) canceled = true;
      },
      hasCancellationTombstone: () => canceled,
    },
  }), /canceled before start/);
  assert.deepEqual(fixture.calls.map((call) => call.action), ['register', 'revoke', 'release-lock']);
  assert.equal(fs.existsSync(fixture.lockPath), false);
});

test('uncertain model or egress cleanup retains the fence against a different provider', async (t) => {
  const cases = [
    ['populated cgroup', {
      operations: { waitQuiesced: async () => ({ quiesced: false }) },
    }],
    ['unavailable cgroup status', {
      operations: { waitQuiesced: async () => { throw new Error('fixture status unavailable'); } },
    }],
    ['truthy cgroup proof', {
      operations: { waitQuiesced: async () => ({ quiesced: 'true' }) },
    }],
    ['synchronous spawn failure', {
      spawnImpl: () => { throw new Error('fixture systemd submission uncertain'); },
    }],
    ['asynchronous spawn failure', {
      spawnImpl: () => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('error', new Error('fixture child error')));
        return child;
      },
    }],
    ...[
      ['nonzero helper exit with absent unit', 1, null],
      ['helper signal with absent unit', null, 'SIGTERM'],
      ['missing helper exit status with absent unit', null, null],
    ].map(([name, code, signal]) => [name, {
      spawnImpl: () => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', code, signal));
        return child;
      },
      operations: { waitQuiesced: async () => ({ exists: false, quiesced: true }) },
    }]),
    ...[
      ['revocation transport failure', () => { throw new Error('fixture revoke unavailable'); }],
      ['revocation not durable', () => ({ persisted: false, quiesced: true })],
      ['egress not quiesced', () => ({ persisted: true, quiesced: false })],
      ['malformed revocation proof', () => ({ persisted: 1, quiesced: 'true' })],
      ['missing revocation proof', () => null],
    ].map(([name, revoke]) => [name, {
      control: async (frame) => frame.action === 'register' ? { registered: true } : revoke(),
    }]),
    ['lost registration reply and uncertain revocation', {
      control: async (frame) => {
        if (frame.action === 'register') throw new Error('fixture registration reply lost');
        return { persisted: false, quiesced: false };
      },
    }],
    ['invalid registration reply and uncertain revocation', {
      control: async () => null,
    }],
    ['credential cleanup fails during interrupted launch', {
      operations: {
        waitQuiesced: async () => ({ quiesced: false }),
        removeCapabilityFile: () => { throw new Error('fixture credential cleanup failed'); },
      },
    }],
    ['credential cleanup alone fails after proven completion', {
      operations: {
        removeCapabilityFile: () => { throw new Error('fixture credential cleanup failed'); },
      },
    }, false],
  ];
  for (const [name, overrides, interruptedRevoke = true] of cases) {
    await t.test(name, async (t) => {
      const fixture = launchTransactionFixture(t);
      await assert.rejects(fixture.run('claude', overrides));
      assert.equal(fs.existsSync(fixture.lockPath), true, 'uncertainty must retain global admission');
      const retained = fs.readFileSync(fixture.lockPath, 'utf8');
      assert.equal(JSON.parse(retained).launchId, fixture.launchIds.claude);
      await assert.rejects(fixture.run('codex'), /global workspace lock/);
      assert.equal(fs.readFileSync(fixture.lockPath, 'utf8'), retained);
      assert.equal(fixture.calls.some((call) => call.provider === 'codex'), false,
        'the successor must reach neither provider registration nor systemd submission');
      assert.equal(fixture.calls.some((call) => call.action === 'release-lock'), false);
      assert.equal(fixture.calls.some((call) => call.action === 'revoke' &&
        call.reason === 'interrupted'), interruptedRevoke,
      'every attempted registration needs proven revocation, completed or interrupted');
      if (!interruptedRevoke) {
        assert.deepEqual(fixture.calls.map((call) => call.action), [
          'register', 'spawn', 'cgroup-quiesced', 'revoke',
        ]);
        assert.equal(fixture.calls.at(-1).reason, 'completed');
      }
    });
  }
});

test('proven cleanup admits a different provider without losing readiness evidence', async (t) => {
  for (const name of ['normal completion', 'pre-registration rejection', 'lost registration reply',
    'revocation retry succeeds', 'canceled before model submission']) {
    await t.test(name, async (t) => {
      const fixture = launchTransactionFixture(t);
      let completionRevokes = 0;
      let cancellationChecks = 0;
      const overrides = {
        control: async (frame) => {
          if (name === 'lost registration reply' && frame.action === 'register') {
            throw new Error('fixture registration reply lost');
          }
          if (name === 'revocation retry succeeds' && frame.reason === 'completed') {
            completionRevokes += 1;
            throw new Error('fixture first revoke reply lost');
          }
          return fixture.defaultControl(frame);
        },
        operations: {
          validateProviderWorkspace: () => {
            if (name === 'pre-registration rejection') throw new Error('fixture workspace rejected');
          },
          hasCancellationTombstone: () => {
            cancellationChecks += 1;
            return name === 'canceled before model submission' && cancellationChecks === 2;
          },
        },
      };
      if (name === 'normal completion') assert.equal(await fixture.run('claude', overrides), 0);
      else await assert.rejects(fixture.run('claude', overrides));
      assert.equal(fs.existsSync(fixture.lockPath), false);
      if (name !== 'pre-registration rejection') {
        assert.equal(fs.existsSync(path.join(fixture.directory,
          `claude.${fixture.launchIds.claude}.provider-readiness.jsonl`)), true);
        assert.equal(fs.existsSync(path.join(fixture.directory,
          `${fixture.launchIds.claude}.credential`)), false);
      }
      if (name === 'revocation retry succeeds') assert.equal(completionRevokes, 1);
      if (name === 'lost registration reply') {
        assert.deepEqual(fixture.calls.map((call) => call.action), ['register', 'revoke', 'release-lock']);
      }
      assert.equal(await fixture.run('codex'), 0);
      assert.equal(fs.existsSync(fixture.lockPath), false);
      assert.ok(fixture.calls.some((call) => call.provider === 'codex' && call.action === 'spawn'));
    });
  }
});

function panicRecoveryFixture(fixture, overrides = {}) {
  const directory = path.join(fixture.directory, 'systemd');
  fs.mkdirSync(directory, { mode: 0o700 });
  const events = [];
  const quiesced = async () => ({ persisted: true, quiesced: true });
  const recovery = () => boundary.panicAllProviderPlanes({
    activationProviders: ['claude', 'codex'],
    control: quiesced,
    persistPanic: () => {
      events.push('panic-persisted');
      return { persisted: true };
    },
    runSystemctl: () => ({ status: 0, signal: null }),
    stopUnit: quiesced,
    inspectLaunchLock: () => JSON.parse(fs.readFileSync(fixture.lockPath, 'utf8')),
    terminate: async (provider, launchId, terminationOptions) => boundary.terminateUnit(provider, launchId, {
      ...terminationOptions,
      persistTombstone: (unit) => {
        const result = boundary.persistCancellationTombstone(unit, {
          directory, uid: process.getuid(), reload: () => {},
        });
        events.push(`tombstone:${provider}:${launchId}`);
        return result;
      },
      runSystemctl: () => ({ status: 0, signal: null }),
      awaitQuiescence: quiesced,
      inspectReadiness: (name, id, status) => boundary.inspectProviderReadiness(name, id, status, {
        directory: fixture.directory, uid: process.getuid(),
      }),
      removeReadiness: (filename) => boundary.removeReadinessFile(
        path.join(fixture.directory, path.basename(filename)), fixture.directory,
      ),
    }),
    enumerateUnits: (provider) => {
      events.push(`enumerate-empty:${provider}`);
      return [];
    },
    recoverEgress: quiesced,
    clearLaunchLock: (proof) => {
      events.push('clear-lock');
      return boundary.clearStaleGlobalLaunchLockAfterQuiescence({
        ...fixture.options, ...proof, readStartTime: () => null,
      });
    },
    ...overrides,
  });
  return { recovery, events, directory };
}

test('global panic fences delayed exact submissions even after empty enumeration', async (t) => {
  const fixture = launchTransactionFixture(t);
  await assert.rejects(fixture.run('claude', {
    spawnImpl: () => { throw new Error('fixture submission reply lost'); },
  }));
  await assert.rejects(fixture.run('codex'), /global workspace lock/);
  const panic = panicRecoveryFixture(fixture);
  const recovered = await panic.recovery();
  assert.equal(recovered.persisted, true);
  assert.equal(recovered.quiesced, true);
  assert.equal(recovered.launchCount, 0);
  assert.equal(recovered.retainedLaunchCount, 2);
  assert.equal(recovered.launchLockRecovery.removed, true);
  assert.equal(fs.existsSync(fixture.lockPath), false);
  assert.deepEqual(panic.events, [
    'panic-persisted',
    `tombstone:claude:${fixture.launchIds.claude}`,
    `tombstone:codex:${fixture.launchIds.claude}`,
    'enumerate-empty:claude', 'enumerate-empty:codex', 'clear-lock',
  ]);
  for (const provider of ['claude', 'codex']) {
    const unit = boundary.unitName(provider, fixture.launchIds.claude);
    assert.equal(boundary.hasCancellationTombstone(unit, { directory: panic.directory }), true,
      'late exact submissions remain canceled after global admission recovery');
    assert.equal(fs.readlinkSync(path.join(panic.directory, unit)), '/dev/null');
  }
  // Simulate the separately authorized removal of global panic, not an
  // implicit unlock by recovery. Only the fresh launch identity can proceed.
  assert.equal(await fixture.run('codex', {
    operations: {
      hasCancellationTombstone: (unit) =>
        boundary.hasCancellationTombstone(unit, { directory: panic.directory }),
    },
  }), 0);
});

test('global recovery tolerates exact absent sibling and already-removed readiness, not unsafe evidence',
  async (t) => {
    for (const provider of ['claude', 'codex']) {
      for (const scenario of ['normal', 'egress-retry', 'invalid', 'symlink', 'broad-mode']) {
        await t.test(`${provider}: ${scenario}`, async (t) => {
          const fixture = launchTransactionFixture(t);
          await assert.rejects(fixture.run(provider, {
            operations: { waitQuiesced: async () => ({ quiesced: false }) },
          }));
          const launchId = fixture.launchIds[provider];
          const readiness = path.join(fixture.directory, `${provider}.${launchId}.provider-readiness.jsonl`);
          if (scenario === 'invalid') fs.writeFileSync(readiness, 'not-json\n');
          if (scenario === 'broad-mode') fs.chmodSync(readiness, 0o644);
          if (scenario === 'symlink') {
            fs.renameSync(readiness, `${readiness}.original`);
            fs.symlinkSync(`${readiness}.original`, readiness);
          }
          let recoveringEgress = false;
          const panic = panicRecoveryFixture(fixture, {
            // A masked/stopped retained unit can still be enumerated and must
            // be safe to terminate again after its readiness has been removed.
            enumerateUnits: (name) => [boundary.unitName(name, launchId)],
            recoverEgress: async () => ({
              persisted: scenario !== 'egress-retry' || recoveringEgress,
              quiesced: scenario !== 'egress-retry' || recoveringEgress,
            }),
          });
          if (['invalid', 'symlink', 'broad-mode'].includes(scenario)) {
            await assert.rejects(panic.recovery(), /readiness evidence is (unsafe|invalid)/);
            assert.equal(fs.existsSync(fixture.lockPath), true);
            const successor = provider === 'claude' ? 'codex' : 'claude';
            await assert.rejects(fixture.run(successor), /global workspace lock/);
            return;
          }
          if (scenario === 'egress-retry') {
            assert.equal((await panic.recovery()).quiesced, false);
            assert.equal(fs.existsSync(readiness), false);
            assert.equal(fs.existsSync(fixture.lockPath), true);
            recoveringEgress = true;
          }
          const result = await panic.recovery();
          assert.equal(result.quiesced, true);
          assert.equal(result.retainedLaunchCount, 2);
          assert.equal(result.launchCount, 2);
          assert.equal(fs.existsSync(readiness), false);
          assert.equal(fs.existsSync(fixture.lockPath), false);
        });
      }
    }
  });

test('failed global recovery never clears an uncertain launch fence', async (t) => {
  for (const name of ['tombstone failure', 'retained egress active', 'supervisor active',
    'supervisor proof malformed', 'enumeration failure', 'egress recovery failure',
    'lock identity replaced', 'lock appears after empty snapshot', 'owner still live']) {
    await t.test(name, async (t) => {
      const fixture = launchTransactionFixture(t);
      await assert.rejects(fixture.run('claude', {
        operations: { waitQuiesced: async () => ({ quiesced: false }) },
      }));
      const overrides = {};
      if (name === 'tombstone failure') {
        overrides.terminate = async () => { throw new Error('fixture tombstone failed'); };
      } else if (name === 'retained egress active') {
        overrides.terminate = async () => ({ persisted: true, quiesced: false });
      } else if (name.startsWith('supervisor')) {
        overrides.stopUnit = async () => ({
          quiesced: name === 'supervisor active' ? false : 'true',
        });
      } else if (name === 'enumeration failure') {
        overrides.enumerateUnits = () => { throw new Error('fixture enumeration failed'); };
      } else if (name === 'egress recovery failure') {
        overrides.recoverEgress = async () => ({ persisted: false, quiesced: true });
      } else if (name === 'lock appears after empty snapshot') {
        overrides.inspectLaunchLock = () => {
          const error = new Error('fixture lock initially absent');
          error.code = 'ENOENT';
          throw error;
        };
      } else if (name === 'lock identity replaced') {
        overrides.recoverEgress = async () => {
          const record = JSON.parse(fs.readFileSync(fixture.lockPath, 'utf8'));
          fs.writeFileSync(fixture.lockPath, `${JSON.stringify({ ...record, startTime: '1' })}\n`);
          return { persisted: true, quiesced: true };
        };
      } else if (name === 'owner still live') {
        overrides.clearLaunchLock = (proof) => boundary.clearStaleGlobalLaunchLockAfterQuiescence({
          ...fixture.options, ...proof,
        });
      }
      const panic = panicRecoveryFixture(fixture, overrides);
      if (['tombstone failure', 'enumeration failure'].includes(name)) {
        await assert.rejects(panic.recovery());
      } else {
        assert.equal((await panic.recovery()).quiesced, false);
      }
      assert.equal(fs.existsSync(fixture.lockPath), true);
      await assert.rejects(fixture.run('codex'), /global workspace lock/);
      assert.equal(fixture.calls.some((call) => call.provider === 'codex'), false);
    });
  }
});

test('missing readiness is cleanup-only and never a never-started or retry-safe result', async (t) => {
  const fixture = launchTransactionFixture(t);
  const options = {
    control: async () => ({ persisted: true, quiesced: true }),
    persistTombstone: () => true,
    runSystemctl: () => ({ status: 0 }),
    awaitQuiescence: async () => ({ quiesced: true }),
    inspectReadiness: (provider, launchId, status) => boundary.inspectProviderReadiness(
      provider, launchId, status, { directory: fixture.directory, uid: process.getuid() },
    ),
    removeReadiness: (filename) => boundary.removeReadinessFile(
      path.join(fixture.directory, path.basename(filename)), fixture.directory,
    ),
  };
  const terminate = (overrides = {}) => boundary.terminateUnit('claude', fixture.launchIds.claude, {
    ...options, ...overrides,
  });
  await assert.rejects(terminate(), { code: 'PROVIDER_READINESS_MISSING' });
  await assert.rejects(terminate({ allowMissingReadinessForGlobalRecovery: 'true' }), {
    code: 'PROVIDER_READINESS_MISSING',
  });
  const cleanup = await terminate({ allowMissingReadinessForGlobalRecovery: true });
  assert.equal(cleanup.quiesced, true);
  assert.equal(cleanup.providerHistoryUnavailable, true);
  for (const key of ['providerExecutionAttempted', 'providerSpawnedEver', 'providerAlive', 'retrySafe']) {
    assert.equal(Object.hasOwn(cleanup, key), false, `${key} must not fabricate absent history`);
  }
  for (const unproved of [
    { control: async () => ({ persisted: false, quiesced: true }) },
    { control: async () => ({ persisted: true, quiesced: false }) },
    { runSystemctl: () => ({ status: 1 }) },
    { awaitQuiescence: async () => ({ quiesced: false }) },
  ]) {
    await assert.rejects(terminate({ allowMissingReadinessForGlobalRecovery: true, ...unproved }), {
      code: 'PROVIDER_READINESS_MISSING',
    });
  }
  fs.chmodSync(fixture.directory, 0o777);
  await assert.rejects(terminate({ allowMissingReadinessForGlobalRecovery: true }),
    /root boundary directory is unsafe/);
  fs.chmodSync(fixture.directory, 0o700);
  assert.throws(() => boundary.parseControl([
    '--action', 'terminate', '--provider', 'claude', '--launch-id', fixture.launchIds.claude,
    '--allow-missing-readiness-for-global-recovery', 'true',
  ], { SUDO_USER: 'teleagent-claude-supervisor' }, { uid: 0 }), /identity is invalid/);
});

test('global panic is authoritative at every provider launch commit boundary', () => {
  assert.throws(
    () => boundary.assertGlobalProviderLaunchUnlocked({ isLocked: () => true }),
    /panic-locked/
  );
  assert.equal(
    boundary.assertGlobalProviderLaunchUnlocked({ isLocked: () => false }),
    true
  );
  const source = fs.readFileSync(
    path.join(__dirname, '../../deploy/worker-session/teleagent-provider-boundary'), 'utf8'
  );
  const launchBranch = source.slice(
    source.indexOf("if (input.action === 'launch')"),
    source.indexOf("if (input.action === 'status')")
  );
  const checks = [...launchBranch.matchAll(/assertGlobalProviderLaunchUnlocked\(\)/g)]
    .map((match) => match.index);
  const register = launchBranch.indexOf("action: 'register'");
  const spawn = launchBranch.indexOf('const child = spawnImpl');
  assert.ok(checks.length >= 4);
  assert.ok(checks.some((index) => index < register));
  assert.ok(checks.some((index) => index > register && index < spawn));
  assert.ok(checks.some((index) => index > launchBranch.indexOf('buildSystemdRunInvocation') &&
    index < spawn));
});

test('workspace git configuration is read from one bounded stable descriptor', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-config-descriptor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'config');
  fs.writeFileSync(config, '[core]\n\trepositoryformatversion = 0\n');
  assert.equal(
    boundary.readStableBoundedFile(config),
    '[core]\n\trepositoryformatversion = 0\n'
  );
  fs.writeFileSync(config, Buffer.alloc(1025, 0x61));
  assert.throws(
    () => boundary.readStableBoundedFile(config, 1024),
    /bounded regular-file contract/
  );
  const link = path.join(directory, 'config-link');
  fs.symlinkSync(config, link);
  assert.throws(() => boundary.readStableBoundedFile(link, 2048));
  const source = fs.readFileSync(
    path.join(__dirname, '../../deploy/worker-session/teleagent-provider-boundary'), 'utf8'
  );
  assert.doesNotMatch(source,
    /const gitConfig = fs\.readFileSync\(filename/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /fs\.fstatSync\(descriptor, \{ bigint: true \}\)/);
});

test('root boundary forwards the exact trusted launch binding on register', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-control-'));
  const socketPath = path.join(directory, 'control.sock');
  let observed = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      observed = {
        method: request.method,
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, registered: true }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await boundary.providerControl({
      action: 'register',
      provider: 'claude',
      launchId: 'launch_11111111111111111111111111111111',
      capability: 'a'.repeat(64),
      expiresAtMs: 1_800_000_000_000,
      model: 'claude-sonnet-5',
      reasoningEffort: 'high',
      routeKinds: ['inference', 'count_tokens'],
      mode: 'managed',
    }, { socketPath });
    assert.equal(observed.method, 'POST');
    assert.equal(observed.path, '/v1/control/register');
    assert.equal(observed.body.model, 'claude-sonnet-5');
    assert.equal(observed.body.reasoningEffort, 'high');
    assert.deepEqual(observed.body.routeKinds, ['inference', 'count_tokens']);
    assert.equal(observed.body.mode, 'managed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('root boundary binds only exact canonical provider model IDs', () => {
  for (const model of [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'claude-opus-5',
  ]) {
    assert.deepEqual(
      boundary.deriveProviderLaunchPolicy('claude', ['-p', '--model', model]),
      {
        model,
        reasoningEffort: model === 'claude-haiku-4-5-20251001' ? 'default' : 'high',
        routeKinds: ['inference', 'count_tokens'],
      }
    );
  }
  for (const [model, reasoningEffort] of [
    ['gpt-5.6-luna', 'low'],
    ['gpt-5.6-terra', 'medium'],
    ['gpt-5.6-sol', 'high'],
  ]) {
    assert.deepEqual(
      boundary.deriveProviderLaunchPolicy('codex', [
        '--config', `model_reasoning_effort="${reasoningEffort}"`,
        'exec', '--model', model,
      ]),
      { model, reasoningEffort, routeKinds: ['inference'] }
    );
  }
  assert.throws(
    () => boundary.deriveProviderLaunchPolicy('codex', [
      '--config', 'model_reasoning_effort="max"',
      'exec', '--model', 'gpt-5.6-luna',
    ]),
    /reasoning effort does not match/
  );
  for (const alias of ['haiku', 'sonnet', 'opus', 'claude-haiku-4-5']) {
    assert.throws(
      () => boundary.deriveProviderLaunchPolicy('claude', ['-p', '--model', alias]),
      /model is not an approved canonical ID/
    );
  }
});

test('global panic actions admit only the isolated session broker and keep supervisors fenced', () => {
  assert.deepEqual(boundary.parseControl(['--action', 'panic-all'], {
    SUDO_USER: 'teleagent-session-broker',
  }, { uid: 0 }), {
    action: 'panic-all', provider: null, launchId: null, spec: null,
  });
  assert.deepEqual(boundary.parseControl(['--action', 'assert-global-unlocked'], {}, { uid: 0 }), {
    action: 'assert-global-unlocked', provider: null, launchId: null, spec: null,
  });
  assert.deepEqual(boundary.parseControl([
    '--action', 'assert-supervisor-start-admitted',
  ], {}, { uid: 0 }), {
    action: 'assert-supervisor-start-admitted', provider: null, launchId: null, spec: null,
  });
  assert.deepEqual(boundary.parseControl([
    '--action', 'attest-workspace-storage',
  ], { SUDO_USER: 'root-installer-caller' }, { uid: 0 }), {
    action: 'attest-workspace-storage', provider: null, launchId: null, spec: null,
  });
  assert.deepEqual(boundary.parseControl([
    '--action', 'attest-provider-plane-storage',
  ], { SUDO_USER: 'root-installer-caller' }, { uid: 0 }), {
    action: 'attest-provider-plane-storage', provider: null, launchId: null, spec: null,
  });
  assert.deepEqual(boundary.parseControl([
    '--action', 'attest-worker-storage',
  ], {}, { uid: 0 }), {
    action: 'attest-worker-storage', provider: null, launchId: null, spec: null,
  });
  assert.throws(
    () => boundary.parseControl([
      '--action', 'attest-workspace-storage', '--provider', 'claude',
    ], {}, { uid: 0 }),
    /global provider boundary identity/
  );
  assert.throws(
    () => boundary.parseControl([
      '--action', 'attest-workspace-storage',
    ], {}, { uid: 1000 }),
    /global provider boundary identity/
  );
  assert.throws(
    () => boundary.parseControl(['--action', 'recover-root-panic'], {
      SUDO_USER: 'teleagent-claude-worker',
    }, { uid: 0 }),
    /global provider boundary identity/,
  );
  assert.deepEqual(boundary.parseControl(['--action', 'recover-root-panic'], {}, { uid: 0 }), {
    action: 'recover-root-panic', provider: null, launchId: null, spec: null,
  });
  assert.deepEqual(boundary.parseControl(['--action', 'recover-root-panic'], {
    SUDO_USER: 'teleagent-session-broker',
  }, { uid: 0 }), {
    action: 'recover-root-panic', provider: null, launchId: null, spec: null,
  });
});

test('root recovery commits the global unlock only after both locked supervisors answer health', async () => {
  const order = [];
  const state = { panic: true, recovery: false };
  const ok = { status: 0, signal: null, error: null, stdout: '' };
  const result = await boundary.unlockAllProviderPlanes({
    activationProviders: ['claude', 'codex'],
    panicAll: async () => {
      order.push('panic-all');
      return { persisted: true, quiesced: true };
    },
    persistRecovery: () => {
      assert.equal(state.panic, true);
      state.recovery = true;
      order.push('persist-recovery');
      return { persisted: true };
    },
    runSystemctl: (args) => {
      order.push(`systemctl:${args[0]}:${args.at(-1)}`);
      return ok;
    },
    forceStop: async () => {
      assert.fail('successful recovery must not enter rollback');
    },
    probe: async (provider) => {
      assert.equal(state.panic, true);
      assert.equal(state.recovery, true);
      order.push(`probe:${provider}`);
      return {
        success: true,
        provider,
        ready: false,
        panicLocked: true,
        boundaryRecovered: true,
        active: 0,
      };
    },
    clearRecovery: () => {
      assert.equal(state.panic, true);
      state.recovery = false;
      order.push('clear-recovery');
      return { persisted: true };
    },
    clearPanic: () => {
      assert.equal(state.recovery, false);
      state.panic = false;
      order.push('clear-panic');
      return { persisted: true };
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(state, { panic: false, recovery: false });
  assert.ok(order.indexOf('probe:claude') < order.indexOf('clear-recovery'));
  assert.ok(order.indexOf('probe:codex') < order.indexOf('clear-recovery'));
  assert.deepEqual(order.slice(-2), ['clear-recovery', 'clear-panic']);
});

test('Codex-only panic and unlock never restart Claude or require its egress broker', async () => {
  const panicCommands = [];
  const recovered = [];
  const panic = await boundary.panicAllProviderPlanes({
    activationProviders: ['codex'],
    persistPanic: () => ({ persisted: true }),
    runSystemctl: (args) => {
      panicCommands.push(args.join(' '));
      return { status: 0, signal: null, error: null };
    },
    stopUnit: async () => ({ quiesced: true }),
    enumerateUnits: () => [],
    recoverEgress: async (provider) => {
      recovered.push(provider);
      return { persisted: true, quiesced: true };
    },
    inspectLaunchLock: () => {
      const error = new Error('absent');
      error.code = 'ENOENT';
      throw error;
    },
    clearLaunchLock: () => ({ proved: true, removed: false }),
  });
  assert.equal(panic.quiesced, true);
  assert.deepEqual(recovered, ['codex']);
  assert.equal(panic.egress.claude.disabled, true);
  assert.ok(panicCommands.includes('stop teleagent-provider-egress@claude.socket'));
  assert.ok(panicCommands.includes('stop teleagent-provider-egress-control@claude.socket'));

  const unlockCommands = [];
  const unlock = await boundary.unlockAllProviderPlanes({
    activationProviders: ['codex'],
    panicAll: async () => ({ persisted: true, quiesced: true }),
    persistRecovery: () => ({ persisted: true }),
    clearRecovery: () => ({ persisted: true }),
    clearPanic: () => ({ persisted: true }),
    runSystemctl: (args) => {
      unlockCommands.push(args.join(' '));
      return { status: 0, signal: null, error: null };
    },
    forceStop: async () => assert.fail('Codex-only unlock must not roll back'),
    probe: async (provider) => ({
      success: true, provider, ready: false, panicLocked: true,
      boundaryRecovered: true, active: 0,
    }),
  });
  assert.equal(unlock.success, true);
  assert.ok(unlockCommands.some((command) => command ===
    'start teleagent-provider-supervisor@codex.socket'));
  assert.ok(unlockCommands.every((command) => !command.includes('@claude.')));
});

test('root provider activation mode accepts only a stable exact root-owned selection', () => {
  const content = Buffer.from('codex\n');
  const metadata = {
    dev: 7, ino: 11, uid: 0, gid: 0, mode: 0o100444,
    nlink: 1, size: content.length, mtimeMs: 2, ctimeMs: 3,
    isFile: () => true, isSymbolicLink: () => false,
  };
  const filesystem = {
    constants: fs.constants,
    openSync: (filename, flags) => {
      assert.equal(filename, '/etc/teleagent/provider-runtime/enabled-providers');
      assert.notEqual(flags & fs.constants.O_NOFOLLOW, 0);
      return 31;
    },
    fstatSync: () => metadata,
    readFileSync: () => content,
    closeSync: (descriptor) => assert.equal(descriptor, 31),
  };
  assert.deepEqual(boundary.readEnabledProviders({ filesystem }), ['codex']);
  assert.throws(() => boundary.readEnabledProviders({
    filesystem: { ...filesystem, readFileSync: () => Buffer.from('codex,claude\n') },
  }), /activation mode is invalid/u);
  assert.throws(() => boundary.readEnabledProviders({
    filesystem: {
      ...filesystem,
      fstatSync: () => ({ ...metadata, mode: 0o100666 }),
    },
  }), /activation mode metadata is unsafe/u);
});

test('Codex-only activation refuses Claude launches before any model effect', () => {
  assert.equal(boundary.assertProviderEnabled('codex', {
    readProviders: () => ['codex'],
  }), true);
  assert.throws(() => boundary.assertProviderEnabled('claude', {
    readProviders: () => ['codex'],
  }), /provider is disabled by the root activation mode/u);
});

test('root recovery keeps panic locked and remasks when a supervisor is not locally locked', async () => {
  const commands = [];
  let panicCleared = false;
  let recoveryPending = false;
  let stopped = 0;
  const result = await boundary.unlockAllProviderPlanes({
    activationProviders: ['claude', 'codex'],
    panicAll: async () => ({ persisted: true, quiesced: true }),
    persistRecovery: () => {
      recoveryPending = true;
      return { persisted: true };
    },
    clearRecovery: () => {
      recoveryPending = false;
      return { persisted: true };
    },
    clearPanic: () => {
      panicCleared = true;
      return { persisted: true };
    },
    runSystemctl: (args) => {
      commands.push(args);
      return { status: 0, signal: null, error: null, stdout: '' };
    },
    forceStop: async () => {
      stopped += 1;
      return { quiesced: true };
    },
    probe: async (provider) => ({
      success: true,
      provider,
      ready: provider === 'codex',
      panicLocked: provider === 'claude',
      boundaryRecovered: true,
      active: 0,
    }),
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'PROVIDER_RESTART_NOT_LOCKED');
  assert.equal(panicCleared, false);
  assert.equal(recoveryPending, false);
  assert.equal(stopped, 2);
  assert.ok(commands.some((args) => args[0] === 'mask'));
});

test('provider-qualified planned readiness is retry-safe and cross-provider recovery cannot purge it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-readiness-'));
  const launchId = 'launch_11111111111111111111111111111111';
  const filename = path.join(directory, `codex.${launchId}.provider-readiness.jsonl`);
  try {
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(filename, `${JSON.stringify({
      version: 1,
      type: 'provider_planned',
      provider: 'codex',
      launchId,
    })}\n`, { mode: 0o600 });
    assert.deepEqual(boundary.inspectProviderReadiness(
      'codex', launchId,
      { quiesced: false, controlGroup: '/planned' },
      { directory, uid: process.getuid() }
    ), {
      providerExecutionAttempted: false,
      providerSpawnedEver: false,
      providerAlive: false,
    });
    fs.appendFileSync(filename, `${JSON.stringify({
      version: 1,
      type: 'provider_start_intent',
      provider: 'codex',
      launchId,
    })}\n`);
    assert.deepEqual(boundary.inspectProviderReadiness(
      'codex', launchId,
      { quiesced: true, controlGroup: null },
      { directory, uid: process.getuid() }
    ), {
      providerExecutionAttempted: true,
      providerSpawnedEver: false,
      providerAlive: false,
    });
    assert.equal(boundary.purgeProviderReadinessArtifacts('claude', {
      directory,
      uid: process.getuid(),
    }), 0);
    assert.equal(fs.existsSync(filename), true);
    assert.equal(boundary.purgeProviderReadinessArtifacts('codex', {
      directory,
      uid: process.getuid(),
    }), 1);
    assert.equal(fs.existsSync(filename), false);
    assert.throws(
      () => boundary.inspectProviderReadiness(
        'codex', launchId, { exists: true, quiesced: false, controlGroup: '/live' },
        { directory, uid: process.getuid() }
      ),
      /readiness evidence is missing/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('instant provider exit is observed before a later readiness wait', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(23)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exit = observeChildExit(child);
  // Model the boundary persisting/inspecting readiness after the wrapper has
  // already disappeared. The exit event must remain awaitable.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await exit, { code: 23, signal: null });

  const runtimeSource = fs.readFileSync(
    path.join(__dirname, '../../deploy/worker-session/teleagent-provider-boundary-runtime'),
    'utf8'
  );
  assert.ok(
    runtimeSource.indexOf('observeChildExit(runtime)') <
      runtimeSource.indexOf('await waitForProviderSpawn(runtime'),
    'exit observation must be installed before awaiting provider readiness'
  );
});

test('boundary parser binds sudo identity, provider, launch, workspace, and argv', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-boundary-parse-'));
  const workspace = path.join(directory, 'phone');
  fs.mkdirSync(workspace);
  try {
    // The production parser has a fixed workspace root. Its exact root check is
    // separately asserted by source deployment tests; use the canonical value
    // here only to prove identity/argv rejection without mutating the host.
    assert.throws(
      () => boundary.parseControl(launchArgs(workspace), {
        SUDO_USER: 'teleagent-codex-supervisor',
      }, { uid: 0 }),
      /identity is invalid/
    );
    assert.throws(
      () => boundary.parseControl([
        '--action', 'terminate', '--provider', 'claude',
        '--launch-id', 'launch_11111111111111111111111111111111', '--', '/bin/sh',
      ], { SUDO_USER: 'teleagent-claude-supervisor' }, { uid: 0 }),
      /control action contains launch arguments/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('boot-lifetime cancellation tombstone is atomic, idempotent, and conflict closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-mask-'));
  const unit = 'teleagent-provider-launch-claude-11111111111111111111111111111111.service';
  let reloads = 0;
  try {
    const options = { directory, uid: process.getuid(), reload: () => { reloads += 1; } };
    assert.equal(boundary.persistCancellationTombstone(unit, options), true);
    assert.equal(boundary.hasCancellationTombstone(unit, { directory }), true);
    assert.equal(fs.readlinkSync(path.join(directory, unit)), '/dev/null');
    assert.equal(boundary.persistCancellationTombstone(unit, options), true);
    assert.equal(reloads, 2);

    const conflict = 'teleagent-provider-launch-claude-22222222222222222222222222222222.service';
    fs.writeFileSync(path.join(directory, conflict), 'unsafe');
    assert.throws(
      () => boundary.persistCancellationTombstone(conflict, options),
      /tombstone conflicts/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider recovery never treats systemd enumeration or status failure as quiescent', () => {
  const unavailable = () => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'Failed to connect to bus',
  });
  assert.throws(
    () => boundary.listProviderUnits('claude', { runSystemctl: unavailable }),
    /unit enumeration is unavailable/
  );
  assert.throws(
    () => boundary.inspectUnit(
      'teleagent-provider-launch-claude-11111111111111111111111111111111.service',
      { runSystemctl: unavailable }
    ),
    /unit status is unavailable/
  );
  assert.throws(
    () => boundary.listProviderUnits('claude', {
      runSystemctl: () => ({ status: 0, signal: null, stdout: 'truncated-or-foreign-output\n' }),
    }),
    /unit enumeration is invalid/
  );

  const notFound = boundary.inspectUnit(
    'teleagent-provider-launch-claude-11111111111111111111111111111111.service',
    { runSystemctl: () => ({
      status: 0,
      signal: null,
      stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n',
    }) }
  );
  assert.deepEqual(notFound, {
    exists: false,
    quiesced: true,
    activeState: 'not-found',
    controlGroup: null,
  });
  assert.throws(
    () => boundary.inspectUnit(
      'teleagent-provider-launch-claude-11111111111111111111111111111111.service',
      { runSystemctl: () => ({
        status: 0,
        signal: null,
        stdout: 'LoadState=not-found\nActiveState=active\nSubState=running\nControlGroup=/live\n',
      }) }
    ),
    /missing-unit status is inconsistent/
  );
});

test('termination cancels queued start jobs even when the cgroup is already empty', async () => {
  let queuedStart = true;
  let readinessRemoved = false;
  const calls = [];
  const unit = boundary.unitName('claude', 'launch_11111111111111111111111111111111');
  const result = await boundary.terminateUnit('claude', 'launch_11111111111111111111111111111111', {
    persistTombstone: (name) => {
      assert.equal(name, unit);
      calls.push('mask');
      return true;
    },
    control: async () => ({ persisted: true, quiesced: true }),
    runSystemctl: (args) => {
      assert.equal(args.at(-1), unit);
      calls.push(args[0]);
      if (args[0] === 'stop') {
        assert.ok(args.includes('--job-mode=replace'));
        queuedStart = false;
      }
      return { status: 0, signal: null };
    },
    awaitQuiescence: async () => {
      calls.push('empty-cgroup');
      return { quiesced: true, activeState: 'inactive' };
    },
    inspectReadiness: () => ({}),
    removeReadiness: () => { readinessRemoved = true; },
  });
  assert.equal(result.quiesced, true);
  assert.equal(queuedStart, false, 'an empty cgroup does not mean there is no queued start job');
  assert.equal(readinessRemoved, true);
  assert.deepEqual(calls, ['mask', 'kill', 'stop', 'empty-cgroup']);
});

test('an unavailable stop proof cannot release termination or readiness evidence', async () => {
  for (const stopResult of [null, undefined, { status: 1 }, { status: 0, signal: 'SIGTERM' },
    { status: 0, error: new Error('fixture bus failure') }, { status: '0' }]) {
    let readinessRemoved = false;
    const result = await boundary.terminateUnit('claude', 'launch_11111111111111111111111111111111', {
      persistTombstone: () => true,
      control: async () => ({ persisted: true, quiesced: true }),
      runSystemctl: (args) => args[0] === 'stop' ? stopResult : { status: 0 },
      awaitQuiescence: async () => ({ quiesced: true }),
      inspectReadiness: () => ({}),
      removeReadiness: () => { readinessRemoved = true; },
    });
    assert.equal(result.persisted, true);
    assert.equal(result.quiesced, false);
    assert.equal(readinessRemoved, false);
  }
});

test('termination retry requires its own successful stop proof', async () => {
  for (const stopStatuses of [[0, 1], [1, 0]]) {
    let stopCalls = 0;
    let statusCalls = 0;
    let readinessRemoved = false;
    const result = await boundary.terminateUnit('claude', 'launch_11111111111111111111111111111111', {
      persistTombstone: () => true,
      control: async () => ({ persisted: true, quiesced: true }),
      runSystemctl: (args) => ({ status: args[0] === 'stop' ? stopStatuses[stopCalls++] : 0 }),
      awaitQuiescence: async () => ({ quiesced: ++statusCalls === 2 }),
      inspectReadiness: () => ({}),
      removeReadiness: () => { readinessRemoved = true; },
    });
    assert.equal(stopCalls, 2);
    assert.equal(statusCalls, 2);
    assert.equal(result.quiesced, stopStatuses[1] === 0);
    assert.equal(readinessRemoved, stopStatuses[1] === 0);
  }
});

test('only an unambiguous populated zero can prove cgroup quiescence', () => {
  const unit = boundary.unitName('claude', 'launch_11111111111111111111111111111111');
  const runSystemctl = () => ({
    status: 0, signal: null,
    stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nControlGroup=/fixture\n',
  });
  for (const events of [
    '', 'frozen 0\n', 'populated\n', 'populated 2\n', 'populated 00\n',
    'populated false\n', 'populated 0', 'populated 0\r\n', 'populated 0\0\n',
    'populated 0\npopulated 0\n', 'populated 0\npopulated 1\n',
    'populated 0\nfrozen 0\nfrozen 0\n', 'populated 0\ninvalid\n',
    'populated 0\n' + 'x'.repeat(4096), 'populated 1\nfrozen 0\n',
  ]) {
    const status = boundary.inspectUnit(unit, { runSystemctl, readCgroupEvents: () => events });
    assert.equal(status.quiesced, false, `must not accept ${JSON.stringify(events.slice(0, 80))}`);
    assert.equal(status.populated, true);
  }
  assert.equal(boundary.inspectUnit(unit, {
    runSystemctl,
    readCgroupEvents: () => { throw new Error('fixture read failed'); },
  }).quiesced, false);
  for (const events of ['populated 0\n', 'populated 0\nfrozen 0\n', 'frozen 0\npopulated 0\n']) {
    const status = boundary.inspectUnit(unit, { runSystemctl, readCgroupEvents: () => events });
    assert.equal(status.quiesced, true);
    assert.equal(status.populated, false);
  }
});
