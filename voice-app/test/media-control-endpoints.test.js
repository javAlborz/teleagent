'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildFreeswitchConnectionOptions,
  loadMediaControlEndpoints,
} = require('../lib/media-control-endpoints');

test('media control clients are pinned to exact IPv4 loopback ports', () => {
  assert.deepEqual(loadMediaControlEndpoints({}), {
    drachtio: { host: '127.0.0.1', port: 9022 },
    freeswitch: { host: '127.0.0.1', port: 8021 },
  });
  assert.deepEqual(loadMediaControlEndpoints({
    DRACHTIO_HOST: '127.0.0.1', DRACHTIO_PORT: '9022',
    FREESWITCH_HOST: '127.0.0.1', FREESWITCH_PORT: '8021',
  }), {
    drachtio: { host: '127.0.0.1', port: 9022 },
    freeswitch: { host: '127.0.0.1', port: 8021 },
  });
});

test('attacker hosts, alternate ports, IPv6, whitespace, and trailing junk fail closed', () => {
  for (const settings of [
    { DRACHTIO_HOST: 'attacker.example' },
    { DRACHTIO_HOST: '::1' },
    { DRACHTIO_HOST: '127.0.0.1 ' },
    { DRACHTIO_PORT: '9023' },
    { DRACHTIO_PORT: '9022junk' },
    { FREESWITCH_HOST: '10.0.0.8' },
    { FREESWITCH_HOST: 'localhost' },
    { FREESWITCH_PORT: '8022' },
    { FREESWITCH_PORT: '08021' },
  ]) assert.throws(() => loadMediaControlEndpoints(settings), /exact reviewed loopback endpoint/);
});

test('endpoint validation precedes all secret-bearing network clients', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const validation = source.indexOf('config.media_endpoints = loadMediaControlEndpoints(process.env, mediaReceiverRuntime)');
  assert.ok(validation > 0);
  for (const boundary of ['var srf = new Srf()', 'new OutboundRuntimeFence', 'srf.connect({']) {
    assert.ok(validation < source.indexOf(boundary), `endpoint validation must precede ${boundary}`);
  }
});

test('FreeSWITCH reverse ESL callback cannot auto-select a host interface', () => {
  assert.deepEqual(buildFreeswitchConnectionOptions(
    { host: '127.0.0.1', port: 8021 },
    'not-a-real-secret',
  ), {
    address: '127.0.0.1',
    port: 8021,
    secret: 'not-a-real-secret',
    listenAddress: '127.0.0.1',
    advertisedAddress: '127.0.0.1',
  });
  for (const endpoint of [
    { host: '77.42.23.239', port: 8021 },
    { host: '127.0.0.1', port: 8022 },
    null,
  ]) assert.throws(
    () => buildFreeswitchConnectionOptions(endpoint, 'not-a-real-secret'),
    /exact reviewed loopback endpoint/,
  );

  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const connectStart = source.indexOf('function connectToFreeswitch()');
  const connectEnd = source.indexOf('// Connect with exponential backoff retry');
  const connectSource = source.slice(connectStart, connectEnd);

  assert.ok(connectStart > 0 && connectEnd > connectStart);
  assert.match(connectSource, /buildFreeswitchConnectionOptions\(/);
});
