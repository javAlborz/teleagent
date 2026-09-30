'use strict';

// This service has no activation unit in the live release. The host installer
// must supply its fixed root-owned listener, catalog and sandbox before start.
const fs = require('node:fs');
const path = require('node:path');
const { OwnerSessionCatalog } = require('./owner-session-catalog');
const { OwnerSessionDeliveryStore } = require('./owner-session-delivery');
const { OwnerSessionBroker } = require('./owner-session-broker');
const { createOwnerSessionServer } = require('./owner-session-http');
const { sessionError } = require('./owner-session-endpoint');
const { SOCKET_PATH } = require('./owner-session-proxy');
const {
  inheritedSocketFd, assertInheritedSocketBoundary, lookupSystemGroupGid,
  acquireWorkerSessionSingletonLock, assertCredentialFreeEnvironment,
} = require('./worker-session-broker-service');
const CATALOG_PATH = '/etc/teleagent/owner-session/catalog.json';
const STATE_ROOT = '/var/lib/teleagent-owner-session';

function assertDirectory(directory, uid, mode) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== mode ||
      fs.realpathSync(directory) !== directory) throw sessionError('OWNER_BROKER_BOUNDARY_UNSAFE');
}

async function startOwnerSessionBroker() {
  assertCredentialFreeEnvironment();
  const catalog = OwnerSessionCatalog.load(CATALOG_PATH);
  if (process.getuid() !== catalog.catalog.ownerUid) throw sessionError('OWNER_BROKER_UID_INVALID');
  assertDirectory(STATE_ROOT, process.getuid(), 0o700);
  assertDirectory(path.dirname(SOCKET_PATH), 0, 0o750);
  const fd = inheritedSocketFd();
  assertInheritedSocketBoundary(fd, SOCKET_PATH, 0, lookupSystemGroupGid(), { allowTestPath: true });
  const lock = acquireWorkerSessionSingletonLock(path.join(STATE_ROOT, 'lifetime.sqlite'), { allowTestPath: true });
  let store; let runtime;
  try {
    store = new OwnerSessionDeliveryStore({ dbPath: path.join(STATE_ROOT, 'deliveries.sqlite') });
    // Deliberately read-only until the independently attested controller
    // authority and host key epochs are included in a reviewed release.
    const broker = new OwnerSessionBroker({ catalog, store, authority: null });
    runtime = createOwnerSessionServer(broker);
    await new Promise((resolve, reject) => {
      runtime.server.once('error', reject);
      runtime.server.listen({ fd, exclusive: false }, resolve);
    });
    return { async shutdown() {
      await runtime.close();
      // Every client RPC is bounded; leave intents unknown if the host's stop
      // deadline kills this process. Never close SQLite under an active request.
      while (broker.busy) await new Promise((resolve) => setTimeout(resolve, 50));
      store.close(); lock.release();
    } };
  } catch (error) {
    if (runtime) await runtime.close();
    store?.close(); lock.release(); throw error;
  }
}

if (require.main === module) {
  startOwnerSessionBroker().then((runtime) => {
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void runtime.shutdown().then(() => process.exit(0), () => process.exit(1));
    });
  }).catch(() => {
    console.error('OWNER_BROKER_STARTUP_REFUSED'); process.exitCode = 1;
  });
}
module.exports = { startOwnerSessionBroker, CATALOG_PATH, STATE_ROOT };
