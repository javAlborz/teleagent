'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { Writable } = require('node:stream');
const { runtimeFixture } = require('./helpers/media-runtime-fixture');
const { createMediaRequestHandler, createIsolatedMediaHttp, createMediaStartupFence } = require('../lib/isolated-media-http');

function media(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-private-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['audio', 'static', 'outside']) fs.mkdirSync(path.join(root, name));
  fs.mkdirSync(path.join(root, 'static/music'));
  fs.writeFileSync(path.join(root, 'audio/response.wav'), 'private response');
  fs.writeFileSync(path.join(root, 'static/music/hold.mp3'), 'private music');
  fs.writeFileSync(path.join(root, 'outside/secret.wav'), 'must not escape');
  fs.symlinkSync(path.join(root, 'outside/secret.wav'), path.join(root, 'audio/link.wav'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'static/escape'));
  const f = runtimeFixture(), runtime = f.load();
  const directories = { audioDir: path.join(root, 'audio'), staticDir: path.join(root, 'static') };
  return { f, runtime, directories, handler: createMediaRequestHandler(runtime, directories) };
}
function request(overrides = {}) {
  return { method: 'GET', url: '/audio-files/response.wav', headers: {},
    socket: { remoteAddress: '10.254.0.10', localAddress: '10.254.0.14', localPort: 3000, remotePort: 50000 }, ...overrides };
}
async function exchange(handler, req) {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
  const finished = once(res, 'finish');
  await handler(req, res); await finished;
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() };
}

test('GET and HEAD serve only confined media with private caching and no redirects', async (t) => {
  const { handler } = media(t);
  const audio = await exchange(handler, request());
  assert.equal(audio.status, 200); assert.equal(audio.body, 'private response');
  assert.equal(audio.headers['Cache-Control'], 'no-store'); assert.equal(audio.headers.Location, undefined);
  const head = await exchange(handler, request({ method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['Content-Length'], '16');
  const music = await exchange(handler, request({ url: '/static/music/hold.mp3' }));
  assert.equal(music.status, 200); assert.equal(music.body, 'private music');
  assert.equal(music.headers['Cache-Control'], 'private, max-age=300');
});

test('exact remote/local socket tuple is required; forwarding and Host headers cannot authorize', async (t) => {
  const { handler } = media(t);
  for (const mutation of [
    { remoteAddress: '127.0.0.1' }, { remoteAddress: '10.254.0.14' }, { remoteAddress: '::ffff:10.254.0.10' },
    { localAddress: '127.0.0.1' }, { localAddress: '0.0.0.0' }, { localPort: 3002 }, { remotePort: 49151 }, { remotePort: 65536 },
  ]) {
    const req = request({ headers: { host: '10.254.0.14:3000', 'x-forwarded-for': '10.254.0.10' } });
    Object.assign(req.socket, mutation);
    assert.equal((await exchange(handler, req)).status, 403);
  }
  const headers = { host: 'ignored.example', forwarded: 'for=127.0.0.1', 'x-forwarded-for': 'untrusted' };
  assert.equal((await exchange(handler, request({ headers }))).status, 200);
});

test('control routes, traversal, encoded/absolute URLs, symlinks and unexpected body/methods refuse', async (t) => {
  const { handler } = media(t);
  for (const url of ['/health', '/api/outbound-call', '/voice-control/stop', '/static', '/static/',
    '/audio-files/../outside/secret.wav', '/static/../outside/secret.wav', '/static/music//hold.mp3',
    '/audio-files/link.wav', '/static/escape/secret.wav', '/audio-files/response.wav?token=ignored',
    '/audio-files/response.wav#part', '/static/%2e%2e/secret.wav', '/static/%252e%252e/secret.wav',
    '/static/music%2fhold.mp3', '/static/music\\hold.mp3', 'http://10.254.0.14:3000/audio-files/response.wav',
    '//10.254.0.14/audio-files/response.wav', '/static/config.json']) {
    const response = await exchange(handler, request({ url }));
    assert.equal(response.status, 404, url); assert.equal(response.body, ''); assert.equal(response.headers.Location, undefined);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT']) {
    assert.equal((await exchange(handler, request({ method }))).status, 405);
  }
  for (const headers of [{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }, { upgrade: 'websocket' }, { expect: '100-continue' }]) {
    assert.equal((await exchange(handler, request({ headers }))).status, 405);
  }
});

test('admission is checked per request and again after async file open', async (t) => {
  const { f, handler } = media(t);
  assert.equal((await exchange(handler, request())).status, 200);
  f.onRead((count) => { if (count === 2) f.identity.startTicks = '7701'; });
  const response = await exchange(handler, request());
  assert.equal(response.status, 503); assert.equal(response.body, '');
  assert.equal((await exchange(handler, request())).status, 503);
});

function fakeFactory({ actual, listenError, syncError } = {}) {
  let server;
  const createServer = (options, handler) => {
    server = new EventEmitter(); Object.assign(server, { options, handler, listening: false, closes: 0,
      setTimeout(ms, cb) { this.timeout = ms; this.timeoutCallback = cb; },
      listen(args) {
        this.listenArgs = args;
        if (syncError) throw new Error('test synchronous listen failure');
        queueMicrotask(() => {
          if (listenError) this.emit('error', new Error('EADDRINUSE'));
          else if (!args.signal.aborted) { this.listening = true; this.emit('listening'); }
        });
      },
      address() { return actual || { address: '10.254.0.14', port: 3000, family: 'IPv4' }; },
      closeAllConnections() {}, close(cb) { this.closes += 1; this.listening = false; cb(); },
    });
    return server;
  };
  return { createServer, get server() { return server; } };
}

test('listener fixes bind and bounds; identity changes, wrong binds and errors fail closed', async (t) => {
  const { f, runtime, directories } = media(t);
  const factory = fakeFactory(), listener = createIsolatedMediaHttp(runtime, directories, factory);
  await listener.ready;
  assert.deepEqual({ ...factory.server.listenArgs, signal: undefined }, {
    host: '10.254.0.14', port: 3000, exclusive: true, backlog: 32, signal: undefined });
  assert.equal(factory.server.maxConnections, 32); assert.equal(factory.server.maxRequestsPerSocket, 16);
  assert.equal(factory.server.options.maxHeaderSize, 8192); assert.equal(factory.server.timeout, 15000);
  assert.equal(listener.healthy(), true); await listener.close(); assert.equal(listener.healthy(), false);
  for (const options of [{ actual: { address: '0.0.0.0', port: 3000, family: 'IPv4' } },
    { actual: { address: '10.254.0.14', port: 3002, family: 'IPv4' } },
    { actual: { address: '10.254.0.14', port: 3000, family: 'IPv6' } }, { listenError: true }, { syncError: true }]) {
    const other = createIsolatedMediaHttp(runtime, directories, fakeFactory(options));
    await assert.rejects(other.ready); await other.close(); assert.equal(other.healthy(), false);
  }
  const changed = createIsolatedMediaHttp(runtime, directories, fakeFactory());
  f.identity.startTicks = '7701';
  await assert.rejects(changed.ready); await changed.close(); assert.equal(changed.healthy(), false);
});

test('native pending loopback bind cannot open after close, and a bind error closes safely', async (t) => {
  const { runtime, directories } = media(t);
  let native, listenEvents = 0;
  const pending = createIsolatedMediaHttp(runtime, directories, { createServer(options, handler) {
    native = http.createServer(options, handler);
    const original = native.listen.bind(native);
    native.listen = (args) => original({ ...args, host: '127.0.0.1', port: 0 });
    native.on('listening', () => { listenEvents += 1; }); return native;
  } });
  const rejected = assert.rejects(pending.ready); await pending.close(); await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(native.listening, false); assert.equal(native.address(), null); assert.equal(listenEvents, 0);

  const occupied = http.createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const failed = createIsolatedMediaHttp(runtime, directories, { createServer(options, handler) {
    const server = http.createServer(options, handler), original = server.listen.bind(server);
    server.listen = (args) => original({ ...args, host: '127.0.0.1', port: occupied.address().port }); return server;
  } });
  await assert.rejects(failed.ready); await failed.close(); assert.equal(failed.server.listening, false);
});

test('shutdown during deferred HTTP readiness prevents late listeners and reopened SIP admission', async () => {
  const fence = createMediaStartupFence();
  let release, lateListeners = 0, acceptCalls = 0;
  const ready = new Promise((resolve) => { release = resolve; });
  const started = fence.run(async (assertActive) => {
    assertActive(); await ready; assertActive(); lateListeners += 1;
  }, () => { acceptCalls += 1; });
  fence.stop(); release(); await assert.rejects(started);
  assert.equal(lateListeners, 0); assert.equal(acceptCalls, 0);
  await assert.rejects(fence.run(() => { lateListeners += 1; }, () => { acceptCalls += 1; }));
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(source, /await isolatedMediaHttp\.ready;\s*assertStartupActive\(\);/u);
  assert.match(source, /function shutdown\(signal\) \{\s*mediaStartupFence\.stop\(\);/u);
  assert.match(source, /mediaStartupFence\.run\(initializeServers,/u);
});
