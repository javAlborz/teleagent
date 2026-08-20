'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { AudioForkSession } = require('../lib/audio-fork');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(data, options) {
    this.sent.push({ data, options });
  }
}

test('audio fork emits every inbound PCM chunk even when legacy utterance capture is disabled', async () => {
  const ws = new FakeSocket();
  const session = new AudioForkSession({
    ws,
    callUuid: 'call-realtime',
    sampleRate: 24000,
    bidirectionalStreaming: true,
  });
  session.setCaptureEnabled(false);

  const incoming = once(session, 'audio');
  const chunk = Buffer.from([0, 0, 1, 0]);
  ws.emit('message', chunk, true);
  const [received] = await incoming;
  assert.deepEqual(received, chunk);
});

test('text metadata delivered as a Buffer is not mistaken for audio', async () => {
  const ws = new FakeSocket();
  const session = new AudioForkSession({ ws, callUuid: 'call-metadata' });
  const metadata = once(session, 'metadata');
  ws.emit('message', Buffer.from('{"sampleRate":24000,"mode":"realtime"}'), false);
  const [value] = await metadata;
  assert.equal(value.sampleRate, 24000);
  assert.equal(session.sampleRate, 24000);
});

test('streaming bidirectional playout sends raw PCM binary and killAudio flushes it', () => {
  const ws = new FakeSocket();
  const session = new AudioForkSession({
    ws,
    callUuid: 'call-playout',
    sampleRate: 24000,
    bidirectionalStreaming: true,
  });
  const audio = Buffer.alloc(2400, 1);
  assert.equal(session.sendAudio(audio, { sampleRate: 24000, itemId: 'item-1' }), true);
  assert.deepEqual(ws.sent[0].data, audio);
  assert.deepEqual(ws.sent[0].options, { binary: true });

  const playout = session.stopPlayback();
  assert.equal(playout.itemId, 'item-1');
  assert.equal(playout.totalAudioMs, 50);
  assert.deepEqual(JSON.parse(ws.sent[1].data), { type: 'killAudio' });
});

test('completed playout is not killed after all source audio has drained', () => {
  const ws = new FakeSocket();
  const session = new AudioForkSession({
    ws,
    callUuid: 'call-playout-complete',
    sampleRate: 24000,
    bidirectionalStreaming: true,
  });
  const audio = Buffer.alloc(2400, 1);
  session.sendAudio(audio, { sampleRate: 24000, itemId: 'item-complete' });
  assert.equal(session.markPlaybackComplete('item-complete'), true);
  session._playout.startedAt -= 200;

  assert.equal(session.stopPlayback(), null);
  assert.equal(ws.sent.length, 1);
});

test('legacy non-streaming bidirectional playout remains JSON base64', () => {
  const ws = new FakeSocket();
  const session = new AudioForkSession({ ws, callUuid: 'call-legacy' });
  const audio = Buffer.from([1, 2, 3, 4]);
  session.sendAudio(audio, { sampleRate: 16000 });
  const message = JSON.parse(ws.sent[0].data);
  assert.equal(message.type, 'playAudio');
  assert.equal(message.data.sampleRate, 16000);
  assert.deepEqual(Buffer.from(message.data.audioContent, 'base64'), audio);
});
