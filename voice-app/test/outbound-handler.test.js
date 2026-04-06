const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSipUri } = require('../lib/outbound-handler');

test('buildSipUri forces UDP for loopback SIP trunk hosts', () => {
  const sipUri = buildSipUri({
    to: '1001',
    sipTrunkHost: '127.0.0.1',
    sipTrunkTransport: ''
  });

  assert.equal(sipUri, 'sip:1001@127.0.0.1;transport=udp');
});

test('buildSipUri honors explicit transport configuration', () => {
  const sipUri = buildSipUri({
    to: '1001',
    sipTrunkHost: 'pbx.internal:5060',
    sipTrunkTransport: 'tcp'
  });

  assert.equal(sipUri, 'sip:1001@pbx.internal:5060;transport=tcp');
});

test('buildSipUri preserves explicit dial URIs', () => {
  const sipUri = buildSipUri({
    to: '1001',
    dialUri: 'sip:1001@100.101.120.26:57515;transport=udp',
    sipTrunkHost: '127.0.0.1',
    sipTrunkTransport: 'udp'
  });

  assert.equal(sipUri, 'sip:1001@100.101.120.26:57515;transport=udp');
});
