'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { probeProviderSupervisors } = require('./provider-supervisor-client');

const execFileAsync = promisify(execFile);
const FIXED_TMUX_SOCKET = '/run/teleagent-worker-session/tmux.sock';
const FIXED_PANE_STATUS_DIRECTORY = '/run/teleagent-worker-session/pane-status';
const FIXED_PANE_ENTRY = '/usr/local/libexec/teleagent-session-pane-entry';
const FIXED_WORKSPACE_ROOT = '/srv/teleagent-agent-workspaces';
const PROVIDER_USERS = Object.freeze({
  claude: 'teleagent-claude-worker',
  codex: 'teleagent-codex-worker',
});
const PANE_FORMAT = [
  '#{pane_id}', '#{session_name}', '#{window_index}', '#{pane_index}',
  '#{pane_current_path}', '#{pane_start_command}', '#{pane_active}', '#{window_name}',
].join('\t');

function codedError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizePanePlan(input = {}, workspaceRoot = FIXED_WORKSPACE_ROOT) {
  const creationId = String(input.creationId || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  const providerSessionId = String(input.providerSessionId || '').trim().toLowerCase();
  const workspace = path.resolve(String(input.workspace || ''));
  if (!/^session_[A-Za-z0-9]{16,128}$/.test(creationId)) {
    throw codedError('WORKER_SESSION_CREATION_ID_INVALID', 'A high-entropy session creation ID is required.');
  }
  if (!PROVIDER_USERS[provider]) {
    throw codedError('WORKER_SESSION_PROVIDER_INVALID', 'Provider must be claude or codex.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(providerSessionId)) {
    throw codedError('WORKER_SESSION_PROVIDER_SESSION_INVALID', 'An exact provider session UUID is required.');
  }
  if (!within(workspaceRoot, workspace) || !/^[A-Za-z0-9_./-]+$/.test(workspace)) {
    throw codedError(
      'WORKER_SESSION_WORKSPACE_INVALID',
      'The session workspace must be one simple canonical child of the shared workspace root.'
    );
  }
  const suffix = creationId.slice('session_'.length, 'session_'.length + 24).toLowerCase();
  return Object.freeze({
    creationId,
    sessionName: `teleagent-${provider}-${suffix}`,
    provider,
    providerUser: PROVIDER_USERS[provider],
    providerSessionId,
    workspace,
    launcherPath: FIXED_PANE_ENTRY,
  });
}

function paneStartCommand(plan, workspaceRoot = FIXED_WORKSPACE_ROOT) {
  const normalized = normalizePanePlan(plan, workspaceRoot);
  return [
    FIXED_PANE_ENTRY,
    '--creation-id', normalized.creationId,
    '--provider', normalized.provider,
    '--workspace', normalized.workspace,
    '--session-id', normalized.providerSessionId,
  ].join(' ');
}

function parsePaneLine(line) {
  const [paneId, sessionName, window, pane, cwd, startCommand, active, windowName] =
    String(line || '').split('\t');
  if (!/^%[1-9][0-9]*$/.test(paneId || '')) return null;
  return {
    paneId,
    sessionName,
    window: Number.parseInt(window, 10),
    pane: Number.parseInt(pane, 10),
    cwd,
    startCommand,
    active: active === '1',
    windowName: windowName || null,
    target: `${sessionName}:${window}.${pane}`,
  };
}

function assertTmuxSocketBoundary(socketPath, uid, { allowAbsent = false } = {}) {
  let metadata;
  try { metadata = fs.lstatSync(socketPath); }
  catch (error) {
    if (allowAbsent && error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.uid !== uid ||
      (metadata.mode & 0o777) !== 0o600) {
    throw codedError(
      'WORKER_SESSION_TMUX_BOUNDARY_UNSAFE',
      'The dedicated tmux socket must be broker-owned mode 0600.'
    );
  }
  return true;
}

function assertPaneStatusDirectory(directory, uid) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid ||
      (metadata.mode & 0o777) !== 0o700) {
    throw codedError(
      'WORKER_SESSION_STATUS_BOUNDARY_UNSAFE',
      'The provider acceptance status directory must be broker-owned mode 0700.',
      503
    );
  }
}

function paneStatusPath(plan) {
  const creationId = String(plan?.creationId || '');
  if (!/^session_[A-Za-z0-9]{16,128}$/.test(creationId)) {
    throw codedError('WORKER_SESSION_CREATION_ID_INVALID', 'The session creation ID is invalid.');
  }
  return path.join(FIXED_PANE_STATUS_DIRECTORY, `${creationId}.json`);
}

function validateStatusFile(filename, uid) {
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid ||
      (metadata.mode & 0o777) !== 0o600 || metadata.size > 1024) {
    throw codedError(
      'WORKER_SESSION_STATUS_BOUNDARY_UNSAFE',
      'The provider acceptance status file is unsafe.',
      503
    );
  }
  return metadata;
}

function createPaneStatusControl({ uid = process.getuid(), pollMs = 25, timeoutMs = 10_000 } = {}) {
  const read = (plan) => {
    assertPaneStatusDirectory(FIXED_PANE_STATUS_DIRECTORY, uid);
    const filename = paneStatusPath(plan);
    try { validateStatusFile(filename, uid); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const serialized = fs.readFileSync(filename, 'utf8');
    if (!serialized) return null;
    const newline = serialized.indexOf('\n');
    if (newline <= 0 || newline !== serialized.length - 1) {
      throw codedError(
        'WORKER_SESSION_PROVIDER_STATUS_INVALID',
        'The provider acceptance status was malformed.',
        503
      );
    }
    let status;
    try { status = JSON.parse(serialized.slice(0, newline)); }
    catch {
      throw codedError(
        'WORKER_SESSION_PROVIDER_STATUS_INVALID',
        'The provider acceptance status was malformed.',
        503
      );
    }
    if (status?.version !== 1 || typeof status.accepted !== 'boolean') {
      throw codedError(
        'WORKER_SESSION_PROVIDER_STATUS_INVALID',
        'The provider acceptance status was malformed.',
        503
      );
    }
    if (status.accepted === true && !/^launch_[a-f0-9]{32}$/.test(status.launchId || '')) {
      throw codedError(
        'WORKER_SESSION_PROVIDER_STATUS_INVALID',
        'The provider acceptance identity was malformed.',
        503
      );
    }
    if (status.accepted === false && typeof status.code !== 'string') {
      throw codedError(
        'WORKER_SESSION_PROVIDER_STATUS_INVALID',
        'The provider rejection status was malformed.',
        503
      );
    }
    return status;
  };
  return Object.freeze({
    clear(plan) {
      assertPaneStatusDirectory(FIXED_PANE_STATUS_DIRECTORY, uid);
      const filename = paneStatusPath(plan);
      try { validateStatusFile(filename, uid); }
      catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
      fs.unlinkSync(filename);
      return true;
    },
    async waitForAccepted(plan) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const status = read(plan);
        if (status?.accepted === true) return status;
        if (status?.accepted === false) {
          const code = status.code === 'PROVIDER_SUPERVISOR_BUSY'
            ? 'PROVIDER_SUPERVISOR_BUSY'
            : 'WORKER_SESSION_PROVIDER_LAUNCH_DENIED';
          throw codedError(
            code,
            'The provider supervisor refused the interactive launch before acceptance.',
            503
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      throw codedError(
        'WORKER_SESSION_PROVIDER_ACCEPTANCE_TIMEOUT',
        'The provider supervisor did not confirm the interactive launch.',
        503
      );
    },
  });
}

class WorkerSessionPaneManager {
  constructor({
    store,
    tmuxSocketPath = FIXED_TMUX_SOCKET,
    workspaceRoot = FIXED_WORKSPACE_ROOT,
    execFileImpl = execFileAsync,
    probeSupervisors = probeProviderSupervisors,
    statusControl = null,
    uid = process.getuid(),
    socketBoundary = null,
  } = {}) {
    if (!store?.planPaneAttestation || !store?.activatePaneAttestation) {
      throw new Error('WorkerSessionPaneManager requires the durable broker store.');
    }
    if (path.resolve(tmuxSocketPath) !== FIXED_TMUX_SOCKET) {
      throw new Error(`Worker session tmux socket must be ${FIXED_TMUX_SOCKET}.`);
    }
    this.store = store;
    this.tmuxSocketPath = tmuxSocketPath;
    this.workspaceRoot = workspaceRoot;
    this.execFile = execFileImpl;
    this.probeSupervisors = probeSupervisors;
    this.statusControl = statusControl || createPaneStatusControl({ uid });
    this.uid = uid;
    this.socketBoundary = socketBoundary;
  }

  _args(args) {
    return ['-S', this.tmuxSocketPath, ...args];
  }

  _assertSocketBoundary({ allowAbsent = false } = {}) {
    if (typeof this.socketBoundary === 'function') {
      return this.socketBoundary({ allowAbsent, socketPath: this.tmuxSocketPath, uid: this.uid });
    }
    return assertTmuxSocketBoundary(this.tmuxSocketPath, this.uid, { allowAbsent });
  }

  async listPanes() {
    this._assertSocketBoundary({ allowAbsent: true });
    try {
      const { stdout } = await this.execFile(
        '/usr/bin/tmux',
        this._args(['list-panes', '-a', '-F', PANE_FORMAT]),
        { timeout: 5000, maxBuffer: 64 * 1024 }
      );
      return String(stdout || '').split('\n').map(parsePaneLine).filter(Boolean);
    } catch (error) {
      if (/no server running|failed to connect|not found/i.test(`${error.message}\n${error.stderr || ''}`)) {
        return [];
      }
      throw error;
    }
  }

  async health() {
    const result = await this.probeSupervisors({ timeoutMs: 2000 });
    return {
      ready: result?.ready === true,
      providers: {
        claude: {
          ready: result?.claude?.ready === true,
          capacityAvailable: result?.claude?.capacityAvailable === true,
          active: Number.parseInt(result?.claude?.active, 10) || 0,
          maxActive: Number.parseInt(result?.claude?.maxActive, 10) || 1,
          sessionCreationAvailable: false,
        },
        codex: {
          ready: result?.codex?.ready === true,
          capacityAvailable: result?.codex?.capacityAvailable === true,
          active: Number.parseInt(result?.codex?.active, 10) || 0,
          maxActive: Number.parseInt(result?.codex?.maxActive, 10) || 1,
          sessionCreationAvailable: false,
        },
      },
    };
  }

  async create(input) {
    if (this.store.panicStatus?.().locked === true) {
      throw codedError('WORKER_SESSION_PANIC_LOCKED', 'Worker session creation is panic-locked.');
    }
    normalizePanePlan(input, this.workspaceRoot);
    throw codedError(
      'WORKER_SESSION_INTERACTIVE_UNAVAILABLE',
      'Persistent provider sessions are disabled; durable voice context supplies continuity.',
      503
    );
  }

  async recover() {
    const panes = await this.listPanes();
    const active = this.store.listPaneAttestations({ state: 'active' });
    const planned = this.store.listPaneAttestations({ state: 'planned' });
    const adopted = 0;
    let retired = 0;
    let removedUnknown = 0;

    for (const attestation of [...active, ...planned]) {
      this.store.retirePaneAttestation(
        attestation.creationId,
        'persistent_provider_sessions_disabled'
      );
      retired += 1;
    }

    for (const pane of panes) {
      await this.execFile('/usr/bin/tmux', this._args(['kill-pane', '-t', pane.paneId]), {
        timeout: 5000,
        maxBuffer: 4096,
      });
      removedUnknown += 1;
    }
    return { adopted, retired, removedUnknown };
  }
}

module.exports = {
  FIXED_PANE_ENTRY,
  FIXED_PANE_STATUS_DIRECTORY,
  FIXED_TMUX_SOCKET,
  FIXED_WORKSPACE_ROOT,
  PANE_FORMAT,
  PROVIDER_USERS,
  WorkerSessionPaneManager,
  assertPaneStatusDirectory,
  assertTmuxSocketBoundary,
  normalizePanePlan,
  createPaneStatusControl,
  paneStartCommand,
  parsePaneLine,
};
