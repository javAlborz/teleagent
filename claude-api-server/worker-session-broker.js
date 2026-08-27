'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { targetSessionOperationMarker } = require('../lib/voice-authorization-plan');
const { canonicalizeTargetSessionMessage } = require('../lib/target-session-message');
const { requestHash } = require('./worker-session-operation-store');
const {
  panicProviderPlaneRoot,
  panicProviderSupervisors,
  unlockProviderPlaneRoot,
  unlockProviderSupervisors,
} = require('./provider-supervisor-client');

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_INSPECTIONS = new Set([
  'list_directory',
  'read_text_file',
  'find_files',
  'git_status',
  'list_tmux_sessions',
  'inspect_tmux_pane',
  'inspect_agent_activity',
  'describe_runtime',
]);

function codedError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function jsonResponse(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(codedError('WORKER_SESSION_BODY_TOO_LARGE', 'The request body is too large.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once('error', reject);
    req.once('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('body must be an object');
        }
        resolve(body);
      } catch {
        reject(codedError('WORKER_SESSION_JSON_INVALID', 'The request body is invalid JSON.'));
      }
    });
  });
}

function normalizeSessionRequest(input = {}) {
  const operationId = String(input.operationId || '').trim();
  const target = String(input.target || '').trim();
  let message;
  try { message = canonicalizeTargetSessionMessage(input.message); }
  catch { throw codedError('INVALID_TARGET_MESSAGE', 'A bounded visible plain-text target message is required.'); }
  const sessionFingerprint = String(input.sessionFingerprint || '').trim();
  const timeoutMs = Math.max(
    30000,
    Math.min(Number.parseInt(input.timeoutMs, 10) || 1800000, 3600000)
  );
  if (!/^job_[A-Za-z0-9]+$/.test(operationId) || operationId.length > 200) {
    throw codedError('OPERATION_ID_REQUIRED', 'A job-scoped operation ID is required.');
  }
  if (!target || target.length > 512 || /[\u0000-\u001F\u007F]/.test(target)) {
    throw codedError('EXACT_TMUX_TARGET_REQUIRED', 'An exact worker-owned tmux target is required.');
  }
  if (!/^[a-f0-9]{64}$/i.test(sessionFingerprint)) {
    throw codedError('TARGET_SESSION_CHANGED', 'An exact provider-session fingerprint is required.', 409);
  }
  return { operationId, target, message, sessionFingerprint, timeoutMs };
}

function operationError(operation) {
  if (!operation) {
    return codedError('WORKER_SESSION_OPERATION_NOT_FOUND', 'The operation was not found.', 404);
  }
  if (operation.state === 'completed') return null;
  if (operation.state === 'failed_pre_delivery') {
    return codedError(
      operation.errorCode || 'WORKER_SESSION_PRE_DELIVERY_FAILED',
      operation.errorMessage || 'Worker session delivery failed before submission.',
      409
    );
  }
  if (operation.state === 'outcome_unknown' || operation.state === 'delivery_started') {
    return codedError(
      'TARGET_DELIVERY_OUTCOME_UNKNOWN',
      'Worker-owned target delivery may have occurred and will not be resent.',
      409
    );
  }
  if (operation.state === 'commit_claimed') {
    return codedError(
      'WORKER_SESSION_OPERATION_IN_PROGRESS',
      'The exact worker session operation is already being committed.',
      409
    );
  }
  return null;
}

function assertOperationIdentity(operation, request) {
  const hash = requestHash(request);
  if (!operation || operation.requestHash !== hash || operation.target !== request.target ||
      operation.sessionFingerprint !== request.sessionFingerprint) {
    throw codedError(
      'WORKER_SESSION_IDEMPOTENCY_CONFLICT',
      'The operation ID is bound to another exact worker session request.',
      409
    );
  }
  return hash;
}

function statusForError(error) {
  if (Number.isInteger(error.status)) return error.status;
  if (error.code === 'WORKER_SESSION_OPERATION_NOT_FOUND') return 404;
  if (String(error.code || '').includes('PANIC_LOCKED')) return 423;
  if (/CONFLICT|CHANGED|OUTCOME_UNKNOWN|IN_PROGRESS/.test(String(error.code || ''))) return 409;
  if (/OUTSIDE_ROOTS|SENSITIVE_PATH|INSPECTION_DENIED/.test(String(error.code || ''))) return 403;
  return 400;
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function createWorkerSessionBroker({
  inspector,
  controller,
  store,
  workerHome,
  inspectionRoots,
  server: inheritedServer = null,
  paneManager = null,
  providerControl = null,
  panicDrainMs = 10_000,
} = {}) {
  if (!inspector?.execute || !inspector?.inspectWorkerSessionBoundary ||
      !controller?.prepare || !controller?.send || !store?.db) {
    throw new Error('Worker session broker requires an inspector, session controller, and store.');
  }
  const active = new Map();
  const activeRuns = new Set();
  const handlerRuns = new Set();
  let closing = false;
  let closePromise = null;
  let controlTransitions = 0;
  let controlLane = Promise.resolve();
  const configuredRoots = (inspectionRoots || []).map((root) => path.resolve(root));
  let realRootsPromise = null;
  store.recoverInterrupted();
  const providerPanic = providerControl?.panic || panicProviderSupervisors;
  const providerUnlock = providerControl?.unlock || unlockProviderSupervisors;
  const providerRootPanic = providerControl?.panicRoot || panicProviderPlaneRoot;
  const providerRootUnlock = providerControl?.unlockRoot || unlockProviderPlaneRoot;
  const providerControlRequired = providerControl !== null;
  const providerRootControlRequired = providerControlRequired &&
    typeof providerControl?.panicRoot === 'function' &&
    typeof providerControl?.unlockRoot === 'function';

  const realRoots = () => {
    if (!realRootsPromise) {
      realRootsPromise = Promise.all(configuredRoots.map(async (root) => {
        try {
          return await fs.realpath(root);
        } catch {
          return null;
        }
      })).then((roots) => roots.filter(Boolean));
    }
    return realRootsPromise;
  };

  const assertDedicatedTarget = async (target, prepared = null) => {
    const boundary = await inspector.inspectWorkerSessionBoundary(target);
    const roots = await realRoots();
    let cwd;
    try {
      cwd = await fs.realpath(boundary.cwd);
    } catch {
      throw codedError(
        'WORKER_SESSION_OUTSIDE_WORKSPACE',
        'The worker tmux pane is not attached to an approved workspace.',
        403
      );
    }
    if (roots.length === 0 || !roots.some((root) => within(root, cwd))) {
      throw codedError(
        'WORKER_SESSION_OUTSIDE_WORKSPACE',
        'Only dedicated worker-owned sessions inside approved workspaces are available.',
        403
      );
    }
    if (!['claude', 'codex'].includes(boundary.provider) || !boundary.agent_running) {
      throw codedError(
        'WORKER_SESSION_PROVIDER_REQUIRED',
        'The worker pane does not own one supported provider session.',
        404
      );
    }
    if (prepared && (boundary.stable_target !== prepared.stable_target ||
        boundary.provider !== prepared.provider)) {
      throw codedError(
        'TARGET_SESSION_CHANGED',
        'The dedicated worker session changed during resolution.',
        409
      );
    }
    return { ...boundary, cwd };
  };

  const prepareDedicated = async (target) => {
    const prepared = await controller.prepare({ target });
    await assertDedicatedTarget(prepared.stable_target || prepared.target, prepared);
    return prepared;
  };

  const assertOpen = () => {
    if (closing) {
      throw codedError(
        'WORKER_SESSION_BROKER_DRAINING',
        'The worker-session broker is draining and cannot accept work.',
        503
      );
    }
  };

  const assertMutationUnlocked = () => {
    const status = store.panicStatus?.();
    if (!status || status.locked === true || controlTransitions !== 0) {
      throw codedError(
        'WORKER_SESSION_PANIC_LOCKED',
        'Worker-session mutation is locked by panic.',
        423
      );
    }
  };

  const waitForActiveDrain = async () => {
    const deadline = Date.now() + panicDrainMs;
    while (activeRuns.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...activeRuns]),
        new Promise((resolve) => setTimeout(
          resolve,
          Math.max(1, Math.min(25, deadline - Date.now()))
        )),
      ]);
    }
    return activeRuns.size === 0 && active.size === 0;
  };

  const panicAllImpl = async ({ reason = 'worker_session_panic', source = 'controller' } = {}) => {
    let local;
    try { local = store.panic({ reason, source }); }
    catch {
      return {
        success: false, accepted: false, persisted: false, quiesced: false,
        code: 'WORKER_SESSION_PANIC_PERSISTENCE_FAILED',
      };
    }
    for (const controller of active.values()) controller.abort();
    let providers = null;
    try {
      providers = providerControlRequired
        ? await providerPanic({ reason, source, timeoutMs: panicDrainMs })
        : { accepted: true, persisted: true, quiesced: true, notConfigured: true };
    } catch {
      providers = { accepted: false, persisted: false, quiesced: false };
    }
    if (providerRootControlRequired && !(
      providers?.accepted === true && providers?.persisted === true &&
      providers?.quiesced === true
    )) {
      const cooperative = providers;
      try {
        const fallback = await providerRootPanic({ timeoutMs: Math.max(60_000, panicDrainMs) });
        providers = {
          ...fallback,
          rootFallback: true,
          cooperative,
        };
      } catch {
        providers = {
          accepted: false,
          persisted: cooperative?.persisted === true,
          quiesced: false,
          rootFallback: true,
          cooperative,
        };
      }
    }
    const localQuiesced = await waitForActiveDrain();
    const accepted = local.accepted === true && local.persisted === true &&
      providers?.accepted === true && providers?.persisted === true;
    const quiesced = accepted && localQuiesced && providers?.quiesced === true;
    return {
      success: quiesced,
      accepted,
      persisted: accepted,
      quiesced,
      alreadyLocked: local.alreadyLocked === true,
      activeOperationIds: store.panicStatus().activeOperationIds,
      activeOperationCount: store.panicStatus().activeOperationCount,
      providers,
    };
  };

  const unlockAllImpl = async () => {
    const current = store.panicStatus();
    if (active.size !== 0 || activeRuns.size !== 0 || current.activeOperationCount !== 0) {
      return {
        success: false, persisted: true, quiesced: false,
        code: 'WORKER_SESSION_NOT_QUIESCENT',
      };
    }
    let rootRecovery = {
      success: true, persisted: true, quiesced: true, notConfigured: true,
    };
    if (providerRootControlRequired) {
      try {
        rootRecovery = await providerRootUnlock({
          timeoutMs: Math.max(60_000, panicDrainMs),
        });
      } catch {
        rootRecovery = { success: false, persisted: true, quiesced: false };
      }
      if (rootRecovery?.success !== true || rootRecovery?.persisted !== true ||
          rootRecovery?.quiesced !== true) {
        store.panic({ reason: 'provider_root_unlock_unconfirmed', source: 'worker_session_broker' });
        return {
          success: false, persisted: true, quiesced: false,
          code: 'WORKER_PROVIDER_ROOT_UNLOCK_UNCONFIRMED', rootRecovery,
        };
      }
    }
    let providers;
    try {
      providers = providerControlRequired
        ? await providerUnlock({ timeoutMs: panicDrainMs })
        : { success: true, persisted: true, quiesced: true, notConfigured: true };
    } catch { providers = { success: false, persisted: false, quiesced: false }; }
    if (providers?.success !== true || providers?.quiesced !== true) {
      store.panic({ reason: 'provider_unlock_unconfirmed', source: 'worker_session_broker' });
      let rootRollback = null;
      if (providerRootControlRequired) {
        try {
          rootRollback = await providerRootPanic({
            timeoutMs: Math.max(60_000, panicDrainMs),
          });
        } catch {
          rootRollback = { accepted: false, persisted: false, quiesced: false };
        }
      }
      return {
        success: false, persisted: true, quiesced: false,
        code: 'WORKER_PROVIDER_UNLOCK_UNCONFIRMED', providers, rootRecovery, rootRollback,
      };
    }
    // Clear the broker-local durable fence last. Crashes at either awaited
    // provider transition therefore cannot reopen public admission.
    const local = store.unlockPanic();
    return { ...local, providers, rootRecovery };
  };

  const enqueueControl = (operation) => {
    controlTransitions += 1;
    const result = controlLane.then(operation, operation).finally(() => {
      controlTransitions -= 1;
    });
    controlLane = result.catch(() => {});
    return result;
  };
  const panicAll = (input) => enqueueControl(() => panicAllImpl(input));
  const unlockAll = () => enqueueControl(() => unlockAllImpl());

  const server = inheritedServer || http.createServer();
  const processRequest = async (req, res) => {
    try {
      assertOpen();
      const url = new URL(req.url, 'http://worker-session');
      if (req.method === 'POST' && url.pathname === '/v1/control/panic') {
        const body = await readJson(req);
        const result = await panicAll({
          reason: String(body.reason || 'worker_session_panic').slice(0, 160),
          source: String(body.source || 'controller').slice(0, 80),
        });
        return jsonResponse(res, result.quiesced ? 200 : 503, result);
      }
      if (req.method === 'POST' && url.pathname === '/v1/control/unlock') {
        const result = await unlockAll();
        return jsonResponse(res, result.success ? 200 : 409, result);
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        let providerSupervisors = {
          ready: false,
          providers: {
            claude: { ready: false, capacityAvailable: false, sessionCreationAvailable: true },
            codex: { ready: false, capacityAvailable: false, sessionCreationAvailable: false },
          },
        };
        if (paneManager?.health) {
          try { providerSupervisors = await paneManager.health(); }
          catch { /* a missing supervisor is a sanitized not-ready result */ }
        }
        const panic = store.panicStatus?.() || { locked: true };
        const ready = providerSupervisors.ready === true && panic.locked !== true &&
          controlTransitions === 0;
        return jsonResponse(res, ready ? 200 : 503, {
          success: ready,
          service: 'teleagent-worker-session-broker',
          ready,
          uid: typeof process.getuid === 'function' ? process.getuid() : null,
          home: workerHome,
          inspectionRoots,
          capabilities: {
            workspaceRead: true,
            gitRead: true,
            tmuxInspect: true,
            providerHistory: false,
            targetDelivery: true,
            // Route B deliberately disables provider-native resume and all
            // long-lived panes. A healthy boundary supports only fresh,
            // ephemeral managed launches.
            freshProviderLaunches: ready,
            providerContextPersistent: false,
            attestedSessionCreation: false,
            providerSupervisorsReady: ready,
            homelabStatus: false,
            privilegedExecution: false,
          },
          providerSupervisors: providerSupervisors.providers,
          panicLocked: panic.locked === true,
        });
      }

      if (req.method === 'POST' && url.pathname === '/v1/session/create') {
        assertMutationUnlocked();
        if (!paneManager?.create) {
          throw codedError(
            'WORKER_SESSION_CREATION_DISABLED',
            'Attested provider-session creation is not configured.',
            503
          );
        }
        const body = await readJson(req);
        assertOpen();
        const attestation = await paneManager.create(body);
        return jsonResponse(res, 201, { success: true, attestation });
      }

      if (req.method === 'POST' && url.pathname === '/v1/inspect') {
        const body = await readJson(req);
        const action = String(body.action || '').trim();
        if (!ALLOWED_INSPECTIONS.has(action)) {
          throw codedError(
            'WORKER_SESSION_INSPECTION_DENIED',
            'That inspection is outside the worker workspace/session boundary.',
            403
          );
        }
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args
          : {};
        if (['inspect_tmux_pane', 'inspect_agent_activity'].includes(action)) {
          await assertDedicatedTarget(args.target);
        }
        const result = await inspector.execute(action, args);
        return jsonResponse(res, 200, { success: true, action, result });
      }

      if (req.method === 'POST' && url.pathname === '/v1/session/prepare') {
        assertMutationUnlocked();
        const body = await readJson(req);
        const result = await prepareDedicated(body.target);
        return jsonResponse(res, 200, { success: true, result });
      }

      if (req.method === 'POST' && url.pathname === '/v1/session/send/preflight') {
        assertMutationUnlocked();
        const request = normalizeSessionRequest(await readJson(req));
        const prepared = await prepareDedicated(request.target);
        assertOpen();
        if (prepared.session_fingerprint !== request.sessionFingerprint) {
          throw codedError(
            'TARGET_SESSION_CHANGED',
            'The worker-owned pane no longer owns the approved provider session.',
            409
          );
        }
        const stableTarget = String(prepared.stable_target || prepared.target || '').trim();
        const provider = String(prepared.provider || '').trim();
        const operationMarker = targetSessionOperationMarker(request.operationId);
        const preparedOperation = store.prepare({
          operationId: request.operationId,
          requestHash: requestHash(request),
          target: request.target,
          stableTarget,
          sessionFingerprint: request.sessionFingerprint,
          provider,
          operationMarker,
        }).operation;
        const terminalError = operationError(preparedOperation);
        if (terminalError) throw terminalError;
        return jsonResponse(res, 200, {
          success: true,
          operation: preparedOperation,
          prepared: {
            ...prepared,
            stable_target: stableTarget,
            provider,
            operation_marker: operationMarker,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/v1/session/send/commit') {
        assertMutationUnlocked();
        const request = normalizeSessionRequest(await readJson(req));
        const existing = store.get(request.operationId);
        const hash = assertOperationIdentity(existing, request);
        if (existing.state === 'completed') {
          return jsonResponse(res, 200, {
            success: true,
            idempotent: true,
            result: existing.result,
          });
        }
        const terminalError = operationError(existing);
        if (terminalError) throw terminalError;
        const claim = store.claimCommit(request.operationId, hash);
        if (!claim.claimed) throw operationError(claim.operation) || codedError(
          'WORKER_SESSION_OPERATION_IN_PROGRESS',
          'The exact operation is already being committed.',
          409
        );

        try {
          await assertDedicatedTarget(existing.stableTarget, {
            stable_target: existing.stableTarget,
            provider: existing.provider,
          });
          assertOpen();
        } catch (error) {
          if (store.get(request.operationId)?.state === 'commit_claimed') {
            store.failPreDelivery(request.operationId, error);
          }
          throw error;
        }
        const abortController = new AbortController();
        active.set(request.operationId, abortController);
        const abortOnDisconnect = () => {
          if (!res.writableEnded) abortController.abort();
        };
        res.once('close', abortOnDisconnect);
        const run = (async () => {
          const result = await controller.send({
            target: existing.stableTarget,
            message: request.message,
            sessionFingerprint: request.sessionFingerprint,
            timeoutMs: request.timeoutMs,
            operationId: request.operationId,
            signal: abortController.signal,
            onBeforeSubmit: ({ stableTarget, provider, operationMarker }) => {
              if (stableTarget !== existing.stableTarget || provider !== existing.provider ||
                  operationMarker !== existing.operationMarker) {
                throw codedError(
                  'WORKER_SESSION_DELIVERY_IDENTITY_CHANGED',
                  'The worker delivery identity changed before submission.',
                  409
                );
              }
              store.markDeliveryStarted(request.operationId, hash);
            },
          });
          const completed = store.complete(request.operationId, result);
          return jsonResponse(res, 200, { success: true, result: completed.result });
        })();
        activeRuns.add(run);
        try {
          return await run;
        } catch (error) {
          const latest = store.get(request.operationId);
          if (latest?.state === 'commit_claimed') store.failPreDelivery(request.operationId, error);
          else if (latest?.state === 'delivery_started') store.outcomeUnknown(request.operationId, error);
          const terminal = store.get(request.operationId);
          throw operationError(terminal) || error;
        } finally {
          res.removeListener('close', abortOnDisconnect);
          active.delete(request.operationId);
          activeRuns.delete(run);
        }
      }

      if (req.method === 'POST' && url.pathname === '/v1/session/reconcile') {
        const request = normalizeSessionRequest(await readJson(req));
        const operation = store.get(request.operationId);
        assertOperationIdentity(operation, request);
        if (operation.state === 'completed') {
          return jsonResponse(res, 200, {
            success: true,
            outcome: { status: 'completed', result: operation.result },
          });
        }
        if (operation.state === 'prepared') {
          return jsonResponse(res, 200, {
            success: true,
            outcome: {
              status: 'not_delivered',
              safe_to_retry: true,
              reason: 'worker_delivery_boundary_not_crossed',
            },
          });
        }
        if (operation.state === 'commit_claimed') {
          return jsonResponse(res, 200, {
            success: true,
            outcome: {
              status: 'pre_delivery_in_progress',
              safe_to_retry: false,
              reason: 'worker_commit_in_progress',
            },
          });
        }
        if (operation.state === 'failed_pre_delivery') {
          return jsonResponse(res, 409, {
            success: false,
            code: operation.errorCode || 'WORKER_SESSION_PRE_DELIVERY_FAILED',
            error: operation.errorMessage || 'Worker delivery failed before submission.',
          });
        }
        await assertDedicatedTarget(operation.stableTarget, {
          stable_target: operation.stableTarget,
          provider: operation.provider,
        });
        const outcome = await controller.reconcileOperation({
          target: operation.stableTarget,
          message: request.message,
          operationId: request.operationId,
          sessionFingerprint: request.sessionFingerprint,
        });
        if (outcome?.status === 'completed' && outcome.result &&
            ['delivery_started', 'outcome_unknown'].includes(operation.state)) {
          store.completeReconciled(request.operationId, outcome.result, {
            operationMarker: operation.operationMarker,
            sessionFingerprint: request.sessionFingerprint,
          });
        }
        if (outcome?.status === 'unknown' &&
            outcome.reason === 'operation_marker_not_observed' &&
            ['delivery_started', 'outcome_unknown'].includes(operation.state)) {
          return jsonResponse(res, 200, {
            success: true,
            outcome: {
              status: 'in_progress',
              delivered: false,
              reason: 'delivery_boundary_crossed_marker_not_yet_observed',
            },
          });
        }
        return jsonResponse(res, 200, { success: true, outcome });
      }

      if (req.method === 'POST' && url.pathname === '/v1/session/interrupt') {
        const body = await readJson(req);
        const operationId = String(body.operationId || '').trim();
        if (operationId) active.get(operationId)?.abort();
        const interrupted = await controller.interrupt(body.target);
        return jsonResponse(res, 200, { success: true, interrupted: Boolean(interrupted) });
      }

      const operationPath = url.pathname.match(/^\/v1\/session\/operations\/([^/]+)$/);
      if (req.method === 'GET' && operationPath) {
        const operation = store.get(decodeURIComponent(operationPath[1]));
        if (!operation) throw codedError(
          'WORKER_SESSION_OPERATION_NOT_FOUND', 'The operation was not found.', 404
        );
        return jsonResponse(res, 200, { success: true, operation });
      }

      return jsonResponse(res, 404, { success: false, code: 'NOT_FOUND' });
    } catch (error) {
      return jsonResponse(res, statusForError(error), {
        success: false,
        code: error.code || 'WORKER_SESSION_BROKER_ERROR',
        error: error.message,
      });
    }
  };
  const handleRequest = (req, res) => {
    if (closing) {
      jsonResponse(res, 503, {
        success: false,
        code: 'WORKER_SESSION_BROKER_DRAINING',
        error: 'The worker-session broker is draining and cannot accept work.',
      });
      return;
    }
    const run = processRequest(req, res);
    handlerRuns.add(run);
    void run.finally(() => handlerRuns.delete(run));
  };
  server.on('request', handleRequest);

  return Object.freeze({
    server,
    active,
    panic: panicAll,
    unlock: unlockAll,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const stopAccepting = server.listening
          ? new Promise((resolve) => server.close(resolve))
          : Promise.resolve();
        const panic = await panicAll({
          reason: 'worker_session_broker_shutdown',
          source: 'worker_session_broker',
        });
        while (handlerRuns.size > 0 || activeRuns.size > 0) {
          await Promise.allSettled([...handlerRuns, ...activeRuns]);
        }
        server.closeIdleConnections?.();
        await stopAccepting;
        server.removeListener('request', handleRequest);
        if (providerControlRequired && panic.quiesced !== true) {
          throw codedError(
            'WORKER_PROVIDER_NOT_QUIESCENT',
            'Worker broker shutdown could not verify provider cgroup quiescence.',
            503
          );
        }
      })();
      return closePromise;
    },
  });
}

module.exports = {
  ALLOWED_INSPECTIONS,
  createWorkerSessionBroker,
  normalizeSessionRequest,
  readJson,
};
