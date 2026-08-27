'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  createHttpServer,
  isLoopbackAddress,
} = require('../lib/http-server');

function request(port, requestPath, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: body ? { 'content-type': 'audio/wav', 'content-length': body.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP media surface is local-only and has no upload endpoint', async (t) => {
  const audioDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teleagent-http-media-'));
  await fs.promises.writeFile(path.join(audioDir, 'private.wav'), Buffer.from('private-audio'));
  const runtime = createHttpServer(audioDir, 0, '127.0.0.1');
  runtime.finalize();
  if (!runtime.server.listening) {
    await new Promise((resolve) => runtime.server.once('listening', resolve));
  }
  t.after(async () => {
    await new Promise((resolve) => runtime.server.close(resolve));
    await fs.promises.rm(audioDir, { recursive: true, force: true });
  });
  const port = runtime.server.address().port;

  const health = await request(port, '/health');
  assert.equal(health.status, 200);
  const healthPayload = JSON.parse(health.body.toString('utf8'));
  assert.deepEqual(Object.keys(healthPayload).sort(), ['status', 'timestamp']);
  assert.doesNotMatch(health.body.toString('utf8'), /teleagent-http-media|audioDir|host|port/);

  const media = await request(port, '/audio-files/private.wav');
  assert.equal(media.status, 200);
  assert.equal(media.body.toString('utf8'), 'private-audio');

  const upload = await request(port, '/audio', { method: 'POST', body: Buffer.from('x') });
  assert.equal(upload.status, 404);
});

test('loopback media check rejects mapped or remote LAN peers correctly', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.5'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.5'), false);
});

test('generated and static routes never follow a symlink outside their media root', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teleagent-http-nofollow-'));
  const audioDir = path.join(directory, 'audio');
  const staticDir = path.join(directory, 'static');
  const secretPath = path.join(directory, 'approval-private.pem');
  await fs.promises.mkdir(audioDir, { mode: 0o700 });
  await fs.promises.mkdir(staticDir, { mode: 0o700 });
  await fs.promises.writeFile(secretPath, 'signer-must-not-leave-container');
  await fs.promises.symlink(secretPath, path.join(audioDir, 'leak.wav'));
  await fs.promises.symlink(secretPath, path.join(staticDir, 'leak.mp3'));
  const nestedOutside = path.join(directory, 'outside');
  await fs.promises.mkdir(nestedOutside);
  await fs.promises.writeFile(path.join(nestedOutside, 'nested.wav'), 'nested-secret');
  await fs.promises.symlink(nestedOutside, path.join(staticDir, 'linked'));

  const runtime = createHttpServer(audioDir, 0, '127.0.0.1', { staticDir });
  runtime.finalize();
  if (!runtime.server.listening) {
    await new Promise((resolve) => runtime.server.once('listening', resolve));
  }
  t.after(async () => {
    await new Promise((resolve) => runtime.server.close(resolve));
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const port = runtime.server.address().port;

  for (const requestPath of [
    '/audio-files/leak.wav',
    '/static/leak.mp3',
    '/static/linked/nested.wav',
    '/audio-files/%2e%2e%2fapproval-private.pem.wav',
  ]) {
    const response = await request(port, requestPath);
    assert.equal(response.status, 404, requestPath);
    assert.doesNotMatch(response.body.toString('utf8'), /signer-must|nested-secret/u);
  }
});
