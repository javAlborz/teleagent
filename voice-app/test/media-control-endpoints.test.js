'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadMediaControlEndpoints } = require('../lib/media-control-endpoints');

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
  const validation = source.indexOf('config.media_endpoints = loadMediaControlEndpoints(process.env)');
  assert.ok(validation > 0);
  for (const boundary of ['var srf = new Srf()', 'new OutboundRuntimeFence', 'srf.connect({']) {
    assert.ok(validation < source.indexOf(boundary), `endpoint validation must precede ${boundary}`);
  }
});
