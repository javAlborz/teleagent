'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exact } = require('./owner-session-catalog');
const { sessionError } = require('./owner-session-endpoint');
const { PBX_EVIDENCE_METHOD } = require('../lib/telecap2-execution-capability');
const ROOT = '/etc/teleagent/owner-authority';

function protectedRead(filename, { secret = false, uid = 0, gid = process.getgid() } = {}) {
  let parent = path.dirname(filename);
  while (parent !== '/') {
    const st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022)) throw sessionError('OWNER_AUTHORITY_BOUNDARY_UNSAFE');
    parent = path.dirname(parent);
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || st.nlink !== 1 || st.size < 1 || st.size > 16384 ||
        (secret ? ((st.mode & 0o777) !== 0o640 || st.gid !== gid) : (st.mode & 0o222))) {
      throw sessionError('OWNER_AUTHORITY_BOUNDARY_UNSAFE');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function fingerprint(key) {
  return crypto.createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex');
}
function parseEpoch(raw) {
  const input = JSON.parse(raw);
  exact(input, ['version', 'epoch', 'arm', 'pbx', 'execution']);
  if (input.version !== 1 || !/^[a-f0-9]{64}$/.test(input.epoch)) throw sessionError('OWNER_AUTHORITY_CONFIG_INVALID');
  const roles = {};
  for (const role of ['arm', 'pbx', 'execution']) {
    exact(input[role], ['keyId', 'publicKey']);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(input[role].keyId) ||
        typeof input[role].publicKey !== 'string' || !input[role].publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) {
      throw sessionError('OWNER_AUTHORITY_CONFIG_INVALID');
    }
    const key = crypto.createPublicKey(input[role].publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw sessionError('OWNER_AUTHORITY_CONFIG_INVALID');
    roles[role] = { keyId: input[role].keyId, publicKey: key, fingerprint: fingerprint(key) };
  }
  if (new Set(Object.values(roles).map((role) => role.fingerprint)).size !== 3 ||
      new Set(Object.values(roles).map((role) => role.keyId)).size !== 3) throw sessionError('OWNER_AUTHORITY_KEYS_NOT_DISTINCT');
  return { epoch: input.epoch, ...roles };
}
function loadOwnerAuthority(role) {
  if (!['controller', 'broker', 'pbx'].includes(role)) throw sessionError('OWNER_AUTHORITY_ROLE_INVALID');
  const raw = protectedRead(`${ROOT}/epoch.json`);
  const epoch = parseEpoch(raw);
  const assertCurrent = () => {
    if (protectedRead(`${ROOT}/epoch.json`) !== raw) throw sessionError('OWNER_AUTHORITY_EPOCH_CHANGED');
  };
  const privateKey = (name) => {
    const key = crypto.createPrivateKey(protectedRead(`${ROOT}/${role}/${name}.pem`, { secret: true }));
    if (key.asymmetricKeyType !== 'ed25519' || fingerprint(crypto.createPublicKey(key)) !== epoch[name].fingerprint) {
      throw sessionError('OWNER_AUTHORITY_KEY_MISMATCH');
    }
    return key;
  };
  const shared = { assertCurrent, epoch: epoch.epoch,
    controllerArmPublicKeys: { [epoch.arm.keyId]: epoch.arm.publicKey },
    pbxAttesterPublicKeys: { [epoch.pbx.keyId]: epoch.pbx.publicKey } };
  if (role === 'controller') return { ...shared, armPrivateKey: privateKey('arm'), armKeyId: epoch.arm.keyId,
    executionPrivateKey: privateKey('execution'), executionKeyId: epoch.execution.keyId };
  if (role === 'pbx') return { ...shared, privateKey: privateKey('pbx'), keyId: epoch.pbx.keyId };
  return { ...shared, publicKeys: { [epoch.execution.keyId]: epoch.execution.publicKey }, bindings: {
    controllerKeyId: epoch.execution.keyId, controllerArmKeyId: epoch.arm.keyId,
    controllerArmKeyFingerprint: epoch.arm.fingerprint, pbxAttesterKeyId: epoch.pbx.keyId,
    pbxAttesterKeyFingerprint: epoch.pbx.fingerprint, evidenceMethod: PBX_EVIDENCE_METHOD,
  } };
}
module.exports = { ROOT, protectedRead, parseEpoch, loadOwnerAuthority };
