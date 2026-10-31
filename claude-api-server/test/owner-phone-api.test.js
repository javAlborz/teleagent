'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOwnerPhoneApi } = require('../owner-phone-api');
const { parseEpoch } = require('../owner-authority-config');
const crypto = require('node:crypto');

test('invalid line/control characters receive a pre-dispatch refusal without starting a coordinator', async () => {
  const api = createOwnerPhoneApi({assertUnlocked() {}, broker: {}, coordinator: {
    store: {assertUnlocked() {}}, request() {assert.fail('invalid message must not reach dispatch');},
  }});
  for (const message of ['what is five plus five?\nCan you', 'first\rsecond', 'hello\x1b[31m', 'a\u202eb', '']) {
    await assert.rejects(api.handle('request', {id: 'os_beta', operationId: 'job_example', message,
      sipCallId: 'call@pbx'}), {code: 'OWNER_PHONE_MESSAGE_INVALID'});
  }
});

test('phone projection strips native identities and forwards only the exact canonical request', async () => {
  const calls = [];
  const api = createOwnerPhoneApi({ assertUnlocked() {}, broker: {
    async inspect() { return { id: 'os_a', provider: 'codex', label: 'A', status: 'idle',
      sessionFingerprint: 'private', activeTurnId: 'private', history: { messages: [] } }; },
  }, coordinator: { store: { assertUnlocked() {} }, async request(input, context) { calls.push({ input, context }); return { state: 'pending_approval' }; } } });
  assert.deepEqual(await api.handle('inspect', { id: 'os_a', history: true }), {
    id: 'os_a', provider: 'codex', label: 'A', status: 'idle', history: { messages: [] }, scope: 'exact_enrolled_native_session',
  });
  const input = { id: 'os_a', operationId: 'job_a', message: 'Review', sipCallId: 'call@pbx' };
  await api.handle('request', input);
  assert.deepEqual(calls, [{ input: { id: 'os_a', operationId: 'job_a', message: 'Review' }, context: { sipCallId: 'call@pbx' } }]);
  await assert.rejects(api.handle('request', { ...input, evidenceToken: 'invented' }));
  await assert.rejects(api.handle('deliver', input));
  await assert.rejects(api.handle('inspect', { id: 'os_a', history: 'true' }));
  assert.equal(calls.length, 1);
});

test('panic or host admission refusal fences even otherwise valid phone requests', async () => {
  const api = createOwnerPhoneApi({ assertUnlocked() { throw new Error('locked'); },
    broker: { list() { assert.fail('must not read'); } }, coordinator: {} });
  await assert.rejects(api.handle('list', {}), /locked/);
});

test('group inventory is read-only and cannot accept caller-selected host commands or sockets', async () => {
  let calls = 0;
  const api = createOwnerPhoneApi({assertUnlocked() {}, coordinator: {store: {assertUnlocked() {}}},
    broker: {inventory: async () => {calls++; return {groups: [], sessions: []};}}});
  assert.deepEqual(await api.handle('inventory', {}), {groups: [], sessions: []});
  for (const input of [{command: 'send-keys'}, {socket: '/tmp/other'}, {id: 'os_invented'}]) {
    await assert.rejects(api.handle('inventory', input));
  }
  assert.equal(calls, 1);
});

test('authority epochs require three distinct Ed25519 public keys with exact roles', () => {
  const input = { version: 1, epoch: 'a'.repeat(64) };
  for (const role of ['arm', 'pbx', 'execution']) input[role] = { keyId: role,
    publicKey: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) };
  assert.equal(parseEpoch(JSON.stringify(input)).arm.publicKey.asymmetricKeyType, 'ed25519');
  assert.throws(() => parseEpoch(JSON.stringify({ ...input, token: 'unexpected' })));
  assert.throws(() => parseEpoch(JSON.stringify({ ...input, pbx: { ...input.arm, keyId: 'pbx' } })), { code: 'OWNER_AUTHORITY_KEYS_NOT_DISTINCT' });
  assert.throws(() => parseEpoch(JSON.stringify({ ...input, pbx: { ...input.pbx, keyId: 'arm' } })), { code: 'OWNER_AUTHORITY_KEYS_NOT_DISTINCT' });
  const rsa = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => parseEpoch(JSON.stringify({ ...input, pbx: { keyId: 'pbx', publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }) } })), { code: 'OWNER_AUTHORITY_CONFIG_INVALID' });
});

test('operation reply uses the stored request and target, rejects injected identities', async () => {
  const operationId = 'job_' + 'a'.repeat(64); const calls = [];
  const request = { operationId, message: 'test' };
  const api = createOwnerPhoneApi({ assertUnlocked() {}, coordinator: { store: {
    assertUnlocked() {}, get: id => id === operationId ? { catalog_id: 'os_original', request_json: JSON.stringify(request) } : null,
  } }, broker: { reply: input => { calls.push(input); return { history: { latestTurn: { status: 'unknown', reply: null } } }; } } });
  await api.handle('reply', { operationId });
  assert.deepEqual(calls, [{ id: 'os_original', request }]);
  await assert.rejects(api.handle('reply', { operationId, id: 'os_other' }));
  await assert.rejects(api.handle('reply', { operationId: 'job_' + 'b'.repeat(64) }), { code: 'OWNER_PHONE_OPERATION_NOT_FOUND' });
  assert.equal(calls.length, 1);
});
