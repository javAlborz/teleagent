import assert from 'node:assert/strict';
import test from 'node:test';

import { SidebandSession } from '../src/sideband-session.js';
import { FakeSocket, makeConfig } from './helpers.js';

test('sideband attaches by call_id with server-side authorization and emits raw DTMF', async () => {
  const socket = new FakeSocket();
  let connection;
  const session = new SidebandSession({
    callId: 'rtc_test_1',
    config: makeConfig(),
    webSocketFactory(url, options) {
      connection = { url, options };
      return socket;
    },
  });
  const rawEvents = [];
  const dtmfEvents = [];
  session.on('raw_event', (event) => rawEvents.push(event));
  session.on('dtmf', (event) => dtmfEvents.push(event));

  const connecting = session.connect();
  socket.emit('open');
  await connecting;
  assert.equal(new URL(connection.url).searchParams.get('call_id'), 'rtc_test_1');
  assert.equal(connection.options.headers.Authorization, 'Bearer sk-test-not-a-real-key');

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'input_audio_buffer.dtmf_event_received',
    event: '#',
    received_at: 123,
  })));
  assert.equal(rawEvents.length, 1);
  assert.equal(dtmfEvents[0].digit, '#');
  assert.equal(dtmfEvents[0].receivedAt, 123);

  session.requestResponse();
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'response.create' });
});

test('sideband reports malformed messages without emitting raw events', async () => {
  const socket = new FakeSocket();
  const session = new SidebandSession({
    callId: 'rtc_test_1',
    config: makeConfig(),
    webSocketFactory: () => socket,
  });
  const errors = [];
  const events = [];
  session.on('protocol_error', (error) => errors.push(error));
  session.on('raw_event', (event) => events.push(event));
  const connecting = session.connect();
  socket.emit('open');
  await connecting;
  socket.emit('message', Buffer.from('not-json'));
  socket.emit('message', Buffer.from('{}'));
  assert.equal(errors.length, 2);
  assert.equal(events.length, 0);
});

test('sideband closes an event that exceeds the local size limit', async () => {
  const socket = new FakeSocket();
  const session = new SidebandSession({
    callId: 'rtc_test_1',
    config: makeConfig({ maxRealtimeEventBytes: 16 }),
    webSocketFactory: () => socket,
  });
  const connecting = session.connect();
  socket.emit('open');
  await connecting;
  socket.emit('message', Buffer.from('{"type":"this-is-too-large"}'));
  assert.deepEqual(socket.closes[0], { code: 1009, reason: 'event too large' });
});
