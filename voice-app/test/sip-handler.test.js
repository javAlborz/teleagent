const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractContactUri,
  normalizeCallbackContactUri,
} = require('../lib/sip-handler');

test('extractContactUri parses bracketed SIP contact headers', () => {
  const req = {
    get(name) {
      if (name === 'Contact') {
        return '<sip:1001@100.101.120.26:52596;transport=udp>';
      }
      return '';
    }
  };

  assert.equal(extractContactUri(req), 'sip:1001@100.101.120.26:52596;transport=udp');
});

test('extractContactUri parses bare SIP contact headers', () => {
  const req = {
    get(name) {
      if (name === 'Contact') {
        return 'sip:1001@100.101.120.26:52596';
      }
      return '';
    }
  };

  assert.equal(extractContactUri(req), 'sip:1001@100.101.120.26:52596');
});

test('normalizeCallbackContactUri rejects Asterisk loopback contacts', () => {
  assert.equal(
    normalizeCallbackContactUri('sip:asterisk@127.0.0.1:5060'),
    null
  );
});
