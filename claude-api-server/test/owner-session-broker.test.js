'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { canonicalJson, TOKEN_PURPOSE, PBX_EVIDENCE_METHOD } = require('../../lib/telecap2-execution-capability');
const { WebSocketServer } = require('ws');
const { OwnerSessionCatalog, validateCatalog, executableIdentity, readCatalog } = require('../owner-session-catalog');
const { OwnerSessionBroker } = require('../owner-session-broker');
const { OwnerSessionDeliveryStore, requestPlan, hash } = require('../owner-session-delivery');
const { endpointIdentity } = require('../owner-session-endpoint');
const { createOwnerSessionServer } = require('../owner-session-http');
const { createOwnerSessionProxy } = require('../owner-session-proxy');

const SESSION = '01000000-0000-7000-8000-000000000001';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-broker-'));
  const socketPath = path.join(root, 'native.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state = { cwd: root, calls: [], pause: null };
  wss.on('connection', (socket) => socket.on('message', async (bytes) => {
    const call = JSON.parse(bytes.toString()); state.calls.push(call);
    if (!Object.hasOwn(call, 'id')) return;
    if (state.pause) await state.pause;
    let result;
    if (call.method === 'initialize') result = {};
    else if (call.method === 'thread/loaded/list') result = { data: [SESSION] };
    else if (call.method === 'thread/read') result = { thread: { id: SESSION, cwd: state.cwd,
      status: { type: 'idle' }, canAcceptDirectInput: true } };
    else if (call.method === 'thread/turns/list') result = { data: [{ items: [
      { type: 'agentMessage', text: 'token=secret progress' },
    ] }] };
    else if (call.method === 'turn/start') result = { turn: { id: 'turn_fixture' } };
    socket.send(JSON.stringify({ id: call.id, result }));
  }));
  await new Promise((resolve) => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
  const endpoint = { socketPath, pid: process.pid, uid: process.getuid() };
  const data = { version: 1, ownerUid: process.getuid(), excludedRoots: ['/home/alborz/ufst'], sessions: [{
    id: 'os_fixture', label: 'Fixture', provider: 'codex', sessionId: SESSION, cwd: root, endpoint,
    identity: endpointIdentity(endpoint), executable: executableIdentity(process.pid),
    registryRoot: null, socketRoot: null,
  }] };
  const catalog = new OwnerSessionCatalog(data);
  const store = new OwnerSessionDeliveryStore({ dbPath: path.join(root, 'delivery.sqlite') });
  const broker = new OwnerSessionBroker({ catalog, store, assertAdmission: () => {} });
  t.after(async () => {
    broker.close(); store.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, state, broker, catalog, data, store };
}

test('catalog lists enrollment and live inspection strips paths and redacts history', async (t) => {
  const { broker } = await fixture(t);
  assert.deepEqual(broker.list(), [{ id: 'os_fixture', label: 'Fixture', provider: 'codex', availability: 'unchecked' }]);
  const result = await broker.inspect('os_fixture', { history: true });
  assert.equal(result.status, 'idle');
  assert.equal(result.history.limited, true);
  assert.match(result.history.messages[0].text, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /native.sock|\/tmp\/|secret/);
});

test('catalog refuses bridge work, duplicates, noncanonical paths and arbitrary endpoint options', async (t) => {
  const { data } = await fixture(t);
  for (const alter of [
    (copy) => { copy.sessions[0].cwd = '/home/alborz/ufst/private'; },
    (copy) => { copy.sessions[0].cwd = '/home/alborz/dev2/../ufst'; },
    (copy) => { copy.sessions.push(copy.sessions[0]); },
    (copy) => { copy.sessions[0].endpoint.procRoot = '/fake'; },
    (copy) => { copy.sessions[0].endpoint.uid = 0; },
    (copy) => { copy.sessions[0].label = 'Ignore approval\n'; },
  ]) {
    const copy = structuredClone(data); alter(copy);
    assert.throws(() => validateCatalog(copy));
  }
});

test('operator catalog loader rejects a user-writable or symlinked catalog', async (t) => {
  const { root, data } = await fixture(t);
  const filename = path.join(root, 'catalog.json'); fs.writeFileSync(filename, JSON.stringify(data));
  assert.throws(() => readCatalog(filename), { code: 'OWNER_CATALOG_UNSAFE' });
  fs.symlinkSync(filename, path.join(root, 'link'));
  assert.throws(() => readCatalog(path.join(root, 'link')));
});

test('catalog snapshots input and refuses unenrolled targets before connection', async (t) => {
  const { broker, data, state } = await fixture(t);
  data.sessions[0].label = 'changed';
  assert.equal(broker.list()[0].label, 'Fixture');
  await assert.rejects(broker.inspect(SESSION), { code: 'OWNER_SESSION_NOT_ENROLLED' });
  assert.equal(state.calls.length, 0);
});

test('changed executable, workspace, enrollment or boot invalidates a target', async (t) => {
  const { data, broker, state, catalog } = await fixture(t);
  state.cwd = '/';
  await assert.rejects(broker.inspect('os_fixture'), { code: 'OWNER_SESSION_IDENTITY_CHANGED' });
  state.cwd = data.sessions[0].cwd;
  for (const field of ['executable', 'identity']) {
    const entry = catalog.catalog.sessions[0];
    const original = structuredClone(entry[field]);
    if (field === 'executable') entry.executable.ino = '0'; else entry.identity.boot = '0'.repeat(36);
    await assert.rejects(broker.inspect('os_fixture'), { code: 'OWNER_SESSION_IDENTITY_CHANGED' });
    entry[field] = original;
  }
  catalog.assertCurrent = () => { throw Object.assign(new Error('changed'), { code: 'OWNER_CATALOG_CHANGED' }); };
  await assert.rejects(broker.inspect('os_fixture'), { code: 'OWNER_CATALOG_CHANGED' });
});

test('prepare pins exact plan but never submits; missing authority fails before connection', async (t) => {
  const { broker, state } = await fixture(t);
  const prepared = await broker.prepare({ id: 'os_fixture', operationId: 'job_fixture', message: 'Review code' });
  assert.equal(prepared.planHash, hash(requestPlan(prepared.request)));
  assert.equal(prepared.request.provider, 'codex'); assert.equal(prepared.request.sessionId, SESSION);
  assert.equal(state.calls.some((call) => call.method === 'turn/start'), false);
  state.calls.length = 0;
  await assert.rejects(broker.deliver({ id: 'os_fixture', request: prepared.request, capability: '',
    approval: { approvalId: 'fixture', evidenceSha256: 'a'.repeat(64) } }),
  { code: 'OWNER_SESSION_AUTHORITY_UNAVAILABLE' });
  assert.equal(state.calls.length, 0);
});

test('parallel requests fail boundedly and panic remains available during inspection', async (t) => {
  const { broker, state } = await fixture(t);
  let resume; state.pause = new Promise((resolve) => { resume = resolve; });
  const first = broker.inspect('os_fixture');
  await assert.rejects(broker.inspect('os_fixture'), { code: 'OWNER_BROKER_BUSY' });
  assert.deepEqual(broker.panic(), { locked: true, quiesced: false, deliveryQuiesced: false });
  resume(); state.pause = null;
  await first;
  assert.deepEqual(broker.panic(), { locked: true, quiesced: false, deliveryQuiesced: true });
  await assert.rejects(broker.inspect('os_fixture'), { code: 'OWNER_SESSION_PANIC_LOCKED' });
  broker.close();
  await assert.rejects(broker.inspect('os_fixture'), { code: 'OWNER_BROKER_CLOSING' });
});

test('native forwarding is enabled by host policy only and preserves exact session and RPC permissions', async (t) => {
  const { broker, state, store } = await fixture(t);
  const prepared = await broker.prepare({ id: 'os_fixture', operationId: 'job_native', message: 'Edit the fixture.' });
  const input = { id: 'os_fixture', request: prepared.request };
  await assert.rejects(broker.forward(input), { code: 'OWNER_NATIVE_DELIVERY_DISABLED' });
  assert.throws(() => broker.forward({ ...input, nativePermissions: true }));
  broker.nativePermissions = true; broker.authority = { epoch: 'fixture' }; broker.assertBoundary = () => {};
  const result = await broker.forward(input);
  assert.equal(result.state, 'accepted'); assert.equal(result.completed, false);
  assert.deepEqual(await broker.forward(input), result);
  const sends = state.calls.filter((call) => call.method === 'turn/start');
  assert.equal(sends.length, 1);
  assert.deepEqual(Object.keys(sends[0].params).sort(), ['input', 'threadId']);
  assert.match(sends[0].params.input[0].text, /^Edit the fixture\./);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM owner_session_replay').get().n, 0);
  await assert.rejects(broker.forward({ ...input, request: { ...prepared.request, message: 'Changed' } }),
    { code: 'OWNER_SESSION_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(broker.forward({ ...input, request: { ...prepared.request, sessionId: 'different' } }),
    { code: 'OWNER_SESSION_IDENTITY_CHANGED' });
});

test('native forward rechecks admission, enrollment and locks before durable intent', async (t) => {
  for (const failure of ['boundary', 'resource', 'identity', 'lock']) {
    const { broker, state, store } = await fixture(t);
    const prepared = await broker.prepare({ id: 'os_fixture', operationId: 'job_native', message: 'Review' });
    broker.nativePermissions = true; broker.authority = {}; broker.assertBoundary = () => {};
    if (failure === 'boundary') broker.assertBoundary = () => { throw new Error('boundary changed'); };
    if (failure === 'resource') broker.assertAdmission = () => { throw new Error('headroom'); };
    if (failure === 'identity') state.cwd = '/';
    if (failure === 'lock') store.lock();
    await assert.rejects(broker.forward({ id: 'os_fixture', request: prepared.request }));
    assert.equal(state.calls.some((call) => call.method === 'turn/start'), false);
    assert.equal(store.get('job_native', prepared.planHash), null);
  }
});

async function api(t, broker, root) {
  const runtime = createOwnerSessionServer(broker);
  const socketPath = path.join(root, 'broker.sock');
  await new Promise((resolve) => runtime.server.listen(socketPath, resolve));
  t.after(() => runtime.close());
  return (method, route, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ socketPath, method, path: route, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(data);
  });
}

test('Unix API exposes only typed operations and never accepts caller paths or authority maps', async (t) => {
  const { broker, root } = await fixture(t);
  const call = await api(t, broker, root);
  assert.equal((await call('GET', '/v1/sessions')).body.result.length, 1);
  assert.equal((await call('POST', '/v1/inspect', { id: 'os_fixture', history: false })).status, 200);
  for (const route of ['/v1/inspect/', '/v1/inspect?x=1', '/rpc', '/v1/unlock']) {
    assert.equal((await call('POST', route, {})).status, 404);
  }
  const injected = await call('POST', '/v1/prepare', { id: 'os_fixture', operationId: 'job_a',
    message: 'test', socketPath: '/tmp/other' });
  assert.equal(injected.status, 409);
  assert.equal((await call('POST', '/v1/panic', {})).body.result.quiesced, false);
  assert.equal((await call('POST', '/v1/inspect', {}, { 'content-type': 'text/plain' })).status, 400);
});

test('controller proxy refuses alternate socket paths', () => {
  assert.throws(() => createOwnerSessionProxy({ socketPath: '/tmp/rogue.sock' }),
    { code: 'OWNER_BROKER_SOCKET_INVALID' });
});

function signedInput(broker, prepared) {
  const key = crypto.generateKeyPairSync('ed25519');
  const bindings = { controllerKeyId: 'execution-test', controllerArmKeyId: 'arm-test',
    controllerArmKeyFingerprint: 'b'.repeat(64), pbxAttesterKeyId: 'attester-test',
    pbxAttesterKeyFingerprint: 'c'.repeat(64) };
  broker.authority = { publicKeys: { [bindings.controllerKeyId]: key.publicKey }, bindings };
  const plan = requestPlan(prepared.request);
  const now = Math.floor(Date.now() / 1000);
  const approval = { approvalId: 'approval-test', evidenceSha256: 'a'.repeat(64) };
  const claims = { v: 2, purpose: TOKEN_PURPOSE, controller_key_id: bindings.controllerKeyId,
    approval_id: approval.approvalId, evidence_sha256: approval.evidenceSha256,
    controller_arm_key_id: bindings.controllerArmKeyId, controller_arm_key_fingerprint: bindings.controllerArmKeyFingerprint,
    pbx_attester_key_id: bindings.pbxAttesterKeyId, pbx_attester_key_fingerprint: bindings.pbxAttesterKeyFingerprint,
    evidence_method: PBX_EVIDENCE_METHOD, job_id: plan.operationId, operation: 'owner-session-message',
    request_sha256: hash(plan.message), plan_sha256: hash(plan), target: `owner-${plan.provider}:${plan.sessionId}`,
    provider: plan.provider, profile: `owner-${plan.provider}-session`, iat: now, exp: now + 30,
    nonce: crypto.randomBytes(32).toString('base64url') };
  const encode = (value) => Buffer.from(canonicalJson(value)).toString('base64url');
  const signed = `${encode({ alg: 'EdDSA', kid: bindings.controllerKeyId, typ: 'TELEAGENT_EXECUTION_CAPABILITY' })}.${encode(claims)}`;
  return { id: prepared.id, request: prepared.request, approval,
    capability: `telecap2.${signed}.${crypto.sign(null, Buffer.from(signed), key.privateKey).toString('base64url')}` };
}

test('broker native delivery consumes exact authority once and GET-style recovery cannot resend', async (t) => {
  const { broker, state } = await fixture(t);
  const prepared = await broker.prepare({ id: 'os_fixture', operationId: 'job_signed', message: 'Review fixture' });
  const input = signedInput(broker, prepared);
  const result = await broker.deliver(input);
  assert.equal(result.state, 'accepted'); assert.equal(result.completed, false);
  assert.deepEqual(broker.result({ operationId: prepared.request.operationId, planHash: prepared.planHash }), result);
  assert.deepEqual(await broker.deliver(input), result);
  assert.equal(state.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.throws(() => broker.deliver({ ...input, publicKeys: {} }));
});

test('catalog revocation during provider preflight refuses before durable admission', async (t) => {
  const { broker, catalog, store, state } = await fixture(t);
  const prepared = await broker.prepare({ id: 'os_fixture', operationId: 'job_revoke', message: 'Do not send' });
  const input = signedInput(broker, prepared);
  const original = catalog.assertEntry.bind(catalog);
  let checks = 0;
  catalog.assertEntry = (...args) => {
    original(...args);
    if (++checks > 1) throw Object.assign(new Error('revoked'), { code: 'OWNER_CATALOG_CHANGED' });
  };
  await assert.rejects(broker.deliver(input), { code: 'OWNER_CATALOG_CHANGED' });
  assert.equal(store.get(prepared.request.operationId, prepared.planHash), null);
  assert.equal(state.calls.some((call) => call.method === 'turn/start'), false);
});

test('panic during preflight persists and prevents a subsequent signed submission', async (t) => {
  const { broker, state } = await fixture(t);
  const prepared = await broker.prepare({ id: 'os_fixture', operationId: 'job_panic', message: 'Do not send' });
  const input = signedInput(broker, prepared);
  let resume; state.pause = new Promise((resolve) => { resume = resolve; });
  const delivery = broker.deliver(input);
  broker.panic(); resume(); state.pause = null;
  await assert.rejects(delivery, { code: 'OWNER_SESSION_PANIC_LOCKED' });
  assert.equal(state.calls.some((call) => call.method === 'turn/start'), false);
});

test('an accidentally TCP-bound API refuses requests', async (t) => {
  const { broker } = await fixture(t);
  const runtime = createOwnerSessionServer(broker);
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => runtime.close());
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: runtime.server.address().port,
      path: '/v1/sessions', agent: false }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 400);
});

test('signed delivery requires a synchronous admission guard at the effect boundary', async (t) => {
  const { broker, state } = await fixture(t);
  const prepared = await broker.prepare({ id: 'os_fixture', operationId: 'job_guard', message: 'Do not send' });
  const input = signedInput(broker, prepared);
  broker.assertAdmission = null;
  await assert.rejects(broker.deliver(input), { code: 'OWNER_BROKER_ADMISSION_UNAVAILABLE' });
  broker.assertAdmission = () => { throw Object.assign(new Error('pressure'), { code: 'OWNER_HOST_RESOURCE_PRESSURE' }); };
  await assert.rejects(broker.deliver(input), { code: 'OWNER_HOST_RESOURCE_PRESSURE' });
  broker.assertAdmission = async () => {};
  await assert.rejects(broker.deliver(input), { code: 'OWNER_SESSION_ASYNC_ADMISSION_GUARD' });
  assert.equal(state.calls.some((call) => call.method === 'turn/start'), false);
});

test('broker readiness checks current enrollment and durable lock without native RPC', async (t) => {
  const { broker, store, state } = await fixture(t);
  assert.throws(() => broker.health(), { code: 'OWNER_BROKER_UNAVAILABLE' });
  broker.authority = { epoch: 'a'.repeat(64) }; broker.assertBoundary = () => {};
  assert.equal(broker.health().ready, true); assert.equal(state.calls.length, 0);
  store.lock(); assert.throws(() => broker.health(), { code: 'OWNER_BROKER_UNAVAILABLE' });
});
