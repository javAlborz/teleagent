'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createIsolatedControlHttp } = require('../lib/isolated-control-http');
const { isLocalUnixRequest, admitLocalUnixRequest } = require('../lib/local-control-request');

function request(socketPath, method, pathname) {
  return new Promise((resolve, reject) => {
    const call = http.request({ socketPath, method, path: pathname, timeout: 2000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    call.on('error', reject);
    call.end();
  });
}

test('host Unix control listener exposes only isolated health and panic routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-control-test-'));
  const directory = path.join(root, 'control');
  fs.mkdirSync(directory, { mode: 0o700 });
  const filename = path.join(directory, 'control.sock');
  const uid = 989, gid = 989;
  const io = {
    lstatSync(target) {
      const info = fs.lstatSync(target);
      if (target === directory || target === filename) {
        return { mode: info.mode, dev: info.dev, ino: info.ino, nlink: info.nlink,
          uid, gid, isDirectory: () => info.isDirectory(),
          isSymbolicLink: () => info.isSymbolicLink(), isSocket: () => info.isSocket() };
      }
      return info;
    },
    realpathSync: fs.realpathSync, existsSync: fs.existsSync,
    chmodSync: fs.chmodSync, unlinkSync: fs.unlinkSync,
  };
  let handled = 0;
  const app = (req, res) => {
    handled += 1;
    assert.equal(isLocalUnixRequest(req), true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  };
  let listener;
  try {
    listener = createIsolatedControlHttp(app, { filename, io, uid, gid });
    await listener.ready;
    assert.equal(listener.healthy(), true);
    assert.deepEqual(await request(filename, 'GET', '/api/realtime-health'),
      { status: 200, body: '{"status":"ok"}' });
    assert.deepEqual(await request(filename, 'POST', '/api/voice-control/stop'),
      { status: 200, body: '{"status":"ok"}' });
    assert.equal((await request(filename, 'GET', '/api/devices')).status, 404);
    assert.equal(handled, 2);
    assert.throws(() => admitLocalUnixRequest({ socket: { remoteAddress: '127.0.0.1' } }));
  } finally {
    if (listener) await listener.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(filename), false);
});
