'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBoundaryProof, SPEECH_SHA256 } = require('../pbx-attester-boundary');
const epoch = 'a'.repeat(64);
const proof = { version: 1, epoch, bootId: '00000000-0000-4000-8000-000000000000',
  pbxInstanceId: 'b'.repeat(64), pbxPid: 100, pbxStart: '123', proxyPid: 101, proxyStart: '124',
  namespaceDevice: '4', namespaceInode: '567', speechSha256: SPEECH_SHA256,
  policy: 'tailnet-sdes-authenticated-rfc4733-no-info-v1', ariSocketDevice: '25', ariSocketInode: '678' };
test('boundary receipt requires exact current authority and reviewed media policy', () => {
  assert.deepEqual(parseBoundaryProof(JSON.stringify(proof), epoch), proof);
  for (const change of [{ epoch: 'b'.repeat(64) }, { policy: 'plain-rtp' }, { speechSha256: 'c'.repeat(64) },
    { pbxPid: 0 }, { proxyPid: '101' }, { proxyStart: 124 }, { namespaceInode: '../ns' },
    { bootId: 'old' }, { arbitrary: true }, { ariSocketDevice: '-1' }]) {
    assert.throws(() => parseBoundaryProof(JSON.stringify({ ...proof, ...change }), epoch));
  }
});
