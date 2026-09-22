'use strict';
const tls = require('node:tls');
const { canonical, digest } = require('../../../lib/media-receiver-runtime');
const { ADMISSION_FILE, SOCKETS, loadVoiceEgressRuntime } = require('../../../lib/voice-egress-runtime');
const { runtimeFixture } = require('./media-runtime-fixture');
function egressFixture({ speech = true, caCertificates = tls.rootCertificates } = {}) {
  const media = runtimeFixture(), mediaRuntime = media.load(), sockets = new Map();
  const record = { schema: 'teleagent.voice-egress-admission.v1', generation: 'e'.repeat(64),
    mediaGeneration: mediaRuntime.generation, imageId: mediaRuntime.imageId, identity: { ...media.identity },
    socketGid: 983, caDigest: digest(canonical(caCertificates)), listenerEvidenceDigest: `sha256:${'f'.repeat(64)}`,
    services: { realtime: { device: 1, inode: 101 }, tts: speech ? { device: 1, inode: 102 } : null,
      stt: speech ? { device: 1, inode: 103 } : null } };
  for (const [name, value] of Object.entries(record.services)) if (value) sockets.set(SOCKETS[name], {
    uid: 0, gid: 983, mode: 0o660, nlink: 1, dev: value.device, ino: value.inode,
    isSocket: () => true, isDirectory: () => false, isFile: () => false,
  });
  const original = media.io.lstatSync;
  media.io.lstatSync = (filename) => sockets.get(filename) || original(filename);
  const publish = () => media.files.set(ADMISSION_FILE, Buffer.from(canonical(record)));
  publish();
  return { media, record, sockets, publish,
    load: () => loadVoiceEgressRuntime(mediaRuntime, { io: media.io, caCertificates }) };
}
function installEgressFixture() {
  const fixture = egressFixture();
  require('../../lib/voice-egress-transport').configureVoiceEgress(fixture.load());
  return fixture;
}
module.exports = { egressFixture, installEgressFixture };
