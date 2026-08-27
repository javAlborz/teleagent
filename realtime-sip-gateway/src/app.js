import { CallGateway } from './call-gateway.js';
import { CallRegistry } from './call-registry.js';
import { GatewayStateStore } from './gateway-state-store.js';
import { acquireGatewaySingleton } from './gateway-singleton.js';
import { createHttpServer } from './http-server.js';
import { createLogger } from './logger.js';
import { OpenAICallService } from './openai-call-service.js';
import {
  createSipStateStorageGuard,
  SIP_STATE_DATABASE,
} from './state-storage-boundary.js';
import { OpenAIWebhookHandler } from './webhook-handler.js';

// A failed initialization/close must not let V8 garbage collection release the
// SQLite lifetime lock while provider or call resources may still exist. A
// successful retry removes the ownership record; failed initialization keeps it
// until process death.
const retainedOwnership = new Set();

function requireGatewayQuiescence(result) {
  if (result?.quiesced !== true) {
    const error = new Error('Realtime SIP gateway did not prove call and sideband quiescence');
    error.code = 'SIP_GATEWAY_NOT_QUIESCED';
    throw error;
  }
  return result;
}

async function closeHttpServer(server) {
  if (!server.listening) return { quiesced: true };
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (server.listening) {
    throw new Error('Realtime SIP HTTP listener did not quiesce');
  }
  return { quiesced: true };
}

export async function createApp({
  config,
  logger = createLogger(),
  callService,
  stateStore,
  callGateway,
  storageGuard = null,
  createStorageGuard = createSipStateStorageGuard,
} = {}) {
  if (!config) throw new TypeError('Realtime SIP gateway configuration is required');
  const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const expectedGid = typeof process.getegid === 'function' ? process.getegid() : null;
  const durableStorage = storageGuard ?? createStorageGuard({
    databasePath: config.stateDatabasePath,
    expectedUid,
    expectedGid,
  });
  // This must precede both the lifetime-lock SQLite open and the state-store
  // open. A low-space restart must not create either file or begin recovery.
  durableStorage.assertOpen();
  const singleton = acquireGatewaySingleton({
    stateDatabasePath: config.stateDatabasePath,
    expectedUid,
    expectedGid,
    requireExisting: config.stateDatabasePath === SIP_STATE_DATABASE,
    storageGuard: durableStorage,
  });
  let resolvedCallService;
  let resolvedStateStore;
  let gateway;
  let server;
  const ownership = {
    singleton,
    gateway: null,
    stateStore: null,
    server: null,
  };

  try {
    resolvedCallService = callService ?? new OpenAICallService({ config });
    resolvedStateStore = stateStore ?? new GatewayStateStore({
      filePath: config.stateDatabasePath,
      expectedUid,
      expectedGid,
      strictOwnership: true,
      storageGuard: durableStorage,
    });
    ownership.stateStore = resolvedStateStore;
    await resolvedStateStore.init();
    const registry = callGateway?.registry ?? new CallRegistry({ stateStore: resolvedStateStore });
    gateway = callGateway ?? new CallGateway({
      config,
      callService: resolvedCallService,
      logger,
      registry,
    });
    ownership.gateway = gateway;
    await gateway.recover();
    const webhookHandler = new OpenAIWebhookHandler({
      callService: resolvedCallService,
      callGateway: gateway,
      stateStore: resolvedStateStore,
      logger,
    });
    server = createHttpServer({
      config,
      webhookHandler,
      callGateway: gateway,
      stateStore: resolvedStateStore,
      logger,
    });
    ownership.server = server;
  } catch (error) {
    let gatewayQuiesced = !gateway;
    let stateQuiesced = !resolvedStateStore;
    try {
      if (gateway) {
        requireGatewayQuiescence(await gateway.close());
        gatewayQuiesced = true;
      }
      if (gatewayQuiesced && resolvedStateStore) {
        await resolvedStateStore.close();
        stateQuiesced = true;
      }
    } catch (cleanupError) {
      error.initializationCleanupCode = cleanupError.code ?? 'SIP_GATEWAY_INIT_CLEANUP_FAILED';
    }
    if (gatewayQuiesced && stateQuiesced) {
      try {
        singleton.release();
      } catch (releaseError) {
        error.initializationCleanupCode = releaseError.code ?? 'SIP_GATEWAY_LOCK_RELEASE_FAILED';
        retainedOwnership.add(ownership);
      }
    } else {
      retainedOwnership.add(ownership);
    }
    throw error;
  }

  let closed = false;
  let closeStarted = false;
  let closePromise = null;
  let serverQuiesced = false;
  let gatewayQuiesced = false;
  let stateQuiesced = false;
  const closedResult = Object.freeze({
    closed: true,
    quiesced: true,
    serverQuiesced: true,
    gatewayQuiesced: true,
    stateQuiesced: true,
  });

  return {
    config,
    server,
    callGateway: gateway,
    stateStore: resolvedStateStore,
    async listen() {
      if (closeStarted || closed) {
        throw new Error('Realtime SIP gateway cannot listen after close has started');
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      logger.info('Realtime SIP canary gateway listening', {
        host: config.host,
        port: config.port,
        mode: config.mode,
      });
    },
    async close() {
      if (closed) return closedResult;
      if (closePromise) return closePromise;
      closeStarted = true;
      closePromise = (async () => {
        if (!serverQuiesced) {
          await closeHttpServer(server);
          serverQuiesced = true;
        }
        if (!gatewayQuiesced) {
          requireGatewayQuiescence(await gateway.close());
          gatewayQuiesced = true;
        }
        if (!stateQuiesced) {
          await resolvedStateStore.close();
          stateQuiesced = true;
        }
        singleton.release();
        retainedOwnership.delete(ownership);
        closed = true;
        return closedResult;
      })();
      try {
        return await closePromise;
      } catch (error) {
        // Keep a strong reference to the singleton and partially closed runtime.
        // A later close() call may retry; otherwise only process death releases
        // the kernel-backed lock.
        retainedOwnership.add(ownership);
        throw error;
      } finally {
        closePromise = null;
      }
    },
  };
}
