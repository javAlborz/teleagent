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
  assert.match(joined, /TasksMax=512/);
  assert.match(joined, /MemoryMax=4G/);
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
      stat: (filename) => ({ dev: filename === '/' ? 1n : (overrides.dev ?? 2n) }),
      statfs: () => ({
        bsize: 4096n,
        blocks: (overrides.total ?? (32n * gib)) / 4096n,
        bavail: (overrides.free ?? (8n * gib)) / 4096n,
      }),
    },
  );
  assert.deepEqual(inspect(), { totalBytes: 32n * gib, freeBytes: 8n * gib });
  assert.throws(() => inspect({ dev: 1n }), /dedicated filesystem/);
  assert.throws(() => inspect({ total: 65n * gib }), /size or free-space/);
  assert.throws(() => inspect({ free: 1n * gib }), /size or free-space/);
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
