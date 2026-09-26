'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  createMemoryPanicState,
  createProviderSupervisor,
  normalizeLaunch,
  startProviderSupervisor,
  validateProviderPlaneStorageBoundary,
} = require('../provider-supervisor-service');

function config() {
  return {
    provider: 'claude',
    uid: process.getuid(),
    gid: process.getgid(),
    spec: {
      supervisorUser: 'teleagent-claude-supervisor',
      supervisorHome: '/var/lib/teleagent-provider-plane/claude-supervisor',
      runtimeUser: 'teleagent-claude-worker',
      runtimeHome: '/var/lib/teleagent-claude-worker',
      command: '/opt/teleagent/agent-tools/claude',
      socket: '/run/teleagent-provider-launch/claude.sock',
    },
  };
}

function providerPlaneStorage(overrides = {}) {
  const root = '/var/lib/teleagent-provider-plane';
  const parent = '/var/lib';
  const home = `${root}/claude-supervisor`;
  const metadata = ({ uid, gid, mode }) => ({
    uid,
    gid,
    mode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  return validateProviderPlaneStorageBoundary({
    supervisorHome: home,
    expectedUid: 991,
    expectedGid: 992,
    lstat: (filename) => {
      if (filename === parent) return metadata({ uid: 0, gid: 0, mode: 0o40755 });
      if (filename === root) {
        return metadata({ uid: 0, gid: 0, mode: overrides.rootMode ?? 0o40751 });
      }
      assert.equal(filename, home);
      return metadata({
        uid: overrides.uid ?? 991,
        gid: overrides.gid ?? 992,
        mode: overrides.homeMode ?? 0o40700,
      });
    },
    realpath: (filename) => filename,
    stat: (filename) => ({
      dev: filename === parent
        ? 1n
        : filename === root
          ? (overrides.rootDev ?? 2n)
          : (overrides.homeDev ?? 2n),
    }),
    statfs: () => ({
      type: overrides.filesystemType ?? 0xef53n,
      bsize: 4096n,
      blocks: (overrides.capacity ?? (2n * 1024n * 1024n * 1024n)) / 4096n,
      bavail: (overrides.free ?? (768n * 1024n * 1024n)) / 4096n,
    }),
  });
}

test('provider supervisor state requires its exact bounded dedicated mount and reserve', async () => {
  const healthy = providerPlaneStorage();
  assert.equal(healthy.root, '/var/lib/teleagent-provider-plane');
  assert.equal(healthy.directory,
    '/var/lib/teleagent-provider-plane/claude-supervisor');
  assert.equal(healthy.requiredFreeBytes, 512n * 1024n * 1024n);
  assert.throws(() => providerPlaneStorage({ rootDev: 1n }), /dedicated storage boundary/);
  assert.throws(() => providerPlaneStorage({ homeDev: 3n }), /dedicated storage boundary/);
  assert.throws(() => providerPlaneStorage({ rootMode: 0o40771 }), /dedicated storage boundary/);
  assert.throws(() => providerPlaneStorage({ uid: 993 }), /dedicated storage boundary/);
  assert.throws(
    () => providerPlaneStorage({ capacity: 5n * 1024n * 1024n * 1024n }),
    /1-4 GiB/
  );
  assert.throws(
    () => providerPlaneStorage({ free: 511n * 1024n * 1024n }),
    /reserve is exhausted/
  );
  assert.throws(
    () => providerPlaneStorage({ filesystemType: 0x01021994n }),
    /durable local filesystem/
  );
  assert.throws(
    () => providerPlaneStorage({ filesystemType: 0x6969n }),
    /durable local filesystem/
  );
  for (const filesystemType of [
    0xef53n,
    0x58465342n,
    BigInt.asIntN(32, 0x9123683en),
    BigInt.asIntN(32, 0xf2f52010n),
    0x2fc12fc1n,
  ]) {
    assert.doesNotThrow(() => providerPlaneStorage({ filesystemType }));
  }

  let recoveryCalled = false;
  await assert.rejects(startProviderSupervisor({
    config: config(),
    ptySpawnImpl: assert.fail,
    validateStorage: () => { throw new Error('storage startup refused'); },
    boundaryControl: {
      recover: async () => { recoveryCalled = true; },
    },
  }), /storage startup refused/);
  assert.equal(recoveryCalled, false);
});

function frameSocket(socketPath) {
  const socket = net.createConnection({ path: socketPath });
  let buffer = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  const deliver = (value) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else frames.push(value);
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      deliver(JSON.parse(line.toString('utf8')));
    }
  });
  return {
    socket,
    send(value) { socket.write(`${JSON.stringify(value)}\n`); },
    next(timeoutMs = 3000) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timed out')), timeoutMs);
        waiters.push({ resolve(value) { clearTimeout(timer); resolve(value); } });
      });
    },
  };
}

async function listen(runtime, socketPath) {
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(socketPath, resolve);
  });
}

async function connect(client) {
  await new Promise((resolve, reject) => {
    client.socket.once('connect', resolve);
    client.socket.once('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not reached before timeout');
}

function startFrame(workspace, overrides = {}) {
  return {
    version: 1,
    type: 'start',
    provider: 'claude',
    mode: 'managed',
    accessMode: 'read-only',
    cwd: workspace,
    taskId: 'job_provider_lifecycle',
    sessionId: null,
    args: ['-p'],
    ...overrides,
  };
}

function fakeRuntime() {
  const runtime = new EventEmitter();
  runtime.stdin = new PassThrough();
  runtime.stdout = new PassThrough();
  runtime.stderr = new PassThrough();
  runtime.kill = () => {
    queueMicrotask(() => runtime.emit('close', null, 'SIGKILL'));
    return true;
  };
  return runtime;
}

function boundaryHarness() {
  const calls = [];
  const statuses = new Map();
  return {
    calls,
    statuses,
    control: {
      async status(provider, launchId) {
        calls.push(['status', provider, launchId]);
        return statuses.get(launchId) || {
          quiesced: false,
          providerSpawnedEver: true,
          providerAlive: true,
        };
      },
      async terminate(provider, launchId) {
        calls.push(['terminate', provider, launchId]);
        const state = statuses.get(launchId);
        if (state?.terminate) return state.terminate();
        return { accepted: true, persisted: true, quiesced: true };
      },
      async recover(provider) {
        calls.push(['recover', provider]);
        return { accepted: true, persisted: true, quiesced: true, unitCount: 0 };
      },
    },
  };
}

test('launch normalization binds a canonical child workspace and exact provider mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-workspace-'));
  const workspace = path.join(directory, 'phone');
  fs.mkdirSync(workspace);
  try {
    const launch = normalizeLaunch(startFrame(workspace), config(), directory);
    assert.equal(launch.cwd, workspace);
    assert.equal(launch.mode, 'managed');
    assert.throws(() => normalizeLaunch(startFrame(directory), config(), directory), /outside policy/);
    assert.throws(
      () => normalizeLaunch(startFrame(workspace, { provider: 'codex' }), config(), directory),
      /identity is invalid/
    );
    assert.throws(() => normalizeLaunch(startFrame(workspace, {
      provider: 'codex', mode: 'interactive', accessMode: 'mutating',
      sessionId: '019ff711-d480-7f22-8fd4-01acf85cb83d', args: [],
    }), { ...config(), provider: 'codex' }, directory), /outside policy/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('launcher exit is not terminal until the exact transient cgroup is verified empty', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-boundary-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  const boundary = boundaryHarness();
  let resolveTermination;
  let child;
  boundary.statuses.set('launch_11111111111111111111111111111111', {
    quiesced: false,
    providerSpawnedEver: true,
    providerAlive: true,
    terminate: () => new Promise((resolve) => { resolveTermination = resolve; }),
  });
  const runtime = createProviderSupervisor({
    config: config(),
    workspaceRoot: directory,
    boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_11111111111111111111111111111111',
    spawnImpl() {
      child = fakeRuntime();
      return child;
    },
  });
  try {
    await listen(runtime, socketPath);
    const client = frameSocket(socketPath);
    await connect(client);
    client.send(startFrame(workspace));
    const accepted = await client.next();
    assert.equal(accepted.type, 'accepted');
    assert.equal(accepted.launchId, 'launch_11111111111111111111111111111111');
    child.emit('close', 0, null);
    await waitFor(() => typeof resolveTermination === 'function');
    assert.equal(runtime.active.size, 1, 'an exited helper is not cgroup truth');
    resolveTermination({ accepted: true, persisted: true, quiesced: true });
    const terminal = await client.next();
    assert.equal(terminal.type, 'exit');
    assert.equal(terminal.quiesced, true);
    assert.equal(runtime.active.size, 0);
    assert.deepEqual(boundary.calls.slice(0, 3), [
      ['status', 'claude', accepted.launchId],
      ['status', 'claude', accepted.launchId],
      ['terminate', 'claude', accepted.launchId],
    ]);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider stdin is refused until a live model-spawn boundary is verified', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-ready-input-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  const boundary = boundaryHarness();
  let child;
  let providerAlive = false;
  boundary.control.status = async (_provider, launchId) => providerAlive ? {
    quiesced: false, providerSpawnedEver: true, providerAlive: true, launchId,
  } : {
    quiesced: false, providerHistoryUnavailable: true, launchId,
  };
  const runtime = createProviderSupervisor({
    config: config(), workspaceRoot: directory, boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_77777777777777777777777777777777',
    providerReadyPollMs: 5,
    spawnImpl() { child = fakeRuntime(); return child; },
  });
  let written = '';
  try {
    await listen(runtime, socketPath);
    const client = frameSocket(socketPath);
    await connect(client);
    client.send(startFrame(workspace));
    await waitFor(() => Boolean(child));
    child.stdin.on('data', (chunk) => { written += chunk.toString(); });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(written, '');
    assert.equal(runtime.active.size, 1);
    assert.equal(boundary.calls.some(([action]) => action === 'terminate'), false);
    providerAlive = true;
    assert.equal((await client.next()).type, 'accepted');
    client.send({ version: 1, type: 'stdin', data: Buffer.from('approved input').toString('base64') });
    await waitFor(() => written === 'approved input');
    client.socket.destroy();
    await waitFor(() => runtime.active.size === 0);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider output flood terminates the exact launch before any oversized frame is forwarded', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-output-bound-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  const boundary = boundaryHarness();
  let child;
  const runtime = createProviderSupervisor({
    config: config(), workspaceRoot: directory, boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_88888888888888888888888888888888',
    spawnImpl() { child = fakeRuntime(); return child; },
  });
  try {
    await listen(runtime, socketPath);
    const client = frameSocket(socketPath);
    await connect(client);
    client.send(startFrame(workspace));
    assert.equal((await client.next()).type, 'accepted');
    child.stdout.write(Buffer.alloc((8 * 1024 * 1024) + 1, 0x61));
    await waitFor(() => runtime.active.size === 0);
    assert.equal(
      boundary.calls.some(([action, , launchId]) => (
        action === 'terminate' && launchId === 'launch_88888888888888888888888888888888'
      )),
      true,
    );
    const terminal = await client.next();
    assert.equal(terminal.type, 'exit');
    assert.equal(terminal.quiesced, true);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('spawned-ever evidence makes an immediate model exit post-provider, not retry-safe pre-start', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-immediate-exit-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  let child;
  const boundary = boundaryHarness();
  boundary.control.status = async () => ({
    quiesced: true,
    providerSpawnedEver: true,
    providerAlive: false,
  });
  const runtime = createProviderSupervisor({
    config: config(), workspaceRoot: directory, boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_88888888888888888888888888888888',
    spawnImpl() { child = fakeRuntime(); return child; },
  });
  try {
    await listen(runtime, socketPath);
    const client = frameSocket(socketPath);
    await connect(client);
    client.send(startFrame(workspace));
    await waitFor(() => Boolean(child));
    child.emit('close', 1, null);
    const accepted = await client.next();
    const terminal = await client.next();
    assert.equal(accepted.type, 'accepted');
    assert.equal(terminal.type, 'exit');
    assert.equal(terminal.code, 1);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fsynced start intent without spawn confirmation is outcome-unknown and never receives stdin', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-intent-exit-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  let child;
  let written = '';
  const boundary = boundaryHarness();
  boundary.control.status = async () => ({
    quiesced: true,
    providerExecutionAttempted: true,
    providerSpawnedEver: false,
    providerAlive: false,
  });
  const runtime = createProviderSupervisor({
    config: config(), workspaceRoot: directory, boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    spawnImpl() {
      child = fakeRuntime();
      child.stdin.on('data', (chunk) => { written += chunk.toString(); });
      return child;
    },
  });
  try {
    await listen(runtime, socketPath);
    const client = frameSocket(socketPath);
    await connect(client);
    client.send(startFrame(workspace));
    await waitFor(() => Boolean(child));
    client.send({ version: 1, type: 'stdin', data: Buffer.from('must stay buffered').toString('base64') });
    child.emit('close', 77, null);
    const terminal = await client.next();
    assert.equal(terminal.type, 'error');
    assert.equal(terminal.code, 'PROVIDER_EXECUTION_OUTCOME_UNKNOWN');
    assert.equal(terminal.retrySafe, false);
    assert.equal(written, '');
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('wrapper exit with no spawned-ever evidence is definitive provider-not-started', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-never-started-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  let child;
  const boundary = boundaryHarness();
  boundary.control.status = async () => ({
    quiesced: true,
    providerSpawnedEver: false,
    providerAlive: false,
  });
  const runtime = createProviderSupervisor({
    config: config(), workspaceRoot: directory, boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_99999999999999999999999999999999',
    spawnImpl() { child = fakeRuntime(); return child; },
  });
  try {
    await listen(runtime, socketPath);
    const client = frameSocket(socketPath);
    await connect(client);
    client.send(startFrame(workspace));
    await waitFor(() => Boolean(child));
    child.emit('close', 77, null);
    const denied = await client.next();
    assert.equal(denied.type, 'error');
    assert.equal(denied.code, 'PROVIDER_NOT_STARTED');
    assert.equal(denied.providerStarted, false);
    assert.equal(denied.retrySafe, true);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('client loss reserves termination and waits for boundary quiescence before exit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-disconnect-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  const boundary = boundaryHarness();
  let child;
  const runtime = createProviderSupervisor({
    config: config(),
    workspaceRoot: directory,
    boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_22222222222222222222222222222222',
    spawnImpl() {
      child = fakeRuntime();
      return child;
    },
  });
  try {
    await listen(runtime, socketPath);
    const client = frameSocket(socketPath);
    await connect(client);
    client.send(startFrame(workspace));
    assert.equal((await client.next()).type, 'accepted');
    client.socket.destroy();
    await waitFor(() => runtime.active.size === 0);
    assert.ok(boundary.calls.some((call) => (
      call[0] === 'terminate' && call[1] === 'claude' &&
      call[2] === 'launch_22222222222222222222222222222222'
    )));
    assert.equal(child.signalCode, undefined);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('panic persists first, terminates exact launches, recovers orphans, and gates unlock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-panic-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  const boundary = boundaryHarness();
  const panicState = createMemoryPanicState();
  const runtime = createProviderSupervisor({
    config: config(), workspaceRoot: directory, panicState,
    boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_33333333333333333333333333333333',
    spawnImpl: () => fakeRuntime(),
  });
  try {
    await listen(runtime, socketPath);
    const provider = frameSocket(socketPath);
    await connect(provider);
    provider.send(startFrame(workspace));
    assert.equal((await provider.next()).type, 'accepted');

    const panic = frameSocket(socketPath);
    await connect(panic);
    panic.send({ version: 1, type: 'panic', reason: 'test', source: 'test' });
    const result = await panic.next();
    assert.equal(result.accepted, true);
    assert.equal(result.persisted, true);
    assert.equal(result.quiesced, true);
    assert.equal(panicState.status().locked, true);
    assert.ok(boundary.calls.some((call) => (
      call[0] === 'terminate' && call[1] === 'claude' &&
      call[2] === 'launch_33333333333333333333333333333333'
    )));
    assert.ok(boundary.calls.some((call) => call[0] === 'recover' && call[1] === 'claude'));

    const denied = frameSocket(socketPath);
    await connect(denied);
    denied.send(startFrame(workspace, { taskId: 'job_during_panic' }));
    assert.equal((await denied.next()).code, 'PROVIDER_SUPERVISOR_BUSY');

    const unlock = frameSocket(socketPath);
    await connect(unlock);
    unlock.send({ version: 1, type: 'unlock' });
    const unlocked = await unlock.next();
    assert.equal(unlocked.success, true);
    assert.equal(unlocked.quiesced, true);
    assert.equal(panicState.status().locked, false);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('boundary uncertainty keeps the supervisor panic-locked and not ready', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-unknown-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  const panicState = createMemoryPanicState();
  const boundary = boundaryHarness();
  boundary.control.terminate = async () => ({ accepted: true, persisted: true, quiesced: false });
  const runtime = createProviderSupervisor({
    config: config(), workspaceRoot: directory, panicState,
    boundaryControl: boundary.control,
    randomLaunchId: () => 'launch_44444444444444444444444444444444',
    spawnImpl: () => fakeRuntime(),
  });
  try {
    await listen(runtime, socketPath);
    const provider = frameSocket(socketPath);
    await connect(provider);
    provider.send(startFrame(workspace));
    assert.equal((await provider.next()).type, 'accepted');
    provider.socket.destroy();
    await waitFor(() => panicState.status().locked);
    assert.equal(runtime.active.size, 1);
    assert.equal(runtime.boundaryStatus().recovered, false);

    const health = frameSocket(socketPath);
    await connect(health);
    health.send({ version: 1, type: 'health' });
    const status = await health.next();
    assert.equal(status.ready, false);
    assert.equal(status.boundaryRecovered, false);

    boundary.control.terminate = async () => ({ accepted: true, persisted: true, quiesced: true });
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shutdown drains an admitted control transition before final recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-control-drain-'));
  const panicState = createMemoryPanicState();
  let releaseFirstRecovery;
  const firstRecovery = new Promise((resolve) => { releaseFirstRecovery = resolve; });
  let recoveryCalls = 0;
  const boundary = boundaryHarness();
  boundary.control.recover = async (provider) => {
    boundary.calls.push(['recover', provider]);
    recoveryCalls += 1;
    if (recoveryCalls === 1) await firstRecovery;
    return { accepted: true, persisted: true, quiesced: true, unitCount: 0 };
  };
  const runtime = createProviderSupervisor({
    config: config(),
    workspaceRoot: directory,
    panicState,
    boundaryControl: boundary.control,
  });
  try {
    const panic = runtime.panic({ reason: 'test', source: 'test' });
    await waitFor(() => recoveryCalls === 1);
    const closing = runtime.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recoveryCalls, 1, 'shutdown recovery must not overlap the admitted control lane');
    releaseFirstRecovery();
    await panic;
    await closing;
    assert.equal(recoveryCalls, 2);
    assert.equal(panicState.status().locked, true);
  } finally {
    releaseFirstRecovery?.();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('same-provider launches are serialized until exact prior cgroup quiescence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-serialized-'));
  const workspace = path.join(directory, 'phone');
  const socketPath = path.join(directory, 'supervisor.sock');
  fs.mkdirSync(workspace);
  const boundary = boundaryHarness();
  const children = [];
  const launchIds = [
    'launch_55555555555555555555555555555555',
    'launch_66666666666666666666666666666666',
  ];
  let sequence = 0;
  const runtime = createProviderSupervisor({
    config: config(),
    workspaceRoot: directory,
    boundaryControl: boundary.control,
    randomLaunchId: () => launchIds[sequence++],
    spawnImpl() {
      assert.equal(runtime.active.size, 0, 'a new launch requires exact prior boundary zero');
      const child = fakeRuntime();
      children.push(child);
      return child;
    },
  });
  try {
    await listen(runtime, socketPath);
    const first = frameSocket(socketPath);
    await connect(first);
    first.send(startFrame(workspace, { taskId: 'job_serialized_first' }));
    assert.equal((await first.next()).type, 'accepted');
    assert.equal(runtime.active.size, 1);

    const overlapping = frameSocket(socketPath);
    await connect(overlapping);
    overlapping.send(startFrame(workspace, { taskId: 'job_serialized_overlap' }));
    assert.equal((await overlapping.next()).code, 'PROVIDER_SUPERVISOR_BUSY');
    assert.equal(children.length, 1);

    children[0].emit('close', 0, null);
    assert.equal((await first.next()).quiesced, true);
    assert.equal(runtime.active.size, 0);

    const second = frameSocket(socketPath);
    await connect(second);
    second.send(startFrame(workspace, { taskId: 'job_serialized_second' }));
    assert.equal((await second.next()).launchId, launchIds[1]);
    assert.equal(children.length, 2);
    second.socket.destroy();
    await waitFor(() => runtime.active.size === 0);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  assert.throws(() => createProviderSupervisor({
    config: config(),
    maxActive: 2,
    boundaryControl: boundary.control,
  }), /concurrency is fixed at one/);
});
