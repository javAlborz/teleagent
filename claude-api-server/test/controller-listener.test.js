'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CONTROLLER_SOCKET, controllerListenOptions, inheritedControllerListener } = require('../controller-listener');

function fixture() {
  const environment = { LISTEN_PID: '4242', LISTEN_FDS: '2', LISTEN_FDNAMES: 'agent-controller:pbx-panic' };
  const metadata = (type, mode, gid = 0) => ({ uid: 0, gid, mode, ino: 1234,
    isFile: () => type === 'file', isDirectory: () => type === 'directory',
    isSocket: () => type === 'socket', isSymbolicLink: () => false });
  const paths = new Map(['/', '/run', '/run/teleagent-controller']
    .map((name) => [name, metadata('directory', 0o755)]));
  paths.set('/etc/group', metadata('file', 0o644));
  paths.set(CONTROLLER_SOCKET, metadata('socket', 0o660, 982));
  const content = new Map([
    ['/etc/group', 'root:x:0:\nteleagent-voice:x:982:\n'],
    ['/proc/net/unix', `Num RefCount Protocol Flags Type St Inode Path\n00: 00000002 00000000 00010000 0001 01 1234 ${CONTROLLER_SOCKET}\n`],
  ]);
  const descriptor = metadata('socket', 0o777);
  return { environment, paths, content, descriptor, fs: {
    lstatSync: (name) => paths.get(name),
    fstatSync: (fd) => { assert.ok(fd === 3 || fd === 4); return descriptor; },
    readFileSync: (name) => content.get(name),
  } };
}

test('controller accepts the exact inherited listener and never binds a writable path', () => {
  const f = fixture();
  assert.deepEqual(inheritedControllerListener(f.environment, 4242, f.fs), { fd: 3, exclusive: true });
  f.environment.LISTEN_FDNAMES = 'pbx-panic:agent-controller';
  assert.deepEqual(inheritedControllerListener(f.environment, 4242, f.fs), { fd: 4, exclusive: true });
});

test('production never falls back to TCP when activation descriptors or transport are absent', () => {
  for (const environment of [
    { TELEAGENT_CONTROLLER_STATE_BOUNDARY: 'required' },
    { AGENT_API_TRANSPORT: 'systemd-unix' },
    { AGENT_API_TRANSPORT: 'tcp' },
    { LISTEN_FDS: '1' },
  ]) assert.throws(() => controllerListenOptions({ environment }), /root-owned systemd Unix/);
  assert.deepEqual(controllerListenOptions({ environment: {}, port: 3333, host: '127.0.0.1' }),
    { port: 3333, host: '127.0.0.1' });
});

test('controller rejects wrong activation PID, name and socket counts', () => {
  for (const [name, value] of [['LISTEN_PID', '4243'], ['LISTEN_FDS', '0'],
    ['LISTEN_FDS', '1'], ['LISTEN_FDNAMES', ''], ['LISTEN_FDNAMES', 'worker-session-broker'],
    ['LISTEN_FDNAMES', 'agent-controller:agent-controller']]) {
    const f = fixture();
    f.environment[name] = value;
    assert.throws(() => inheritedControllerListener(f.environment, 4242, f.fs), /root-owned systemd Unix/);
  }
});

test('controller refuses replaceable parents, symlinks, unsafe socket owners and groups', () => {
  for (const [name, update] of [
    ['/run', { mode: 0o777 }], ['/run/teleagent-controller', { uid: 984 }],
    ['/run/teleagent-controller', { isSymbolicLink: () => true }],
    [CONTROLLER_SOCKET, { uid: 996 }], [CONTROLLER_SOCKET, { gid: 984 }],
    [CONTROLLER_SOCKET, { mode: 0o666 }], [CONTROLLER_SOCKET, { isSocket: () => false }],
    ['/etc/group', { mode: 0o666 }],
  ]) {
    const f = fixture();
    Object.assign(f.paths.get(name), update);
    assert.throws(() => inheritedControllerListener(f.environment, 4242, f.fs), /root-owned systemd Unix/);
  }
});

test('controller refuses non-listening, unrelated, ambiguous and non-socket descriptors', () => {
  for (const replace of [
    (text) => text.replace('00010000', '00000000'),
    (text) => text.replace('0001 01', '0002 01'),
    (text) => text.replace(CONTROLLER_SOCKET, '/tmp/attacker.sock'),
    (text) => text.replace('1234', '4321'),
    (text) => text + text.split('\n')[1] + '\n',
  ]) {
    const f = fixture();
    f.content.set('/proc/net/unix', replace(f.content.get('/proc/net/unix')));
    assert.throws(() => inheritedControllerListener(f.environment, 4242, f.fs), /root-owned systemd Unix/);
  }
  const f = fixture();
  f.descriptor.isSocket = () => false;
  assert.throws(() => inheritedControllerListener(f.environment, 4242, f.fs), /root-owned systemd Unix/);
});
