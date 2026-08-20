'use strict';

const crypto = require('node:crypto');
const fsNative = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BYTES = 24 * 1024;
const TMUX_MAX_BYTES = 12 * 1024;
const DEFAULT_MAX_RESULTS = 80;
const DEFAULT_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_MESSAGE_CHARS = 1600;
const MAX_SESSION_LOG_BYTES = 256 * 1024 * 1024;
const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git', '.gnupg', '.kube', '.secrets', '.ssh', 'node_modules',
]);
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts|credentials|credentials\.json|secrets?\.ya?ml|.*\.(?:key|pem|p12|pfx))$/i;
const TMUX_TARGET = /^(?:%[0-9]+|[A-Za-z0-9_.:+-]+)$/;
const TMUX_SESSION_TARGET = /^[A-Za-z0-9_.:+-]+$/;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TMUX_FORMAT = '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_active}\t#{window_name}\t#{pane_title}\t#{@ai-session-name-owned}\t#{@ai-session-name-current-name}';
const CODEX_CONTEXT_MESSAGE = /^<(?:environment_context|permissions_instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|multi_agent_mode)>/i;
const CLAUDE_META_MESSAGE = /^<(?:local-command-caveat|command-name|command-message|local-command-stdout|system-reminder)>/i;

function parseRoots(value, fallbackHome = os.homedir()) {
  const configured = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.length > 0
    ? configured
    : [
      path.join(fallbackHome, 'phone'),
      path.join(fallbackHome, 'dev'),
      path.join(fallbackHome, 'dev2'),
      path.join(fallbackHome, 'ufst'),
    ];
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]')
    .replace(/(--?(?:api[_-]?key|token|secret|password)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp|github_pat|xox[baprs]|AKIA)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function isSensitivePath(filename) {
  const segments = path.resolve(filename).split(path.sep).filter(Boolean);
  return segments.some((segment) => SKIPPED_DIRECTORY_NAMES.has(segment)) ||
    SENSITIVE_BASENAME.test(path.basename(filename));
}

function clip(value, max = DEFAULT_MAX_BYTES) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n[output clipped]` : text;
}

function parseProcessTable(stdout) {
  const processes = [];
  for (const line of String(stdout || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    processes.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      state: match[3],
      args: match[4],
    });
  }
  return processes;
}

function classifyAgentProcess(args) {
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  const classifyToken = (token) => {
    if (!/^[A-Za-z0-9_./@+-]+$/.test(token)) return null;
    const executable = path.basename(token).toLowerCase();
    if (/^(?:codex|codex\.js|codex-linux-[a-z0-9_-]+|codex-code-mode-host)$/.test(executable) ||
        /(?:^|\/)@openai\/codex(?:\/|$)/i.test(token)) return 'codex';
    if (/^(?:claude|claude\.js|claude-code)$/.test(executable) ||
        /(?:^|\/)@anthropic-ai\/claude-code(?:\/|$)/i.test(token)) return 'claude';
    return null;
  };
  const direct = classifyToken(tokens[0] || '');
  if (direct) return direct;
  const wrapper = path.basename(tokens[0] || '').toLowerCase();
  if (['bun', 'deno', 'node', 'nodejs', 'npm', 'npx'].includes(wrapper)) {
    for (const token of tokens.slice(1, 5)) {
      const provider = classifyToken(token);
      if (provider) return provider;
    }
  }
  return null;
}

function summarizeAgentProcess(process, provider = classifyAgentProcess(process.args)) {
  if (!provider) return null;
  const executable = path.basename(String(process.args || '').trim().split(/\s+/, 1)[0] || 'unknown');
  return {
    pid: process.pid,
    ppid: process.ppid,
    state: process.state,
    provider,
    executable,
  };
}

function descendantProcesses(processes, rootPid) {
  const children = new Map();
  for (const process of processes) {
    if (!children.has(process.ppid)) children.set(process.ppid, []);
    children.get(process.ppid).push(process);
  }

  const descendants = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (seen.has(parentPid)) continue;
    seen.add(parentPid);
    const process = processes.find((entry) => entry.pid === parentPid);
    if (process) descendants.push(process);
    for (const child of children.get(parentPid) || []) queue.push(child.pid);
  }
  return descendants;
}

function enrichTmuxPanes(tmuxStdout, processStdout) {
  const processes = parseProcessTable(processStdout);

  return String(tmuxStdout || '').trim().split('\n').filter(Boolean).map((line) => {
    const [
      session, window, pane, paneId, pid, command, cwd, active, windowName,
      paneTitle, aiSessionNameOwned, aiSessionName,
    ] = line.split('\t');
    const rootPid = Number.parseInt(pid, 10);
    const descendants = descendantProcesses(processes, rootPid);
    const agentProcesses = descendants
      .map((process) => summarizeAgentProcess(process))
      .filter(Boolean);
    const providers = [...new Set(agentProcesses.map((process) => process.provider))];

    const safeWindowName = /^[A-Za-z0-9_.+-]+$/.test(windowName || '') ? windowName : null;
    return {
      target: `${session}:${window}.${pane}`,
      stable_target: paneId || null,
      named_target: safeWindowName ? `${session}:${safeWindowName}.${pane}` : null,
      session,
      window: Number.parseInt(window, 10),
      window_name: windowName || null,
      pane: Number.parseInt(pane, 10),
      pane_id: paneId,
      pid: rootPid,
      command,
      cwd,
      active: active === '1',
      pane_title: paneTitle || null,
      agent: providers.length === 1 ? providers[0] : (providers.length > 1 ? 'mixed' : null),
      agent_running: providers.length > 0,
      agent_attribution: providers.length > 0 ? 'process_tree' : 'none',
      agent_process_count: agentProcesses.length,
      agent_processes: agentProcesses,
      ai_session_name_owned: aiSessionNameOwned === '1',
      ai_session_name: aiSessionName || null,
    };
  });
}

function groupTmuxPanes(panes) {
  const sessions = [];
  const sessionMap = new Map();
  for (const pane of panes) {
    let session = sessionMap.get(pane.session);
    if (!session) {
      session = { name: pane.session, windows: [], window_count: 0, pane_count: 0 };
      sessionMap.set(pane.session, session);
      sessions.push(session);
    }
    let window = session.windows.find((entry) => entry.index === pane.window);
    if (!window) {
      window = {
        index: pane.window,
        name: pane.window_name,
        active: false,
        agent: null,
        agent_running: false,
        agent_process_count: 0,
        panes: [],
      };
      session.windows.push(window);
      session.window_count += 1;
    }
    window.active = window.active || pane.active;
    window.agent_running = window.agent_running || pane.agent_running;
    window.agent_process_count += pane.agent_process_count;
    if (!window.agent) window.agent = pane.agent;
    else if (pane.agent && window.agent !== pane.agent) window.agent = 'mixed';
    window.panes.push({
      index: pane.pane,
      target: pane.target,
      stable_target: pane.stable_target,
      named_target: pane.named_target,
      conversation_name: pane.ai_session_name || pane.window_name || null,
      active: pane.active,
      command: pane.command,
      cwd: pane.cwd,
      agent: pane.agent,
      agent_running: pane.agent_running,
      agent_attribution: pane.agent_attribution,
      agent_process_count: pane.agent_process_count,
    });
    session.pane_count += 1;
  }
  return sessions;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => ['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function extractCodexMessage(record) {
  if (record?.type !== 'response_item' || record.payload?.type !== 'message') return null;
  const role = record.payload.role;
  if (!['user', 'assistant'].includes(role)) return null;
  const text = extractTextContent(record.payload.content).trim();
  if (!text || (role === 'user' && CODEX_CONTEXT_MESSAGE.test(text))) return null;
  return { role, text, at: record.timestamp || null };
}

function extractClaudeMessage(record) {
  if (!['user', 'assistant'].includes(record?.type) || record.isMeta || record.toolUseResult) return null;
  const role = record.message?.role || record.type;
  if (!['user', 'assistant'].includes(role)) return null;
  const rawContent = record.message?.content;
  let text = extractTextContent(rawContent).trim();
  if (role === 'user' && typeof rawContent === 'string') {
    const commandArgs = rawContent.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1]?.trim();
    if (commandArgs) text = commandArgs;
  }
  if (!text || (role === 'user' && CLAUDE_META_MESSAGE.test(text))) return null;
  return { role, text, at: record.timestamp || null };
}

function clipHistoryMessage(text) {
  const redacted = redactSensitiveText(text).trim();
  if (redacted.length <= MAX_HISTORY_MESSAGE_CHARS) {
    return { text: redacted, clipped: false };
  }
  return {
    text: `${redacted.slice(0, MAX_HISTORY_MESSAGE_CHARS)}\n[message clipped]`,
    clipped: true,
  };
}

function normalizeHistoryPosition(position) {
  const value = String(position || 'start').trim().toLowerCase();
  if (value === 'tail') return 'latest';
  if (['start', 'after', 'latest', 'before'].includes(value)) return value;
  throw Object.assign(new Error('The provider-history position is invalid.'), { code: 'INVALID_HISTORY_POSITION' });
}

function normalizeHistoryRole(role) {
  const value = String(role || 'any').trim().toLowerCase();
  if (['any', 'user', 'assistant'].includes(value)) return value;
  throw Object.assign(new Error('The provider-history role filter is invalid.'), { code: 'INVALID_HISTORY_ROLE' });
}

async function readSessionHistory(filename, provider, {
  cursor = 0,
  limit = DEFAULT_HISTORY_MESSAGES,
  position = 'start',
  role = 'any',
} = {}) {
  const safeCursor = Math.max(0, Math.min(Number.parseInt(cursor, 10) || 0, 100000));
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || DEFAULT_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  const safePosition = normalizeHistoryPosition(position);
  const safeRole = normalizeHistoryRole(role);
  if (safePosition === 'before' && safeCursor === 0) {
    throw Object.assign(new Error('A positive cursor is required when reading older provider history.'), {
      code: 'HISTORY_CURSOR_REQUIRED',
    });
  }
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw Object.assign(new Error('The provider session log is unavailable.'), { code: 'SESSION_LOG_NOT_FOUND' });
  if (stat.size > MAX_SESSION_LOG_BYTES) {
    throw Object.assign(new Error('The provider session log exceeds the bounded inspection limit.'), { code: 'SESSION_LOG_TOO_LARGE' });
  }

  const stream = fsNative.createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const messages = [];
  let messageCount = 0;
  let matchingCount = 0;
  let parseErrors = 0;
  let hasOlder = false;
  let hasNewer = false;
  const extract = provider === 'codex' ? extractCodexMessage : extractClaudeMessage;

  try {
    for await (const line of lines) {
      if (!line || line.length > 4 * 1024 * 1024) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        parseErrors += 1;
        continue;
      }
      const message = extract(record);
      if (!message) continue;
      const number = messageCount + 1;
      messageCount += 1;
      if (safeRole !== 'any' && message.role !== safeRole) continue;
      matchingCount += 1;
      const clipped = clipHistoryMessage(message.text);
      const entry = {
        number,
        role: message.role,
        text: clipped.text,
        at: message.at,
        clipped: clipped.clipped,
      };

      if (safePosition === 'start' || safePosition === 'after') {
        if (number <= safeCursor) {
          hasOlder = true;
          continue;
        }
        if (messages.length < safeLimit) messages.push(entry);
        else hasNewer = true;
        continue;
      }

      if (safePosition === 'before' && number >= safeCursor) {
        hasNewer = true;
        continue;
      }

      if (messages.length >= safeLimit) {
        messages.shift();
        hasOlder = true;
      }
      messages.push(entry);
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  const firstNumber = messages[0]?.number || null;
  const lastNumber = messages.at(-1)?.number || null;
  const direction = ['latest', 'before'].includes(safePosition) ? 'backward' : 'forward';
  return {
    cursor: safePosition === 'latest' ? null : safeCursor,
    position: safePosition,
    role: safeRole,
    direction,
    next_cursor: hasNewer ? lastNumber : null,
    previous_cursor: hasOlder ? firstNumber : null,
    has_more: direction === 'backward' ? hasOlder : hasNewer,
    has_older: hasOlder,
    has_newer: hasNewer,
    messages,
    total_messages: messageCount,
    total_matching_messages: matchingCount,
    parse_errors: parseErrors,
  };
}

async function findSessionLogs(root, predicate, { maxDepth = 5, maxVisited = 5000 } = {}) {
  const matches = [];
  let visited = 0;
  const walk = async (directory, depth) => {
    if (depth > maxDepth || visited >= maxVisited) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxVisited) break;
      visited += 1;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'subagents') await walk(filename, depth + 1);
      } else if (entry.isFile() && predicate(filename, entry.name)) {
        matches.push(filename);
      }
    }
  };
  await walk(root, 0);
  return matches;
}

function resumeSessionIds(processes, provider) {
  const expression = provider === 'claude'
    ? new RegExp(`(?:^|\\s)(?:-r|--resume)(?:=|\\s+)(${UUID})(?:\\s|$)`, 'i')
    : new RegExp(`(?:^|\\s)resume\\s+(${UUID})(?:\\s|$)`, 'i');
  return [...new Set(processes.map((process) => String(process.args || '').match(expression)?.[1]).filter(Boolean))];
}

function encodedClaudeProjectDirectory(home, cwd) {
  const encoded = String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
  return encoded ? path.join(home, '.claude', 'projects', encoded) : null;
}

async function newestFile(filenames) {
  const candidates = [];
  for (const filename of filenames) {
    try {
      const stat = await fs.stat(filename);
      if (stat.isFile()) candidates.push({ filename, mtimeMs: stat.mtimeMs });
    } catch {
      // A provider may rotate a session file while inspection is in progress.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filename || null;
}

async function fileContains(filename, needle) {
  const stream = fsNative.createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.includes(needle)) return true;
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

class OperatorInspector {
  constructor({
    allowedRoots = parseRoots(process.env.VOICE_INSPECTION_ROOTS),
    home = os.homedir(),
    execFileImpl = execFileAsync,
  } = {}) {
    this.home = home;
    this.configuredRoots = allowedRoots.map((root) => path.resolve(root));
    this.realRootsPromise = null;
    this.execFile = execFileImpl;
  }

  async _realRoots() {
    if (!this.realRootsPromise) {
      this.realRootsPromise = Promise.all(this.configuredRoots.map(async (root) => {
        try {
          return await fs.realpath(root);
        } catch {
          return null;
        }
      })).then((roots) => roots.filter(Boolean));
    }
    return this.realRootsPromise;
  }

  async resolveAllowedPath(requestedPath) {
    const input = String(requestedPath || '').trim();
    if (!input) throw Object.assign(new Error('A path is required.'), { code: 'PATH_REQUIRED' });
    const candidate = path.resolve(input.startsWith('~') ? path.join(this.home, input.slice(1)) : input);
    if (isSensitivePath(candidate)) {
      throw Object.assign(new Error('That path is protected from voice inspection.'), { code: 'SENSITIVE_PATH' });
    }

    let real;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw Object.assign(new Error('The requested path does not exist.'), { code: 'PATH_NOT_FOUND' });
    }

    const roots = await this._realRoots();
    const allowed = roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
    if (!allowed) {
      throw Object.assign(new Error('That path is outside the approved inspection roots.'), { code: 'PATH_OUTSIDE_ROOTS' });
    }
    if (isSensitivePath(real)) {
      throw Object.assign(new Error('That path is protected from voice inspection.'), { code: 'SENSITIVE_PATH' });
    }
    return real;
  }

  async listDirectory({ path: requestedPath, limit = DEFAULT_MAX_RESULTS } = {}) {
    const real = await this.resolveAllowedPath(requestedPath);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw Object.assign(new Error('The requested path is not a directory.'), { code: 'NOT_DIRECTORY' });
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || DEFAULT_MAX_RESULTS, 200));
    const entries = await fs.readdir(real, { withFileTypes: true });
    return {
      path: real,
      entries: entries
        .filter((entry) => !isSensitivePath(path.join(real, entry.name)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, safeLimit)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : (entry.isSymbolicLink() ? 'symlink' : 'file'),
        })),
      clipped: entries.length > safeLimit,
    };
  }

  async readTextFile({ path: requestedPath, max_bytes = DEFAULT_MAX_BYTES } = {}) {
    const real = await this.resolveAllowedPath(requestedPath);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw Object.assign(new Error('The requested path is not a regular file.'), { code: 'NOT_FILE' });
    const safeMax = Math.max(256, Math.min(Number.parseInt(max_bytes, 10) || DEFAULT_MAX_BYTES, 64 * 1024));
    const handle = await fs.open(real, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, safeMax + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) throw Object.assign(new Error('Binary files cannot be read through the voice inspector.'), { code: 'BINARY_FILE' });
      return {
        path: real,
        content: redactSensitiveText(content.subarray(0, safeMax).toString('utf8')),
        clipped: stat.size > safeMax,
        size: stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  async findFiles({ path: requestedPath, query, max_depth = 4, limit = DEFAULT_MAX_RESULTS } = {}) {
    const root = await this.resolveAllowedPath(requestedPath);
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) throw Object.assign(new Error('A filename query is required.'), { code: 'QUERY_REQUIRED' });
    const safeDepth = Math.max(0, Math.min(Number.parseInt(max_depth, 10) || 4, 8));
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || DEFAULT_MAX_RESULTS, 200));
    const results = [];
    let visited = 0;

    const walk = async (directory, depth) => {
      if (results.length >= safeLimit || visited >= 5000) return;
      visited += 1;
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= safeLimit || visited >= 5000) break;
        const entryPath = path.join(directory, entry.name);
        if (isSensitivePath(entryPath)) continue;
        if (entry.name.toLowerCase().includes(needle)) {
          results.push({
            path: entryPath,
            type: entry.isDirectory() ? 'directory' : 'file',
          });
        }
        if (entry.isDirectory() && depth < safeDepth && !SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          await walk(entryPath, depth + 1);
        }
      }
    };

    await walk(root, 0);
    return { root, query: needle, results, clipped: results.length >= safeLimit || visited >= 5000 };
  }

  async gitStatus({ path: requestedPath } = {}) {
    const real = await this.resolveAllowedPath(requestedPath);
    const { stdout } = await this.execFile('git', ['-C', real, 'status', '--short', '--branch'], {
      timeout: 5000,
      maxBuffer: DEFAULT_MAX_BYTES,
    });
    return { path: real, status: redactSensitiveText(clip(stdout, DEFAULT_MAX_BYTES)).trim() };
  }

  async _inspectTmuxTarget(target) {
    const safeTarget = String(target || '').trim();
    if (!TMUX_TARGET.test(safeTarget)) {
      throw Object.assign(new Error('The tmux target is invalid.'), { code: 'INVALID_TMUX_TARGET' });
    }
    const [metadataResult, processResult] = await Promise.all([
      this.execFile('tmux', ['display-message', '-p', '-t', safeTarget, TMUX_FORMAT], {
        timeout: 5000,
        maxBuffer: 4096,
      }),
      this.execFile('ps', ['-eo', 'pid=,ppid=,stat=,args='], { timeout: 5000, maxBuffer: 256 * 1024 }),
    ]);
    const processes = parseProcessTable(processResult.stdout);
    const pane = enrichTmuxPanes(metadataResult.stdout, processResult.stdout)[0] || null;
    if (!pane) throw Object.assign(new Error('The tmux pane was not found.'), { code: 'TMUX_TARGET_NOT_FOUND' });
    return {
      target: safeTarget,
      pane,
      processes,
      descendants: descendantProcesses(processes, pane.pid),
    };
  }

  async _resolveCodexSessionLog(descendants) {
    const root = path.join(this.home, '.codex', 'sessions');
    let realRoot;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      throw Object.assign(new Error('Codex session storage is unavailable.'), { code: 'SESSION_STORAGE_UNAVAILABLE' });
    }
    const pids = descendants
      .filter((process) => classifyAgentProcess(process.args) === 'codex')
      .map((process) => process.pid);
    const openLogs = [];
    if (pids.length > 0) {
      try {
        const { stdout } = await this.execFile('lsof', ['-Fn', '-p', pids.join(',')], {
          timeout: 5000,
          maxBuffer: 64 * 1024,
        });
        for (const line of String(stdout || '').split('\n')) {
          if (!line.startsWith('n')) continue;
          const candidate = line.slice(1);
          if (!path.basename(candidate).startsWith('rollout-') || path.extname(candidate) !== '.jsonl') continue;
          try {
            const real = await fs.realpath(candidate);
            if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) openLogs.push(real);
          } catch {
            // Ignore descriptors that disappeared between lsof and realpath.
          }
        }
      } catch {
        // Resume-argument resolution below is an exact fallback when lsof has no match.
      }
    }
    const openLog = await newestFile(openLogs);
    if (openLog) return { filename: openLog, resolution: 'open_provider_log' };

    const ids = resumeSessionIds(descendants, 'codex');
    for (const id of ids) {
      const logs = await findSessionLogs(realRoot, (_filename, basename) => (
        basename.startsWith('rollout-') && basename.endsWith(`${id}.jsonl`)
      ));
      const filename = await newestFile(logs);
      if (filename) return { filename, resolution: 'explicit_resume_id' };
    }
    throw Object.assign(
      new Error('The active Codex process could not be mapped to one exact provider session log.'),
      { code: 'SESSION_HISTORY_UNRESOLVED' }
    );
  }

  async _resolveClaudeSessionLog(pane, descendants) {
    const root = path.join(this.home, '.claude', 'projects');
    let realRoot;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      throw Object.assign(new Error('Claude session storage is unavailable.'), { code: 'SESSION_STORAGE_UNAVAILABLE' });
    }
    const ids = resumeSessionIds(descendants, 'claude');
    for (const id of ids) {
      const logs = await findSessionLogs(realRoot, (_filename, basename) => basename === `${id}.jsonl`, { maxDepth: 3 });
      const filename = await newestFile(logs);
      if (filename) return { filename, resolution: 'explicit_resume_id' };
    }

    const sessionName = pane.ai_session_name_owned && pane.ai_session_name
      ? pane.ai_session_name
      : null;
    const projectDirectory = encodedClaudeProjectDirectory(this.home, pane.cwd);
    if (sessionName && projectDirectory) {
      const logs = await findSessionLogs(
        projectDirectory,
        (_filename, basename) => basename.endsWith('.jsonl'),
        { maxDepth: 0, maxVisited: 1000 }
      );
      const newest = [];
      for (const filename of logs) {
        try {
          const stat = await fs.stat(filename);
          newest.push({ filename, mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore logs rotated during inspection.
        }
      }
      newest.sort((left, right) => right.mtimeMs - left.mtimeMs);
      const marker = `<local-command-stdout>Session renamed to: ${sessionName}</local-command-stdout>`;
      for (const candidate of newest.slice(0, 25)) {
        if (await fileContains(candidate.filename, marker)) {
          return { filename: candidate.filename, resolution: 'verified_tmux_session_name' };
        }
      }
    }

    throw Object.assign(
      new Error('The active Claude process could not be mapped to one exact provider session log.'),
      { code: 'SESSION_HISTORY_UNRESOLVED' }
    );
  }

  async resolveAgentSessionTarget(target) {
    const inspected = await this._inspectTmuxTarget(target);
    if (!['codex', 'claude'].includes(inspected.pane.agent)) {
      throw Object.assign(
        new Error('The requested tmux pane does not own one identifiable Codex or Claude process.'),
        { code: 'AGENT_SESSION_NOT_FOUND' }
      );
    }
    const resolved = inspected.pane.agent === 'codex'
      ? await this._resolveCodexSessionLog(inspected.descendants)
      : await this._resolveClaudeSessionLog(inspected.pane, inspected.descendants);
    const filename = await fs.realpath(resolved.filename);
    const sessionFingerprint = crypto
      .createHash('sha256')
      .update(`${inspected.pane.agent}\0${filename}`)
      .digest('hex');
    return {
      inspected,
      resolved: { ...resolved, filename },
      sessionFingerprint,
    };
  }

  async inspectAgentSessionHistory({
    target,
    cursor = 0,
    limit = DEFAULT_HISTORY_MESSAGES,
    position = 'start',
    role = 'any',
  } = {}) {
    const targetSession = await this.resolveAgentSessionTarget(target);
    const { inspected, resolved } = targetSession;
    const history = await readSessionHistory(resolved.filename, inspected.pane.agent, {
      cursor,
      limit,
      position,
      role,
    });
    const chunkStart = history.messages[0]?.number || null;
    const chunkEnd = history.messages.at(-1)?.number || null;
    return {
      target: inspected.pane.target,
      stable_target: inspected.pane.stable_target,
      named_target: inspected.pane.named_target,
      provider: inspected.pane.agent,
      conversation_name: inspected.pane.ai_session_name || inspected.pane.window_name || null,
      tmux: {
        session: inspected.pane.session,
        window: { index: inspected.pane.window, name: inspected.pane.window_name },
        pane: { index: inspected.pane.pane, target: inspected.pane.target },
      },
      source: 'provider_session_log',
      resolution: resolved.resolution,
      exact_provider_history: true,
      redacted: true,
      messages: history.messages,
      chunk: {
        start: chunkStart,
        end: chunkEnd,
        position: history.position,
        role: history.role,
        direction: history.direction,
        next_cursor: history.next_cursor,
        previous_cursor: history.previous_cursor,
        has_more: history.has_more,
        has_older: history.has_older,
        has_newer: history.has_newer,
        total_messages: history.total_messages,
        total_matching_messages: history.total_matching_messages,
      },
      parse_errors: history.parse_errors,
    };
  }

  async listTmuxSessions({ session = null } = {}) {
    const safeSession = String(session || '').trim();
    if (safeSession && !TMUX_SESSION_TARGET.test(safeSession)) {
      throw Object.assign(new Error('The tmux session target is invalid.'), { code: 'INVALID_TMUX_TARGET' });
    }
    try {
      const tmuxArgs = ['list-panes', ...(safeSession ? ['-s', '-t', safeSession] : ['-a']), '-F', TMUX_FORMAT];
      const [tmuxResult, processResult] = await Promise.all([
        this.execFile('tmux', tmuxArgs, { timeout: 5000, maxBuffer: TMUX_MAX_BYTES }),
        this.execFile('ps', ['-eo', 'pid=,ppid=,stat=,args='], { timeout: 5000, maxBuffer: 256 * 1024 }),
      ]);
      const panes = enrichTmuxPanes(tmuxResult.stdout, processResult.stdout);
      const sessions = groupTmuxPanes(panes);
      return {
        available: true,
        session_count: sessions.length,
        window_count: sessions.reduce((total, entry) => total + entry.window_count, 0),
        pane_count: panes.length,
        sessions,
        terminology: 'A tmux session contains windows; each window contains one or more panes.',
      };
    } catch (error) {
      if (/no server running|failed to connect|not found/i.test(`${error.message}\n${error.stderr || ''}`)) {
        return { available: false, sessions: [], message: 'No tmux server is currently available.' };
      }
      throw error;
    }
  }

  async inspectTmuxPane({ target, lines = 40 } = {}) {
    const safeTarget = String(target || '').trim();
    if (!TMUX_TARGET.test(safeTarget)) {
      throw Object.assign(new Error('The tmux target is invalid.'), { code: 'INVALID_TMUX_TARGET' });
    }
    const safeLines = Math.max(10, Math.min(Number.parseInt(lines, 10) || 40, 120));
    const [captureResult, metadataResult, processResult] = await Promise.all([
      this.execFile('tmux', ['capture-pane', '-p', '-J', '-t', safeTarget, '-S', `-${safeLines}`], {
        timeout: 5000,
        maxBuffer: TMUX_MAX_BYTES,
      }),
      this.execFile('tmux', ['display-message', '-p', '-t', safeTarget, TMUX_FORMAT], {
        timeout: 5000,
        maxBuffer: 4096,
      }),
      this.execFile('ps', ['-eo', 'pid=,ppid=,stat=,args='], { timeout: 5000, maxBuffer: 256 * 1024 }),
    ]);
    const pane = enrichTmuxPanes(metadataResult.stdout, processResult.stdout)[0] || null;
    return {
      requested_target: safeTarget,
      target: pane?.target || safeTarget,
      stable_target: pane?.stable_target || null,
      named_target: pane?.named_target || null,
      conversation_name: pane?.ai_session_name || pane?.window_name || null,
      window_name: pane?.window_name || null,
      agent: pane?.agent || null,
      agent_running: Boolean(pane?.agent_running),
      agent_attribution: pane?.agent_attribution || 'none',
      agent_process_count: pane?.agent_process_count || 0,
      content: redactSensitiveText(clip(captureResult.stdout, TMUX_MAX_BYTES)).trim(),
      context_only: true,
      native_resume: false,
      display_note: pane?.agent_running
        ? 'The process tree proves an agent is running even if the captured TUI looks idle.'
        : 'No Claude or Codex process was found in the pane process tree.',
    };
  }

  async listAgentProcesses() {
    const { stdout } = await this.execFile('ps', ['-eo', 'pid=,ppid=,stat=,args='], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const processes = parseProcessTable(stdout)
      .map((process) => summarizeAgentProcess(process))
      .filter(Boolean)
      .slice(0, 100);
    return { processes };
  }

  async homelabStatus() {
    const localPromise = this.execFile('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'], {
      timeout: 8000,
      maxBuffer: DEFAULT_MAX_BYTES,
    });
    const clusterPromise = this.execFile('sudo', [
      '-n', 'ssh', '-o', 'BatchMode=yes', 'hera',
      "sudo kubectl get nodes --no-headers; sudo kubectl get pods -A --field-selector=status.phase!=Running --no-headers",
    ], {
      timeout: 15000,
      maxBuffer: 64 * 1024,
    });
    const [local, cluster] = await Promise.allSettled([localPromise, clusterPromise]);
    return {
      hermes_containers: local.status === 'fulfilled'
        ? redactSensitiveText(clip(local.value.stdout, DEFAULT_MAX_BYTES)).trim()
        : `unavailable: ${local.reason.message}`,
      cluster_nodes_and_nonrunning_pods: cluster.status === 'fulfilled'
        ? redactSensitiveText(clip(cluster.value.stdout, DEFAULT_MAX_BYTES)).trim()
        : `unavailable: ${cluster.reason.message}`,
      checked_at: new Date().toISOString(),
      read_only: true,
    };
  }

  describeRuntime() {
    return {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      uptime_seconds: Math.floor(os.uptime()),
      allowed_roots: [...this.configuredRoots],
      filesystem_access: 'bounded-read-only',
      tmux_access: 'bounded read-only inspection; approved target-bound messaging uses a separate controller',
    };
  }

  async execute(action, args = {}) {
    switch (action) {
      case 'list_directory': return this.listDirectory(args);
      case 'read_text_file': return this.readTextFile(args);
      case 'find_files': return this.findFiles(args);
      case 'git_status': return this.gitStatus(args);
      case 'list_tmux_sessions': return this.listTmuxSessions(args);
      case 'inspect_tmux_pane': return this.inspectTmuxPane(args);
      case 'inspect_agent_session_history': return this.inspectAgentSessionHistory(args);
      case 'list_agent_processes': return this.listAgentProcesses();
      case 'homelab_status': return this.homelabStatus();
      case 'describe_runtime': return this.describeRuntime();
      default: throw Object.assign(new Error('Unknown operator inspection action.'), { code: 'UNKNOWN_INSPECTION_ACTION' });
    }
  }
}

module.exports = {
  OperatorInspector,
  classifyAgentProcess,
  descendantProcesses,
  enrichTmuxPanes,
  extractClaudeMessage,
  extractCodexMessage,
  groupTmuxPanes,
  isSensitivePath,
  parseProcessTable,
  parseRoots,
  redactSensitiveText,
  readSessionHistory,
};
