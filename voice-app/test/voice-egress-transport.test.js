'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { egressFixture } = require('./helpers/voice-egress-fixture');
const { SOCKETS } = require('../../lib/voice-egress-runtime');
const transport = require('../lib/voice-egress-transport');
const { OpenAIRealtimeClient } = require('../lib/openai-realtime-client');
let root, fixture, certificates;

function openssl(args) {
  const result = spawnSync('/usr/bin/openssl', args, { cwd: root, encoding: 'utf8', timeout: 5000,
    maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  assert.equal(result.status, 0, result.stderr);
}
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-egress-'));
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=Teleagent Local Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', 'ca.key', '-out', 'ca.pem']);
  certificates = {};
  for (const [name, hostname] of [['good', 'api.openai.com'], ['wrong', 'other.invalid']]) {
    openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-subj', `/CN=${hostname}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    fs.writeFileSync(path.join(root, 'extensions'), `subjectAltName=DNS:${hostname}\nbasicConstraints=CA:FALSE\n`);
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-extfile', 'extensions', '-out', `${name}.pem`]);
    certificates[name] = { key: fs.readFileSync(path.join(root, `${name}.key`)), cert: fs.readFileSync(path.join(root, `${name}.pem`)) };
  }
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=api.openai.com', '-addext', 'subjectAltName=DNS:api.openai.com', '-keyout', 'untrusted.key', '-out', 'untrusted.pem']);
  certificates.untrusted = { key: fs.readFileSync(path.join(root, 'untrusted.key')), cert: fs.readFileSync(path.join(root, 'untrusted.pem')) };
  fixture = egressFixture({ caCertificates: [fs.readFileSync(path.join(root, 'ca.pem'), 'utf8')] });
  transport.configureVoiceEgress(fixture.load());
});
test.after(() => { transport.stopVoiceEgress(); fs.rmSync(root, { recursive: true, force: true }); });

async function server(t, name, options, onRequest) {
  const value = options ? https.createServer(options, onRequest) : http.createServer(onRequest);
  value.on('tlsClientError', () => {});
  const socketPath = path.join(root, `${name}.sock`);
  value.listen(socketPath); await once(value, 'listening');
  t.after(() => { value.closeAllConnections(); return new Promise((resolve) => value.close(resolve)); });
  return { value, socketPath };
}
function mapTls(t, target, onSecure) {
  const original = tls.connect;
  const calls = [];
  t.mock.method(tls, 'connect', (options) => {
    assert.equal(options.path, SOCKETS.realtime, 'default ws TLS/TCP factory must never run');
    assert.equal(options.host, undefined); assert.equal(options.port, undefined);
    assert.equal(options.servername, 'api.openai.com'); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.checkServerIdentity, tls.checkServerIdentity);
    assert.deepEqual(options.ALPNProtocols, ['http/1.1']); assert.equal(options.minVersion, 'TLSv1.2');
    calls.push(options);
    const socket = original({ ...options, path: target });
    if (onSecure) socket.prependOnceListener('secureConnect', onSecure);
    return socket;
  });
  return calls;
}
function client() { return new OpenAIRealtimeClient({ apiKey: 'local-test-bearer-only', instructions: 'Local fixture.' }); }
function mapSpeech(t, target) {
  const original = net.createConnection, connections = [];
  t.mock.method(net, 'createConnection', (options) => {
    assert.deepEqual(Object.keys(options), ['path']);
    assert.ok([SOCKETS.tts, SOCKETS.stt].includes(options.path));
    connections.push(options.path);
    return original({ path: target });
  });
  return connections;
}

test('actual pinned ws factory uses Unix TLS with exact SNI/CA before sending bearer and expected upgrade', async (t) => {
  const endpoint = await server(t, 'realtime', certificates.good);
  let request;
  const websocket = new WebSocketServer({ noServer: true });
  endpoint.value.on('upgrade', (req, socket, head) => {
    request = req;
    websocket.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'session.created', session: { id: 'local-session' } }));
      ws.once('message', () => ws.send(JSON.stringify({ type: 'session.updated', session: { id: 'local-session' } })));
    });
  });
  const calls = mapTls(t, endpoint.socketPath), realtime = client();
  t.after(() => { realtime.close(); for (const ws of websocket.clients) ws.terminate(); });
  await realtime.connect();
  assert.equal(calls.length, 1); assert.equal(request.url, '/v1/realtime?model=gpt-realtime-2.1-mini');
  assert.equal(request.headers.host, 'api.openai.com'); assert.equal(request.headers.authorization, 'Bearer local-test-bearer-only');
  realtime.close();
});

test('wrong certificate identity prevents any HTTP bearer request', async (t) => {
  let requests = 0;
  const endpoint = await server(t, 'wrong', certificates.wrong, () => { requests += 1; });
  const calls = mapTls(t, endpoint.socketPath), realtime = client();
  realtime.on('error', () => {});
  await assert.rejects(realtime.connect(), /certificate|Hostname|altname/iu);
  realtime.close(); assert.equal(calls.length, 1); assert.equal(requests, 0);
});

test('untrusted certificate chain prevents any HTTP bearer request', async (t) => {
  let requests = 0;
  const endpoint = await server(t, 'untrusted', certificates.untrusted, () => { requests += 1; });
  const calls = mapTls(t, endpoint.socketPath), realtime = client(); realtime.on('error', () => {});
  await assert.rejects(realtime.connect(), /certificate|self.signed/iu);
  realtime.close(); assert.equal(calls.length, 1); assert.equal(requests, 0);
});

test('redirected WebSocket upgrades never connect to the redirected TCP destination', async (t) => {
  const endpoint = await server(t, 'redirect', certificates.good, (_req, res) => {
    res.writeHead(302, { Location: 'wss://127.0.0.1:9/steal' }); res.end();
  });
  const calls = mapTls(t, endpoint.socketPath), realtime = client(); realtime.on('error', () => {});
  await assert.rejects(realtime.connect(), /302/u); realtime.close(); assert.equal(calls.length, 1);
});

test('missing Unix receiver or changed authority has no TCP fallback', async (t) => {
  const calls = mapTls(t, path.join(root, 'absent.sock')), realtime = client(); realtime.on('error', () => {});
  await assert.rejects(realtime.connect(), /ENOENT/u); realtime.close(); assert.equal(calls.length, 1);
  const socket = fixture.sockets.get(SOCKETS.realtime); socket.ino += 1;
  try { await assert.rejects(client().connect(), { code: 'VOICE_EGRESS_ADMISSION_REFUSED' }); }
  finally { socket.ino -= 1; }
  assert.equal(calls.length, 1);
});

test('admission revoked during TLS closes before the bearer reaches HTTP', async (t) => {
  let requests = 0;
  const endpoint = await server(t, 'revoked', certificates.good, () => { requests += 1; });
  endpoint.value.on('upgrade', () => { requests += 1; });
  const peer = fixture.sockets.get(SOCKETS.realtime);
  mapTls(t, endpoint.socketPath, () => { peer.ino += 1; });
  const realtime = client(); realtime.on('error', () => {});
  try { await assert.rejects(realtime.connect(), /generation changed/u); }
  finally { peer.ino -= 1; realtime.close(); }
  assert.equal(requests, 0);
});

test('native Axios TTS/STT use exact separate Unix receivers, bounded methods and no proxy', async (t) => {
  const requests = [];
  let oversized = false;
  const endpoint = await server(t, 'speech', null, (req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end('local-test-audio'); }
      else if (req.url === '/v1/audio/transcriptions') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(oversized ? 'x'.repeat(65537) : 'local test transcript'); }
      else { res.writeHead(302, { Location: 'http://127.0.0.1:9/steal' }); res.end(); }
    });
  });
  const connections = mapSpeech(t, endpoint.socketPath);
  const previous = { ...process.env };
  process.env.LEGACY_SPEECH_SERVICES_ENABLED = 'true'; process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'; process.env.ALL_PROXY = 'http://127.0.0.1:9';
  t.after(() => { process.env = previous; });
  const tts = require('../lib/tts-service'), whisper = require('../lib/whisper-client');
  const audio = path.join(root, 'audio'); fs.mkdirSync(audio); tts.setAudioDir(audio);
  await tts.generateSpeech('local fixture', 'af_bella');
  assert.equal(await whisper.transcribe(Buffer.from([0, 0, 1, 0])), 'local test transcript');
  assert.deepEqual(connections, [SOCKETS.tts, SOCKETS.stt]);
  assert.deepEqual(requests.map((value) => [value.method, value.path]), [['POST', '/v1/audio/speech'], ['POST', '/v1/audio/transcriptions']]);
  assert.equal(JSON.parse(requests[0].body).model, 'kokoro'); assert.match(requests[1].body, /whisper-1/u);
  assert.ok(requests.every((value) => value.headers.authorization === undefined));
  await assert.rejects(tts.getAvailableVoices(), /voice list request failed/u);
  assert.equal(connections.length, 3); assert.equal(requests[2].path, '/v1/audio/voices');
  oversized = true;
  await assert.rejects(whisper.transcribe(Buffer.from([0, 0])), /maxContentLength/u);
  assert.equal(connections.length, 4);
  const peer = fixture.sockets.get(SOCKETS.stt); peer.ino += 1;
  try { await assert.rejects(whisper.transcribe(Buffer.from([0, 0])), { code: 'VOICE_EGRESS_ADMISSION_REFUSED' }); }
  finally { peer.ino -= 1; }
  assert.equal(connections.length, 4);
});

for (const revoke of [false, true]) for (const close of [false, true]) {
test(`ninth queued speech request ${revoke ? 'refuses revoked' : 'completes admitted'} dispatch with ${close ? 'closed' : 'reusable'} original socket`, { timeout: 10000 }, async (t) => {
  const responses = [];
  let acceptedEight;
  const eight = new Promise((resolve) => { acceptedEight = resolve; });
  const endpoint = await server(t, `queued-speech-${revoke}-${close}`, null, (req, res) => {
    req.resume(); responses.push(res); if (responses.length === 8) acceptedEight();
    if (responses.length === 9) res.end('queued request completed');
  });
  const connections = mapSpeech(t, endpoint.socketPath);
  const axios = require('axios');
  const cancellation = new AbortController();
  const requests = Array.from({ length: 9 }, () => axios({ method: 'POST', url: 'http://127.0.0.1:18001/v1/audio/transcriptions',
    data: 'local-test-body', timeout: 3000, ...transport.speechRequestOptions('stt', cancellation.signal) }));
  const settled = Promise.allSettled(requests);
  const originalGeneration = fixture.record.generation;
  try {
    await eight;
    assert.equal(connections.length, 8); assert.equal(responses.length, 8);
    if (revoke) { fixture.record.generation = 'd'.repeat(64); fixture.publish(); }
    if (close) responses[0].setHeader('Connection', 'close');
    responses[0].end('slot released');
    if (revoke) await assert.rejects(requests[8], { code: 'VOICE_EGRESS_ADMISSION_REFUSED' });
    else assert.equal((await requests[8]).data, 'queued request completed');
    assert.equal(connections.length, !revoke && close ? 9 : 8);
    assert.equal(responses.length, revoke ? 8 : 9);
    for (const res of responses.slice(1)) res.end('finish');
    await Promise.all(requests.slice(0, 8));
  } finally {
    cancellation.abort(); await settled;
    fixture.record.generation = originalGeneration; fixture.publish();
  }
});
}

test('shutdown closes active Unix TLS and speech requests and fences new provider work', async (t) => {
  const endpoint = await server(t, 'shutdown-tls', certificates.good);
  const websocket = new WebSocketServer({ noServer: true });
  endpoint.value.on('upgrade', (req, socket, head) => websocket.handleUpgrade(req, socket, head, (ws) => {
    ws.once('message', () => ws.send(JSON.stringify({ type: 'session.updated', session: { id: 'local-shutdown' } })));
  }));
  mapTls(t, endpoint.socketPath);
  const realtime = client(); realtime.on('error', () => {});
  await realtime.connect();
  const closed = once(realtime.ws, 'close');
  let sawRequest;
  const started = new Promise((resolve) => { sawRequest = resolve; });
  const pending = await server(t, 'shutdown-speech', null, (req) => { req.resume(); sawRequest(); });
  mapSpeech(t, pending.socketPath);
  const previous = process.env.LEGACY_SPEECH_SERVICES_ENABLED;
  process.env.LEGACY_SPEECH_SERVICES_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.LEGACY_SPEECH_SERVICES_ENABLED;
    else process.env.LEGACY_SPEECH_SERVICES_ENABLED = previous;
    for (const ws of websocket.clients) ws.terminate();
  });
  const inflight = require('../lib/whisper-client').transcribe(Buffer.from([0, 0]));
  const cancelled = assert.rejects(inflight, { code: 'ERR_CANCELED' });
  await started;
  const speech = transport.speechRequestOptions('tts');
  transport.stopVoiceEgress();
  await Promise.all([closed, cancelled]);
  assert.equal(speech.signal.aborted, true);
  assert.throws(() => transport.speechRequestOptions('stt')); assert.throws(() => transport.realtimeWebSocketOptions());
});
