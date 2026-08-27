'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createOutboundRoutingConfig,
} = require('../lib/outbound-routing-config');

const CALLBACK_AUTH = Object.freeze({
  username: 'teleagent-voice',
  password: 'callback-0123456789abcdef0123456789abcdef',
});

test('startup routing config binds an exact host, port, and transport', () => {
  const route = createOutboundRoutingConfig({
    host: 'PBX.INTERNAL',
    port: '5061',
    transport: 'TLS',
    callbackAuth: CALLBACK_AUTH,
  });

  assert.deepEqual(
    { host: route.host, port: route.port, transport: route.transport, authority: route.authority },
    { host: 'pbx.internal', port: 5061, transport: 'tls', authority: 'pbx.internal:5061' }
  );
  assert.equal(route.buildSipUri('+15551234567'), 'sip:95551234567@pbx.internal:5061;transport=tls');
});

test('routing config rejects embedded authorities, URI syntax, parameters, and invalid ports', () => {
  const invalidHosts = [
    'sip:pbx.internal',
    'user@pbx.internal',
    '127.0.0.1:5060',
    '127.0.0.1;transport=tcp',
    'pbx.internal/path',
    ' pbx.internal',
  ];
  for (const host of invalidHosts) {
    assert.throws(
      () => createOutboundRoutingConfig({
        host,
        port: '5060',
        transport: 'udp',
        callbackAuth: CALLBACK_AUTH,
      }),
      /SIP_TRUNK_HOST/
    );
  }
  assert.throws(
    () => createOutboundRoutingConfig({
      host: '127.0.0.1', port: 65536, transport: 'udp', callbackAuth: CALLBACK_AUTH,
    }),
    /SIP_TRUNK_PORT/
  );
  assert.throws(
    () => createOutboundRoutingConfig({
      host: '127.0.0.1', port: 5060, transport: 'ws', callbackAuth: CALLBACK_AUTH,
    }),
    /SIP_TRUNK_TRANSPORT/
  );
});

test('PBX route validation runs before voice-app opens SIP or HTTP', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  const validation = source.indexOf('config.sip_trunk_security = loadSipTrunkSecurityConfig()');
  const ingressAuthentication = source.indexOf('.authenticateInvite(req, res)');
  const inboundDispatch = source.indexOf('inboundCallRegistry.dispatch(req, res');
  const srfConstruction = source.indexOf('var srf = new Srf()');
  const sipConnect = source.indexOf('srf.connect({');
  const httpCreate = source.indexOf('createHttpServer(');
  assert.ok(validation > 0);
  assert.ok(srfConstruction > validation);
  assert.ok(sipConnect > validation);
  assert.ok(httpCreate > validation);
  assert.ok(ingressAuthentication > validation);
  assert.ok(inboundDispatch > ingressAuthentication);
});
