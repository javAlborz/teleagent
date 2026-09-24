'use strict';

const fs = require('node:fs');

const CONTROLLER_SOCKET = '/run/teleagent-controller/controller.sock';
const CONTROLLER_SOCKET_NAME = 'agent-controller';

function refuse() {
  throw new Error('Controller requires the root-owned systemd Unix listener.');
}

// Socket ownership alone is insufficient: the descriptor must be the listening
// socket at the fixed pathname, below parents unprivileged users cannot replace.
function inheritedControllerListener(environment = process.env, pid = process.pid, fileSystem = fs) {
  const names = String(environment.LISTEN_FDNAMES || '').split(':');
  if (environment.LISTEN_PID !== String(pid) || environment.LISTEN_FDS !== '2' ||
      names.length !== 2 || names.filter((name) => name === CONTROLLER_SOCKET_NAME).length !== 1 ||
      names.filter((name) => name === 'pbx-panic').length !== 1) refuse();
  const fd = 3 + names.indexOf(CONTROLLER_SOCKET_NAME);
  for (const directory of ['/', '/run', '/run/teleagent-controller']) {
    const metadata = fileSystem.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 ||
        (metadata.mode & 0o022) !== 0) refuse();
  }
  const groups = fileSystem.lstatSync('/etc/group');
  if (!groups.isFile() || groups.isSymbolicLink() || groups.uid !== 0 ||
      (groups.mode & 0o022) !== 0) refuse();
  const matches = fileSystem.readFileSync('/etc/group', 'utf8').split('\n')
    .map((line) => line.split(':')).filter((fields) => fields[0] === 'teleagent-voice');
  if (matches.length !== 1 || matches[0].length !== 4 || !/^[1-9][0-9]*$/.test(matches[0][2])) refuse();
  const voiceGid = Number(matches[0][2]);
  if (!Number.isSafeInteger(voiceGid)) refuse();
  const socket = fileSystem.lstatSync(CONTROLLER_SOCKET);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0 ||
      socket.gid !== voiceGid || (socket.mode & 0o7777) !== 0o660) refuse();
  const descriptor = fileSystem.fstatSync(fd);
  if (!descriptor.isSocket()) refuse();
  const listeners = fileSystem.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1)
    .map((line) => line.trim().split(/\s+/)).filter((fields) => fields[6] === String(descriptor.ino));
  if (listeners.length !== 1 || listeners[0].length !== 8 ||
      listeners[0][3] !== '00010000' || listeners[0][4] !== '0001' ||
      listeners[0][5] !== '01' || listeners[0][7] !== CONTROLLER_SOCKET) refuse();
  return { fd, exclusive: true };
}

function controllerListenOptions({ environment = process.env, pid = process.pid,
  fileSystem = fs, port, host } = {}) {
  const transport = environment.AGENT_API_TRANSPORT || 'loopback';
  if (transport === 'systemd-unix') return inheritedControllerListener(environment, pid, fileSystem);
  if (transport !== 'loopback' || environment.TELEAGENT_CONTROLLER_STATE_BOUNDARY === 'required' ||
      environment.LISTEN_PID || environment.LISTEN_FDS || environment.LISTEN_FDNAMES) refuse();
  return { port, host };
}

module.exports = { CONTROLLER_SOCKET, CONTROLLER_SOCKET_NAME, controllerListenOptions,
  inheritedControllerListener };
