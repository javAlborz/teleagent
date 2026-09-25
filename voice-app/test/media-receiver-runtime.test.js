'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ADMISSION_FILE, START_FIFO, REQUIRED_SOURCES, canonical, digest, awaitHostStart,
  assertMediaReceiverRuntime } = require('../../lib/media-receiver-runtime');
const { runtimeFixture } = require('./helpers/media-runtime-fixture');
const { loadMediaControlEndpoints, buildFreeswitchConnectionOptions } = require('../lib/media-control-endpoints');
const { VOICE_APP_FIXED_ENV } = require('../../lib/voice-app-runtime-env');

test('real entrypoint refuses absent independent runtime before dependencies, secrets or clients', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../index.js')], {
    env: { ...VOICE_APP_FIXED_ENV }, encoding: 'utf8', timeout: 3000, maxBuffer: 16384,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Voice state\/listener boundary failed:/u);
  assert.match(result.stderr, /media runtime admission|teleagent-media/u);
  assert.doesNotMatch(result.stderr, /Cannot find module|MODULE_NOT_FOUND/u);
  assert.equal(result.stdout, '');
});

test('host start fence requires a root-owned FIFO and one exact generation', () => {
  const generation = 'a'.repeat(64);
  const metadata = { dev: 3, ino: 82, uid: 0, gid: 987, mode: 0o010440,
    nlink: 1, isFIFO: () => true };
  const directory = { uid: 0, gid: 0, mode: 0o40755, isDirectory: () => true };
  const createIo = (payload, altered = {}) => {
    let position = 0, closed = false;
    const fifo = { ...metadata, ...altered };
    return {
      lstatSync(filename) { return filename === START_FIFO ? fifo : directory; },
      openSync(filename) { assert.equal(filename, START_FIFO); return 11; },
      fstatSync() { return fifo; },
      readSync(_fd, target, offset, length) {
        const count = Math.min(length, 7, payload.length - position);
        if (count > 0) payload.copy(target, offset, position, position + count);
        position += count;
        return count;
      },
      closeSync() { closed = true; },
      get closed() { return closed; },
    };
  };
  const accepted = createIo(Buffer.from(`${generation}\n`));
  assert.equal(awaitHostStart({ io: accepted, gid: 987 }), generation);
  assert.equal(accepted.closed, true);
  for (const [payload, altered] of [
    [Buffer.from(`${generation}\nextra`), {}],
    [Buffer.from(`${generation.slice(1)}\n`), {}],
    [Buffer.from(`${'z'.repeat(64)}\n`), {}],
    [Buffer.from(`${generation}\n`), { isFIFO: () => false }],
    [Buffer.from(`${generation}\n`), { mode: 0o010660 }],
  ]) assert.throws(() => awaitHostStart({ io: createIo(payload, altered), gid: 987 }));
  const entrypoint = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.ok(entrypoint.indexOf('hostStartGeneration = mediaRuntimeModule.awaitHostStart();') <
    entrypoint.indexOf('mediaReceiverRuntime = mediaRuntimeModule.loadMediaReceiverRuntime();'));
  assert.doesNotMatch(entrypoint, /NODE_ENV === 'production'\) hostStartGeneration/u);
});

test('runtime admission binds actual sources, private clients and fixed native reverse ESL options', () => {
  const f = runtimeFixture(), runtime = f.load();
  assert.equal(Object.isFrozen(runtime.projection.reverseEsl), true);
  const endpoints = loadMediaControlEndpoints({ DRACHTIO_HOST: 'untrusted.example' }, runtime);
  assert.deepEqual(endpoints, { drachtio: { host: '10.254.0.6', port: 9022 }, freeswitch: { host: '10.254.0.10', port: 8021 } });
  assert.deepEqual(buildFreeswitchConnectionOptions(endpoints.freeswitch, 'unit-test-only', runtime), {
    address: '10.254.0.10', port: 8021, secret: 'unit-test-only', profile: 'drachtio_mrf',
    listenAddress: '10.254.0.14', listenPort: 3002, advertisedAddress: '10.254.0.14', advertisedPort: 3002 });
  assert.throws(() => buildFreeswitchConnectionOptions({ host: '127.0.0.1', port: 8021 }, '', runtime));
  assert.throws(() => assertMediaReceiverRuntime({ projection: runtime.projection, assertCurrent() {} }));
});

test('missing or writable authority, source drift and self-reported template digests cannot admit', () => {
  for (const change of [
    (f) => f.files.delete(ADMISSION_FILE), (f) => f.unsafe('/run/teleagent-media'), (f) => f.unsafe(ADMISSION_FILE),
    (f) => f.unsafe('/app/lib'), (f) => f.files.set(`/app/${REQUIRED_SOURCES[0]}`, Buffer.from('changed executable bytes')),
    (f) => { delete f.record.approvedRuntimeSources; f.publish(); },
    (f) => { f.record.rendererClosureDigest = 'self-reported'; f.publish(); },
    (f) => { f.files.set(ADMISSION_FILE, Buffer.from(JSON.stringify(f.record))); },
  ]) {
    const f = runtimeFixture(); change(f); assert.throws(() => f.load());
  }
});

test('inconsistent projection fields refuse even with a freshly calculated projection digest', () => {
  for (const change of [
    (p) => { p.privateHttpAudio.host = '0.0.0.0'; }, (p) => { p.privateHttpAudio.methods.push('POST'); },
    (p) => { p.privateHttpAudio.allowedPeer = p.privateHttpAudio.host; }, (p) => { p.controlHttp.host = p.privateHttpAudio.host; },
    (p) => { p.reverseEsl.listenPort = 0; }, (p) => { p.reverseEsl.advertisedAddress = 'localhost'; },
    (p) => { p.audioForkOptions.allowedPeers.push('10.254.0.6'); }, (p) => { p.voiceEnvironment.DRACHTIO_HOST = 'localhost'; },
    (p) => { p.endpoints['voice-media-http'].ports.end = 3001; }, (p) => { p.readyToLaunch = true; },
  ]) {
    const f = runtimeFixture(); change(f.record.projection);
    delete f.record.projection.projectionDigest;
    f.record.projectionDigest = digest(canonical(f.record.projection));
    f.record.projection.projectionDigest = f.record.projectionDigest;
    f.publish(); assert.throws(() => f.load());
  }
});

test('generation replacement and boot, UID, same-tick different PID or namespace changes revoke every consumer', () => {
  for (const change of [
    (f) => { f.record.generation = 'f'.repeat(64); f.publish(); }, (f) => { f.identity.bootId = 'different-boot'; },
    (f) => { f.identity.uid += 1; }, (f) => { f.identity.startTicks = '7701'; }, (f) => { f.identity.namespacePid += 1; },
    (f) => { f.identity.namespaceDevice += 1; }, (f) => { f.identity.namespaceInode += 1; },
  ]) {
    const f = runtimeFixture(), runtime = f.load(); change(f);
    assert.throws(() => assertMediaReceiverRuntime(runtime));
    assert.throws(() => loadMediaControlEndpoints({}, runtime));
  }
});

test('generated and static playback URLs follow admitted receiver and revoke with generation', () => {
  const playback = require('../lib/media-playback-urls');
  const f = runtimeFixture(), runtime = f.load(); playback.configureMediaPlayback(runtime);
  assert.equal(playback.playbackUrl('audio-files', 'response.wav'), 'http://10.254.0.14:3000/audio-files/response.wav');
  assert.equal(playback.playbackUrl('static', 'hold-music/one.mp3'), 'http://10.254.0.14:3000/static/hold-music/one.mp3');
  for (const value of ['../other.wav', '/tmp/other.wav', 'encoded%2fwav.wav', 'other.txt']) {
    assert.throws(() => playback.playbackUrl('audio-files', value));
  }
  assert.throws(() => playback.playbackUrl('api', 'response.wav'));
  assert.throws(() => playback.configureMediaPlayback(runtimeFixture().load()));
  f.identity.startTicks = '7701'; assert.throws(() => playback.playbackUrl('static', 'ready-beep.wav'));
});
