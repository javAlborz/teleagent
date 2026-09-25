'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const { CONTROLLER_SOCKET, createControllerHttpClient } = require('../lib/controller-http-client');

test('all controller operations fix the Unix destination and disable redirects and proxies', async () => {
  const requests = [];
  const client = createControllerHttpClient({
    get: (...args) => requests.push(args), post: (...args) => requests.push(args),
  });
  const options = { socketPath: '/tmp/attacker.sock', maxRedirects: 5,
    proxy: { host: '127.0.0.1', port: 1 }, headers: { Authorization: 'Bearer fixture' } };
  await client.get('http://127.0.0.1:3333/health', options);
  await client.post('http://127.0.0.1:3333/voice-control/stop', {}, options);
  for (const args of requests) {
    const request = args.at(-1);
    assert.equal(request.socketPath, CONTROLLER_SOCKET);
    assert.equal(request.proxy, false);
    assert.equal(request.maxRedirects, 0);
    assert.deepEqual(request.headers, options.headers);
  }
});

test('real Unix HTTP succeeds, rejects redirects, and missing receiver never contacts TCP', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-controller-http-'));
  const socketPath = path.join(directory, 'controller.sock');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let tcpRequests = 0;
  const tcp = http.createServer((_request, response) => { tcpRequests += 1; response.end('attacker'); });
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => tcp.close(resolve)));
  const origin = `http://127.0.0.1:${tcp.address().port}`;
  let unixRequests = 0;
  const unix = http.createServer((request, response) => {
    unixRequests += 1;
    assert.equal(request.headers.authorization, 'Bearer fixture');
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `${origin}/stolen` });
      response.end();
    } else response.end('controller');
  });
  await new Promise((resolve) => unix.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => unix.close(resolve)));
  const client = createControllerHttpClient(axios, socketPath);
  const options = { headers: { Authorization: 'Bearer fixture' }, timeout: 500 };
  assert.equal((await client.get(`${origin}/health`, options)).data, 'controller');
  await assert.rejects(client.get(`${origin}/redirect`, options), (error) => error.response.status === 302);
  const missing = createControllerHttpClient(axios, path.join(directory, 'missing.sock'));
  await assert.rejects(missing.post(`${origin}/executor/tasks`, { sensitive: 'fixture' }, options),
    (error) => error.code === 'ENOENT');
  assert.equal(unixRequests, 2);
  assert.equal(tcpRequests, 0);
});
