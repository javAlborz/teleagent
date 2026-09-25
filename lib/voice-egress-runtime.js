'use strict';
const fs = require('node:fs');
const tls = require('node:tls');
const path = require('node:path');
const { canonical, digest, protectedRead, currentIdentity, assertMediaReceiverRuntime } = require('./media-receiver-runtime');

const ADMISSION_FILE = '/run/teleagent-media/voice-egress.json';
const SOCKETS = Object.freeze({ realtime: '/run/teleagent-voice-egress/realtime.sock',
  tts: '/run/teleagent-voice-egress/tts.sock', stt: '/run/teleagent-voice-egress/stt.sock' });
const contexts = new WeakSet();
function need(value) {
  if (!value) throw Object.assign(new Error('independent voice egress admission is unavailable or changed'),
    { code: 'VOICE_EGRESS_ADMISSION_REFUSED' });
}
function exactKeys(value, names) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '));
}
function hash(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function checkSocket(name, expected, gid, io) {
  need(Object.hasOwn(SOCKETS, name) && expected);
  const filename = SOCKETS[name];
  for (const directory of ['/', '/run', path.dirname(filename)]) {
    const info = io.lstatSync(directory);
    need(info.isDirectory() && info.uid === 0 && [0, gid].includes(info.gid) && !(info.mode & 0o022));
  }
  const info = io.lstatSync(filename);
  need(info.isSocket() && info.uid === 0 && info.gid === gid && (info.mode & 0o7777) === 0o660 &&
    info.nlink === 1 && info.dev === expected.device && info.ino === expected.inode);
}

function loadVoiceEgressRuntime(media, { io = fs, caCertificates = tls.rootCertificates } = {}) {
  assertMediaReceiverRuntime(media);
  const bytes = protectedRead(ADMISSION_FILE, io), text = bytes.toString('utf8');
  const record = JSON.parse(text);
  need(text.trim() === canonical(record));
  exactKeys(record, 'schema generation mediaGeneration imageId identity socketGid caDigest listenerEvidenceDigest services');
  need(record.schema === 'teleagent.voice-egress-admission.v1' && typeof record.generation === 'string' && /^[a-f0-9]{64}$/u.test(record.generation) &&
    record.mediaGeneration === media.generation && record.imageId === media.imageId &&
    Number.isSafeInteger(record.socketGid) && record.socketGid > 0 && record.socketGid < 1000 &&
    Array.isArray(caCertificates) && caCertificates.length > 0 &&
    record.caDigest === digest(canonical(caCertificates)) && hash(record.listenerEvidenceDigest));
  need(canonical(record.identity) === canonical(currentIdentity(io)));
  exactKeys(record.services, 'realtime tts stt');
  need(record.services.realtime && Boolean(record.services.tts) === Boolean(record.services.stt));
  for (const endpoint of Object.values(record.services)) {
    if (endpoint === null) continue;
    exactKeys(endpoint, 'device inode');
    need(Number.isSafeInteger(endpoint.device) && endpoint.device >= 0 && Number.isSafeInteger(endpoint.inode) && endpoint.inode > 0);
  }
  const identities = Object.values(record.services).filter(Boolean).map((value) => `${value.device}:${value.inode}`);
  need(new Set(identities).size === identities.length);
  const admitted = structuredClone(record), originalDigest = digest(bytes), roots = Object.freeze([...caCertificates]);
  const runtime = Object.freeze({ generation: admitted.generation, speechEnabled: Boolean(admitted.services.tts),
    assertCurrent() {
      assertMediaReceiverRuntime(media);
      need(digest(protectedRead(ADMISSION_FILE, io)) === originalDigest &&
        canonical(currentIdentity(io)) === canonical(admitted.identity));
    },
    endpoint(name) {
      this.assertCurrent();
      checkSocket(name, admitted.services[name], admitted.socketGid, io);
      return SOCKETS[name];
    },
    caCertificates: roots,
  });
  contexts.add(runtime);
  runtime.endpoint('realtime');
  if (runtime.speechEnabled) { runtime.endpoint('tts'); runtime.endpoint('stt'); }
  return runtime;
}
function assertVoiceEgressRuntime(runtime) { need(runtime && contexts.has(runtime)); runtime.assertCurrent(); return runtime; }
module.exports = { ADMISSION_FILE, SOCKETS, loadVoiceEgressRuntime, assertVoiceEgressRuntime };
