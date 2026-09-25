'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkerSessionOperationStore } = require('../worker-session-operation-store');
const {
  WorkerSessionPaneManager,
  paneStartCommand,
} = require('../worker-session-pane-manager');
const { AttestedWorkerSessionInspector } = require('../worker-session-attested-inspector');
const { TmuxAgentController } = require('../tmux-agent-controller');

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function plan(workspace, overrides = {}) {
  return {
    creationId: 'session_0123456789abcdef01234567',
    provider: 'codex',
    providerSessionId: SESSION_ID,
    workspace,
    ...overrides,
  };
}

test('all persistent provider pane creation is disabled before store, supervisor, or tmux access', async (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const workspace = '/srv/teleagent-agent-workspaces/phone';
  let boundaryCalls = 0;
  const manager = new WorkerSessionPaneManager({
    store,
    socketBoundary: () => true,
    probeSupervisors: async () => { boundaryCalls += 1; return { ready: true }; },
    execFileImpl: async () => { boundaryCalls += 1; return { stdout: '' }; },
  });
  await assert.rejects(manager.create(plan(workspace)), {
    code: 'WORKER_SESSION_INTERACTIVE_UNAVAILABLE', status: 503,
  });
  await assert.rejects(manager.create(plan(workspace, { provider: 'claude' })), {
    code: 'WORKER_SESSION_INTERACTIVE_UNAVAILABLE', status: 503,
  });
  assert.equal(store.listPaneAttestations({ state: 'planned' }).length, 0);
  assert.equal(boundaryCalls, 0);
});

test('recovery retires every legacy attestation and kills every provider pane', async (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const workspace = '/srv/teleagent-agent-workspaces/phone';
  const requested = {
    ...plan(workspace, { provider: 'claude' }),
    sessionName: 'teleagent-claude-0123456789abcdef01234567',
    providerUser: 'teleagent-claude-worker',
    launcherPath: '/usr/local/libexec/teleagent-session-pane-entry',
  };
  store.planPaneAttestation(requested);
  store.activatePaneAttestation(requested.creationId, '%42');
  const calls = [];
  const manager = new WorkerSessionPaneManager({
    store,
    socketBoundary: () => true,
    execFileImpl: async (_command, args) => {
      calls.push(args);
      if (args.includes('list-panes')) return { stdout: '' };
      if (args.includes('kill-pane')) return { stdout: '' };
      throw new Error(`unexpected tmux call: ${args.join(' ')}`);
    },
  });
  manager.listPanes = async () => [{
    paneId: '%42', sessionName: requested.sessionName, cwd: workspace,
    startCommand: paneStartCommand(requested),
  }];
  const result = await manager.recover();
  assert.deepEqual(result, { adopted: 0, retired: 1, removedUnknown: 1 });
  assert.equal(store.listPaneAttestations({ state: 'active' }).length, 0);
  assert.equal(store.getPaneAttestationByCreationId(requested.creationId).state, 'retired');
  assert.ok(calls.some((args) => args.includes('kill-pane') && args.includes('%42')));
});

test('an empty dedicated tmux server has no panes to recover', async (t) => {
  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const manager = new WorkerSessionPaneManager({
    store,
    socketBoundary: () => true,
    execFileImpl: async () => {
      const error = new Error('Command failed: tmux list-panes: no current target');
      error.stderr = 'no current target';
      throw error;
    },
  });
  assert.deepEqual(await manager.recover(), {
    adopted: 0, retired: 0, removedUnknown: 0,
  });
});

test('attested two-identity prepare and send need no cross-UID process visibility', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attested-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const providerView = path.join(directory, 'provider-view');
  const workspace = path.join(directory, 'workspace');
  const logDirectory = path.join(providerView, '.codex', 'sessions', '2026', '08', '25');
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.mkdirSync(workspace);
  const log = path.join(logDirectory, `rollout-test-${SESSION_ID}.jsonl`);
  fs.writeFileSync(log, '');
  fs.chmodSync(log, 0o640);

  const store = new WorkerSessionOperationStore();
  t.after(() => store.close());
  const attestationPlan = {
    ...plan(workspace),
    sessionName: 'teleagent-codex-0123456789abcdef01234567',
    providerUser: 'teleagent-codex-worker',
    launcherPath: '/usr/local/libexec/teleagent-session-pane-entry',
  };
  store.planPaneAttestation(attestationPlan);
  store.activatePaneAttestation(attestationPlan.creationId, '%42');
  const paneLine = [
    '%42', attestationPlan.sessionName, '0', '0', workspace,
    paneStartCommand(attestationPlan, directory), '1', 'codex',
  ].join('\t');
  let pasted = '';
  const execFileImpl = async (command, args) => {
    assert.notEqual(command, 'ps', 'attested inspection must never inspect unrelated processes');
    if (args.includes('display-message')) return { stdout: paneLine };
    if (args.includes('paste-buffer') || args.includes('delete-buffer')) return { stdout: '' };
    if (args.includes('send-keys') && args.includes('Enter')) {
      fs.appendFileSync(log, `${JSON.stringify({
        type: 'response_item',
        timestamp: new Date().toISOString(),
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: pasted }] },
      })}\n${JSON.stringify({
        type: 'response_item',
        timestamp: new Date().toISOString(),
        payload: {
          type: 'message', role: 'assistant', phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Attested worker response.' }],
        },
      })}\n`);
      return { stdout: '' };
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  const inspector = new AttestedWorkerSessionInspector({
    store,
    providerView,
    allowedRoots: [workspace],
    tmuxSocketPath: '/run/teleagent-worker-session/tmux.sock',
    workspaceRoot: directory,
    execFileImpl,
  });
  const controller = new TmuxAgentController({
    inspector,
    tmuxSocketPath: '/run/teleagent-worker-session/tmux.sock',
    execFileImpl,
    inputCommandImpl: async (_command, _args, input) => {
      pasted = input;
      return { stdout: '' };
    },
    pollIntervalMs: 25,
  });
  const prepared = await controller.prepare({ target: '%42' });
  assert.equal(prepared.provider, 'codex');
  assert.equal(prepared.resolution, 'durable_broker_attestation');
  const result = await controller.send({
    target: '%42',
    message: 'Continue the reviewed task.',
    sessionFingerprint: prepared.session_fingerprint,
    operationId: 'job_attestedsend',
    timeoutMs: 30000,
  });
  assert.equal(result.delivered, true);
  assert.equal(result.response, 'Attested worker response.');
  assert.match(pasted, /teleagent-operation/);
  await assert.rejects(inspector.listAgentProcesses(), {
    code: 'WORKER_SESSION_PROCESS_INSPECTION_DENIED',
  });
});
