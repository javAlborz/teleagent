'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PBX_PANIC_SOCKET, pbxPanicListenOptions, createPbxPanicRequestGate } = require('../pbx-panic-listener');

function fixture(reversed = false) {
  const environment = { LISTEN_PID: '4242', LISTEN_FDS: '2',
    LISTEN_FDNAMES: reversed ? 'pbx-panic:agent-controller' : 'agent-controller:pbx-panic' };
  const metadata = (type, mode, gid = 0) => ({ uid: 0, gid, mode, ino: 8765, nlink: 1, size: 128,
    isFile: () => type === 'file', isDirectory: () => type === 'directory',
    isSocket: () => type === 'socket', isSymbolicLink: () => false });
  const paths = new Map(['/', '/run', '/run/teleagent-pbx-panic']
    .map((name) => [name, metadata('directory', 0o755)]));
  paths.set('/etc/group', metadata('file', 0o644));
  paths.set(PBX_PANIC_SOCKET, metadata('socket', 0o660, 976));
  const content = new Map([
    ['/etc/group', 'root:x:0:\nteleagent-asterisk:x:976:\n'],
    ['/proc/net/unix', `Num RefCount Protocol Flags Type St Inode Path\n00: 00000002 00000000 00010000 0001 01 8765 ${PBX_PANIC_SOCKET}\n`],
  ]);
  const descriptor = metadata('socket', 0o777);
  const fds = [];
  return { environment, paths, content, descriptor, fds, options: {
    environment, pid: 4242, fileSystem: {
      lstatSync: (name) => paths.get(name),
      fstatSync: (fd) => { fds.push(fd); return descriptor; },
      readFileSync: (name) => content.get(name),
    },
  } };
}

test('PBX selects only its named listener regardless of inherited descriptor ordering', () => {
  for (const reversed of [false, true]) {
    const f = fixture(reversed);
    assert.deepEqual(pbxPanicListenOptions(f.options), { fd: reversed ? 3 : 4, exclusive: true });
    assert.deepEqual(f.fds, [reversed ? 3 : 4]);
  }
});

test('missing, duplicate, extra and wrong-generation inherited sockets refuse without fallback', () => {
  for (const [key, value] of [['LISTEN_PID', '4243'], ['LISTEN_FDS', '1'], ['LISTEN_FDS', '3'],
    ['LISTEN_FDNAMES', 'pbx-panic:pbx-panic'], ['LISTEN_FDNAMES', 'voice:pbx-panic'],
    ['LISTEN_FDNAMES', 'agent-controller:pbx-panic:extra']]) {
    const f = fixture();
    f.environment[key] = value;
    assert.throws(() => pbxPanicListenOptions(f.options), /exact root-owned systemd Unix/);
  }
  assert.throws(() => pbxPanicListenOptions({ environment: {} }), /exact root-owned systemd Unix/);
});

test('panic listener refuses replaceable parents, wrong groups, non-listeners and ambiguous paths', () => {
  for (const [name, changes] of [
    ['/run', { mode: 0o777 }], ['/run/teleagent-pbx-panic', { uid: 976 }],
    ['/run/teleagent-pbx-panic', { isSymbolicLink: () => true }],
    [PBX_PANIC_SOCKET, { gid: 982 }], [PBX_PANIC_SOCKET, { uid: 976 }],
    [PBX_PANIC_SOCKET, { mode: 0o666 }], [PBX_PANIC_SOCKET, { isSocket: () => false }],
    ['/etc/group', { nlink: 2 }], ['/etc/group', { size: 2 * 1024 * 1024 }],
  ]) {
    const f = fixture();
    Object.assign(f.paths.get(name), changes);
    assert.throws(() => pbxPanicListenOptions(f.options), /exact root-owned systemd Unix/);
  }
  for (const transform of [
    (value) => value.replace('00010000', '00000000'),
    (value) => value.replace(PBX_PANIC_SOCKET, '/run/teleagent-controller/controller.sock'),
    (value) => value.replace('8765', '5555'),
    (value) => value + value.split('\n')[1] + '\n',
  ]) {
    const f = fixture();
    f.content.set('/proc/net/unix', transform(f.content.get('/proc/net/unix')));
    assert.throws(() => pbxPanicListenOptions(f.options), /exact root-owned systemd Unix/);
  }
  for (const groups of ['teleagent-asterisk:x:0:\n', 'teleagent-asterisk:x:976:\nteleagent-asterisk:x:977:\n']) {
    const f = fixture();
    f.content.set('/etc/group', groups);
    assert.throws(() => pbxPanicListenOptions(f.options), /exact root-owned systemd Unix/);
  }
});

async function socketServer(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-pbx-panic-'));
  const socketPath = path.join(directory, 'panic.sock');
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return (target, method = 'POST', headers = {}) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: target, method, headers, agent: false,
      timeout: 1000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('fixture HTTP deadline')));
    request.end();
  });
}

test('real Unix HTTP grants only exact panic POSTs and clears request identity after completion', async (t) => {
  const requests = [];
  let gate;
  const foreign = createPbxPanicRequestGate(() => {});
  gate = createPbxPanicRequestGate(async (request, response) => {
    assert.equal(gate.isPbxPanicRequest(request), true);
    assert.equal(foreign.isPbxPanicRequest(request), false);
    request.originalUrl = request.url; // Express preserves this across middleware.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.isPbxPanicRequest(request), true);
    requests.push(request);
    response.end('STOPPED');
  });
  const send = await socketServer(t, gate.dispatch);
  for (const target of ['/voice-control/stop', '/voice-control/stop?response=plain']) {
    assert.deepEqual(await send(target), { status: 200, body: 'STOPPED' });
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !gate.isPbxPanicRequest(request)));
});

test('panic socket denies unlock, other APIs, alternate methods and noncanonical request targets', async (t) => {
  let effects = 0;
  const gate = createPbxPanicRequestGate((_request, response) => {
    effects += 1;
    response.end('unsafe');
  });
  const send = await socketServer(t, gate.dispatch);
  for (const [target, method] of [
    ['/voice-control/unlock', 'POST'], ['/executor/panic/unlock', 'POST'], ['/executor/tasks', 'POST'],
    ['/operator/inspect', 'POST'], ['/health', 'GET'], ['/voice-control/stop', 'GET'],
    ['/voice-control/stop', 'PUT'], ['/voice-control/stop', 'HEAD'],
    ['/voice-control/stop/', 'POST'], ['/voice-control/%73top', 'POST'],
    ['/voice-control/STOP', 'POST'], ['/voice-control/stop?response=plain&extra=1', 'POST'],
    ['http://localhost/voice-control/stop', 'POST'],
  ]) {
    assert.equal((await send(target, method, { 'X-Pbx-Panic': 'true',
      Authorization: 'Bearer fixture-cannot-grant-other-routes' })).status, 403, target);
  }
  assert.equal(effects, 0);
});

test('a normal Unix request and caller properties cannot acquire the private panic brand', async (t) => {
  const gate = createPbxPanicRequestGate(() => {});
  assert.equal(gate.isPbxPanicRequest({ method: 'POST', url: '/voice-control/stop',
    pbxPanic: true, isPbxPanicRequest: true }), false);
  const send = await socketServer(t, (request, response) => {
    assert.equal(gate.isPbxPanicRequest(request), false);
    response.end('unbranded');
  });
  assert.deepEqual(await send('/voice-control/stop', 'POST', { 'X-Pbx-Panic': 'true' }),
    { status: 200, body: 'unbranded' });
});

test('synchronous and asynchronous dispatch failures stay PARTIAL and never leak diagnostics', async (t) => {
  for (const handler of [() => { throw new Error('private fixture detail'); },
    async () => { throw new Error('private fixture detail'); }]) {
    const gate = createPbxPanicRequestGate(handler);
    const send = await socketServer(t, gate.dispatch);
    assert.deepEqual(await send('/voice-control/stop'), { status: 503, body: 'PARTIAL' });
  }
});
