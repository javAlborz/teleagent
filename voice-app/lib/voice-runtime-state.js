'use strict';

const { OutboundRuntimeFence } = require('./outbound-runtime-fence');
const { VoiceStateStore } = require('./voice-state-store');

/**
 * Open the process-owned voice state plane.
 *
 * The separate SQLite fence is intentionally acquired before the primary DB
 * is opened. That ordering prevents a losing duplicate process from running a
 * migration or declaring the live owner's SIP/agent work interrupted.
 */
function openVoiceRuntimeState({
  dbPath,
  runtimeFence: providedRuntimeFence = null,
  FenceClass = OutboundRuntimeFence,
  StoreClass = VoiceStateStore,
} = {}) {
  const runtimeFence = providedRuntimeFence || new FenceClass({ stateDbPath: dbPath });
  runtimeFence.assertHeld();
  let stateStore = null;
  try {
    stateStore = new StoreClass({ dbPath });
    const recovery = {
      outboundCalls: stateStore.recoverInterruptedOutboundCalls(),
      realtimeSessions: stateStore.recoverInterruptedRealtimeSessions(),
      agentJobs: stateStore.recoverInterruptedJobs(),
    };
    return { runtimeFence, stateStore, recovery };
  } catch (error) {
    try {
      stateStore?.close();
    } finally {
      runtimeFence.release();
    }
    throw error;
  }
}

function releaseVoiceRuntimeFenceAfterShutdown({
  runtimeFence,
  stateStore,
  brokerDrain,
  outboundDrain,
  inboundDrain,
  transportsClosed = false,
} = {}) {
  const safeToReplace = Boolean(
    brokerDrain?.safeToClose === true &&
    outboundDrain?.safeToClose === true &&
    inboundDrain?.safeToClose === true &&
    transportsClosed === true &&
    stateStore?.db?.open === false
  );
  if (!safeToReplace) return { released: false, safeToReplace: false };
  runtimeFence?.assertHeld?.();
  const release = runtimeFence?.release?.() || { changed: false };
  return { released: release.changed === true, safeToReplace: true };
}

module.exports = {
  openVoiceRuntimeState,
  releaseVoiceRuntimeFenceAfterShutdown,
};
