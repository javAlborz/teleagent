'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { OwnerCodexClient } = require('../owner-codex-client');
const { OwnerClaudeClient, readClaudeRegistration } = require('../owner-claude-client');
const { endpointIdentity, socketIdentity } = require('../owner-session-endpoint');
const {
  OwnerSessionDeliveryStore, inspectOwnerSession, deliverOwnerSession, requestPlan, hash,
} = require('../owner-session-delivery');
const { canonicalJson, TOKEN_PURPOSE, PBX_EVIDENCE_METHOD } = require('../../lib/telecap2-execution-capability');

const SESSION = '01000000-0000-7000-8000-000000000001';
const NOW = 1800000000000;
const keys = crypto.generateKeyPairSync('ed25519');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function listen(server, socket) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
}

async function codexFixture(t) {
  const root = directory(t);
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  const socketPath = path.join(root, 'rpc.sock');
  await listen(server, socketPath);
  const state = { calls: [], status: 'idle', loaded: true, dropDelivery: false, turnId: 'turn_current' };
  sockets.on('connection', (socket) => socket.on('message', (data) => {
    const call = JSON.parse(data);
    state.calls.push(call);
    if (!Object.hasOwn(call, 'id')) return;
    let result;
    if (call.method === 'initialize') result = { userAgent: 'fixture' };
    else if (call.method === 'thread/loaded/list') result = { data: state.loaded ? [SESSION] : [] };
    else if (call.method === 'thread/read') result = { thread: { id: SESSION, cwd: root,
      status: { type: state.status }, canAcceptDirectInput: true, preview: 'SECRET-NOT-RETURNED' } };
    else if (call.method === 'thread/turns/list') result = { data: state.historyTurns || [{ id: state.turnId,
      status: state.status === 'active' ? 'inProgress' : 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        ...(call.params.itemsView === 'full' ? [{ type: 'commandExecution',
          aggregatedOutput: state.largeToolOutput ? 'x'.repeat(2 * 1024 * 1024) : 'SECRET-TOOL-OUTPUT' }] : []),
        { type: 'agentMessage', text: 'token=fixture-sensitive answer' },
      ] }] };
    else if (['turn/start', 'turn/steer'].includes(call.method)) {
      if (state.dropDelivery) { socket.terminate(); return; }
      result = call.method === 'turn/start' ? { turn: { id: state.turnId } } : { turnId: state.turnId };
    } else { socket.send(JSON.stringify({ id: call.id, error: { code: -32601 } })); return; }
    socket.send(JSON.stringify({ id: call.id, result }));
  }));
  const endpoint = { socketPath, pid: process.pid, uid: process.getuid() };
  const client = await new OwnerCodexClient({ endpoint, timeoutMs: 500 }).connect();
  t.after(async () => {
    client.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  return { root, state, client, endpoint };
}

async function claudeFixture(t) {
  const root = directory(t);
  const registryRoot = path.join(root, 'sessions');
  const socketRoot = path.join(root, 'socks');
  fs.mkdirSync(registryRoot, { mode: 0o700 }); fs.mkdirSync(socketRoot, { mode: 0o700 });
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (bytes) => received.push(bytes.toString()));
  });
  const socketPath = path.join(socketRoot, `${process.pid}.sock`);
  await listen(server, socketPath);
  const identity = endpointIdentity({ socketPath, pid: process.pid, uid: process.getuid() });
  const record = { pid: process.pid, sessionId: SESSION, procStart: identity.process.start,
    messagingSocketPath: socketPath, peerProtocol: 1, kind: 'interactive', cwd: root, status: 'idle' };
  const filename = path.join(registryRoot, `${process.pid}.json`);
  fs.writeFileSync(filename, JSON.stringify(record), { mode: 0o600 });
  const registration = { registryRoot, socketRoot, pid: process.pid, uid: process.getuid() };
  const client = await new OwnerClaudeClient({ registration, timeoutMs: 500 }).connect();
  t.after(async () => {
    client.close(); for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { root, client, registration, record, filename, received };
}

function authority(plan, overrides = {}) {
  const bindings = { controllerKeyId: 'test-execution', approvalId: 'test-approval',
    evidenceSha256: 'a'.repeat(64), controllerArmKeyId: 'test-arm',
    controllerArmKeyFingerprint: 'b'.repeat(64), pbxAttesterKeyId: 'test-pbx',
    pbxAttesterKeyFingerprint: 'c'.repeat(64) };
  // Synthetic signed execution receipt, not simulated handset acceptance.
  const claims = { v: 2, purpose: TOKEN_PURPOSE, controller_key_id: bindings.controllerKeyId,
    approval_id: bindings.approvalId, evidence_sha256: bindings.evidenceSha256,
    controller_arm_key_id: bindings.controllerArmKeyId,
    controller_arm_key_fingerprint: bindings.controllerArmKeyFingerprint,
    pbx_attester_key_id: bindings.pbxAttesterKeyId, pbx_attester_key_fingerprint: bindings.pbxAttesterKeyFingerprint,
    evidence_method: PBX_EVIDENCE_METHOD, job_id: plan.operationId, operation: 'owner-session-message',
    request_sha256: hash(plan.message), plan_sha256: hash(plan),
    target: `owner-${plan.provider}:${plan.sessionId}`, provider: plan.provider,
    profile: `owner-${plan.provider}-session`, iat: NOW / 1000, exp: NOW / 1000 + 30,
    nonce: crypto.randomBytes(32).toString('base64url'), ...overrides };
  const encode = (value) => Buffer.from(canonicalJson(value)).toString('base64url');
  const signed = `${encode({ alg: 'EdDSA', kid: bindings.controllerKeyId, typ: 'TELEAGENT_EXECUTION_CAPABILITY' })}.${encode(claims)}`;
  return { authority: { bindings, publicKeys: { [bindings.controllerKeyId]: keys.publicKey } },
    capability: `telecap2.${signed}.${crypto.sign(null, Buffer.from(signed), keys.privateKey).toString('base64url')}` };
}

async function deliveryFixture(t, options = {}) {
  const fixture = await codexFixture(t);
  const request = { operationId: 'job_fixture', provider: 'codex', sessionId: SESSION,
    sessionFingerprint: (await inspectOwnerSession(fixture.client, 'codex', SESSION)).sessionFingerprint,
    message: 'Please review the test fixture', ...options };
  const store = new OwnerSessionDeliveryStore({ dbPath: path.join(fixture.root, 'delivery.sqlite'), now: () => NOW });
  t.after(() => { if (store.db.open) store.close(); });
  return { ...fixture, request, store, ...authority(requestPlan(request)) };
}

test('native Codex inventory/history redact output and never subscribe, resume, or launch', async (t) => {
  const { client, state } = await codexFixture(t);
  assert.deepEqual(await client.loaded(), [SESSION]);
  const metadata = await client.read(SESSION);
  assert.equal(metadata.status, 'idle'); assert.equal('preview' in metadata, false);
  const history = await client.history(SESSION);
  assert.equal(history.messages.length, 2);
  assert.match(history.messages[1].text, /REDACTED/);
  assert.equal(history.latestTurn.status, 'completed');
  assert.match(history.latestTurn.reply.text, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(history), /fixture-sensitive|SECRET/);
  assert.ok(state.calls.every((call) => ['initialize', 'initialized', 'thread/loaded/list',
    'thread/read', 'thread/turns/list'].includes(call.method)));
});

test('latest native reply belongs only to the newest turn, including unfinished and empty turns', async (t) => {
  const { client, state } = await codexFixture(t);
  const older = { status: 'completed', items: [{ type: 'agentMessage', text: 'Old test complete.' }] };
  for (const status of ['inProgress', 'failed', 'interrupted', 'completed']) {
    state.historyTurns = [{ status, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'New task' }] }] }, older];
    const history = await client.history(SESSION);
    assert.equal(history.latestTurn.status, status);
    assert.equal(history.latestTurn.reply, null);
    assert.ok(history.messages.some((message) => message.text === 'Old test complete.'));
  }
  state.historyTurns = [{ status: 'completed', items: [
    { type: 'agentMessage', text: 'Working.' },
    { type: 'agentMessage', text: 'token=fixture-sensitive New result.' },
  ] }, older];
  const history = await client.history(SESSION);
  assert.match(history.latestTurn.reply.text, /New result/);
  assert.doesNotMatch(JSON.stringify(history.latestTurn), /fixture-sensitive|Old test complete/);
  state.historyTurns = [];
  assert.deepEqual((await client.history(SESSION)).latestTurn, { status: 'unknown', reply: null });
});

test('native summary history succeeds when full tool output exceeds the unchanged transport bound', async (t) => {
  const { client, state } = await codexFixture(t);
  state.largeToolOutput = true;
  const history = await client.history(SESSION);
  assert.equal(history.messages.length, 2);
  assert.equal(client.maxPayload, 1024 * 1024);
  await assert.rejects(client._request('thread/turns/list', {
    threadId: SESSION, limit: 3, sortDirection: 'desc', itemsView: 'full',
  }), { code: 'OWNER_SESSION_TRANSPORT_LOST' });
});

test('one exact capability admits one native delivery and replay returns its receipt', async (t) => {
  const fixture = await deliveryFixture(t);
  const result = await deliverOwnerSession(fixture);
  assert.equal(result.state, 'accepted'); assert.equal(result.completed, false);
  assert.deepEqual(await deliverOwnerSession(fixture), result);
  const calls = fixture.state.calls.filter((call) => call.method === 'turn/start');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].params).sort(), ['input', 'threadId']);
  assert.match(calls[0].params.input[0].text, /\[teleagent-operation:job_fixture\]$/);
  const rows = fixture.store.db.prepare('SELECT * FROM owner_session_deliveries').all();
  assert.doesNotMatch(JSON.stringify(rows), /Please review|telecap2\./);
  await assert.rejects(deliverOwnerSession({ ...fixture, request: { ...fixture.request, message: 'changed' } }),
    { code: 'OWNER_SESSION_IDEMPOTENCY_CONFLICT' });
});

test('missing, forged, expired, and differently bound approval all fail before native delivery', async (t) => {
  const fixture = await deliveryFixture(t);
  for (const capability of ['', `${fixture.capability}x`,
    authority(requestPlan(fixture.request), { exp: NOW / 1000 }).capability,
    authority(requestPlan(fixture.request), { plan_sha256: 'd'.repeat(64) }).capability]) {
    await assert.rejects(deliverOwnerSession({ ...fixture, capability }));
  }
  assert.equal(fixture.state.calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(fixture.store.db.prepare('SELECT count(*) n FROM owner_session_replay').get().n, 0);
});

test('ambiguous socket loss is durable and cannot resend after database reopen', async (t) => {
  const fixture = await deliveryFixture(t);
  fixture.state.dropDelivery = true;
  const first = await deliverOwnerSession(fixture);
  assert.equal(first.state, 'outcome_unknown');
  fixture.store.close();
  const reopened = new OwnerSessionDeliveryStore({ dbPath: path.join(fixture.root, 'delivery.sqlite'), now: () => NOW });
  t.after(() => reopened.close());
  const again = await deliverOwnerSession({ ...fixture, store: reopened });
  assert.equal(again.state, 'outcome_unknown');
  assert.equal(fixture.state.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('panic locks new admissions without claiming the owner agent has stopped', async (t) => {
  const fixture = await deliveryFixture(t);
  assert.deepEqual(fixture.store.lock(), { locked: true, quiesced: false });
  await assert.rejects(deliverOwnerSession(fixture), { code: 'OWNER_SESSION_PANIC_LOCKED' });
  assert.equal(fixture.state.calls.some((call) => call.method === 'turn/start'), false);
});

test('changed or unloaded sessions cannot consume authority', async (t) => {
  const fixture = await deliveryFixture(t);
  await assert.rejects(deliverOwnerSession({ ...fixture,
    request: { ...fixture.request, sessionFingerprint: 'f'.repeat(64) } }), { code: 'OWNER_SESSION_IDENTITY_CHANGED' });
  fixture.state.loaded = false;
  await assert.rejects(deliverOwnerSession(fixture), { code: 'OWNER_SESSION_NOT_LOADED' });
  assert.equal(fixture.store.db.prepare('SELECT count(*) n FROM owner_session_replay').get().n, 0);
});

test('steering binds the active turn and carries no configuration or permission overrides', async (t) => {
  const fixture = await deliveryFixture(t);
  fixture.state.status = 'active';
  await assert.rejects(deliverOwnerSession(fixture), { code: 'OWNER_SESSION_TURN_CHANGED' });
  fixture.request.expectedTurnId = 'turn_current';
  Object.assign(fixture, authority(requestPlan(fixture.request)));
  assert.equal((await deliverOwnerSession(fixture)).state, 'accepted');
  const call = fixture.state.calls.find((item) => item.method === 'turn/steer');
  assert.deepEqual(Object.keys(call.params).sort(), ['expectedTurnId', 'input', 'threadId']);
  assert.equal(call.params.expectedTurnId, 'turn_current');
});

test('an outer transaction cannot roll back authority after an external effect', async (t) => {
  const fixture = await deliveryFixture(t);
  fixture.store.db.exec('BEGIN');
  await assert.rejects(deliverOwnerSession(fixture), { code: 'OWNER_SESSION_STORAGE_TRANSACTION_ACTIVE' });
  fixture.store.db.exec('ROLLBACK');
  assert.equal(fixture.state.calls.some((call) => call.method === 'turn/start'), false);
});

test('Claude uses exact native session ID without auth or bypass impersonation', async (t) => {
  const fixture = await claudeFixture(t);
  const result = await fixture.client.deliver({ threadId: SESSION, message: 'A fixture message' });
  assert.equal(result.state, 'submitted_unconfirmed'); assert.equal(result.completed, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const frames = fixture.received.join('').trim().split('\n').map(JSON.parse);
  assert.equal(frames.length, 1); assert.equal(frames[0].session_id, SESSION);
  assert.equal(frames[0].priority, 'next'); assert.equal(frames[0].type, 'user');
  assert.equal('token' in frames[0], false); assert.equal('from' in frames[0], false);
  assert.equal(frames[0].message.content, 'A fixture message');
});

test('Claude /resume or recycled process registration refuses the old target', async (t) => {
  const fixture = await claudeFixture(t);
  fs.writeFileSync(fixture.filename, JSON.stringify({ ...fixture.record, sessionId: crypto.randomUUID() }));
  await assert.rejects(fixture.client.deliver({ threadId: SESSION, message: 'never sent' }),
    { code: 'OWNER_SESSION_IDENTITY_CHANGED' });
  fs.writeFileSync(fixture.filename, JSON.stringify({ ...fixture.record, procStart: '1' }));
  assert.throws(() => readClaudeRegistration(fixture.registration), { code: 'OWNER_SESSION_REGISTRATION_CHANGED' });
  assert.equal(fixture.received.length, 0);
});

test('Claude inherited-umask registration is allowed only within its private single-link boundary', async (t) => {
  const fixture = await claudeFixture(t);
  fs.chmodSync(fixture.filename, 0o664);
  assert.equal(readClaudeRegistration(fixture.registration).id, SESSION);
  fs.chmodSync(fixture.registration.registryRoot, 0o750);
  assert.throws(() => readClaudeRegistration(fixture.registration), { code: 'OWNER_SESSION_REGISTRATION_UNSAFE' });
  fs.chmodSync(fixture.registration.registryRoot, 0o700);
  fs.linkSync(fixture.filename, path.join(fixture.root, 'external-link'));
  assert.throws(() => readClaudeRegistration(fixture.registration), { code: 'OWNER_SESSION_REGISTRATION_UNSAFE' });
});

test('Claude history reads only bounded message records belonging to the selected session', async (t) => {
  const fixture = await claudeFixture(t);
  const logs = path.join(fixture.root, 'projects', fixture.root.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, `${SESSION}.jsonl`), [
    { type: 'assistant', sessionId: crypto.randomUUID(), message: { content: 'WRONG_SESSION' } },
    { type: 'assistant', sessionId: SESSION, message: { content: [{ type: 'text', text: 'secret=hidden answer' },
      { type: 'tool_use', input: 'TOOL_SECRET' }] } },
  ].map(JSON.stringify).join('\n'), { mode: 0o600 });
  const history = fixture.client.history(SESSION);
  assert.equal(history.messages.length, 1);
  assert.match(history.messages[0].text, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(history), /WRONG_SESSION|TOOL_SECRET|hidden/);
});

test('Claude newest reply never falls back to an earlier turn or claims uncertain completion', async (t) => {
  const f = await claudeFixture(t);
  const logs = path.join(f.root, 'projects', f.root.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, `${SESSION}.jsonl`);
  const record = (type, text, stop_reason = null) => ({ type, sessionId: SESSION,
    message: { content: text, stop_reason } });
  const rows = [record('user', 'Old request'), record('assistant', 'Old reply', 'end_turn'),
    record('user', 'New request')];
  const write = () => fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'), { mode: 0o600 });
  write();
  assert.deepEqual(f.client.history(SESSION).latestTurn, { status: 'unknown', reply: null });
  rows.push({ type: 'user', sessionId: SESSION,
    message: { content: [{ type: 'tool_result', content: 'TOOL_SECRET' }] } });
  rows.push(record('assistant', 'secret=hidden New reply', 'end_turn')); write();
  const latest = f.client.history(SESSION).latestTurn;
  assert.equal(latest.status, 'completed');
  assert.match(latest.reply.text, /REDACTED.*New reply/);
  assert.doesNotMatch(JSON.stringify(latest), /hidden|Old reply|TOOL_SECRET/);
  fs.writeFileSync(f.filename, JSON.stringify({ ...f.record, status: 'busy' }));
  assert.equal(f.client.history(SESSION).latestTurn.status, 'inProgress');
  fs.writeFileSync(f.filename, JSON.stringify(f.record));
  rows.push(record('user', 'Another request'), record('assistant', 'Progress')); write();
  assert.equal(f.client.history(SESSION).latestTurn.status, 'unknown');
  fs.writeFileSync(file, '', { mode: 0o600 });
  assert.deepEqual(f.client.history(SESSION).latestTurn, { status: 'unknown', reply: null });
  assert.equal(f.received.length, 0);
});

test('socket replacement, symlinks, and foreign listener process are refused', async (t) => {
  const fixture = await codexFixture(t);
  const link = path.join(fixture.root, 'link.sock');
  fs.symlinkSync(fixture.endpoint.socketPath, link);
  assert.throws(() => socketIdentity(link, process.getuid()), { code: 'OWNER_SESSION_SOCKET_UNSAFE' });
  assert.throws(() => endpointIdentity({ ...fixture.endpoint, pid: process.ppid }));
  fs.chmodSync(fixture.endpoint.socketPath, 0o666);
  assert.throws(() => fixture.client.assertIdentity(), { code: 'OWNER_SESSION_SOCKET_UNSAFE' });
});

test('concurrent duplicate commits cannot dispatch twice', async (t) => {
  const fixture = await deliveryFixture(t);
  const results = await Promise.all([deliverOwnerSession(fixture), deliverOwnerSession(fixture)]);
  assert.ok(results.some((result) => result.state === 'accepted'));
  assert.equal(fixture.state.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal((await deliverOwnerSession(fixture)).state, 'accepted');
});

test('durable intent without a receipt remains unknown and does not resend', async (t) => {
  const fixture = await deliveryFixture(t);
  const plan = requestPlan(fixture.request);
  fixture.store.db.prepare('INSERT INTO owner_session_deliveries VALUES (?,?,?,NULL,?)')
    .run(plan.operationId, hash(plan), 'dispatching', NOW);
  const result = await deliverOwnerSession(fixture);
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(fixture.state.calls.some((call) => call.method === 'turn/start'), false);
});

test('native transport refuses generic shell, resume, fork, and configuration RPCs', async (t) => {
  const { client, state } = await codexFixture(t);
  for (const method of ['process/spawn', 'thread/shellCommand', 'thread/resume', 'thread/fork', 'config/write']) {
    await assert.rejects(client._request(method, {}), { code: 'OWNER_SESSION_METHOD_DENIED' });
  }
  await client.loaded(); // A response is a barrier for preceding socket frames.
  assert.ok(state.calls.every((call) => ['initialize', 'initialized', 'thread/loaded/list'].includes(call.method)));
});

test('voice and controller cannot directly import native owner delivery', () => {
  const root = path.resolve(__dirname, '../..');
  for (const directoryName of ['voice-app', 'deploy']) {
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['node_modules', 'test', 'audio'].includes(entry.name)) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(filename);
        else if (entry.isFile() && /\.(?:js|service|socket|json)$/.test(entry.name)) {
          assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /owner-(?:codex-client|claude-client|session-delivery)/);
        }
      }
    };
    walk(path.join(root, directoryName));
  }
  for (const filename of ['server.js', 'worker-session-broker-service.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'claude-api-server', filename), 'utf8'),
      /owner-(?:codex-client|claude-client|session-delivery)/);
  }
});
