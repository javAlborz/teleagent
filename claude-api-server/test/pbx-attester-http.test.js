'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPbxAttesterServer } = require('../pbx-attester-http');

async function fixture(t, tcp = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbx-http-'));
  let calls = 0;
  const server = createPbxAttesterServer({ async handle(route, body) {
    calls++;
    if (body.fail) throw new Error('secret internal diagnostic');
    return { route, accepted: true };
  } });
  await new Promise((resolve) => server.listen(tcp ? { host: '127.0.0.1', port: 0 } : path.join(root, 'api.sock'), resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true });
  });
  const address = tcp ? { host: '127.0.0.1', port: server.address().port } : { socketPath: path.join(root, 'api.sock') };
  return { calls: () => calls, request(route, data = '{}', headers = {}, method = 'POST') {
    return new Promise((resolve, reject) => {
      const req = http.request({ ...address, method, path: route, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
        let body = ''; res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject); req.end(data);
    });
  } };
}

test('only exact private routes with bounded JSON enter the API', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/call')).status, 200);
  for (const route of ['/v1/call/', '/v1/call?x=1', '/v1/ari', '/V1/call']) {
    assert.equal((await f.request(route)).status, 400);
  }
  assert.equal((await f.request('/v1/call', '{}', {}, 'GET')).status, 400);
  assert.equal((await f.request('/v1/call', 'x'.repeat(40001))).status, 400);
  assert.equal((await f.request('/v1/call', '{}', { 'content-type': 'text/plain' })).status, 400);
  assert.equal(f.calls(), 1);
});

test('TCP requests cannot invoke the attester even with correct routes', async (t) => {
  const f = await fixture(t, true);
  assert.equal((await f.request('/v1/attest')).status, 400); assert.equal(f.calls(), 0);
});

test('malformed JSON and internal failures disclose no diagnostics', async (t) => {
  const f = await fixture(t);
  for (const data of ['{', '{"fail":true}']) {
    const result = await f.request('/v1/attest', data);
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { success: false, code: 'PBX_ATTESTER_REQUEST_REFUSED' });
  }
});
