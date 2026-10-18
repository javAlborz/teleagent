'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {OwnerSpeechClient, createOwnerSpeech, speechChunks} = require('../lib/owner-speech');
const {OwnerReplyWatch} = require('../lib/owner-reply-watch');

function transport({status = 200, audio = Buffer.alloc(960), hang = false, timeoutMs = 1000} = {}) {
  const seen = {};
  const connector = () => {};
  const request = (options, callback) => {
    seen.options = options;
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    options.signal?.addEventListener('abort', () => req.destroy(new Error('cancelled')), {once: true});
    req.end = body => {
      seen.body = JSON.parse(body);
      if (hang) return;
      const res = new EventEmitter(); res.statusCode = status; res.headers = {'content-type': 'audio/pcm'};
      queueMicrotask(() => {callback(res); res.emit('data', audio); res.emit('end');});
    };
    return req;
  };
  return {seen, connector, client: new OwnerSpeechClient({apiKey: 'fixture-key', project: 'fixture-project',
    request, connectionOptions: () => ({createConnection: connector}), timeoutMs})};
}

function media({autoMark = true, send = true, mismatched = false} = {}) {
  const session = new EventEmitter(); session.sent = []; session.markers = []; session.stops = 0;
  session.sendAudio = (audio, meta) => {session.sent.push({audio, meta}); return send;};
  session.markPlaybackComplete = id => {session.completed = id; return true;};
  session.sendPlaybackMarker = (name, {itemId}) => {
    session.markers.push({name, itemId});
    if (autoMark) queueMicrotask(() => session.emit('playout_marker', {name, itemId: mismatched ? 'other' : itemId}));
    return true;
  };
  session.stopPlayback = () => {session.stops++;};
  return session;
}

test('speech uses exact supplied text and fixed admitted OpenAI transport without executable tools', async () => {
  const f = transport(); const text = 'alpha: reply: Mean, median and mode.';
  assert.equal((await f.client.synthesize(text)).length, 960);
  assert.equal(f.seen.body.input, text); assert.equal(f.seen.body.model, 'gpt-4o-mini-tts');
  assert.equal(f.seen.body.response_format, 'pcm'); assert.equal(f.seen.body.voice, 'marin');
  assert.equal(f.seen.options.path, '/v1/audio/speech'); assert.equal(f.seen.options.hostname, 'api.openai.com');
  assert.equal(f.seen.options.agent.createConnection, f.connector); assert.equal(f.seen.body.tools, undefined);
});

test('speech rejects redirects, empty, odd and oversized audio and honors cancellation/deadline', async () => {
  for (const options of [{status: 302}, {status: 401}, {audio: Buffer.alloc(0)}, {audio: Buffer.alloc(3)},
    {audio: Buffer.alloc(8 * 1024 * 1024 + 2)}, {hang: true, timeoutMs: 10}]) {
    await assert.rejects(transport(options).client.synthesize('hello'), /OWNER_SPEECH_/);
  }
  const f = transport({hang: true}); const abort = new AbortController();
  const pending = f.client.synthesize('hello', {signal: abort.signal}); abort.abort();
  await assert.rejects(pending, /OWNER_SPEECH_ABORTED/);
  const closed = new OwnerSpeechClient({apiKey: 'fixture-key', connectionOptions: () => ({})});
  await assert.rejects(closed.synthesize('hello'), /EGRESS_UNAVAILABLE/);
});

test('reply is pending until its exact downstream marker; unrelated markers cannot complete it', async () => {
  const audioSession = media({autoMark: false}); const states = [];
  const speech = createOwnerSpeech({audioSession, client: {synthesize: async () => Buffer.alloc(960)},
    onState: e => states.push(e.state)});
  let finished = false;
  const p = speech({text: 'alpha: answer', id: 'one', signal: new AbortController().signal}).then(r => {finished = true; return r;});
  await new Promise(setImmediate);
  assert.equal(finished, false); assert.equal(states.at(-1), 'playing');
  audioSession.emit('playout_marker', {name: 'unrelated', itemId: audioSession.completed});
  assert.equal(finished, false);
  audioSession.emit('playout_marker', audioSession.markers[0]);
  assert.equal((await p).state, 'played'); assert.equal(states.at(-1), 'played');
});

test('transient synthesis failure retries once before audio; playback failure cannot replay', async () => {
  let calls = 0; const audioSession = media();
  const speech = createOwnerSpeech({audioSession, client: {synthesize: async () => {
    if (++calls === 1) throw Object.assign(new Error('timeout'), {code: 'OWNER_SPEECH_TIMEOUT'});
    return Buffer.alloc(960);
  }}});
  assert.equal((await speech({text: 'saved reply', id: 'two', signal: new AbortController().signal})).state, 'played');
  assert.equal(calls, 2); assert.equal(audioSession.sent.length, 1);
  for (const options of [{send: false}, {mismatched: true}]) {
    calls = 0; const failed = createOwnerSpeech({audioSession: media(options), client: {synthesize: async () => {calls++; return Buffer.alloc(960);}}});
    assert.equal((await failed({text: 'reply', id: 'failed', signal: new AbortController().signal})).state, 'failed');
    assert.equal(calls, 1);
  }
});

test('interruption terminates playback and keeps it distinct from delivered or retryable', async () => {
  const audioSession = media({autoMark: false}); const abort = new AbortController();
  const speech = createOwnerSpeech({audioSession, client: {synthesize: async () => Buffer.alloc(960)}});
  const pending = speech({text: 'reply', id: 'cancel', signal: abort.signal});
  await new Promise(setImmediate); abort.abort();
  assert.equal((await pending).state, 'interrupted'); assert.equal(audioSession.stops, 1);
  audioSession.emit('playout_marker', audioSession.markers[0]);
  assert.equal(audioSession.listenerCount('playout_marker'), 0);
});

test('long text is chunked without rewriting commands and audio remains serial', async () => {
  const text = 'Run `echo one && echo two`. '.repeat(100);
  const chunks = speechChunks(text); assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= 1800));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), text.trim());
  assert.throws(() => speechChunks('x'.repeat(48001)), /TEXT_LIMIT/);
  const spoken = []; const speech = createOwnerSpeech({audioSession: media(),
    client: {synthesize: async t => {spoken.push(t); return Buffer.alloc(960);}}});
  assert.equal((await speech({text, id: 'long', signal: new AbortController().signal})).playedChunks, chunks.length);
  assert.deepEqual(spoken, chunks);
});

test('reply watcher waits for playback completion and never overlaps or resends', async () => {
  let finish; let reads = 0; let speaks = 0;
  const watch = new OwnerReplyWatch({schedule: () => 1, cancel() {}, available: () => true,
    read: async () => {reads++; return {success: true, result: {history: {latestTurn: {status: 'completed', reply: {text: 'answer'}}}}};},
    speak: () => {speaks++; return new Promise(resolve => {finish = resolve;});}});
  watch.start('operation'); const pending = watch.tick(watch.current);
  await new Promise(setImmediate); assert.ok(watch.has('operation'));
  await watch.tick(watch.current); assert.equal(reads, 1); assert.equal(speaks, 1);
  finish(true); await pending; assert.equal(watch.has('operation'), false);
});


test('an uncertain speech receipt cannot trigger another readback', async () => {
  let spoken = 0;
  const watch = new OwnerReplyWatch({schedule: () => 1, cancel() {}, available: () => true,
    read: async () => ({success: true, result: {history: {latestTurn: {status: 'completed', reply: {text: 'answer'}}}}}),
    speak: async () => {spoken++; throw new Error('receipt storage unavailable after playout');}});
  watch.start('operation'); await watch.tick(watch.current);
  assert.equal(spoken, 1); assert.equal(watch.has('operation'), false);
});
