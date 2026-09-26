'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { decodeOutputFrame, runClient, readEnabledProviders, probeProviderSupervisors,
  unlockProviderSupervisors, panicProviderSupervisors } = require('../provider-supervisor-client');

function activationFilesystem(text, { metadata = {}, after = {}, openError = false } = {}) {
  const value = Buffer.from(text);
  const info = { isFile: () => true, dev: 1, ino: 2, mode: 0o100444,
    uid: 0, gid: 0, nlink: 1, size: value.length, mtimeMs: 3, ctimeMs: 4, ...metadata };
  let stats = 0;
  const closed = [];
  return { closed, filesystem: {
    openSync(filename, flags) {
      assert.equal(filename, '/etc/teleagent/provider-runtime/enabled-providers');
      assert.ok(flags & require('node:fs').constants.O_NOFOLLOW);
      if (openError) throw new Error('symbolic link or missing file');
      return 99;
    },
    fstatSync() { return stats++ === 0 ? info : { ...info, ...after }; },
    readSync(fd, buffer, offset, length, position) {
      assert.equal(fd, 99);
      assert.equal(length, 33);
      assert.equal(position, 0);
      return value.copy(buffer, offset, 0, length);
    },
    closeSync(fd) { closed.push(fd); },
  } };
}

test('provider selection reads only the two exact protected root modes', () => {
  for (const [text, expected] of [['codex\n', ['codex']], ['claude,codex\n', ['claude', 'codex']]]) {
    const fake = activationFilesystem(text);
    assert.deepEqual(readEnabledProviders(fake), expected);
    assert.deepEqual(fake.closed, [99]);
  }
  for (const text of ['', 'claude\n', 'codex', 'codex\r\n', 'codex,claude\n',
    'codex,codex\n', 'codex\nextra', 'x'.repeat(33)]) {
    const fake = activationFilesystem(text);
    assert.throws(() => readEnabledProviders(fake), /unavailable or unsafe/);
    assert.deepEqual(fake.closed, [99]);
  }
});

test('provider selection rejects unsafe metadata, links and read-time changes', () => {
  for (const metadata of [{ uid: 1000 }, { gid: 1000 }, { mode: 0o100644 },
    { nlink: 2 }, { isFile: () => false }, { size: 1 }]) {
    const fake = activationFilesystem('codex\n', { metadata });
    assert.throws(() => readEnabledProviders(fake), /unavailable or unsafe/);
    assert.deepEqual(fake.closed, [99]);
  }
  for (const after of [{ ino: 3 }, { size: 7 }, { mode: 0o100644 }, { mtimeMs: 4 }]) {
    const fake = activationFilesystem('codex\n', { after });
    assert.throws(() => readEnabledProviders(fake), /unavailable or unsafe/);
    assert.deepEqual(fake.closed, [99]);
  }
  const fake = activationFilesystem('codex\n', { openError: true });
  assert.throws(() => readEnabledProviders(fake), /unavailable or unsafe/);
  assert.deepEqual(fake.closed, []);
});

test('Codex-only health and unlock never contact the disabled Claude supervisor', async () => {
  for (const selected of [['codex'], ['claude', 'codex']]) {
    const calls = [];
    const readProviders = () => selected;
    const health = await probeProviderSupervisors({ readProviders,
      probe: async (provider) => { calls.push(provider); return { ready: true, provider }; } });
    assert.equal(health.ready, true);
    assert.deepEqual(calls, selected);
    assert.equal(Object.hasOwn(health, 'claude'), selected.includes('claude'));
    calls.length = 0;
    const unlocked = await unlockProviderSupervisors({ readProviders,
      request: async (provider, control) => {
        assert.equal(control.type, 'unlock');
        calls.push(provider);
        return { success: true, persisted: true, quiesced: true };
      } });
    assert.equal(unlocked.success, true);
    assert.deepEqual(calls, selected);
  }
});

test('missing selection or enabled-provider failure cannot report readiness or unlock', async () => {
  for (const fn of [probeProviderSupervisors, unlockProviderSupervisors]) {
    const unexpected = () => { assert.fail('must not contact a supervisor'); };
    await assert.rejects(fn({ readProviders: () => { throw new Error('missing mode'); },
      probe: unexpected, request: unexpected }), /missing mode/);
    await assert.rejects(fn({ readProviders: () => [], probe: unexpected, request: unexpected }), /invalid/);
    const failed = async () => { throw new Error('selected supervisor unavailable'); };
    await assert.rejects(fn({ readProviders: () => ['codex'], probe: failed, request: failed }), /unavailable/);
  }
  const result = await unlockProviderSupervisors({ readProviders: () => ['codex'],
    request: async () => ({ success: true, persisted: true, quiesced: false }) });
  assert.equal(result.success, false);
  assert.equal(result.quiesced, false);
});

test('provider selection changes during health or unlock refuse completion', async () => {
  for (const fn of [probeProviderSupervisors, unlockProviderSupervisors]) {
    let reads = 0;
    const response = async () => ({ ready: true, success: true, persisted: true, quiesced: true });
    await assert.rejects(fn({ readProviders: () => reads++ ? ['claude', 'codex'] : ['codex'],
      probe: response, request: response }), /changed during control/);
  }
});

test('panic retains both-plane coverage and cannot infer disabled-plane quiescence', async () => {
  const calls = [];
  await assert.rejects(panicProviderSupervisors({ request: async (provider, control) => {
    calls.push(provider);
    assert.equal(control.type, 'panic');
    if (provider === 'claude') throw new Error('disabled supervisor absent; root proof required');
    return { accepted: true, persisted: true, quiesced: true };
  } }), /root proof required/);
  assert.deepEqual(calls, ['claude', 'codex']);
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.frames = [];
  }

  write(value) {
    this.frames.push(JSON.parse(String(value).trim()));
    return true;
  }

  end() {
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  destroy(error) {
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit('error', error));
    queueMicrotask(() => this.emit('close'));
  }
}

test('pre-accept provider BUSY emits an authenticated side-channel fact without a provider start', async () => {
  const socket = new FakeSocket();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const statuses = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  runClient({
    provider: 'claude', mode: 'managed', accessMode: 'read-only',
    cwd: '/srv/teleagent-agent-workspaces/phone', taskId: 'job_busy',
    sessionId: null, args: ['-p'],
  }, {
    stdin, stdout, stderr,
    createSocket: () => socket,
    statusWriter: (value) => { statuses.push(value); return true; },
  });
  socket.emit('connect');
  assert.equal(socket.frames[0].type, 'start');
  socket.emit('data', Buffer.from(`${JSON.stringify({
    type: 'error', code: 'PROVIDER_SUPERVISOR_BUSY',
  })}\n`));
  await new Promise((resolve) => socket.once('close', resolve));
  assert.deepEqual(statuses, [{
    version: 1, accepted: false, code: 'PROVIDER_SUPERVISOR_BUSY',
    providerStarted: false,
    providerExecutionAttempted: false,
    retrySafe: false,
    quiesced: false,
    launchId: null,
  }]);
  assert.equal(process.exitCode, 78);
  process.exitCode = previousExitCode;
});

test('accepted launch status is distinct from a provider process later exiting 75', async () => {
  const socket = new FakeSocket();
  const stdin = new PassThrough();
  const statuses = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  runClient({
    provider: 'claude', mode: 'managed', accessMode: 'mutating',
    cwd: '/srv/teleagent-agent-workspaces/phone', taskId: 'job_accepted',
    sessionId: null, args: ['-p'],
  }, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    createSocket: () => socket,
    statusWriter: (value) => { statuses.push(value); return true; },
  });
  socket.emit('connect');
  stdin.write('buffered until model readiness');
  assert.equal(socket.frames.length, 1, 'stdin must not cross before the accepted readiness frame');
  socket.emit('data', Buffer.from(`${JSON.stringify({
    type: 'accepted', launchId: 'launch_11111111111111111111111111111111',
  })}\n`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.frames[1].type, 'stdin');
  assert.equal(
    Buffer.from(socket.frames[1].data, 'base64').toString(),
    'buffered until model readiness'
  );
  socket.emit('data', Buffer.from(`${JSON.stringify({
    type: 'exit', code: 75, signal: null, quiesced: true,
  })}\n`));
  await new Promise((resolve) => socket.once('close', resolve));
  assert.deepEqual(statuses, [{ version: 1, accepted: true,
    launchId: 'launch_11111111111111111111111111111111' }]);
  assert.equal(process.exitCode, 75);
  process.exitCode = previousExitCode;
});

test('accepted provider input stays buffered when the controller does not acknowledge persistence', async () => {
  const socket = new FakeSocket();
  const stdin = new PassThrough();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  runClient({
    provider: 'codex', mode: 'managed', accessMode: 'mutating',
    cwd: '/srv/teleagent-agent-workspaces/phone', taskId: 'job_no_ack',
    sessionId: null, args: ['exec', '-'],
  }, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    createSocket: () => socket,
    statusWriter: () => false,
  });
  socket.emit('connect');
  stdin.write('must not cross before durable acknowledgement');
  socket.emit('data', Buffer.from(`${JSON.stringify({
    type: 'accepted', launchId: 'launch_22222222222222222222222222222222',
  })}\n`));
  await new Promise((resolve) => socket.once('close', resolve));
  assert.equal(socket.frames.some((frame) => frame.type === 'stdin'), false);
  assert.equal(socket.frames.some((frame) => frame.type === 'signal' && frame.signal === 'SIGTERM'), true);
  assert.equal(process.exitCode, 78);
  process.exitCode = previousExitCode;
});

test('decoded provider frames have an exact canonical 64 KiB ceiling', () => {
  const exact = Buffer.alloc(64 * 1024, 0x61).toString('base64');
  assert.equal(decodeOutputFrame(exact).length, 64 * 1024);
  assert.throws(
    () => decodeOutputFrame(Buffer.alloc((64 * 1024) + 1, 0x61).toString('base64')),
    /bound|invalid/,
  );
  assert.throws(() => decodeOutputFrame('not base64!'), /encoding/);
});

test('root control sends only fixed requests and validates bounded replies over a real Unix socket', async () => {
  const net = require('node:net');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { requestRootProviderPlane } = require('../provider-supervisor-client');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'teleagent-root-client-'));
  const socketPath = path.join(directory, 'control.sock');
  let response;
  let lastRequest;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let request = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => { request += chunk; });
    socket.on('end', () => {
      lastRequest = request;
      if (response === null) return socket.destroy();
      socket.end(response);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const createSocket = (selectedPath) => {
    assert.equal(selectedPath, '/run/teleagent-provider-control/control.sock');
    return net.createConnection(socketPath);
  };
  try {
    for (const [action, request] of [['panic-all', 'PANIC\n'], ['recover-root-panic', 'RECOVER\n']]) {
      const payload = { version: 1, action, accepted: true, success: true, persisted: true, quiesced: true };
      response = JSON.stringify(payload);
      assert.deepEqual(await requestRootProviderPlane(action, { createSocket }), payload);
      assert.equal(lastRequest, request);
      for (const invalid of [null, 'invalid', '{}', 'x'.repeat(1025),
        JSON.stringify({ ...payload, action: 'another-action' }),
        JSON.stringify({ ...payload, quiesced: 'true' }),
        JSON.stringify({ ...payload, extra: true })]) {
        response = invalid;
        await assert.rejects(requestRootProviderPlane(action, { createSocket }), /response/);
      }
      const partial = { ...payload, success: false, quiesced: false };
      response = JSON.stringify(partial);
      assert.deepEqual(await requestRootProviderPlane(action, { createSocket }), partial);
    }
    for (const action of ['launch', 'toString', 'panic-all --provider codex']) {
      await assert.rejects(requestRootProviderPlane(action, {
        createSocket: () => assert.fail('invalid action connected'),
      }), /invalid/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true });
  }
});

test('missing or stalled root control stays unavailable', async () => {
  const { requestRootProviderPlane } = require('../provider-supervisor-client');
  const socket = new EventEmitter();
  socket.destroy = () => {};
  await assert.rejects(requestRootProviderPlane('panic-all', {
    createSocket: () => socket, timeoutMs: 10,
  }), /timed out/);
  const failed = new EventEmitter();
  failed.destroy = () => {};
  const pending = requestRootProviderPlane('recover-root-panic', { createSocket: () => failed });
  failed.emit('error', new Error('connection refused'));
  await assert.rejects(pending, /control failed/);
});
