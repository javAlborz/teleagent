'use strict';

const { buildScorecard } = require('./scorecard');

const SNAPSHOT_TTL_MS = 75 * 1000;
const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_COLLECTION_SPAN_MS = 10 * 1000;
const CAPACITY_OBSERVATIONS = new Set([
  'proven_healthy',
  'reported_unhealthy',
  'unsupported',
  'not_proven',
]);

function exactIso(value) {
  if (typeof value !== 'string') throw new Error('invalid timestamp');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('invalid timestamp');
  }
  return parsed;
}

function requiredBoolean(value) {
  if (typeof value !== 'boolean') throw new Error('invalid boolean');
  return value;
}

function optionalBoolean(value) {
  if (value !== null && typeof value !== 'boolean') throw new Error('invalid optional boolean');
  return value;
}

function capacityObservation(value) {
  if (!CAPACITY_OBSERVATIONS.has(value)) throw new Error('invalid capacity observation');
  return value;
}

function nonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid integer');
  return value;
}

function optionalInteger(value) {
  return value === null ? null : nonnegativeInteger(value);
}

function requiredNull(value) {
  if (value !== null) throw new Error('expected unavailable metric');
  return null;
}

function safeRate(numerator, denominator) {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function requireSumWithin(total, values, { exact = false } = {}) {
  let sum = 0;
  for (const value of values) {
    if (value > total - sum) throw new Error('inconsistent aggregate counts');
    sum += value;
  }
  if (exact && sum !== total) throw new Error('unrecognized aggregate rows');
  return sum;
}

function sanitizeEvidence(value, sampledAtValue = value?.evidenceSampledAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid evidence');
  }
  const available = requiredBoolean(value.available);
  if (value.windowDays !== 14) throw new Error('invalid evidence window');
  const evidenceSampledAt = exactIso(sampledAtValue).toISOString();
  const trialStartedAt = value.trialStartedAt === null
    ? null : exactIso(value.trialStartedAt).toISOString();
  const windowStartedAt = value.windowStartedAt === null
    ? null : exactIso(value.windowStartedAt).toISOString();
  if (available && (!trialStartedAt || !windowStartedAt)) throw new Error('missing cohort start');
  if ((trialStartedAt === null) !== (windowStartedAt === null)) {
    throw new Error('partial cohort time');
  }
  if (trialStartedAt && windowStartedAt &&
      new Date(windowStartedAt).getTime() < new Date(trialStartedAt).getTime()) {
    throw new Error('invalid cohort window');
  }
  const sessions = value.sessions || {};
  const jobs = value.jobs || {};
  const turns = value.turns || {};
  const usage = value.usage || {};
  const integer = available ? nonnegativeInteger : requiredNull;
  const duration = available ? optionalInteger : requiredNull;

  const sanitized = {
    available,
    windowDays: 14,
    evidenceSampledAt,
    trialStartedAt,
    windowStartedAt,
    sessions: {
      total: integer(sessions.total),
      last24Hours: integer(sessions.last24Hours),
      activeDays: integer(sessions.activeDays),
      closed: integer(sessions.closed),
      failed: integer(sessions.failed),
      active: integer(sessions.active),
      completionRatePercent: available ? null : requiredNull(sessions.completionRatePercent),
      averageDurationSeconds: duration(sessions.averageDurationSeconds),
    },
    jobs: {
      total: integer(jobs.total),
      completed: integer(jobs.completed),
      failed: integer(jobs.failed),
      canceled: integer(jobs.canceled),
      active: integer(jobs.active),
      completionRatePercent: available ? null : requiredNull(jobs.completionRatePercent),
      averageDurationSeconds: duration(jobs.averageDurationSeconds),
    },
    turns: { user: integer(turns.user) },
    usage: {
      records: integer(usage.records),
      responseRecords: integer(usage.responseRecords),
      validResponseRecords: integer(usage.validResponseRecords),
      transcriptionRecords: integer(usage.transcriptionRecords),
      totalTokens: integer(usage.totalTokens),
      inputTokens: integer(usage.inputTokens),
      outputTokens: integer(usage.outputTokens),
      inputAudioTokens: integer(usage.inputAudioTokens),
      outputAudioTokens: integer(usage.outputAudioTokens),
      cachedInputTokens: integer(usage.cachedInputTokens),
    },
  };

  if (!available) return sanitized;

  if (sanitized.sessions.last24Hours > sanitized.sessions.total ||
      sanitized.sessions.activeDays > sanitized.sessions.total) {
    throw new Error('inconsistent session counts');
  }
  requireSumWithin(sanitized.sessions.total, [
    sanitized.sessions.closed,
    sanitized.sessions.failed,
    sanitized.sessions.active,
  ], { exact: true });
  requireSumWithin(sanitized.jobs.total, [
    sanitized.jobs.completed,
    sanitized.jobs.failed,
    sanitized.jobs.canceled,
    sanitized.jobs.active,
  ], { exact: true });
  if (sanitized.usage.responseRecords > sanitized.usage.records ||
      sanitized.usage.validResponseRecords > sanitized.usage.responseRecords ||
      sanitized.usage.transcriptionRecords > sanitized.usage.records) {
    throw new Error('inconsistent usage counts');
  }
  requireSumWithin(sanitized.usage.records, [
    sanitized.usage.responseRecords,
    sanitized.usage.transcriptionRecords,
  ]);
  requireSumWithin(sanitized.usage.totalTokens, [
    sanitized.usage.inputTokens,
    sanitized.usage.outputTokens,
  ], { exact: true });
  if (sanitized.usage.cachedInputTokens > sanitized.usage.inputTokens) {
    throw new Error('inconsistent cached token count');
  }

  sanitized.sessions.completionRatePercent = safeRate(
    sanitized.sessions.closed,
    sanitized.sessions.closed + sanitized.sessions.failed,
  );
  sanitized.jobs.completionRatePercent = safeRate(
    sanitized.jobs.completed,
    sanitized.jobs.completed + sanitized.jobs.failed + sanitized.jobs.canceled,
  );
  return sanitized;
}

function sanitizeHealth(value, sampledAtValue = value?.healthSampledAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid health');
  }
  const voiceApp = value.voiceApp || {};
  const realtime = value.realtime || {};
  const controller = value.controller || {};
  const sanitized = {
    healthSampledAt: exactIso(sampledAtValue).toISOString(),
    voiceApp: {
      reachable: requiredBoolean(voiceApp.reachable),
      healthy: requiredBoolean(voiceApp.healthy),
    },
    realtime: {
      reachable: requiredBoolean(realtime.reachable),
      healthy: requiredBoolean(realtime.healthy),
      configured: optionalBoolean(realtime.configured),
      stateHealthy: optionalBoolean(realtime.stateHealthy),
      capacityHealthy: optionalBoolean(realtime.capacityHealthy),
      capacityObservation: capacityObservation(realtime.capacityObservation),
      voiceExecutionLocked: optionalBoolean(realtime.voiceExecutionLocked),
      voiceExecutionPersistent: optionalBoolean(realtime.voiceExecutionPersistent),
    },
    controller: {
      reachable: requiredBoolean(controller.reachable),
      healthy: requiredBoolean(controller.healthy),
      providerCount: optionalInteger(controller.providerCount),
    },
  };

  for (const service of [sanitized.voiceApp, sanitized.realtime, sanitized.controller]) {
    if (service.healthy && !service.reachable) {
      throw new Error('healthy service is unreachable');
    }
  }
  const capacity = sanitized.realtime;
  const capacityConsistent =
    (capacity.capacityHealthy === true && capacity.capacityObservation === 'proven_healthy' &&
      capacity.reachable === true && capacity.healthy === true &&
      capacity.stateHealthy === true) ||
    (capacity.capacityHealthy === false &&
      capacity.capacityObservation === 'reported_unhealthy' &&
      capacity.reachable === true && capacity.healthy === false) ||
    (capacity.capacityHealthy === null && capacity.capacityObservation === 'unsupported' &&
      capacity.reachable === true && capacity.healthy === true && capacity.stateHealthy === true) ||
    (capacity.capacityHealthy === null && capacity.capacityObservation === 'not_proven');
  if (!capacityConsistent) throw new Error('inconsistent capacity observation');
  return sanitized;
}

function validateChronology(evidence, health, generated) {
  const evidenceSampled = new Date(evidence.evidenceSampledAt);
  const healthSampled = new Date(health.healthSampledAt);
  if (evidenceSampled.getTime() > healthSampled.getTime() ||
      healthSampled.getTime() > generated.getTime() ||
      generated.getTime() - evidenceSampled.getTime() > MAX_COLLECTION_SPAN_MS) {
    throw new Error('invalid collection chronology');
  }

  if (!evidence.trialStartedAt || !evidence.windowStartedAt) {
    if (evidence.available) throw new Error('missing evidence time');
    return;
  }
  const trial = new Date(evidence.trialStartedAt).getTime();
  const window = new Date(evidence.windowStartedAt).getTime();
  if (trial > evidenceSampled.getTime()) {
    throw new Error('evidence outside trial window');
  }
  const expectedWindow = new Date(
    Math.max(trial, evidenceSampled.getTime() - MAX_WINDOW_MS),
  ).toISOString();
  if (evidence.windowStartedAt !== expectedWindow || window > evidenceSampled.getTime()) {
    throw new Error('noncanonical evidence window');
  }
}

function buildPayload({ evidence, health, generatedAt, expiresAt }) {
  const scorecard = buildScorecard(evidence, health);
  const panicPreserved = health.realtime.reachable === true &&
    health.realtime.healthy === true &&
    health.realtime.voiceExecutionLocked === true &&
    health.realtime.voiceExecutionPersistent === true;
  const { evidenceSampledAt, ...publicEvidence } = evidence;
  const { healthSampledAt, ...publicHealth } = health;
  return {
    generatedAt,
    expiresAt,
    evidenceSampledAt,
    healthSampledAt,
    mode: 'read_only_cached_evidence',
    boundary: {
      facadeTransport: 'unix_socket_only',
      previewTransport: 'tailnet_https_to_fixed_unix_socket',
      allowedMethods: ['GET', 'HEAD'],
      snapshotAccess: 'sanitized_cache_only',
      databaseAccess: 'offline_collector_only',
      healthAccess: 'short_lived_collector_only',
      panicPreserved,
      executionAdmission: panicPreserved ? 'blocked_by_persistent_panic' : 'not_proven',
      mutationControlsExposed: false,
      controlRoutesExposed: false,
      rootOrSessionTargetingExposed: false,
      rawRecordsExposed: false,
      productionAuthorized: false,
    },
    evidence: publicEvidence,
    health: publicHealth,
    scorecard,
  };
}

function composeSnapshot({ evidence, health, now = new Date() }) {
  const sampledAt = now instanceof Date ? new Date(now.getTime()) : exactIso(now);
  if (!Number.isFinite(sampledAt.getTime())) throw new Error('invalid generation time');
  const sanitizedEvidence = sanitizeEvidence(evidence);
  const sanitizedHealth = sanitizeHealth(health);
  validateChronology(sanitizedEvidence, sanitizedHealth, sampledAt);
  const generatedAt = sampledAt.toISOString();
  const expiresAt = new Date(sampledAt.getTime() + SNAPSHOT_TTL_MS).toISOString();
  return buildPayload({
    evidence: sanitizedEvidence,
    health: sanitizedHealth,
    generatedAt,
    expiresAt,
  });
}

// Rebuild the public response from allowlisted primitives. Extra keys in a
// staging file are ignored and therefore cannot cross the facade.
function sanitizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid snapshot');
  }
  const generated = exactIso(value.generatedAt);
  const expires = exactIso(value.expiresAt);
  if (expires.getTime() - generated.getTime() !== SNAPSHOT_TTL_MS) {
    throw new Error('invalid snapshot lifetime');
  }
  const evidence = sanitizeEvidence(value.evidence, value.evidenceSampledAt);
  const health = sanitizeHealth(value.health, value.healthSampledAt);
  validateChronology(evidence, health, generated);
  return buildPayload({
    evidence,
    health,
    generatedAt: generated.toISOString(),
    expiresAt: expires.toISOString(),
  });
}

module.exports = {
  MAX_COLLECTION_SPAN_MS,
  SNAPSHOT_TTL_MS,
  composeSnapshot,
  sanitizeEvidence,
  sanitizeHealth,
  sanitizeSnapshot,
};
