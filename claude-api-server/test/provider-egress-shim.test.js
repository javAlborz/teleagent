'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  LOCAL_PROVIDER_SENTINEL,
  createProviderEgressShim,
  normalizeConfig,
  requestSentinel,
} = require('../provider-egress-shim');

const CAPABILITY = 'ef'.repeat(32);
const LAUNCH_ID = 'launch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function request(server, { route, headers, body }) {
  const address = server.address();
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: address.address,
      port: address.port,
      method: 'POST',
      path: route,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('shim identity binds provider and launch and extracts only the bounded client capability', () => {
  const config = normalizeConfig([
    '--provider', 'claude', '--launch-id', LAUNCH_ID,
  ], {
    uid: 1001,
    username: 'teleagent-claude-shim',
    environment: { TELEAGENT_PROVIDER_SHIM_CAPABILITY: CAPABILITY },
  });
  assert.equal(config.launchId, LAUNCH_ID);
  assert.equal(config.capability, CAPABILITY);
  assert.equal(
    requestSentinel('claude', { 'x-api-key': LOCAL_PROVIDER_SENTINEL }),
    LOCAL_PROVIDER_SENTINEL
  );
  assert.equal(
    requestSentinel('codex', { authorization: `Bearer ${LOCAL_PROVIDER_SENTINEL}` }),
    LOCAL_PROVIDER_SENTINEL
  );
  assert.throws(() => requestSentinel('codex', {
    authorization: `Bearer ${CAPABILITY}`,
  }), /unavailable/);
  assert.throws(() => normalizeConfig([
    '--provider', 'claude', '--launch-id', 'launch_bad',
  ], {
    uid: 1001,
    username: 'teleagent-claude-shim',
    environment: { TELEAGENT_PROVIDER_SHIM_CAPABILITY: CAPABILITY },
  }), /identity mismatch/);
  assert.throws(() => normalizeConfig([
    '--provider', 'claude', '--launch-id', LAUNCH_ID,
  ], {
    uid: 1001,
    username: 'teleagent-claude-shim',
    environment: {},
  }), /capability is unavailable/);
});

test('shim forwards a launch-bound capability over its provider Unix socket and strips real auth', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-shim-'));
  const socketPath = path.join(directory, 'egress.sock');
  let observed;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.once('end', () => {
      observed = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => upstream.listen(socketPath, resolve));
  const shim = createProviderEgressShim({
    config: {
      provider: 'claude', launchId: LAUNCH_ID,
      capability: CAPABILITY,
      spec: { socket: socketPath, port: 0 },
    },
  });
  await new Promise((resolve) => shim.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await shim.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const response = await request(shim.server, {
    route: '/v1/messages',
    headers: {
      'x-api-key': LOCAL_PROVIDER_SENTINEL,
      authorization: 'Bearer must-not-forward',
      'anthropic-version': '2023-06-01',
    },
    body: { model: 'claude-sonnet-5', max_tokens: 10 },
  });
  assert.equal(response.status, 200);
  assert.equal(observed.url, '/v1/messages');
  assert.equal(observed.headers['x-teleagent-launch-id'], LAUNCH_ID);
  assert.equal(observed.headers['x-teleagent-launch-capability'], CAPABILITY);
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.headers['x-api-key'], undefined);
  assert.doesNotMatch(response.body, new RegExp(CAPABILITY));

  const denied = await request(shim.server, {
    route: '/v1/messages',
    headers: { 'x-api-key': CAPABILITY },
    body: { model: 'claude-sonnet-5' },
  });
  assert.equal(denied.status, 401);
});
