/**
 * Outbound Call API Routes
 * Express routes for initiating and managing outbound calls
 * v3: Added context parameter for structured data to Claude
 * Supports both announce (one-way) and conversation (two-way) modes
 */

const express = require('express');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { clearImmediate, setImmediate } = require('node:timers');
const router = express.Router();
const logger = require('./logger');
const { OutboundSession, getSession } = require('./outbound-session');
const {
  createOutboundAbortError,
  initiateOutboundCall,
  playMessage,
  hangupCall,
} = require('./outbound-handler');
const { runConversationLoop } = require('./conversation-loop');
const { runRealtimeConversation } = require('./realtime-conversation');
const { getRealtimeApiKey } = require('./openai-realtime-client');
const { getRuntimeSecret } = require('./runtime-secrets');
const { verifyOutboundRoutingConfig } = require('./outbound-routing-config');

// Dependencies injected via setupRoutes()
var srf = null;
var mediaServer = null;
var deviceRegistry = null;
var audioForkServer = null;
var whisperClient = null;
var claudeBridge = null;
var ttsService = null;
var voiceStateStore = null;
var agentJobBroker = null;
var wsPort = 3001;
var outboundApiToken = null;
var outboundAccepting = false;
var outboundPanicLocked = false;
var outboundRecoveryBlocked = false;
var outboundRuntimeFence = null;
var outboundRoutingConfig = null;
const outboundOperations = new Map();
var outboundRecoveryImmediate = null;

function normalizeOutboundApiToken(value) {
  const token = String(value || '').trim();
  const byteLength = Buffer.byteLength(token, 'utf8');
  if (byteLength < 32 || byteLength > 4096 ||
      /[\u0000-\u001F\u007F]/.test(token) ||
      /^(replace|change|your)[-_ ]?with|placeholder|example|changeme/i.test(token)) {
    return null;
  }
  return token;
}

function timingSafeTokenEqual(provided, expected) {
  const left = createHash('sha256').update(String(provided || ''), 'utf8').digest();
  const right = createHash('sha256').update(String(expected || ''), 'utf8').digest();
  return timingSafeEqual(left, right);
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').trim().toLowerCase());
}

function recoveryBarriers() {
  if (!voiceStateStore?.listOutboundRecoveryBarriers) {
    throw new Error('Durable outbound recovery state is unavailable');
  }
  return voiceStateStore.listOutboundRecoveryBarriers({ limit: 1000 });
}

function refreshRecoveryBarrier() {
  let barriers = [];
  try {
    barriers = recoveryBarriers();
    outboundRecoveryBlocked = barriers.length > 0;
  } catch {
    outboundRecoveryBlocked = true;
  }
  if (outboundRecoveryBlocked) {
    outboundPanicLocked = true;
    outboundAccepting = false;
  }
  return barriers;
}

function runtimeFenceHeld() {
  try {
    return outboundRuntimeFence?.assertHeld?.() === true && outboundRuntimeFence.held === true;
  } catch {
    outboundAccepting = false;
    outboundPanicLocked = true;
    return false;
  }
}

function getProvidedApiToken(req) {
  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim() || '';
}

function authorizeOutboundApi(req, res, next) {
  if (!outboundApiToken) {
    return res.status(503).json({
      success: false,
      error: 'outbound_api_not_configured'
    });
  }

  const providedToken = getProvidedApiToken(req);

  if (providedToken && timingSafeTokenEqual(providedToken, outboundApiToken)) {
    return next();
  }

  logger.warn('Unauthorized outbound API request', {
    method: req.method,
    path: req.path,
    hasAuthorizationHeader: !!req.get('authorization'),
  });

  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({
    success: false,
    error: 'unauthorized'
  });
}

/**
 * Validate phone number format
 */
function isValidPhoneNumber(phoneNumber) {
  if (typeof phoneNumber !== 'string') return false;
  var e164Regex = /^\+[1-9]\d{1,14}$/;
  var dialStringRegex = /^\d{1,15}$/;
  return e164Regex.test(phoneNumber) || dialStringRegex.test(phoneNumber);
}

/**
 * Validate outbound call request
 */
function validateRequest(body) {
  if (!body) {
    return { valid: false, error: 'Request body is required' };
  }

  if (!body.to) {
    return { valid: false, error: 'Field "to" is required' };
  }

  if (!isValidPhoneNumber(body.to)) {
    return { valid: false, error: 'Field "to" must be a valid phone number (e.g. +15551234567 or extension 5755)' };
  }

  if (!body.message) {
    return { valid: false, error: 'Field "message" is required' };
  }

  if (typeof body.message !== 'string' || body.message.trim().length === 0) {
    return { valid: false, error: 'Field "message" must be a non-empty string' };
  }

  if (body.message.length > 1000) {
    return { valid: false, error: 'Field "message" must be 1000 characters or less' };
  }

  if (body.callerId && !isValidPhoneNumber(body.callerId)) {
    return { valid: false, error: 'Field "callerId" must be a valid E.164 phone number if provided' };
  }

  if (body.mode && !['announce', 'conversation', 'realtime'].includes(body.mode)) {
    return { valid: false, error: 'Field "mode" must be announce, conversation, or realtime' };
  }

  if (body.device !== undefined && typeof body.device !== 'string') {
    return { valid: false, error: 'Field "device" must be a string (extension number or device name)' };
  }

  // Optional: 'context' validation (string or object)
  if (body.context !== undefined) {
    if (typeof body.context !== 'string' && typeof body.context !== 'object') {
      return { valid: false, error: 'Field "context" must be a string or object' };
    }
  }

  if (body.timeoutSeconds !== undefined) {
    var timeout = Number(body.timeoutSeconds);
    if (!Number.isInteger(timeout) || timeout < 5 || timeout > 120) {
      return { valid: false, error: 'Field "timeoutSeconds" must be an integer between 5 and 120' };
    }
  }

  if (Object.hasOwn(body, 'dialUri')) {
    return {
      valid: false,
      error: 'Field "dialUri" is not supported; outbound SIP routing is configured server-side',
    };
  }

  if (body.voiceThreadId !== undefined && !/^vt_[a-f0-9]{32}$/.test(body.voiceThreadId)) {
    return { valid: false, error: 'Field "voiceThreadId" is invalid' };
  }

  if (Object.hasOwn(body, 'webhookUrl')) {
    return {
      valid: false,
      error: 'Field "webhookUrl" is not supported; use the durable callback outbox',
    };
  }

  return { valid: true };
}

function getOutboundIdempotencyKey(req) {
  const headerKey = String(req.get('idempotency-key') || '').trim();
  const bodyKey = String(req.body?.idempotencyKey || '').trim();
  const clean = (value) => value && value.length <= 200 &&
    !/[\u0000-\u001F\u007F]/.test(value);
  if (!clean(headerKey) || !clean(bodyKey) || headerKey !== bodyKey) return null;
  return headerKey;
}

function normalizeOutboundRequest(body) {
  return {
    to: String(body.to),
    message: String(body.message),
    context: body.context === undefined ? null : body.context,
    mode: body.mode || 'announce',
    device: body.device || null,
    callerId: body.callerId || null,
    timeoutSeconds: body.timeoutSeconds || 30,
    voiceThreadId: body.voiceThreadId || null,
  };
}

function resolveOutboundDevice(deviceParam) {
  if (!deviceParam || !deviceRegistry) return null;
  return deviceRegistry.get(deviceParam) || null;
}

function operationAbortError(operation) {
  return createOutboundAbortError(operation.controller.signal.reason || 'Outbound call canceled');
}

function throwIfOperationAborted(operation) {
  if (operation.controller.signal.aborted) throw operationAbortError(operation);
}

async function cleanupOperation(operation) {
  if (!operation.cleanupPromise) {
    const dialog = operation.dialog || operation.session?.dialog;
    const endpoint = operation.endpoint || operation.session?.endpoint;
    // Do not memoize a no-op while an async SIP setup may still publish its
    // dialog/endpoint. A later abort/failure must get another chance to tear
    // down resources that appeared after the first cleanup attempt.
    if (!dialog && !endpoint) return { success: true, active: false };
    if (operation.session) {
      operation.session.dialog = null;
      operation.session.endpoint = null;
    }
    operation.cleanupPromise = hangupCall(
      dialog,
      endpoint,
      operation.callId
    ).then((result) => {
      operation.cleanupConfirmed = result.success;
      return result;
    });
  }
  return operation.cleanupPromise;
}

async function interruptOutboundOperation(operation, reason) {
  if (!operation) return { success: true, active: false };
  if (!operation.controller.signal.aborted) operation.controller.abort(reason);
  if (operation.session && !['COMPLETED', 'FAILED', 'CANCELED'].includes(operation.session.state)) {
    operation.session.transition('CANCELING', String(reason || 'Outbound call canceled'));
  }
  const cleanup = await cleanupOperation(operation);
  return { success: cleanup.success, active: true };
}

function waitForPromises(promises, timeoutMs) {
  if (promises.length === 0) return Promise.resolve(true);
  const boundedMs = Math.max(10, Math.min(Number(timeoutMs) || 5000, 60000));
  let timer = null;
  return Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), boundedMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function projectOutboundCall(record) {
  if (!record) return null;
  const live = getSession(record.callId)?.getInfo?.() || null;
  const state = record.state === 'dial_intent' && live?.state
    ? String(live.state).toLowerCase()
    : record.state;
  return {
    callId: record.callId,
    to: String(record.request?.to || ''),
    state,
    mode: String(record.request?.mode || 'announce'),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    intentAt: record.intentAt,
    terminalAt: record.terminalAt,
    cancellationRequestedAt: record.cancellationRequestedAt,
    recoveryRequired: Boolean(record.recoveryRequired),
    recoveryBarrierAt: record.recoveryBarrierAt || null,
    recoveryBarrierResolvedAt: record.recoveryBarrierResolvedAt || null,
    answeredAt: live?.answeredAt || null,
    endedAt: live?.endedAt || record.terminalAt || null,
    duration: live?.duration ?? null,
    error: record.error ? String(record.error).slice(0, 500) : null,
  };
}

function getOutboundPlaneStatus() {
  const barriers = refreshRecoveryBarrier();
  const runtimeFenceHealthy = runtimeFenceHeld();
  let active = [];
  let stateAvailable = true;
  try {
    active = voiceStateStore?.listActiveOutboundCalls?.({ limit: 1000 }) || [];
  } catch {
    stateAvailable = false;
  }
  const activeIds = [...new Set([
    ...outboundOperations.keys(),
    ...active.map((record) => record.callId),
    ...barriers.map((record) => record.callId),
  ])];
  const configured = Boolean(
    outboundApiToken && outboundRoutingConfig && srf && mediaServer && voiceStateStore
  );
  const recoveryRequired = outboundRecoveryBlocked;
  return {
    configured,
    accepting: Boolean(outboundAccepting && !recoveryRequired && runtimeFenceHealthy),
    locked: Boolean(outboundPanicLocked || recoveryRequired),
    quiesced: stateAvailable && !recoveryRequired && activeIds.length === 0,
    recoveryRequired,
    recoveryCallIds: barriers.map((record) => record.callId),
    activeCount: activeIds.length,
    activeIds,
    runtimeFenceHeld: runtimeFenceHealthy,
    error: !stateAvailable
      ? 'outbound_state_unavailable'
      : (recoveryRequired ? 'outbound_recovery_required' : null),
  };
}

function scheduleOutboundCall(record) {
  refreshRecoveryBarrier();
  if (!record || !voiceStateStore || !outboundAccepting ||
      !runtimeFenceHeld() || outboundRecoveryBlocked ||
      outboundOperations.has(record.callId)) {
    return record ? outboundOperations.get(record.callId)?.promise || null : null;
  }
  const operation = {
    callId: record.callId,
    idempotencyKey: record.idempotencyKey,
    controller: new AbortController(),
    session: null,
    dialog: null,
    endpoint: null,
    cleanupConfirmed: false,
    cleanupPromise: null,
    remoteHangup: false,
    promise: null,
  };
  const promise = Promise.resolve().then(async function() {
    const claimed = voiceStateStore.claimOutboundCallIntent({
      idempotencyKey: record.idempotencyKey,
      callId: record.callId,
    });
    if (!claimed.changed) return claimed.record;

    const request = claimed.record.request;
    const deviceConfig = resolveOutboundDevice(request.device);
    const session = new OutboundSession(record.callId, {
      to: request.to,
      message: request.message,
      mode: request.mode,
      callerId: request.callerId,
      device: deviceConfig ? deviceConfig.name : null,
    });
    operation.session = session;
    session.on('stateChange', (event) => {
      if (event.reason !== 'remote_hangup') return;
      operation.remoteHangup = true;
      void cleanupOperation(operation);
    });
    const startedAt = Date.now();

    try {
      throwIfOperationAborted(operation);
      session.transition('DIALING');
      const result = await initiateOutboundCall(srf, mediaServer, {
        to: request.to,
        message: request.message,
        callerId: request.callerId,
        timeoutSeconds: request.timeoutSeconds,
        deviceConfig,
        routingConfig: outboundRoutingConfig,
        callId: record.callId,
        signal: operation.controller.signal,
      });
      const dialog = result.dialog;
      const endpoint = result.endpoint;
      operation.dialog = dialog;
      operation.endpoint = endpoint;
      throwIfOperationAborted(operation);
      session.setDialog(dialog);
      session.setEndpoint(endpoint);
      session.transition('PLAYING');

      if (request.mode === 'realtime') {
        logger.info('Entering OpenAI Realtime callback mode', {
          callId: record.callId,
          voiceThreadId: request.voiceThreadId,
          device: deviceConfig ? deviceConfig.name : 'default',
        });
        session.transition('CONVERSING');
        await runRealtimeConversation(endpoint, dialog, record.callId, {
          audioForkServer,
          wsPort,
          stateStore: voiceStateStore,
          jobBroker: agentJobBroker,
          callerId: request.to,
          callbackTarget: request.to,
          resume: true,
          voiceThreadId: request.voiceThreadId,
          initialMessage: request.message,
          defaultProfile: deviceConfig?.defaultAgentProfile || 'codex-terra',
        });
        throwIfOperationAborted(operation);
        const cleanup = await cleanupOperation(operation);
        if (!cleanup.success) throw new Error('outbound_cleanup_failed');
        session.transition('COMPLETED', 'realtime_complete');
      } else {
        const voiceId = deviceConfig?.voiceId || null;
        await playMessage(endpoint, request.message, { voiceId });
        throwIfOperationAborted(operation);
        if (request.mode === 'announce') {
          const cleanup = await cleanupOperation(operation);
          if (!cleanup.success) throw new Error('outbound_cleanup_failed');
          session.transition('COMPLETED', 'announce_complete');
        } else {
          session.transition('CONVERSING');
          try {
            await runConversationLoop(endpoint, dialog, record.callId, {
              audioForkServer,
              whisperClient,
              claudeBridge,
              ttsService,
              wsPort,
              deviceConfig,
              initialContext: request.message,
              context: request.context,
              callbackTarget: request.to,
              skipGreeting: true,
              maxTurns: deviceConfig?.maxTurns,
            });
            throwIfOperationAborted(operation);
            const cleanup = await cleanupOperation(operation);
            if (!cleanup.success) throw new Error('outbound_cleanup_failed');
            session.transition('COMPLETED', 'conversation_complete');
          } catch (conversationError) {
            if (operation.controller.signal.aborted) throw conversationError;
            logger.error('Conversation loop error', {
              callId: record.callId,
              error: conversationError.message,
            });
            const cleanup = await cleanupOperation(operation);
            if (!cleanup.success) throw new Error('outbound_cleanup_failed');
            session.transition('COMPLETED', 'conversation_error');
          }
        }
      }
      return voiceStateStore.markOutboundCallTerminal({
        idempotencyKey: record.idempotencyKey,
        callId: record.callId,
        state: 'completed',
      }).record;
    } catch (error) {
      const cleanup = await cleanupOperation(operation);
      logger.error('Outbound call failed', {
        callId: record.callId,
        error: error.message,
        elapsed: Date.now() - startedAt,
      });
      const current = voiceStateStore.getOutboundCall(record.idempotencyKey);
      const canceled = operation.controller.signal.aborted ||
        current?.state === 'cancel_requested' || current?.state === 'canceled';
      const cleanupConfirmed = cleanup.success && error.cleanupSucceeded !== false;
      if (canceled && cleanupConfirmed) {
        session.transition('CANCELED', error.message);
        return voiceStateStore.markOutboundCallTerminal({
          idempotencyKey: record.idempotencyKey,
          callId: record.callId,
          state: 'canceled',
          error: error.message,
        }).record;
      }
      if (canceled) {
        session.transition('CANCELING', 'cancellation_quiescence_unconfirmed');
        const uncertainCancellation = voiceStateStore.markOutboundCallTerminal({
          idempotencyKey: record.idempotencyKey,
          callId: record.callId,
          state: 'outcome_unknown',
          error: 'Outbound cancellation could not confirm PBX and media quiescence.',
        }).record;
        refreshRecoveryBarrier();
        return uncertainCancellation;
      }
      if (operation.remoteHangup && cleanupConfirmed) {
        return voiceStateStore.markOutboundCallTerminal({
          idempotencyKey: record.idempotencyKey,
          callId: record.callId,
          state: 'completed',
        }).record;
      }
      const knownFailure = ['busy', 'no_answer', 'not_found', 'service_unavailable', 'auth_failed']
        .includes(error.message);
      const terminalState = knownFailure && cleanupConfirmed ? 'failed' : 'outcome_unknown';
      session.transition('FAILED', terminalState === 'failed' ? error.message : 'outcome_unknown');
      const terminal = voiceStateStore.markOutboundCallTerminal({
        idempotencyKey: record.idempotencyKey,
        callId: record.callId,
        state: terminalState,
        error: error.message,
      }).record;
      if (terminalState === 'outcome_unknown') refreshRecoveryBarrier();
      return terminal;
    }
  }).catch(async function(error) {
    await cleanupOperation(operation).catch(() => ({ success: false }));
    logger.error('Outbound scheduler failed before managed execution', {
      callId: record.callId,
      error: error.message,
    });
    const current = voiceStateStore?.getOutboundCall?.(record.idempotencyKey) || null;
    if (!['dial_intent', 'cancel_requested'].includes(current?.state)) return current;
    const uncertain = voiceStateStore.markOutboundCallTerminal({
      idempotencyKey: record.idempotencyKey,
      callId: record.callId,
      state: 'outcome_unknown',
      error: 'Outbound execution failed after durable dial intent; delivery outcome is unknown.',
    }).record;
    refreshRecoveryBarrier();
    return uncertain;
  }).finally(function() {
    outboundOperations.delete(record.callId);
  });
  operation.promise = promise;
  outboundOperations.set(record.callId, operation);
  return promise;
}

async function cancelOutboundCall(callId, {
  reason = 'Outbound call canceled by operator',
  timeoutMs = 3000,
} = {}) {
  if (!voiceStateStore) {
    return { success: false, persisted: false, quiesced: false, error: 'outbound_store_unavailable' };
  }
  const cancellation = voiceStateStore.requestOutboundCallCancellation({ callId, reason });
  if (!cancellation.found) {
    return { success: false, persisted: false, quiesced: false, notFound: true };
  }
  const operation = outboundOperations.get(String(callId));
  let cleanup = { success: true, active: false };
  if (operation) cleanup = await interruptOutboundOperation(operation, reason);
  const settled = operation ? await waitForPromises([operation.promise], timeoutMs) : true;
  const record = voiceStateStore.getOutboundCallByCallId(callId);
  const quiesced = settled && !outboundOperations.has(String(callId)) &&
    !['queued', 'dial_intent', 'cancel_requested', 'outcome_unknown'].includes(record?.state);
  return {
    success: true,
    persisted: true,
    quiesced,
    cleanupSucceeded: cleanup.success,
    changed: cancellation.changed,
    record,
  };
}

async function stopOutboundPlane({
  reason,
  timeoutMs = 5000,
  lock = true,
} = {}) {
  outboundAccepting = false;
  if (lock) outboundPanicLocked = true;
  if (!voiceStateStore) {
    const quiesced = outboundOperations.size === 0;
    return {
      success: quiesced,
      persisted: false,
      quiesced,
      activeCount: outboundOperations.size,
      activeIds: [...outboundOperations.keys()],
      error: quiesced ? null : 'outbound_store_unavailable',
    };
  }

  let cancellations;
  try {
    cancellations = voiceStateStore.requestAllOutboundCallCancellations(
      reason || 'Voice emergency stop'
    );
  } catch (error) {
    return {
      success: false,
      persisted: false,
      quiesced: false,
      activeCount: outboundOperations.size,
      activeIds: [...outboundOperations.keys()],
      error: error.message,
    };
  }

  const operations = [...outboundOperations.values()];
  const cleanupResults = await Promise.allSettled(operations.map((operation) =>
    interruptOutboundOperation(operation, reason || 'Voice emergency stop')
  ));
  const settled = await waitForPromises(operations.map((operation) => operation.promise), timeoutMs);
  const unresolved = voiceStateStore.listUnconfirmedOutboundCancellations({ limit: 1000 });
  const stillActive = voiceStateStore.listActiveOutboundCalls({ limit: 1000 });
  const barriers = refreshRecoveryBarrier();
  const activeIds = [...new Set([
    ...outboundOperations.keys(),
    ...unresolved.map((record) => record.callId),
    ...stillActive.map((record) => record.callId),
    ...barriers.map((record) => record.callId),
  ])];
  const cleanupSucceeded = cleanupResults.every(
    (entry) => entry.status === 'fulfilled' && entry.value?.success === true
  );
  const quiesced = settled && cleanupSucceeded && activeIds.length === 0 &&
    !outboundRecoveryBlocked && runtimeFenceHeld();
  return {
    success: quiesced,
    persisted: cancellations.every((entry) => entry.found === true),
    quiesced,
    canceledCount: cancellations.filter((entry) => entry.record?.state === 'canceled').length,
    cancelRequestedCount: cancellations.filter(
      (entry) => entry.record?.state === 'cancel_requested'
    ).length,
    activeCount: activeIds.length,
    activeIds,
    recoveryRequired: outboundRecoveryBlocked,
    recoveryCallIds: barriers.map((record) => record.callId),
    error: outboundRecoveryBlocked ? 'outbound_recovery_required' : null,
  };
}

async function panicOutboundCalls(options = {}) {
  return stopOutboundPlane({
    reason: options.reason || 'Voice emergency stop',
    timeoutMs: options.timeoutMs || 5000,
    lock: true,
  });
}

function unlockOutboundCalls() {
  const barriers = refreshRecoveryBarrier();
  if (outboundRecoveryBlocked) {
    return {
      success: false,
      locked: true,
      quiesced: false,
      recoveryRequired: true,
      recoveryCallIds: barriers.map((record) => record.callId),
      activeIds: barriers.map((record) => record.callId),
      error: 'outbound_recovery_required',
    };
  }
  const unresolved = voiceStateStore?.listUnconfirmedOutboundCancellations?.({ limit: 1000 }) || [];
  const active = voiceStateStore?.listActiveOutboundCalls?.({ limit: 1000 }) || [];
  if (outboundOperations.size > 0 || unresolved.length > 0 || active.length > 0) {
    return {
      success: false,
      locked: true,
      quiesced: false,
      activeIds: [...new Set([
        ...outboundOperations.keys(),
        ...unresolved.map((record) => record.callId),
        ...active.map((record) => record.callId),
      ])],
      error: 'outbound_quiescence_unconfirmed',
    };
  }
  const ready = Boolean(
    outboundApiToken && srf && mediaServer && voiceStateStore && runtimeFenceHeld()
  );
  if (!ready) {
    outboundPanicLocked = true;
    outboundAccepting = false;
    return {
      success: false,
      locked: true,
      quiesced: true,
      activeIds: [],
      error: 'outbound_infrastructure_unavailable',
    };
  }
  outboundPanicLocked = false;
  outboundAccepting = true;
  if (outboundAccepting) {
    for (const record of voiceStateStore.listQueuedOutboundCalls({ limit: 100 })) {
      scheduleOutboundCall(record);
    }
  }
  return { success: outboundAccepting, locked: false, quiesced: true, activeIds: [] };
}

/**
 * POST /api/outbound-call
 * Initiate an outbound call
 *
 * Body parameters:
 *   - to: Phone number (required)
 *   - message: Initial message to play (required) - what the device SAYS
 *   - context: Background data for Claude (optional) - what the device KNOWS
 *   - mode: 'announce', 'conversation', or 'realtime' (default: announce)
 *   - device: Device extension or name for voice/personality (optional)
 *   - callerId: Caller ID (optional)
 *   - timeoutSeconds: Ring timeout (optional, default: 30)
 */
router.post('/outbound-call', authorizeOutboundApi, async function(req, res) {
  try {
    const planeStatus = getOutboundPlaneStatus();
    if (!planeStatus.accepting) {
      return res.status(503).json({
        success: false,
        queued: false,
        error: planeStatus.recoveryRequired
          ? 'outbound_recovery_required'
          : (outboundPanicLocked ? 'voice_execution_locked' : 'outbound_api_draining'),
        recoveryCallIds: planeStatus.recoveryCallIds,
      });
    }
    // Validate request
    var validation = validateRequest(req.body);
    if (!validation.valid) {
      logger.warn('Invalid outbound call request', {
        error: validation.error,
        hasIdempotencyKey: Boolean(req.get('idempotency-key')),
      });

      return res.status(400).json({
        success: false,
        error: 'validation_failed',
        message: validation.error
      });
    }

    var idempotencyKey = getOutboundIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        queued: false,
        error: 'invalid_idempotency_key',
        message: 'Matching clean Idempotency-Key header and body idempotencyKey are required'
      });
    }

    var outboundRequest = normalizeOutboundRequest(req.body);
    var mode = outboundRequest.mode;
    var deviceParam = outboundRequest.device;

    // Look up device configuration
    var deviceConfig = null;
    if (deviceParam && deviceRegistry) {
      // Use get() which tries extension first, then name (case-insensitive)
      deviceConfig = deviceRegistry.get(deviceParam);

      if (deviceConfig) {
        logger.info('Device found for outbound call', {
          device: deviceConfig.name,
          extension: deviceConfig.extension,
          voiceId: deviceConfig.voiceId || 'default'
        });
      } else {
        logger.warn('Device not found, using default', { requested: deviceParam });
      }
    }

    // Check if infrastructure is available
    if (!srf || !mediaServer || !voiceStateStore) {
      logger.error('Infrastructure not ready', {
        srf: !!srf,
        mediaServer: !!mediaServer,
        voiceStateStore: !!voiceStateStore
      });

      return res.status(503).json({
        success: false,
        error: 'service_unavailable',
        message: 'Voice infrastructure is not ready'
      });
    }

    // For conversation mode, check additional dependencies
    if (mode === 'conversation') {
      if (!audioForkServer || !whisperClient || !claudeBridge || !ttsService) {
        logger.error('Conversation mode dependencies not ready', {
          audioForkServer: !!audioForkServer,
          whisperClient: !!whisperClient,
          claudeBridge: !!claudeBridge,
          ttsService: !!ttsService
        });

        return res.status(503).json({
          success: false,
          error: 'service_unavailable',
          message: 'Conversation mode dependencies not ready'
        });
      }
    }

    if (mode === 'realtime') {
      if (!audioForkServer || !voiceStateStore || !agentJobBroker || !getRealtimeApiKey()) {
        logger.error('Realtime conversation dependencies not ready', {
          audioForkServer: !!audioForkServer,
          voiceStateStore: !!voiceStateStore,
          agentJobBroker: !!agentJobBroker,
          openaiConfigured: !!getRealtimeApiKey()
        });

        return res.status(503).json({
          success: false,
          error: 'service_unavailable',
          message: 'OpenAI Realtime voice is not configured'
        });
      }
    }

    var reservation = voiceStateStore.reserveOutboundCall({
      idempotencyKey: idempotencyKey,
      request: outboundRequest,
      callId: randomUUID()
    });
    if (reservation.conflict) {
      return res.status(409).json({
        success: false,
        queued: false,
        error: 'idempotency_conflict',
        message: 'The idempotency key is already bound to a different outbound request'
      });
    }
    if (reservation.state === 'outcome_unknown') {
      return res.status(409).json({
        success: false,
        queued: false,
        callId: reservation.callId,
        status: reservation.state,
        error: 'outbound_outcome_unknown',
        message: reservation.error || 'The prior dial intent has an unknown outcome and was not redialed'
      });
    }
    if (['failed', 'canceled', 'cancel_requested'].includes(reservation.state)) {
      return res.status(409).json({
        success: false,
        queued: false,
        callId: reservation.callId,
        status: reservation.state,
        error: reservation.state === 'cancel_requested'
          ? 'outbound_cancellation_pending'
          : 'outbound_terminal_failure',
        message: reservation.error || 'The prior outbound request was not delivered successfully',
      });
    }

    var callId = reservation.callId;

    logger.info('Processing outbound call request', {
      callId: callId,
      to: outboundRequest.to,
      mode: mode,
      device: deviceConfig ? deviceConfig.name : 'default',
      messageLength: outboundRequest.message.length,
      hasContext: !!outboundRequest.context,
      duplicate: !reservation.created,
      durableState: reservation.state
    });

    // Return immediately with callId
    res.json({
      success: true,
      queued: true,
      callId: callId,
      status: reservation.state,
      duplicate: !reservation.created,
      message: 'Call durably queued',
      device: deviceConfig ? deviceConfig.name : null
    });

    if (reservation.state === 'queued') scheduleOutboundCall(reservation);

  } catch (error) {
    logger.error('Outbound call endpoint error', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'An internal error occurred'
    });
  }
});

router.get('/outbound-status', authorizeOutboundApi, function(req, res) {
  const status = getOutboundPlaneStatus();
  const ready = status.configured && status.runtimeFenceHeld && !status.recoveryRequired;
  return res.status(ready ? 200 : 503).json({
    success: ready,
    outbound: status,
  });
});

/**
 * GET /api/call/:callId
 */
router.get('/call/:callId', authorizeOutboundApi, function(req, res) {
  var callId = req.params.callId;
  var record = voiceStateStore?.getOutboundCallByCallId?.(callId) || null;

  if (!record) {
    return res.status(404).json({
      success: false,
      error: 'not_found',
      message: 'Call not found'
    });
  }

  res.json({
    success: true,
    data: projectOutboundCall(record)
  });
});

/**
 * GET /api/calls
 */
router.get('/calls', authorizeOutboundApi, function(req, res) {
  var calls = voiceStateStore?.listOutboundCalls?.({ limit: 100 }) || [];

  res.json({
    success: true,
    count: calls.length,
    calls: calls.map(projectOutboundCall)
  });
});

/**
 * POST /api/call/:callId/hangup
 */
router.post('/call/:callId/hangup', authorizeOutboundApi, async function(req, res) {
  var callId = req.params.callId;

  try {
    const result = await cancelOutboundCall(callId, {
      reason: String(req.body?.reason || 'Outbound call canceled by operator').slice(0, 1000),
      timeoutMs: 3000,
    });
    if (result.notFound) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Call not found',
      });
    }
    if (!result.persisted) {
      return res.status(503).json({
        success: false,
        error: result.error || 'cancellation_not_persisted',
      });
    }
    if (!result.changed && ['completed', 'failed', 'outcome_unknown'].includes(result.record?.state)) {
      return res.status(409).json({
        success: false,
        error: 'already_ended',
        callId,
        data: projectOutboundCall(result.record),
      });
    }

    return res.status(result.quiesced ? 200 : 202).json({
      success: true,
      persisted: true,
      quiesced: result.quiesced,
      message: result.quiesced ? 'Call canceled' : 'Call cancellation is pending',
      callId: callId,
      data: projectOutboundCall(result.record),
    });
  } catch (error) {
    logger.error('Failed to hangup call', {
      callId: callId,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      error: 'hangup_failed',
      message: error.message
    });
  }
});

/**
 * Setup routes with dependencies
 */
function setupRoutes(deps) {
  if (outboundRecoveryImmediate) clearImmediate(outboundRecoveryImmediate);
  outboundRecoveryImmediate = null;
  outboundApiToken = null;
  outboundAccepting = false;
  outboundPanicLocked = false;
  outboundRecoveryBlocked = false;
  outboundRoutingConfig = null;
  const configuredOutboundToken = normalizeOutboundApiToken(
    Object.hasOwn(deps, 'outboundApiToken')
      ? deps.outboundApiToken
      : getRuntimeSecret('outboundApiToken')
  );
  if (!configuredOutboundToken) {
    throw new Error('OUTBOUND_API_TOKEN must be a clean non-placeholder token of at least 32 bytes');
  }
  const httpHost = String(deps.httpHost || '127.0.0.1').trim();
  if (!isLoopbackHost(httpHost) && process.env.OUTBOUND_API_NON_LOOPBACK_ENABLED !== 'true') {
    throw new Error(
      'Non-loopback outbound HTTP binding requires OUTBOUND_API_NON_LOOPBACK_ENABLED=true'
    );
  }
  outboundApiToken = configuredOutboundToken;
  srf = deps.srf;
  mediaServer = deps.mediaServer;
  deviceRegistry = deps.deviceRegistry || null;
  audioForkServer = deps.audioForkServer || null;
  whisperClient = deps.whisperClient || null;
  claudeBridge = deps.claudeBridge || null;
  ttsService = deps.ttsService || null;
  voiceStateStore = deps.voiceStateStore || null;
  agentJobBroker = deps.agentJobBroker || null;
  wsPort = deps.wsPort || 3001;
  outboundRuntimeFence = deps.runtimeFence || null;
  try {
    outboundRoutingConfig = verifyOutboundRoutingConfig(deps.routingConfig);
  } catch {
    outboundRoutingConfig = null;
    throw new Error('A validated server-side outbound SIP routing configuration is required');
  }
  if (!runtimeFenceHeld()) {
    outboundRuntimeFence = null;
    throw new Error('A held process-lifetime outbound runtime fence is required');
  }
  outboundPanicLocked = Boolean(agentJobBroker?.getExecutionLock?.().locked);
  refreshRecoveryBarrier();
  outboundAccepting = !outboundPanicLocked && !outboundRecoveryBlocked &&
    runtimeFenceHeld();

  var conversationReady = !!(audioForkServer && whisperClient && claudeBridge && ttsService);
  var realtimeReady = !!(audioForkServer && voiceStateStore && agentJobBroker && getRealtimeApiKey());

  logger.info('Outbound routes initialized', {
    srf: !!srf,
    mediaServer: !!mediaServer,
    deviceRegistry: !!deviceRegistry,
    conversationMode: conversationReady ? 'enabled' : 'disabled',
    realtimeMode: realtimeReady ? 'enabled' : 'disabled',
    recoveryBlocked: outboundRecoveryBlocked
  });
  if (typeof voiceStateStore?.listQueuedOutboundCalls === 'function') {
    outboundRecoveryImmediate = setImmediate(function() {
      outboundRecoveryImmediate = null;
      refreshRecoveryBarrier();
      if (!outboundAccepting || outboundRecoveryBlocked ||
          !runtimeFenceHeld() || voiceStateStore?.db?.open === false) return;
      for (const record of voiceStateStore.listQueuedOutboundCalls({ limit: 100 })) {
        scheduleOutboundCall(record);
      }
    });
    outboundRecoveryImmediate.unref?.();
  }
}

async function shutdownOutboundCalls({ timeoutMs = 5000 } = {}) {
  if (outboundRecoveryImmediate) clearImmediate(outboundRecoveryImmediate);
  outboundRecoveryImmediate = null;
  const result = await stopOutboundPlane({
    reason: 'Voice application shutdown',
    timeoutMs,
    lock: false,
  });
  return {
    ...result,
    drained: result.quiesced,
    safeToClose: result.quiesced,
  };
}

module.exports = {
  router: router,
  setupRoutes: setupRoutes,
  cancelOutboundCall: cancelOutboundCall,
  panicOutboundCalls: panicOutboundCalls,
  unlockOutboundCalls: unlockOutboundCalls,
  shutdownOutboundCalls: shutdownOutboundCalls,
  projectOutboundCall: projectOutboundCall,
  getOutboundPlaneStatus: getOutboundPlaneStatus,
  normalizeOutboundApiToken: normalizeOutboundApiToken,
  isLoopbackHost: isLoopbackHost
};
