'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createIsolatedControlHttp } = require('../lib/isolated-control-http');
const { isLocalUnixRequest, admitLocalUnixRequest } = require('../lib/local-control-request');

function request(socketPath, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({ socketPath, method, path: pathname, headers, timeout: 2000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    call.on('error', reject);
    call.end();
  });
}

test('host Unix control listener exposes only exact isolated control routes', async () => {
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
    for (const [method, route] of [['GET', '/api/voice-control/status'],
      ['POST', '/api/voice-control/unlock']]) {
      assert.equal((await request(filename, method, route)).status, 200);
    }
    for (const [method, route] of [['GET', '/api/voice-control/unlock'],
      ['POST', '/api/voice-control/status'], ['POST', '/api/voice-control/unlock?extra=1']]) {
      assert.equal((await request(filename, method, route)).status, 404);
    }
    assert.equal(handled, 4);
    assert.throws(() => admitLocalUnixRequest({ socket: { remoteAddress: '127.0.0.1' } }));
  } finally {
    if (listener) await listener.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(filename), false);
});


test('isolated Unix status and unlock preserve scoped bearer authentication', async () => {
  const express = require('express');
  const { createVoiceControlRouter } = require('../lib/voice-control-routes');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-auth-control-test-'));
  const directory = path.join(root, 'control');
  fs.mkdirSync(directory, { mode: 0o700 });
  const filename = path.join(directory, 'control.sock');
  const uid = 989, gid = 989;
  const io = {
    lstatSync(target) {
      const info = fs.lstatSync(target);
      return { mode: info.mode, dev: info.dev, ino: info.ino, nlink: info.nlink,
        uid, gid, isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink(), isSocket: () => info.isSocket() };
    },
    realpathSync: fs.realpathSync, existsSync: fs.existsSync,
    chmodSync: fs.chmodSync, unlinkSync: fs.unlinkSync,
  };
  const token = 'isolated-voice-operator-test-token-0123456789abcdef';
  let unlocks = 0, locked = true;
  const app = express();
  app.use('/api', createVoiceControlRouter({
    voiceControlAuth: { apiToken: token },
    jobBroker: {
      getExecutionLock() { return { locked }; },
      getUnlockReadiness() { return { ready: true }; },
      unlockExecution() { locked = false; return { locked }; },
    },
    agentBridge: {
      async unlockVoiceExecution() {
        unlocks += 1; return { success: true, voiceExecution: { locked: false } };
      },
    },
  }));
  let listener;
  try {
    listener = createIsolatedControlHttp(app, { filename, io, uid, gid });
    await listener.ready;
    for (const headers of [{}, { Authorization: 'Bearer wrong-scope-token' }]) {
      assert.equal((await request(filename, 'GET', '/api/voice-control/status', headers)).status, 401);
      assert.equal((await request(filename, 'POST', '/api/voice-control/unlock', headers)).status, 401);
    }
    assert.equal(unlocks, 0);
    const headers = { Authorization: `Bearer ${token}` };
    let response = await request(filename, 'GET', '/api/voice-control/status', headers);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).voiceExecution.locked, true);
    response = await request(filename, 'POST', '/api/voice-control/unlock', headers);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).local.locked, false);
    assert.equal(unlocks, 1);
  } finally {
    if (listener) await listener.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
