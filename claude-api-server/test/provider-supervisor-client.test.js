'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { decodeOutputFrame, runClient } = require('../provider-supervisor-client');

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
