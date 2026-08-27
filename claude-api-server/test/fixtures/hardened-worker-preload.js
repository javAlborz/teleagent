'use strict';

// Subprocess-only dependency injection for server integration tests. Production
// code has no environment bypass for its root-owned launcher or Unix-socket
// broker checks; this preload replaces module exports before server.js imports
// them so integration fixtures can exercise the hardened-only route decisions
// without installing host identities or files.
if (process.env.NODE_ENV !== 'test' || process.env.TELEAGENT_TEST_HARDENED_WORKER !== '1') {
  throw new Error('The hardened worker test preload is test-only.');
}

const path = require('node:path');
const launcher = require('../../agent-worker-launcher');
const workerProxy = require('../../worker-session-proxy');
const { OperatorInspector, parseRoots } = require('../../operator-inspector');
const { TmuxAgentController } = require('../../tmux-agent-controller');

launcher.normalizeWorkerConfig = (environment = process.env) => Object.freeze({
  enabled: true,
  hardened: true,
  legacySameUidEnabled: false,
  readinessCode: null,
  providerUsers: Object.freeze({
    claude: 'teleagent-claude-worker',
    codex: 'teleagent-codex-worker',
  }),
  providerHomes: Object.freeze({
    claude: '/nonexistent/teleagent-claude-worker',
    codex: '/nonexistent/teleagent-codex-worker',
  }),
  workspaceRoot: path.resolve(environment.HOME || '/tmp'),
  defaultWorkspace: path.resolve(environment.HOME || '/tmp'),
  providerCommands: Object.freeze({
    claude: environment.CLAUDE_COMMAND || '/usr/bin/false',
    codex: environment.CODEX_COMMAND || '/usr/bin/false',
  }),
});

launcher.wrapAgentInvocation = (invocation) => {
  const environment = { ...(invocation.env || {}) };
  // Do not preload this fixture into the fake provider child and preserve the
  // production promise that loader variables never cross the worker boundary.
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  for (const name of Object.keys(environment)) {
    if (name.startsWith('LD_')) delete environment[name];
  }
  return {
    ...invocation,
    env: environment,
    isolatedWorker: true,
    workerUser: invocation.provider === 'claude'
      ? 'teleagent-claude-worker'
      : 'teleagent-codex-worker',
  };
};

workerProxy.createWorkerSessionProxy = () => {
  const home = process.env.HOME || '/tmp';
  let panicLocked = false;
  const inspector = new OperatorInspector({
    allowedRoots: parseRoots(process.env.VOICE_INSPECTION_ROOTS, home),
    home,
  });
  const controller = new TmuxAgentController({ inspector });
  return Object.freeze({
    inspector,
    controller,
    async panic() {
      const alreadyLocked = panicLocked;
      panicLocked = true;
      return {
        status: 200,
        payload: {
          success: true,
          accepted: true,
          persisted: true,
          quiesced: true,
          alreadyLocked,
          activeOperationCount: 0,
          activeOperationIds: [],
          providers: {
            success: true, accepted: true, persisted: true, quiesced: true,
          },
        },
      };
    },
    async unlock() {
      panicLocked = false;
      return { success: true, persisted: true, quiesced: true };
    },
    async health() {
      return {
        success: !panicLocked,
        ready: !panicLocked,
        panicLocked,
        service: 'teleagent-worker-session-broker',
        uid: 4242,
        capabilities: {
          workspaceRead: true,
          tmuxInspect: true,
          targetDelivery: true,
          freshProviderLaunches: !panicLocked,
          providerContextPersistent: false,
          attestedSessionCreation: false,
          providerSupervisorsReady: !panicLocked,
          privilegedExecution: false,
        },
      };
    },
  });
};
