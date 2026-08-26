'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
  assert.deepEqual(inspect(), { totalBytes: 32n * gib, freeBytes: 8n * gib });
  assert.throws(() => inspect({ parentDev: 2n }), /dedicated filesystem mountpoint/);
  assert.throws(() => inspect({ total: 65n * gib }), /size or free-space/);
  assert.throws(() => inspect({ free: 1n * gib }), /size or free-space/);
  assert.throws(
    () => boundary.validateWorkspaceStorageBoundary('/srv'),
    /exact dedicated mountpoint/
  );
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

test('root recovery keeps panic locked and remasks when a supervisor is not locally locked', async () => {
  const commands = [];
  let panicCleared = false;
  let recoveryPending = false;
  let stopped = 0;
  const result = await boundary.unlockAllProviderPlanes({
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
