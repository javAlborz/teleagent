import http from 'node:http';

function writeJson(response, statusCode, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(serialized);
}

function writeText(response, statusCode, body = '') {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readRawBody(request, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('Request body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createHttpServer({ config, webhookHandler, callGateway, stateStore, logger }) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        const summary = callGateway.registry.summary();
        const capacityAvailable = stateStore.capacityAvailable === true;
        const healthy = stateStore.healthy
          && capacityAvailable
          && !(summary.states.outcome_unknown > 0);
        writeJson(response, healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'degraded',
          mode: config.mode,
          activeCalls: summary.active,
          trackedCalls: summary.tracked,
          durableState: stateStore.healthy ? 'ok' : 'degraded',
          durableStateAdmission: capacityAvailable ? 'admitted' : 'exhausted',
          uncertainCalls: summary.states.outcome_unknown ?? 0,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/openai') {
        const contentType = request.headers['content-type'] ?? '';
        if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
          writeText(response, 415, 'Expected application/json');
          return;
        }
        const rawBody = await readRawBody(request, config.maxWebhookBytes);
        const result = await webhookHandler.handle({ headers: request.headers, rawBody });
        writeText(response, result.statusCode, result.body);
        return;
      }

      writeText(response, 404, 'Not found');
    } catch (error) {
      if (error.code === 'BODY_TOO_LARGE') {
        writeText(response, 413, 'Request body too large');
        return;
      }
      logger.error('Unhandled SIP gateway HTTP error', { error: error.message });
      if (!response.headersSent) writeText(response, 500, 'Internal server error');
      else response.destroy();
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxConnections = config.maxHttpConnections;
  return server;
}
