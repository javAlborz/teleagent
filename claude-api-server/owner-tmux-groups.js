'use strict';

// Host-only, read-only metadata. Never capture panes, send keys, or use a tmux
// name as native delivery authority. The phone receives no socket, path or PID.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { processIdentity, sessionError } = require('./owner-session-endpoint');
const execute = promisify(execFile);
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FORMAT = '#{session_id}|#{session_name}|#{pane_id}|#{pane_pid}|#{pane_current_path}';

function tmuxIdentity(socketPath, uid) {
  const directory = path.dirname(socketPath);
  const parent = fs.lstatSync(directory); const socket = fs.lstatSync(socketPath);
  // tmux creates a 0770 socket inside its owner's 0700 directory. The private
  // parent is the access boundary; do not change a live server's permissions.
  if (fs.realpathSync(directory) !== directory || !parent.isDirectory() || parent.uid !== uid ||
      (parent.mode & 0o777) !== 0o700 || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o007)) {
    throw sessionError('OWNER_GROUP_SOCKET_UNSAFE');
  }
  return {dev: socket.dev, ino: socket.ino, parentDev: parent.dev, parentIno: parent.ino};
}

function parsePanes(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 65536) throw sessionError('OWNER_GROUP_LIMIT');
  if (!output.trim()) return [];
  const rows = output.trimEnd().split('\n');
  if (rows.length > 128) throw sessionError('OWNER_GROUP_LIMIT');
  return rows.map(line => {
    const [id, name, pane, pid, cwd, ...extra] = line.split('|');
    if (extra.length || !/^\$\d+$/.test(id) || !/^%\d+$/.test(pane) || !/^\d+$/.test(pid) ||
        !Number.isSafeInteger(Number(pid)) || Number(pid) < 1 || !LABEL.test(name) ||
        !path.isAbsolute(cwd || '') || /[\x00-\x1f\x7f]/u.test(cwd)) {
      throw sessionError('OWNER_GROUP_METADATA_INVALID');
    }
    return { id, name, pane, pid: Number(pid), cwd };
  });
}

function eligiblePane(pane, excludedRoots, home) {
  const roots = [...excludedRoots, ...['ufst', 'ThinkPad', '.ssh', '.gnupg', '.secrets', '.kube',
    '.config', '.codex', '.claude', 'phone', '.local/state/backups/secure'].map(p => `${home}/${p}`)];
  return pane.name !== 'ufst' && !roots.some(root => pane.cwd === root || pane.cwd.startsWith(`${root}/`));
}

// A Codex daemon can serve many conversations and need not live in their tmux
// panes. Only an exact resume UUID in a living frontend provides a launch
// association. It does NOT prove which conversation its UI currently displays.
function resumeId(argv) {
  const index = argv.indexOf('resume');
  return index > 0 && UUID.test(argv[index + 1] || '') ? argv[index + 1] : null;
}

function codexExecutable(filename) {
  // Package upgrades unlink the old executable while existing personal agents
  // keep running. This is observation only, never approval to restart them.
  return path.basename(filename).replace(/ \(deleted\)$/, '') === 'codex';
}

function groupSnapshot(panes, processes, entries) {
  const groups = new Map(panes.map(p => [p.id, { id: p.id, name: p.name }]));
  const memberships = {};
  function ancestors(pid) {
    const found = new Set(); const visited = new Set();
    for (let depth = 0; depth < 32 && pid && !visited.has(pid); depth++) {
      visited.add(pid);
      const process = processes.get(pid);
      if (!process) break;
      for (const pane of panes) if (pane.pid === pid) found.add(pane.id);
      pid = process.parent;
    }
    return [...found].sort();
  }
  for (const entry of entries) {
    if (entry.provider === 'claude') {
      const process = processes.get(entry.endpoint.pid);
      memberships[entry.id] = process?.start === entry.identity.process.start
        ? { groups: ancestors(entry.endpoint.pid), basis: 'native_process' } : { groups: [], basis: 'unknown' };
    } else {
      const ids = new Set();
      for (const [pid, process] of processes) {
        if (process.codexSessionId === entry.sessionId) for (const id of ancestors(pid)) ids.add(id);
      }
      memberships[entry.id] = { groups: [...ids].sort(), basis: ids.size ? 'resume_launch' : 'unknown' };
    }
  }
  return { available: true, groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)), memberships };
}

async function readTmuxGroups(entries, { ownerUid, excludedRoots }, {
  run = execute, filesystem = fs, procRoot = '/proc', home = os.userInfo().homedir,
} = {}) {
  // Only the owner's default local tmux server. No caller-supplied command,
  // format, socket, environment, session name or shell is accepted.
  const socketPath = `/tmp/tmux-${ownerUid}/default`;
  const before = tmuxIdentity(socketPath, ownerUid);
  const { stdout } = await run('/usr/bin/tmux', ['-S', socketPath, 'list-panes', '-a', '-F', FORMAT], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  if (JSON.stringify(before) !== JSON.stringify(tmuxIdentity(socketPath, ownerUid))) {
    throw sessionError('OWNER_GROUP_SERVER_CHANGED');
  }
  const panes = parsePanes(stdout).filter(p => {
    try { return eligiblePane(p, excludedRoots, home) && filesystem.realpathSync(p.cwd) === p.cwd; }
    catch { return false; }
  });
  const pids = filesystem.readdirSync(procRoot).filter(p => /^\d+$/.test(p));
  if (pids.length > 8192) throw sessionError('OWNER_GROUP_LIMIT');
  const processes = new Map();
  for (const pidText of pids) {
    const pid = Number(pidText); const root = path.join(procRoot, pidText);
    try {
      if (filesystem.statSync(root).uid !== ownerUid) continue;
      const stat = filesystem.readFileSync(`${root}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (['Z', 'X'].includes(fields[0]) || !/^\d+$/.test(fields[19])) continue;
      const record = { parent: Number(fields[1]), start: fields[19] };
      if (codexExecutable(filesystem.readlinkSync(`${root}/exe`))) {
        const fd = filesystem.openSync(`${root}/cmdline`, 'r');
        try {
          const buffer = Buffer.alloc(65537);
          const bytes = filesystem.readSync(fd, buffer, 0, buffer.length, 0);
          if (bytes <= 65536) record.codexSessionId = resumeId(buffer.subarray(0, bytes).toString().split('\0'));
        } finally { filesystem.closeSync(fd); }
      }
      // A PID reused during the observation must not supply membership.
      if (processIdentity(pid, ownerUid, procRoot).start !== record.start) continue;
      processes.set(pid, record);
    } catch { /* exited or unreadable process: no guessed placement */ }
  }
  return groupSnapshot(panes, processes, entries);
}

module.exports = { readTmuxGroups, parsePanes, groupSnapshot, resumeId, eligiblePane, codexExecutable, tmuxIdentity };
