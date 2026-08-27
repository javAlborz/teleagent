'use strict';

const HEALTH_ENDPOINTS = Object.freeze({
  voiceApp: 'http://127.0.0.1:3000/health',
  realtime: 'http://127.0.0.1:3000/api/realtime-health',
  controller: 'http://127.0.0.1:3333/health',
});
const MAX_HEALTH_BYTES = 64 * 1024;

async function readBoundedJson(response) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_HEALTH_BYTES) throw new Error('oversize');
  if (!response.body) return {};

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HEALTH_BYTES) throw new Error('oversize');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
  return parsed;
}

function healthyStatus(response, body) {
  return response.ok && (
    body.status === 'healthy' || body.status === 'ok' || body.status === 'ready' ||
    body.ready === true
  );
}

async function fetchHealth(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
      headers: { Accept: 'application/json' },
    });
    const body = await readBoundedJson(response);
    return { response, body };
  } catch {
    return null;
  }
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function countOrNull(value) {
  if (!Array.isArray(value)) return null;
  return Math.min(value.length, 1000);
}

async function readLoopbackHealth({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const [voiceResult, realtimeResult, controllerResult] = await Promise.all([
    fetchHealth(HEALTH_ENDPOINTS.voiceApp, fetchImpl),
    fetchHealth(HEALTH_ENDPOINTS.realtime, fetchImpl),
    fetchHealth(HEALTH_ENDPOINTS.controller, fetchImpl),
  ]);

  const voiceBody = voiceResult?.body || {};
  const realtimeBody = realtimeResult?.body || {};
  const controllerBody = controllerResult?.body || {};
  const realtimeAccepted = Boolean(
    realtimeResult && healthyStatus(realtimeResult.response, realtimeBody),
  );
  const realtimeDetails = realtimeAccepted ? realtimeBody : {};
  const capacity = realtimeDetails.state?.capacity;
  const sampledAt = typeof now === 'function' ? now() : now;
  const sampledTime = sampledAt instanceof Date ? new Date(sampledAt.getTime()) : new Date(sampledAt);
  if (!Number.isFinite(sampledTime.getTime())) throw new Error('invalid sample time');

  return {
    healthSampledAt: sampledTime.toISOString(),
    voiceApp: {
      reachable: Boolean(voiceResult),
      healthy: Boolean(voiceResult && healthyStatus(voiceResult.response, voiceBody)),
    },
    realtime: {
      reachable: Boolean(realtimeResult),
      healthy: realtimeAccepted,
      configured: booleanOrNull(realtimeDetails.configured),
      stateHealthy: booleanOrNull(realtimeDetails.state?.ok),
      capacityHealthy: booleanOrNull(capacity?.ok),
      voiceExecutionLocked: booleanOrNull(realtimeDetails.voiceExecution?.locked),
      voiceExecutionPersistent: booleanOrNull(realtimeDetails.voiceExecution?.persistent),
    },
    controller: {
      reachable: Boolean(controllerResult),
      healthy: Boolean(controllerResult && healthyStatus(controllerResult.response, controllerBody)),
      providerCount: countOrNull(controllerBody.providers),
    },
  };
}

module.exports = {
  HEALTH_ENDPOINTS,
  MAX_HEALTH_BYTES,
  readLoopbackHealth,
};
