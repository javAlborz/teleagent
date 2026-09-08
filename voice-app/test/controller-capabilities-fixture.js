'use strict';

const READY_CAPABILITIES = Object.freeze({
  controllerAvailable: true,
  workerInspectionAvailable: true,
  managedExecutionAvailable: true,
  reasonCode: null,
});

function operatorHealth() {
  return {
    service: 'claude-api-server', ready: true, status: 'ok',
    phoneAuthority: { mode: 'read_only', status: 'disabled_pending_independent_pbx_attester' },
    approvalCapabilities: { verifierConfigured: false },
    privilegedActions: { enabled: false, proxyConfigured: false, authConfigured: false },
    authentication: { allActiveScopesConfiguredAndDistinct: true },
    agentWorker: { enabled: true, hardened: true, legacySameUidEnabled: false },
    workerSessionBroker: { enabled: true, ready: true },
    stateStorage: { enforced: true, admitted: true },
    voiceExecution: { locked: false },
    executor: { panic: { locked: false } },
  };
}

function executorHealth() {
  return { service: 'claude-api-server', scope: 'executor', ready: true, status: 'ready' };
}

module.exports = { READY_CAPABILITIES, operatorHealth, executorHealth };
