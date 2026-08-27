'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');
const {
  assertAudioForkDebugSafe,
  AudioForkServer,
  normalizeAudioForkServerOptions,
  redactAudioForkSecrets,
} = require('../lib/audio-fork');

async function startServer(t, options = {}) {
  const server = new AudioForkServer({ port: 0, host: '127.0.0.1', ...options });
  const listening = once(server, 'listening');
  server.start();
  const [{ port }] = await listening;
  const clients = new Set();
  t.after(() => {
    for (const client of clients) {
      try { client.close(); } catch {}
    }
    server.stop();
  });
  return {
    server,
    port,
    track(client) {
      clients.add(client);
      client.once('close', () => clients.delete(client));
      return client;
    },
  };
}

function rejectedConnection(track, url) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = track(new WebSocket(url));
    } catch (error) {
      reject(error);
      return;
    }
    client.once('error', reject);
    client.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

test('AudioFork server defaults to loopback and non-loopback networking is explicit and peer-bound', () => {
  const defaults = normalizeAudioForkServerOptions();
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.connectHost, '127.0.0.1');
  assert.deepEqual(defaults.allowedPeers, ['127.0.0.1', '::1']);

  assert.throws(
    () => new AudioForkServer({ host: '0.0.0.0' }),
    /WS_NON_LOOPBACK_ENABLED=true/
  );
  assert.throws(
    () => new AudioForkServer({
      host: '0.0.0.0', allowNonLoopback: true,
    }),
    /WS_ALLOWED_PEERS/
  );
  assert.throws(
    () => new AudioForkServer({
      host: '0.0.0.0', connectHost: '192.0.2.10', allowNonLoopback: true,
      allowedPeers: ['0.0.0.0'],
    }),
    /exact IP/
  );
  assert.doesNotThrow(() => new AudioForkServer({
    host: '0.0.0.0', connectHost: '192.0.2.10', allowNonLoopback: true,
    allowedPeers: ['192.0.2.11'],
  }));
});

test('startup refuses every enabled drachtio dependency debug namespace', () => {
  assert.throws(() => assertAudioForkDebugSafe('*'), /any drachtio:\*/);
  assert.throws(() => assertAudioForkDebugSafe('voice-app:*,drachtio:*'), /any drachtio:\*/);
  assert.throws(() => assertAudioForkDebugSafe('drachtio:fsmrf'), /any drachtio:\*/);
  assert.throws(() => assertAudioForkDebugSafe('drachtio:agent'), /any drachtio:\*/);
  assert.throws(() => assertAudioForkDebugSafe('*,-drachtio:fsmrf'), /any drachtio:\*/);
  assert.throws(() => assertAudioForkDebugSafe('*agent,-drachtio:fsmrf'), /any drachtio:\*/);
  assert.equal(assertAudioForkDebugSafe('voice-app:*'), true);
  assert.equal(assertAudioForkDebugSafe('*,-drachtio:*'), true);
  assert.equal(assertAudioForkDebugSafe('drachtio:*,-drachtio:*'), true);

  const previousDebug = process.env.DEBUG;
  process.env.DEBUG = '*';
  try {
    assert.throws(() => new AudioForkServer(), /any drachtio:\*/);
  } finally {
    if (previousDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previousDebug;
  }
});

test('loading and constructing AudioForkServer does not install a process-wide rejection swallow', () => {
  const modulePath = path.join(__dirname, '..', 'lib', 'audio-fork.js');
  const result = spawnSync(process.execPath, ['-e', [
    `const before = process.listenerCount('unhandledRejection');`,
    `const { AudioForkServer } = require(${JSON.stringify(modulePath)});`,
    'new AudioForkServer();',
    `const after = process.listenerCount('unhandledRejection');`,
    'process.stdout.write(JSON.stringify({ before, after }));',
  ].join('')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { before: 0, after: 0 });
});

test('expectation timeout, cancel, and stop stay locally observed while preserving late rejection truth', () => {
  const modulePath = path.join(__dirname, '..', 'lib', 'audio-fork.js');
  const source = [
    `const { once } = require('node:events');`,
    `const { AudioForkServer } = require(${JSON.stringify(modulePath)});`,
    '(async () => {',
    `const server = new AudioForkServer({ port: 0, host: '127.0.0.1' });`,
    `const listening = once(server, 'listening'); server.start(); await listening;`,
    `const canceled = server.expectSession('late-cancel', { timeoutMs: 1000 });`,
    `server.cancelExpectation('late-cancel');`,
    `await new Promise((resolve) => setTimeout(resolve, 20));`,
    `let cancelCode; try { await canceled.session; } catch (error) { cancelCode = error.code; }`,
    `const timedOut = server.expectSession('late-timeout', { timeoutMs: 10 });`,
    `await new Promise((resolve) => setTimeout(resolve, 30));`,
    `let timeoutCode; try { await timedOut.session; } catch (error) { timeoutCode = error.code; }`,
    `const stopped = server.expectSession('late-stop', { timeoutMs: 1000 });`,
    `server.stop(); await new Promise((resolve) => setTimeout(resolve, 20));`,
    `let stopCode; try { await stopped.session; } catch (error) { stopCode = error.code; }`,
    `process.stdout.write(JSON.stringify({ cancelCode, timeoutCode, stopCode }));`,
    '})().catch((error) => { console.error(error); process.exit(1); });',
  ].join('');
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', source], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cancelCode: 'AUDIO_FORK_EXPECTATION_CANCELED',
    timeoutCode: 'AUDIO_FORK_EXPECTATION_TIMEOUT',
    stopCode: 'AUDIO_FORK_SERVER_STOPPED',
  });
});

test('pathless, malformed, unsolicited, wrong-peer, and wrong-token sockets cannot claim a pending call', async (t) => {
  const { server, port, track } = await startServer(t);
  const sessions = [];
  server.on('session', (session) => sessions.push(session));
  const expectation = server.expectSession('call-auth-exact', { timeoutMs: 2000 });
  const expectedUrl = new URL(expectation.connectionUrl);
  const token = expectedUrl.pathname.split('/').at(-1);
  const origin = `ws://127.0.0.1:${port}`;

  assert.equal(token.length, 43);
  assert.deepEqual(Object.keys(expectation), ['session']);
  assert.doesNotMatch(
    JSON.stringify([...server._pendingByCall.values()].map((pending) => ({
      callUuid: pending.callUuid,
      tokenHash: pending.tokenHash.toString('hex'),
      expiresAt: pending.expiresAt,
    }))),
    new RegExp(token)
  );
  assert.match(redactAudioForkSecrets(expectation.connectionUrl), /\[redacted-credential\]$/);
  assert.doesNotMatch(redactAudioForkSecrets(expectation.connectionUrl), new RegExp(token));

  assert.equal((await rejectedConnection(track, `${origin}/`)).code, 1008);
  assert.equal((await rejectedConnection(track, `${origin}/%`)).code, 1008);
  assert.equal((await rejectedConnection(
    track,
    `${origin}/v1/audio/unsolicited-call/${'B'.repeat(43)}`
  )).code, 1008);
  const wrongToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await rejectedConnection(
    track,
    `${origin}/v1/audio/call-auth-exact/${wrongToken}`
  )).code, 1008);

  assert.equal(server._consumeAuthorizedExpectation({
    url: expectedUrl.pathname,
    socket: { remoteAddress: '192.0.2.25' },
  }), null);
  assert.equal(server._pendingByCall.size, 1);
  assert.equal(sessions.length, 0);

  const client = track(new WebSocket(expectation.connectionUrl));
  await once(client, 'open');
  const session = await expectation.session;
  assert.equal(session.callUuid, 'call-auth-exact');
  assert.equal(sessions.length, 1);
  assert.equal(server._pendingByCall.size, 0);

  const replay = await rejectedConnection(track, expectation.connectionUrl);
  assert.equal(replay.code, 1008);
  assert.equal(server.getSession('call-auth-exact'), session);
});

test('one raced attach wins without replacing the authenticated session', async (t) => {
  const { server, track } = await startServer(t);
  const expectation = server.expectSession('call-race', { timeoutMs: 2000 });
  let sessionCount = 0;
  server.on('session', () => { sessionCount += 1; });

  const clients = [
    track(new WebSocket(expectation.connectionUrl)),
    track(new WebSocket(expectation.connectionUrl)),
  ];
  const closeResults = clients.map((client) => new Promise((resolve) => {
    client.once('close', (code) => resolve(code));
  }));
  const session = await expectation.session;
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(sessionCount, 1);
  assert.equal(server.getSession('call-race'), session);
  assert.equal(clients.filter((client) => client.readyState === WebSocket.OPEN).length, 1);
  assert.equal(await Promise.race(closeResults), 1008);
});

test('only the authenticated call socket can receive and acknowledge an approval marker', async (t) => {
  const { server, track } = await startServer(t);
  const expectation = server.expectSession('call-marker-auth', {
    timeoutMs: 2000,
    sampleRate: 24000,
    bidirectionalStreaming: true,
  });

  const attacker = await rejectedConnection(track, new URL('/', expectation.connectionUrl));
  assert.equal(attacker.code, 1008);
  assert.equal(server.getSession('call-marker-auth'), undefined);

  const client = track(new WebSocket(expectation.connectionUrl));
  client.on('message', (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString('utf8'));
    if (message.type === 'mark') {
      client.send(JSON.stringify({
        type: 'mark',
        data: { event: 'playout', name: message.data.name },
      }));
    }
  });
  await once(client, 'open');
  const session = await expectation.session;
  session.sendAudio(Buffer.alloc(2400, 1), {
    sampleRate: 24000,
    itemId: 'approval-item-authenticated',
  });
  session.markPlaybackComplete('approval-item-authenticated');
  const acknowledged = once(session, 'playout_marker');
  assert.equal(session.sendPlaybackMarker('approval:authenticated-only', {
    itemId: 'approval-item-authenticated',
  }), true);
  const [marker] = await acknowledged;
  assert.equal(marker.name, 'approval:authenticated-only');
  assert.equal(marker.itemId, 'approval-item-authenticated');
});

test('oversized AudioFork frames are closed before they reach call audio handling', async (t) => {
  const { server, track } = await startServer(t);
  const expectation = server.expectSession('call-oversized-frame', { timeoutMs: 2000 });
  const client = track(new WebSocket(expectation.connectionUrl));
  await once(client, 'open');
  const session = await expectation.session;
  let audioEvents = 0;
  session.on('audio', () => { audioEvents += 1; });
  const closed = once(client, 'close');
  client.send(Buffer.alloc((256 * 1024) + 1, 1));
  const [code] = await closed;
  assert.equal(code, 1009);
  assert.equal(audioEvents, 0);
  assert.equal(server.getSession('call-oversized-frame'), undefined);
});

test('expired and canceled credentials remain unusable and duplicate expectations fail closed', async (t) => {
  const { server, track } = await startServer(t);
  const expired = server.expectSession('call-expired', { timeoutMs: 15 });
  await assert.rejects(expired.session, { code: 'AUDIO_FORK_EXPECTATION_TIMEOUT' });
  assert.equal((await rejectedConnection(track, expired.connectionUrl)).code, 1008);

  const canceled = server.expectSession('call-canceled', { timeoutMs: 2000 });
  assert.throws(
    () => server.expectSession('call-canceled', { timeoutMs: 2000 }),
    { code: 'AUDIO_FORK_EXPECTATION_EXISTS' }
  );
  assert.equal(server.cancelExpectation('call-canceled'), true);
  await assert.rejects(canceled.session, { code: 'AUDIO_FORK_EXPECTATION_CANCELED' });
  assert.equal((await rejectedConnection(track, canceled.connectionUrl)).code, 1008);
});
