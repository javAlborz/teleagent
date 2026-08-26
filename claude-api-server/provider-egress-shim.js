#!/usr/local/libexec/teleagent-node
'use strict';

const http = require('node:http');
const os = require('node:os');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const LAUNCH_ID = /^launch_[a-f0-9]{32}$/;
const LAUNCH_CAPABILITY = /^[a-f0-9]{64}$/;
const LOCAL_PROVIDER_SENTINEL = 'teleagent-local-provider-key';
const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    user: 'teleagent-claude-shim',
    port: 18443,
    socket: '/run/teleagent-provider-egress/claude.sock',
  }),
  codex: Object.freeze({
    user: 'teleagent-codex-shim',
    port: 18444,
    socket: '/run/teleagent-provider-egress/codex.sock',
  }),
});

function normalizeConfig(argv = process.argv.slice(2), {
  uid = process.getuid(),
  username = os.userInfo().username,
  environment = process.env,
} = {}) {
  if (argv.length !== 4 || argv[0] !== '--provider' || argv[2] !== '--launch-id') {
    throw new Error('Provider egress shim requires one exact provider and launch.');
  }
  const provider = String(argv[1] || '');
  const launchId = String(argv[3] || '');
  const spec = PROVIDERS[provider];
  if (!spec || !LAUNCH_ID.test(launchId) || uid === 0 || username !== spec.user) {
    throw new Error('Provider egress shim identity mismatch.');
  }
  const capability = String(environment.TELEAGENT_PROVIDER_SHIM_CAPABILITY || '');
  if (!LAUNCH_CAPABILITY.test(capability)) {
    throw new Error('Provider egress shim launch capability is unavailable.');
  }
  return Object.freeze({ provider, spec, launchId, uid, capability });
}

function requestSentinel(provider, headers) {
  const value = provider === 'claude'
    ? String(headers['x-api-key'] || '')
    : String(headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (value !== LOCAL_PROVIDER_SENTINEL) {
    throw new Error('Provider local credential is unavailable.');
  }
  return value;
}

function createProviderEgressShim({ config } = {}) {
  if (!config?.spec) throw new Error('Provider egress shim config is required.');
  let closing = false;
  const upstreams = new Set();
  const server = http.createServer((req, res) => {
    if (closing) {
      res.writeHead(503, { connection: 'close', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    try { requestSentinel(config.provider, req.headers); }
    catch {
      res.writeHead(401, { connection: 'close', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    let requestBytes = 0;
    req.on('data', (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes > MAX_BYTES) req.destroy();
    });
    const upstream = http.request({
      socketPath: config.spec.socket,
      method: req.method,
      path: req.url,
      headers: {
        'content-type': String(req.headers['content-type'] || 'application/json').slice(0, 100),
        accept: String(req.headers.accept || 'text/event-stream, application/json').slice(0, 200),
        'anthropic-version': String(req.headers['anthropic-version'] || '').slice(0, 40),
        'anthropic-beta': String(req.headers['anthropic-beta'] || '').slice(0, 1000),
        'x-teleagent-launch-id': config.launchId,
        'x-teleagent-launch-capability': config.capability,
      },
      timeout: 30000,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, {
        'content-type': String(upstreamResponse.headers['content-type'] || 'application/json'),
        'cache-control': 'no-store',
      });
      let responseBytes = 0;
      upstreamResponse.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          upstreamResponse.destroy(new Error('egress response exceeded bound'));
          res.destroy();
          return;
        }
        res.write(chunk);
      });
      upstreamResponse.once('end', () => res.end());
    });
    upstreams.add(upstream);
    const cleanup = () => upstreams.delete(upstream);
    upstream.once('close', cleanup);
    upstream.once('timeout', () => upstream.destroy(new Error('egress timeout')));
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close', 'cache-control': 'no-store' });
      res.end();
    });
    req.once('error', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 35_000;
  return Object.freeze({
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: config.spec.port, exclusive: true }, resolve);
      });
    },
    async close() {
      closing = true;
      for (const upstream of upstreams) upstream.destroy();
      await (server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve());
    },
  });
}

if (require.main === module) {
  let shim;
  try {
    const config = normalizeConfig();
    shim = createProviderEgressShim({ config });
    shim.listen().then(() => {
      process.stdout.write('READY\n');
    }, (error) => {
      process.stderr.write(`Provider egress shim failed: ${error.message}\n`);
      process.exit(1);
    });
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => void shim.close().then(() => process.exit(0)));
    }
  } catch (error) {
    process.stderr.write(`Provider egress shim refused: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  LOCAL_PROVIDER_SENTINEL,
  PROVIDERS,
  createProviderEgressShim,
  normalizeConfig,
  requestSentinel,
};
