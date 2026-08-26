'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  OperatorInspector,
  groupTmuxPanes,
  redactSensitiveText,
} = require('./operator-inspector');
const {
  FIXED_PANE_ENTRY,
  FIXED_WORKSPACE_ROOT,
  PANE_FORMAT,
  paneStartCommand,
  parsePaneLine,
} = require('./worker-session-pane-manager');

const PROVIDER_LOG_ROOTS = Object.freeze({
  claude: ['.claude', 'projects'],
  codex: ['.codex', 'sessions'],
});
const MAX_LOG_SCAN_ENTRIES = 10000;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function exactProviderLog(providerView, attestation) {
  const root = await fs.realpath(path.join(providerView, ...PROVIDER_LOG_ROOTS[attestation.provider]));
  const matches = [];
  let visited = 0;
  const walk = async (directory, depth) => {
    if (visited >= MAX_LOG_SCAN_ENTRIES || depth > 5) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > MAX_LOG_SCAN_ENTRIES) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const matchesName = attestation.provider === 'claude'
        ? entry.name === `${attestation.providerSessionId}.jsonl`
        : entry.name.startsWith('rollout-') &&
          entry.name.endsWith(`${attestation.providerSessionId}.jsonl`);
      if (matchesName) matches.push(candidate);
    }
  };
  await walk(root, 0);
  if (matches.length !== 1) {
    throw codedError(
      'SESSION_HISTORY_UNRESOLVED',
      'The attested provider session must map to exactly one broker-readable log.'
    );
  }
  const filename = await fs.realpath(matches[0]);
  const metadata = await fs.lstat(filename);
  if (!within(root, filename) || !metadata.isFile() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o022) !== 0) {
    throw codedError('SESSION_LOG_UNSAFE', 'The attested provider session log is unsafe.');
  }
  return filename;
}

class AttestedWorkerSessionInspector extends OperatorInspector {
  constructor({ store, providerView, workspaceRoot = FIXED_WORKSPACE_ROOT, ...options } = {}) {
    super({ ...options, home: providerView });
    if (!store?.getPaneAttestationByPaneId) {
      throw new Error('AttestedWorkerSessionInspector requires the durable broker store.');
    }
    this.store = store;
    this.providerView = providerView;
    this.workspaceRoot = workspaceRoot;
  }

  async _rawPane(target) {
    const safeTarget = String(target || '').trim();
    if (!/^(?:%[1-9][0-9]*|[A-Za-z0-9_.:+-]+)$/.test(safeTarget)) {
      throw codedError('INVALID_TMUX_TARGET', 'The tmux target is invalid.');
    }
    const { stdout } = await this.execFile('/usr/bin/tmux', this._tmuxArgs([
      'display-message', '-p', '-t', safeTarget, PANE_FORMAT,
    ]), { timeout: 5000, maxBuffer: 4096 });
    const raw = parsePaneLine(String(stdout || '').trim());
    if (!raw) throw codedError('TMUX_TARGET_NOT_FOUND', 'The tmux pane was not found.');
    return raw;
  }

  async _inspectTmuxTarget(target) {
    const raw = await this._rawPane(target);
    const attestation = this.store.getPaneAttestationByPaneId(raw.paneId);
    if (!attestation || attestation.state !== 'active') {
      throw codedError(
        'WORKER_SESSION_ATTESTATION_REQUIRED',
        'The pane is not an active broker-created provider session.'
      );
    }
    const realCwd = await fs.realpath(raw.cwd);
    if (raw.sessionName !== attestation.sessionName ||
        realCwd !== await fs.realpath(attestation.workspace) ||
        raw.startCommand !== paneStartCommand(attestation, this.workspaceRoot) ||
        attestation.launcherPath !== FIXED_PANE_ENTRY) {
      throw codedError(
        'WORKER_SESSION_ATTESTATION_CHANGED',
        'The pane no longer matches its durable provider attestation.'
      );
    }
    const pane = {
      target: raw.target,
      stable_target: raw.paneId,
      named_target: `${raw.sessionName}:${raw.window}.${raw.pane}`,
      session: raw.sessionName,
      window: raw.window,
      window_name: raw.windowName,
      pane: raw.pane,
      pane_id: raw.paneId,
      pid: null,
      command: attestation.provider,
      cwd: realCwd,
      active: raw.active,
      pane_title: null,
      agent: attestation.provider,
      agent_running: true,
      agent_attribution: 'durable_broker_attestation',
      agent_process_count: 1,
      agent_processes: [],
      ai_session_name_owned: true,
      ai_session_name: raw.sessionName,
    };
    return { target: String(target), pane, processes: [], descendants: [], attestation };
  }

  async resolveAgentSessionTarget(target) {
    const inspected = await this._inspectTmuxTarget(target);
    const filename = await exactProviderLog(this.providerView, inspected.attestation);
    const sessionFingerprint = crypto.createHash('sha256').update([
      inspected.attestation.creationId,
      inspected.attestation.provider,
      inspected.attestation.providerSessionId,
      inspected.pane.stable_target,
      filename,
    ].join('\0')).digest('hex');
    return {
      inspected,
      resolved: { filename, resolution: 'durable_broker_attestation' },
      sessionFingerprint,
    };
  }

  async inspectWorkerSessionBoundary(target) {
    const inspected = await this._inspectTmuxTarget(target);
    return {
      target: inspected.pane.target,
      stable_target: inspected.pane.stable_target,
      provider: inspected.pane.agent,
      cwd: inspected.pane.cwd,
      agent_running: true,
      creation_id: inspected.attestation.creationId,
      provider_session_id: inspected.attestation.providerSessionId,
      attribution: 'durable_broker_attestation',
    };
  }

  async listTmuxSessions() {
    let stdout;
    try {
      ({ stdout } = await this.execFile('/usr/bin/tmux', this._tmuxArgs([
        'list-panes', '-a', '-F', PANE_FORMAT,
      ]), { timeout: 5000, maxBuffer: 64 * 1024 }));
    } catch (error) {
      if (/no server running|failed to connect|not found/i.test(`${error.message}\n${error.stderr || ''}`)) {
        return { available: false, sessions: [], message: 'No attested provider sessions are available.' };
      }
      throw error;
    }
    const panes = [];
    for (const raw of String(stdout || '').split('\n').map(parsePaneLine).filter(Boolean)) {
      try {
        panes.push((await this._inspectTmuxTarget(raw.paneId)).pane);
      } catch (error) {
        if (!String(error.code || '').startsWith('WORKER_SESSION_ATTESTATION')) throw error;
      }
    }
    const sessions = groupTmuxPanes(panes);
    return {
      available: true,
      session_count: sessions.length,
      window_count: sessions.reduce((total, entry) => total + entry.window_count, 0),
      pane_count: panes.length,
      sessions,
      activity_included: false,
      activity_semantics: 'Only durable broker-created provider panes are visible.',
    };
  }

  async inspectTmuxPane({ target, lines = 40 } = {}) {
    const inspected = await this._inspectTmuxTarget(target);
    const safeLines = Math.max(10, Math.min(Number.parseInt(lines, 10) || 40, 120));
    const { stdout } = await this.execFile('/usr/bin/tmux', this._tmuxArgs([
      'capture-pane', '-p', '-J', '-t', inspected.pane.stable_target, '-S', `-${safeLines}`,
    ]), { timeout: 5000, maxBuffer: 12 * 1024 });
    let activity = {};
    try {
      activity = await this.inspectAgentActivity({ target: inspected.pane.stable_target });
    } catch (error) {
      activity = { activity_error: error.code || 'SESSION_HISTORY_UNRESOLVED' };
    }
    return {
      requested_target: String(target || ''),
      target: inspected.pane.target,
      stable_target: inspected.pane.stable_target,
      named_target: inspected.pane.named_target,
      conversation_name: inspected.pane.ai_session_name,
      window_name: inspected.pane.window_name,
      agent: inspected.pane.agent,
      agent_running: true,
      agent_attribution: 'durable_broker_attestation',
      cwd: inspected.pane.cwd,
      output: redactSensitiveText(String(stdout || '')).trim(),
      ...activity,
    };
  }

  async listAgentProcesses() {
    throw codedError(
      'WORKER_SESSION_PROCESS_INSPECTION_DENIED',
      'Cross-UID process inspection is outside the attested worker-session boundary.'
    );
  }
}

module.exports = {
  AttestedWorkerSessionInspector,
  exactProviderLog,
};
