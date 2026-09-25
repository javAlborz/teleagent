'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { egressFixture } = require('./helpers/voice-egress-fixture');
const { ADMISSION_FILE, SOCKETS, assertVoiceEgressRuntime } = require('../../lib/voice-egress-runtime');

test('egress admission is independently protected and bound to media/process/source/CA generation', () => {
  const f = egressFixture(), runtime = f.load();
  assert.equal(runtime.endpoint('realtime'), SOCKETS.realtime);
  assert.equal(runtime.endpoint('tts'), SOCKETS.tts);
  assert.equal(runtime.speechEnabled, true);
  assert.throws(() => assertVoiceEgressRuntime({ ...runtime }));
  for (const mutate of [
    (x) => { x.media.files.delete(ADMISSION_FILE); }, (x) => { x.media.unsafe(ADMISSION_FILE); },
    (x) => { x.record.mediaGeneration = 'd'.repeat(64); x.publish(); },
    (x) => { x.record.imageId = `sha256:${'0'.repeat(64)}`; x.publish(); },
    (x) => { x.record.caDigest = `sha256:${'0'.repeat(64)}`; x.publish(); },
    (x) => { x.record.listenerEvidenceDigest = 'self-approved'; x.publish(); },
    (x) => { x.media.identity.namespacePid += 1; },
    (x) => { x.record.services.stt = null; x.publish(); },
    (x) => { x.record.services.tts = { ...x.record.services.realtime }; x.publish(); },
  ]) { const fixture = egressFixture(); mutate(fixture); assert.throws(() => fixture.load()); }
});

test('socket ownership, protection, inode and generation changes fail before connect', () => {
  for (const mutate of [
    (x) => { x.media.unsafe('/run/teleagent-voice-egress'); },
    (x) => { x.sockets.get(SOCKETS.realtime).uid = 1000; },
    (x) => { x.sockets.get(SOCKETS.realtime).gid = 1000; },
    (x) => { x.sockets.get(SOCKETS.realtime).mode = 0o666; },
    (x) => { x.sockets.get(SOCKETS.realtime).ino += 1; },
    (x) => { x.sockets.get(SOCKETS.realtime).nlink = 2; },
    (x) => { x.sockets.get(SOCKETS.realtime).isSocket = () => false; },
    (x) => { x.sockets.delete(SOCKETS.realtime); },
    (x) => { x.record.generation = 'd'.repeat(64); x.publish(); },
  ]) {
    const fixture = egressFixture(), runtime = fixture.load(); mutate(fixture);
    assert.throws(() => runtime.endpoint('realtime'));
  }
});

test('disabled speech needs no speech sockets and cannot accidentally acquire their authority', () => {
  const fixture = egressFixture({ speech: false }), runtime = fixture.load();
  assert.equal(runtime.speechEnabled, false); assert.equal(runtime.endpoint('realtime'), SOCKETS.realtime);
  assert.throws(() => runtime.endpoint('tts')); assert.throws(() => runtime.endpoint('stt'));
  assert.throws(() => runtime.endpoint('controller'));
});
