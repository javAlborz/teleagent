import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authenticatePrivatePbx,
  decideIncomingCall,
  extractDtmfDigit,
  sipHeadersToMap,
} from '../src/sip-event.js';
import { incomingEvent, makeConfig, testPbxSecret } from './helpers.js';

test('SIP policy compares From and To values exactly and case-insensitively by header name', () => {
  const event = incomingEvent();
  event.data.sip_headers[0].name = 'fRoM';
  const decision = decideIncomingCall(
    makeConfig({ allowedTo: ['sip:extension-70@asterisk.test'] }),
    event,
  );
  assert.equal(decision.action, 'accept');

  event.data.sip_headers[0].value = 'sip:someone-else@asterisk.test';
  const rejected = decideIncomingCall(makeConfig(), event);
  assert.equal(rejected.action, 'reject');
  assert.equal(rejected.reason, 'caller_not_allowed');
  assert.equal(rejected.authenticatedPrincipal, 'hermes-test-pbx');
});

test('From and To are routing filters only; the PBX credential is independently required', () => {
  const event = incomingEvent();
  event.data.sip_headers = event.data.sip_headers.filter(
    (header) => header.name.toLowerCase() !== 'x-teleagent-pbx-auth',
  );
  const missing = decideIncomingCall(makeConfig(), event);
  assert.equal(missing.action, 'reject');
  assert.equal(missing.reason, 'pbx_auth_failed');

  event.data.sip_headers.push({ name: 'X-Teleagent-PBX-Auth', value: `${testPbxSecret}-wrong` });
  assert.equal(decideIncomingCall(makeConfig(), event).reason, 'pbx_auth_failed');

  event.data.sip_headers[2].value = testPbxSecret;
  event.data.sip_headers.push({ name: 'x-teleagent-pbx-auth', value: testPbxSecret });
  assert.equal(decideIncomingCall(makeConfig(), event).reason, 'pbx_auth_failed');
});

test('authenticated principal comes only from sanitized local configuration', () => {
  const headers = sipHeadersToMap(incomingEvent().data.sip_headers);
  assert.equal(authenticatePrivatePbx(makeConfig(), headers), 'hermes-test-pbx');
  headers.set('x-teleagent-pbx-principal', ['attacker-controlled']);
  assert.equal(authenticatePrivatePbx(makeConfig(), headers), 'hermes-test-pbx');
});

test('reject mode never accepts an otherwise allowed caller', () => {
  const decision = decideIncomingCall(makeConfig({ mode: 'reject' }), incomingEvent());
  assert.equal(decision.action, 'reject');
  assert.equal(decision.statusCode, 486);
});

test('DTMF extractor supports the documented event field and rejects invalid keys', () => {
  assert.equal(
    extractDtmfDigit({ type: 'input_audio_buffer.dtmf_event_received', event: '#' }),
    '#',
  );
  assert.equal(
    extractDtmfDigit({ type: 'input_audio_buffer.dtmf_event_received', event: 'a' }),
    'A',
  );
  assert.equal(
    extractDtmfDigit({ type: 'input_audio_buffer.dtmf_event_received', event: 'Z' }),
    null,
  );
});

test('SIP header parser drops malformed entries', () => {
  const headers = sipHeadersToMap([
    null,
    { name: 'From', value: ' sip:a@example.test ' },
    { name: 1, value: 'ignored' },
  ]);
  assert.deepEqual(headers.get('from'), ['sip:a@example.test']);
  assert.equal(headers.size, 1);
});
