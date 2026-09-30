'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { protectedRead } = require('./owner-authority-config');
const { exact } = require('./owner-session-catalog');
const { processIdentity, sessionError } = require('./owner-session-endpoint');
const PROOF = '/run/teleagent-pbx-attester/boundary.json';
const SPEECH_SHA256 = '34191438b1e0f8f5aac5d4fdc5df574762b6fbb3c7a219a8c6f14feceb1bd076';

function parseBoundaryProof(raw, epoch) {
  const value = JSON.parse(raw);
  exact(value, ['version', 'epoch', 'bootId', 'pbxInstanceId', 'pbxPid', 'pbxStart',
    'proxyPid', 'proxyStart', 'namespaceDevice', 'namespaceInode', 'speechSha256',
    'policy', 'ariSocketDevice', 'ariSocketInode']);
  if (value.version !== 1 || value.epoch !== epoch || value.speechSha256 !== SPEECH_SHA256 ||
      value.policy !== 'tailnet-sdes-authenticated-rfc4733-no-info-v1' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.pbxInstanceId)) throw sessionError('PBX_BOUNDARY_INVALID');
  if (!/^[a-f0-9-]{36}$/.test(value.bootId) ||
      ![value.pbxPid, value.proxyPid].every((id) => Number.isSafeInteger(id) && id > 1) ||
      ![value.pbxStart, value.proxyStart, value.namespaceDevice, value.namespaceInode,
        value.ariSocketDevice, value.ariSocketInode].every((id) => typeof id === 'string' && /^[1-9][0-9]*$/.test(id))) {
    throw sessionError('PBX_BOUNDARY_INVALID');
  }
  return value;
}

// Only the infrastructure preflight can mint this root-owned current-boot
// receipt, after checking installed units/config, immutable mounts, modules,
// media policy, fixed local speech packages and exact PBX/proxy processes.
function loadPbxAttesterBoundary(epoch) {
  const raw = protectedRead(PROOF);
  const value = parseBoundaryProof(raw, epoch);
  const assertCurrent = () => {
    if (protectedRead(PROOF) !== raw || fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== value.bootId ||
        processIdentity(value.pbxPid, 979).start !== value.pbxStart ||
        processIdentity(value.proxyPid, 979).start !== value.proxyStart) throw sessionError('PBX_BOUNDARY_CHANGED');
    const ns = fs.statSync('/run/netns/tm-asterisk');
    if (String(ns.dev) !== value.namespaceDevice || String(ns.ino) !== value.namespaceInode) throw sessionError('PBX_BOUNDARY_CHANGED');
    const socket = fs.lstatSync('/run/teleagent-pbx-ari/ari.sock');
    if (!socket.isSocket() || socket.uid !== 0 || socket.gid !== process.getgid() || (socket.mode & 0o777) !== 0o660 ||
        String(socket.dev) !== value.ariSocketDevice || String(socket.ino) !== value.ariSocketInode) throw sessionError('PBX_BOUNDARY_CHANGED');
    const file = '/usr/bin/espeak-ng'; const st = fs.lstatSync(file);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) || st.size > 1024 * 1024 ||
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== SPEECH_SHA256) throw sessionError('PBX_SPEECH_BOUNDARY_CHANGED');
  };
  assertCurrent();
  return { assertCurrent, pbxInstanceId: value.pbxInstanceId };
}
module.exports = { loadPbxAttesterBoundary, parseBoundaryProof, SPEECH_SHA256 };
