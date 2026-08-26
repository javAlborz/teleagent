'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_DECODED_FRAME_BYTES = 64 * 1024;
const MAX_LAUNCH_OUTPUT_BYTES = 8 * 1024 * 1024;
// Provider state lives in one provider-specific UID/home. Until each launch
// receives its own UID/home, concurrent same-provider processes could inspect
// or signal one another. Serialize the provider plane and verify the prior
// transient cgroup is empty before admitting the next launch.
const MAX_ACTIVE = 1;
const CONTROL_TIMEOUT_MS = 12_000;
const PROVIDER_READY_TIMEOUT_MS = 15_000;
const PROVIDER_READY_POLL_MS = 25;
const WORKSPACE_ROOT = '/srv/teleagent-agent-workspaces';
const PROVIDER_PLANE_ROOT = '/var/lib/teleagent-provider-plane';
const PROVIDER_PLANE_PARENT = path.dirname(PROVIDER_PLANE_ROOT);
const MIN_PROVIDER_PLANE_CAPACITY_BYTES = 1n * 1024n * 1024n * 1024n;
const MAX_PROVIDER_PLANE_CAPACITY_BYTES = 4n * 1024n * 1024n * 1024n;
const MIN_PROVIDER_PLANE_FREE_BYTES = 512n * 1024n * 1024n;
const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    supervisorUser: 'teleagent-claude-supervisor',
    supervisorHome: '/var/lib/teleagent-provider-plane/claude-supervisor',
    runtimeUser: 'teleagent-claude-worker',
    runtimeHome: '/nonexistent/teleagent-claude-worker',
    command: '/opt/teleagent/agent-tools/claude',
    socket: '/run/teleagent-provider-launch/claude.sock',
  }),
  codex: Object.freeze({
    supervisorUser: 'teleagent-codex-supervisor',
    supervisorHome: '/var/lib/teleagent-provider-plane/codex-supervisor',
    runtimeUser: 'teleagent-codex-worker',
    runtimeHome: '/nonexistent/teleagent-codex-worker',
    command: '/opt/teleagent/agent-tools/codex',
    socket: '/run/teleagent-provider-launch/codex.sock',
  }),
});
const FIXED_SUDO = '/usr/bin/sudo';
const FIXED_BOUNDARY = '/usr/local/libexec/teleagent-provider-boundary';
const SENSITIVE_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|AUTH(?:ORIZATION)?)/i;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LAUNCH_ID = /^launch_[a-f0-9]{32}$/;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function groupGid(name, groupFile = '/etc/group') {
  const metadata = fs.lstatSync(groupFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0) throw new Error('System group database is unsafe.');
  const matches = fs.readFileSync(groupFile, 'utf8').split('\n').filter((line) => (
    line && !line.startsWith('#') && line.split(':', 1)[0] === name
  ));
  if (matches.length !== 1) throw new Error(`Required group ${name} is missing.`);
  const gid = Number.parseInt(matches[0].split(':')[2], 10);
  if (!Number.isInteger(gid)) throw new Error(`Group ${name} is invalid.`);
  return gid;
}

function socketPathForFd(fd) {
  const inode = String(fs.fstatSync(fd).ino);
  const matches = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[6] === inode && fields.length >= 8 ? [fields.slice(7).join(' ')] : [];
  });
  if (matches.length !== 1 || !matches[0].startsWith('/')) {
    throw new Error('Provider supervisor inherited an unbound listener.');
  }
  return path.resolve(matches[0]);
}

function validateProviderPlaneStorageBoundary({
  supervisorHome,
  expectedUid,
  expectedGid,
  lstat = fs.lstatSync,
  stat = (filename) => fs.statSync(filename, { bigint: true }),
  statfs = (filename) => fs.statfsSync(filename, { bigint: true }),
  realpath = fs.realpathSync,
} = {}) {
  if (!Object.values(PROVIDERS).some((spec) => spec.supervisorHome === supervisorHome) ||
      !Number.isSafeInteger(expectedUid) || expectedUid <= 0 ||
      !Number.isSafeInteger(expectedGid) || expectedGid <= 0) {
    throw new Error('Provider plane storage identity is invalid.');
  }
  let parent;
  let root;
  let home;
  let parentDevice;
  let rootDevice;
  let homeDevice;
  let storage;
  try {
    parent = lstat(PROVIDER_PLANE_PARENT);
    root = lstat(PROVIDER_PLANE_ROOT);
    home = lstat(supervisorHome);
    parentDevice = stat(PROVIDER_PLANE_PARENT);
    rootDevice = stat(PROVIDER_PLANE_ROOT);
    homeDevice = stat(supervisorHome);
    storage = statfs(PROVIDER_PLANE_ROOT);
  } catch {
    throw new Error('Provider plane storage cannot be inspected.');
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0 || realpath(PROVIDER_PLANE_PARENT) !== PROVIDER_PLANE_PARENT ||
      !root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || root.gid !== 0 ||
      (root.mode & 0o7777) !== 0o751 || realpath(PROVIDER_PLANE_ROOT) !== PROVIDER_PLANE_ROOT ||
      rootDevice.dev === parentDevice.dev || !home.isDirectory() || home.isSymbolicLink() ||
      home.uid !== expectedUid || home.gid !== expectedGid ||
      (home.mode & 0o7777) !== 0o700 || realpath(supervisorHome) !== supervisorHome ||
      homeDevice.dev !== rootDevice.dev) {
    throw new Error('Provider plane requires one exact private dedicated storage boundary.');
  }
  const blockSize = BigInt(storage.bsize);
  const blocks = BigInt(storage.blocks);
  const availableBlocks = BigInt(storage.bavail);
  if (blockSize <= 0n || blocks <= 0n || availableBlocks < 0n || availableBlocks > blocks) {
    throw new Error('Provider plane filesystem accounting is invalid.');
  }
  const capacityBytes = blockSize * blocks;
  const freeBytes = blockSize * availableBlocks;
  if (capacityBytes < MIN_PROVIDER_PLANE_CAPACITY_BYTES ||
      capacityBytes > MAX_PROVIDER_PLANE_CAPACITY_BYTES) {
    throw new Error('Provider plane filesystem capacity is outside the fixed 1-4 GiB boundary.');
  }
  const percentageReserve = capacityBytes / 5n;
  const requiredFreeBytes = percentageReserve > MIN_PROVIDER_PLANE_FREE_BYTES
    ? percentageReserve
    : MIN_PROVIDER_PLANE_FREE_BYTES;
  if (freeBytes < requiredFreeBytes) {
    throw new Error('Provider plane filesystem reserve is exhausted.');
  }
  return Object.freeze({
    root: PROVIDER_PLANE_ROOT,
    directory: supervisorHome,
    capacityBytes,
    freeBytes,
    requiredFreeBytes,
  });
}

function normalizeProviderSupervisorConfig(environment = process.env, {
  uid = process.getuid(),
  gid = process.getgid(),
  username = os.userInfo().username,
  pid = process.pid,
  launchGid = groupGid('teleagent-provider-launch'),
} = {}) {
  const provider = String(environment.TELEAGENT_PROVIDER || '').trim();
  const spec = PROVIDERS[provider];
  if (!spec || uid === 0 || username !== spec.supervisorUser ||
      environment.HOME !== spec.supervisorHome) {
    throw new Error('Provider supervisor identity does not match its fixed provider.');
  }
  const forbidden = Object.keys(environment).filter((name) => (
    SENSITIVE_ENV_NAME.test(name) || ['NODE_OPTIONS', 'NODE_PATH'].includes(name) || name.startsWith('LD_')
  ));
  if (forbidden.length) {
    throw new Error(`Provider supervisor refuses sensitive environment names: ${forbidden.sort().join(', ')}.`);
  }
  if (String(environment.LISTEN_PID || '') !== String(pid) || environment.LISTEN_FDS !== '1') {
    throw new Error('Provider supervisor requires exactly one systemd socket.');
  }
  if (environment.LISTEN_FDNAMES && environment.LISTEN_FDNAMES !== `provider-${provider}`) {
    throw new Error('Provider supervisor inherited the wrong socket name.');
  }
  validateProviderPlaneStorageBoundary({
    supervisorHome: spec.supervisorHome,
    expectedUid: uid,
    expectedGid: gid,
  });
  for (const filename of [spec.command, FIXED_SUDO, FIXED_BOUNDARY]) {
    const metadata = fs.lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 ||
        (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0 ||
        fs.realpathSync(filename) !== filename) {
      throw new Error('A pinned provider launch executable is unsafe.');
    }
  }
  const fd = 3;
  const descriptor = fs.fstatSync(fd);
  const socketMetadata = fs.lstatSync(spec.socket);
  if (!descriptor.isSocket() || socketPathForFd(fd) !== spec.socket ||
      !socketMetadata.isSocket() || socketMetadata.isSymbolicLink() ||
      socketMetadata.uid !== 0 || socketMetadata.gid !== launchGid ||
      (socketMetadata.mode & 0o777) !== 0o660) {
    throw new Error('Provider supervisor socket boundary is unsafe.');
  }
  return Object.freeze({ provider, spec, uid, gid, fd, launchGid });
}

function normalizeLaunch(input, config, workspaceRoot = WORKSPACE_ROOT) {
  if (input?.version !== 1 || input?.type !== 'start' || input.provider !== config.provider) {
    throw codedError('PROVIDER_LAUNCH_INVALID', 'Provider launch identity is invalid.');
  }
  const mode = String(input.mode || '');
  const accessMode = String(input.accessMode || '');
  const cwd = path.resolve(String(input.cwd || ''));
  const taskId = input.taskId === null ? null : String(input.taskId || '');
  const sessionId = input.sessionId === null ? null : String(input.sessionId || '');
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const relative = path.relative(workspaceRoot, cwd);
  if (!['managed', 'interactive'].includes(mode) ||
      !['read-only', 'mutating'].includes(accessMode) ||
      mode === 'interactive' ||
      !relative || relative.startsWith('..') ||
      path.isAbsolute(relative) || !/^[A-Za-z0-9_./-]+$/.test(cwd) ||
      (taskId && !SAFE_TASK_ID.test(taskId)) || args.length > 256 ||
      args.some((arg) => arg.length > 8192 || /[\0\r\n]/.test(arg))) {
    throw codedError('PROVIDER_LAUNCH_INVALID', 'Provider launch arguments are outside policy.');
  }
  // The unprivileged supervisor intentionally cannot traverse provider
  // workspaces. The exact root boundary re-resolves this path immediately
  // before creating the transient unit, so symlink/canonical truth is checked
  // at the privilege transition instead of granting the supervisor read DAC.
  if (mode === 'interactive') {
    throw codedError('PROVIDER_SESSION_UNAVAILABLE', 'Persistent interactive provider sessions are disabled.');
  }
  if (mode === 'managed' && sessionId) {
    throw codedError('PROVIDER_SESSION_INVALID', 'Managed provider work cannot set a session ID.');
  }
  return { mode, accessMode, cwd, taskId, sessionId, args };
}

function writeFrame(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function createMemoryPanicState(initiallyLocked = false) {
  let locked = Boolean(initiallyLocked);
  return Object.freeze({
    status: () => ({ locked }),
    lock: () => {
      const alreadyLocked = locked;
      locked = true;
      return { locked: true, persisted: true, alreadyLocked };
    },
    unlock: () => {
      const wasLocked = locked;
      locked = false;
      return { locked: false, persisted: true, wasLocked };
    },
  });
}

function createFilePanicState({ directory, uid }) {
  const filename = path.join(directory, 'panic.lock');
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const syncDirectory = () => fs.fsyncSync(directoryFd);
  const validate = () => {
    let metadata;
    try { metadata = fs.lstatSync(filename); }
    catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid ||
        (metadata.mode & 0o077) !== 0) {
      throw new Error('Provider supervisor panic state is unsafe.');
    }
    return true;
  };
  validate();
  return Object.freeze({
    status: () => ({ locked: validate() }),
    lock: ({ reason = 'provider_supervisor_panic', source = 'controller' } = {}) => {
      if (validate()) return { locked: true, persisted: true, alreadyLocked: true };
      let fd;
      try {
        fd = fs.openSync(
          filename,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600
        );
        const payload = `${JSON.stringify({
          version: 1,
          locked: true,
          reason: String(reason).slice(0, 160),
          source: String(source).slice(0, 80),
          lockedAt: new Date().toISOString(),
        })}\n`;
        fs.writeFileSync(fd, payload, { encoding: 'utf8' });
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      syncDirectory();
      return { locked: true, persisted: true, alreadyLocked: false };
    },
    unlock: () => {
      const wasLocked = validate();
      if (wasLocked) {
        fs.unlinkSync(filename);
        syncDirectory();
      }
      return { locked: false, persisted: true, wasLocked };
    },
    close: () => fs.closeSync(directoryFd),
  });
}

function execBoundary(provider, action, launchId = null, {
  execFileImpl = execFile,
  timeoutMs = CONTROL_TIMEOUT_MS,
} = {}) {
  const args = ['-n', FIXED_BOUNDARY, '--action', action, '--provider', provider];
  if (launchId) args.push('--launch-id', launchId);
  return new Promise((resolve, reject) => {
    execFileImpl(FIXED_SUDO, args, {
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
      encoding: 'utf8',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    }, (error, stdout) => {
      let payload;
      try { payload = JSON.parse(String(stdout || '').trim()); }
      catch { return reject(codedError('PROVIDER_BOUNDARY_INVALID', 'Provider boundary response is invalid.')); }
      if (error && payload?.quiesced !== true) {
        return reject(codedError('PROVIDER_BOUNDARY_UNAVAILABLE', 'Provider boundary control failed.'));
      }
      resolve(payload);
    });
  });
}

function createBoundaryControl(options = {}) {
  return Object.freeze({
    status: (provider, launchId) => execBoundary(provider, 'status', launchId, options),
    terminate: (provider, launchId) => execBoundary(provider, 'terminate', launchId, options),
    recover: (provider) => execBoundary(provider, 'recover', null, options),
  });
}

function createProviderSupervisor({
  config,
  spawnImpl = spawn,
  ptySpawnImpl = null,
  maxActive = MAX_ACTIVE,
  workspaceRoot = WORKSPACE_ROOT,
  panicState = createMemoryPanicState(),
  boundaryControl = createBoundaryControl(),
  randomLaunchId = () => `launch_${crypto.randomBytes(16).toString('hex')}`,
  recovered = true,
  providerReadyTimeoutMs = PROVIDER_READY_TIMEOUT_MS,
  providerReadyPollMs = PROVIDER_READY_POLL_MS,
} = {}) {
  if (!config?.spec) throw new Error('Provider supervisor config is required.');
  if (maxActive !== 1) {
    throw new Error('Provider supervisor concurrency is fixed at one isolated launch.');
  }
  const active = new Set();
  const connections = new Set();
  let closing = false;
  let boundaryRecovered = recovered === true;
  let closePromise = null;
  let controlTransitions = 0;
  let controlLane = Promise.resolve();

  const panicStatus = () => {
    try { return panicState.status(); }
    catch { return { locked: true, error: 'panic_state_unavailable' }; }
  };

  const markBoundaryUncertain = () => {
    boundaryRecovered = false;
    try { panicState.lock({ reason: 'provider_boundary_outcome_unknown', source: 'supervisor' }); }
    catch { /* the health/readiness fence remains closed in memory */ }
  };

  const reportProviderStarted = (state) => {
    if (state.providerStarted || state.finished) return false;
    state.providerStarted = true;
    writeFrame(state.socket, {
      version: 1,
      type: 'accepted',
      launchId: state.launchId,
    });
    return true;
  };

  const observeProviderReadiness = (state, boundary) => {
    if (boundary?.providerExecutionAttempted === true) state.providerExecutionAttempted = true;
    if (boundary?.providerSpawnedEver === true) reportProviderStarted(state);
    return boundary?.providerAlive === true;
  };

  const finishRuntime = (state, boundary) => {
    if (state.finished || !state.leaderExited || boundary?.quiesced !== true) return false;
    state.finished = true;
    state.boundaryQuiesced = true;
    active.delete(state);
    if (state.providerStarted) {
      writeFrame(state.socket, {
        version: 1,
        type: 'exit',
        code: Number.isInteger(state.exitCode) ? state.exitCode : 1,
        signal: state.exitSignal || null,
        quiesced: true,
        launchId: state.launchId,
      });
    } else if (state.providerExecutionAttempted) {
      writeFrame(state.socket, {
        version: 1,
        type: 'error',
        code: 'PROVIDER_EXECUTION_OUTCOME_UNKNOWN',
        providerStarted: false,
        retrySafe: false,
        quiesced: true,
        launchId: state.launchId,
      });
    } else {
      writeFrame(state.socket, {
        version: 1,
        type: 'error',
        code: 'PROVIDER_NOT_STARTED',
        providerStarted: false,
        retrySafe: true,
        quiesced: true,
        launchId: state.launchId,
      });
    }
    state.socket.end();
    state.resolveFinished({ quiesced: true });
    return true;
  };

  const terminateRuntime = (state, reason = 'client_disconnected') => {
    if (state.terminationPromise) return state.terminationPromise;
    state.terminationReason = reason;
    const pending = (async () => {
      try {
        const result = await boundaryControl.terminate(config.provider, state.launchId);
        observeProviderReadiness(state, result);
        if (result?.persisted !== true || result?.quiesced !== true) {
          markBoundaryUncertain();
          return { quiesced: false, persisted: result?.persisted === true };
        }
        if (!state.leaderExited) {
          try { state.runtime.kill?.('SIGKILL'); } catch { /* transient cgroup is already empty */ }
          await state.leaderPromise;
        }
        finishRuntime(state, result);
        return { quiesced: true, persisted: true };
      } catch {
        markBoundaryUncertain();
        return { quiesced: false, persisted: false };
      }
    })();
    state.terminationPromise = pending;
    void pending.then((result) => {
      // An uncertain control response is not a terminal result. A later panic,
      // shutdown, or operator retry must be able to reassert the exact
      // cancellation tombstone and re-check the same cgroup.
      if (!result.quiesced && state.terminationPromise === pending) {
        state.terminationPromise = null;
      }
    });
    return pending;
  };

  const inspectAndFinish = async (state) => {
    try {
      const boundary = await boundaryControl.status(config.provider, state.launchId);
      observeProviderReadiness(state, boundary);
      if (!finishRuntime(state, boundary)) {
        await terminateRuntime(state, 'boundary_not_quiescent_after_launcher_exit');
      }
    } catch {
      markBoundaryUncertain();
      await terminateRuntime(state, 'boundary_status_unavailable');
    }
  };

  const registerRuntime = (runtime, socket, mode, launchId) => {
    let resolveFinished;
    let resolveLeader;
    const state = {
      runtime,
      socket,
      mode,
      launchId,
      providerStarted: false,
      providerExecutionAttempted: false,
      leaderExited: false,
      boundaryQuiesced: false,
      finished: false,
      exitCode: null,
      exitSignal: null,
      terminationPromise: null,
      terminationReason: null,
      outputBytes: 0,
      outputLimitExceeded: false,
      finishedPromise: new Promise((resolve) => { resolveFinished = resolve; }),
      leaderPromise: new Promise((resolve) => { resolveLeader = resolve; }),
      resolveFinished,
      resolveLeader,
    };
    void state.finishedPromise.catch(() => {});
    active.add(state);
    const exited = (code, signal = null) => {
      if (state.leaderExited) return;
      state.leaderExited = true;
      state.exitCode = Number.isInteger(code) ? code : 1;
      state.exitSignal = signal || null;
      state.resolveLeader();
      void inspectAndFinish(state);
    };
    if (mode === 'interactive') runtime.onExit(({ exitCode, signal }) => exited(exitCode, signal));
    else {
      runtime.once('close', exited);
      runtime.once('error', () => exited(1, null));
    }
    return state;
  };

  const forwardProviderOutput = (state, type, value) => {
    if (state.finished || state.outputLimitExceeded) return;
    const bytes = Buffer.from(value);
    if (state.outputBytes + bytes.length > MAX_LAUNCH_OUTPUT_BYTES) {
      state.outputLimitExceeded = true;
      void terminateRuntime(state, 'provider_output_limit_exceeded');
      return;
    }
    state.outputBytes += bytes.length;
    for (let offset = 0; offset < bytes.length; offset += MAX_DECODED_FRAME_BYTES) {
      writeFrame(state.socket, {
        version: 1,
        type,
        data: bytes.subarray(offset, offset + MAX_DECODED_FRAME_BYTES).toString('base64'),
      });
    }
  };

  const waitForProviderReadiness = async (state) => {
    const deadline = Date.now() + providerReadyTimeoutMs;
    while (!state.finished && !state.leaderExited && Date.now() < deadline) {
      let boundary;
      try {
        boundary = await boundaryControl.status(config.provider, state.launchId);
      } catch {
        markBoundaryUncertain();
        await terminateRuntime(state, 'provider_readiness_status_unavailable');
        return false;
      }
      if (observeProviderReadiness(state, boundary) && !state.finished) return true;
      await new Promise((resolve) => setTimeout(resolve, providerReadyPollMs));
    }
    if (state.providerStarted || state.finished || state.leaderExited) return state.providerStarted;
    await terminateRuntime(state, 'provider_readiness_timeout');
    return false;
  };

  const panicAllImpl = async ({ reason = 'provider_supervisor_panic', source = 'controller' } = {}) => {
    let persisted;
    try { persisted = panicState.lock({ reason, source }); }
    catch {
      return {
        success: false, accepted: false, persisted: false, quiesced: false,
        code: 'PROVIDER_PANIC_PERSISTENCE_FAILED',
      };
    }
    const results = await Promise.all([...active].map((state) => (
      terminateRuntime(state, 'provider_supervisor_panic')
    )));
    let recovery = null;
    try { recovery = await boundaryControl.recover(config.provider); }
    catch { markBoundaryUncertain(); }
    const quiesced = active.size === 0 && results.every((result) => result.quiesced) &&
      recovery?.persisted === true && recovery?.quiesced === true;
    if (quiesced) boundaryRecovered = true;
    else markBoundaryUncertain();
    return {
      success: quiesced,
      accepted: true,
      persisted: persisted.persisted === true && recovery?.persisted === true,
      alreadyLocked: persisted.alreadyLocked === true,
      quiesced,
      activeCount: active.size,
    };
  };

  const unlockAllImpl = async () => {
    if (closing) {
      return {
        success: false, persisted: true, quiesced: false,
        code: 'PROVIDER_SUPERVISOR_DRAINING',
      };
    }
    let recovery;
    try { recovery = await boundaryControl.recover(config.provider); }
    catch { markBoundaryUncertain(); }
    if (active.size !== 0 || recovery?.quiesced !== true || recovery?.persisted !== true) {
      return {
        success: false, persisted: true, quiesced: false,
        code: 'PROVIDER_SUPERVISOR_NOT_QUIESCENT',
      };
    }
    try {
      const unlocked = panicState.unlock();
      boundaryRecovered = unlocked.persisted === true;
      return {
        success: boundaryRecovered, quiesced: true, ...unlocked,
      };
    } catch {
      return {
        success: false, persisted: true, quiesced: true,
        code: 'PROVIDER_UNLOCK_PERSISTENCE_FAILED',
      };
    }
  };

  const enqueueControl = (operation) => {
    if (closing) {
      return Promise.resolve({
        success: false, persisted: true, quiesced: false,
        code: 'PROVIDER_SUPERVISOR_DRAINING',
      });
    }
    controlTransitions += 1;
    const result = controlLane.then(operation, operation).finally(() => {
      controlTransitions -= 1;
    });
    controlLane = result.catch(() => {});
    return result;
  };
  const panicAll = (input) => enqueueControl(() => panicAllImpl(input));
  const unlockAll = () => enqueueControl(() => unlockAllImpl());

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    if (closing) return socket.end(`${JSON.stringify({ success: false, code: 'DRAINING' })}\n`);
    let buffer = Buffer.alloc(0);
    let state = null;
    let started = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) return socket.destroy();
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        let frame;
        try { frame = JSON.parse(line.toString('utf8')); }
        catch { return socket.destroy(); }
        if (!started && frame?.type === 'health') {
          started = true;
          const panic = panicStatus();
          const ready = !closing && controlTransitions === 0 &&
            boundaryRecovered && panic.locked !== true;
          writeFrame(socket, {
            success: true,
            ready,
            provider: config.provider,
            uid: config.uid,
            active: active.size,
            maxActive,
            capacityAvailable: ready && active.size < maxActive,
            panicLocked: panic.locked === true,
            boundaryRecovered,
          });
          socket.end();
          continue;
        }
        if (!started && frame?.type === 'panic') {
          started = true;
          void panicAll(frame).then((result) => {
            writeFrame(socket, { version: 1, type: 'panic_result', ...result });
            socket.end();
          });
          continue;
        }
        if (!started && frame?.type === 'unlock') {
          started = true;
          void unlockAll().then((result) => {
            writeFrame(socket, { version: 1, type: 'unlock_result', ...result });
            socket.end();
          });
          continue;
        }
        if (!started) {
          started = true;
          try {
            if (closing || controlTransitions !== 0 || !boundaryRecovered ||
                panicStatus().locked === true || active.size >= maxActive) {
              throw codedError('PROVIDER_SUPERVISOR_BUSY', 'Provider supervisor is unavailable.');
            }
            const launch = normalizeLaunch(frame, config, workspaceRoot);
            const launchId = randomLaunchId();
            if (!LAUNCH_ID.test(launchId) || [...active].some((item) => item.launchId === launchId)) {
              throw codedError('PROVIDER_LAUNCH_ID_INVALID', 'Provider launch identity is unavailable.');
            }
            const environment = {
              HOME: config.spec.supervisorHome,
              USER: config.spec.supervisorUser,
              LOGNAME: config.spec.supervisorUser,
              PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
            };
            const boundaryArgs = [
              '-n', FIXED_BOUNDARY,
              '--action', 'launch',
              '--provider', config.provider,
              '--launch-id', launchId,
              '--mode', launch.mode,
              '--access-mode', launch.accessMode,
              '--workspace', launch.cwd,
            ];
            if (launch.taskId) boundaryArgs.push('--task-id', launch.taskId);
            if (launch.sessionId) boundaryArgs.push('--session-id', launch.sessionId);
            boundaryArgs.push('--', ...launch.args);
            if (launch.mode === 'interactive') {
              if (typeof ptySpawnImpl !== 'function') {
                throw codedError('PROVIDER_PTY_UNAVAILABLE', 'Provider PTY support is unavailable.');
              }
              const runtime = ptySpawnImpl(FIXED_SUDO, boundaryArgs, {
                cwd: '/', env: environment, name: 'xterm-256color', cols: 120, rows: 40,
              });
              state = registerRuntime(runtime, socket, launch.mode, launchId);
              runtime.onData((data) => forwardProviderOutput(state, 'stdout', data));
            } else {
              const runtime = spawnImpl(FIXED_SUDO, boundaryArgs, {
                cwd: '/', env: environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
                detached: false,
              });
              state = registerRuntime(runtime, socket, launch.mode, launchId);
              for (const [stream, type] of [[runtime.stdout, 'stdout'], [runtime.stderr, 'stderr']]) {
                stream.on('data', (data) => forwardProviderOutput(state, type, data));
              }
            }
            void waitForProviderReadiness(state);
          } catch (error) {
            writeFrame(socket, { version: 1, type: 'error', code: error.code || 'PROVIDER_LAUNCH_DENIED' });
            socket.end();
          }
          continue;
        }
        const runtime = state?.runtime;
        if (!runtime || state.finished) continue;
        if (frame?.type === 'stdin') {
          if (!state.providerStarted) {
            void terminateRuntime(state, 'input_before_provider_readiness');
            return socket.destroy();
          }
          const data = Buffer.from(String(frame.data || ''), 'base64');
          if (data.length > 64 * 1024) return socket.destroy();
          if (typeof runtime.write === 'function') runtime.write(data.toString('utf8'));
          else runtime.stdin.write(data);
        } else if (frame?.type === 'stdin_end' && runtime.stdin) {
          if (!state.providerStarted) {
            void terminateRuntime(state, 'input_end_before_provider_readiness');
            return socket.destroy();
          }
          runtime.stdin.end();
        }
        else if (frame?.type === 'resize' && typeof runtime.resize === 'function') {
          const columns = Math.max(40, Math.min(Number.parseInt(frame.columns, 10) || 120, 300));
          const rows = Math.max(10, Math.min(Number.parseInt(frame.rows, 10) || 40, 120));
          runtime.resize(columns, rows);
        } else if (frame?.type === 'signal' && ['SIGTERM', 'SIGINT', 'SIGHUP'].includes(frame.signal)) {
          if (frame.signal === 'SIGINT' && state.mode === 'interactive' && typeof runtime.write === 'function') {
            runtime.write('\x03');
          } else void terminateRuntime(state, `client_${frame.signal.toLowerCase()}`);
        }
      }
    });
    socket.once('close', () => {
      if (state && !state.finished) void terminateRuntime(state, 'client_disconnected');
    });
    socket.once('error', () => {
      if (state && !state.finished) void terminateRuntime(state, 'client_error');
    });
  });

  return {
    server,
    active,
    panic: panicAll,
    panicStatus,
    boundaryStatus: () => ({ recovered: boundaryRecovered }),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const stopped = server.listening
          ? new Promise((resolve) => server.close(resolve))
          : Promise.resolve();
        // `closing` fences new control requests above. Drain the exact lane
        // that was already admitted before changing panic or child state, so
        // a queued unlock cannot race shutdown recovery and reopen admission.
        await controlLane;
        try { panicState.lock({ reason: 'provider_supervisor_shutdown', source: 'supervisor' }); }
        catch { markBoundaryUncertain(); }
        const results = await Promise.all([...active].map((state) => (
          terminateRuntime(state, 'supervisor_shutdown')
        )));
        let recovery;
        try { recovery = await boundaryControl.recover(config.provider); }
        catch { markBoundaryUncertain(); }
        for (const socket of connections) socket.destroy();
        await stopped;
        if (active.size !== 0 || results.some((result) => !result.quiesced) ||
            recovery?.quiesced !== true) {
          throw codedError(
            'PROVIDER_CHILD_NOT_REAPED',
            'Provider supervisor shutdown could not verify every provider cgroup exited.'
          );
        }
        panicState.close?.();
      })();
      return closePromise;
    },
  };
}

async function startProviderSupervisor({
  config = normalizeProviderSupervisorConfig(),
  ptySpawnImpl = null,
  panicState = null,
  boundaryControl = createBoundaryControl(),
  validateStorage = validateProviderPlaneStorageBoundary,
} = {}) {
  validateStorage({
    supervisorHome: config.spec.supervisorHome,
    expectedUid: config.uid,
    expectedGid: config.gid,
  });
  const ptySpawn = ptySpawnImpl || require('node-pty').spawn;
  const durablePanicState = panicState || createFilePanicState({
    directory: config.spec.supervisorHome,
    uid: config.uid,
  });
  const recovery = await boundaryControl.recover(config.provider);
  if (recovery?.persisted !== true || recovery?.quiesced !== true) {
    try { durablePanicState.lock({ reason: 'provider_startup_recovery_failed', source: 'supervisor' }); }
    catch { /* startup remains failed closed */ }
    durablePanicState.close?.();
    throw new Error('Provider boundary startup recovery did not reach quiescence.');
  }
  const runtime = createProviderSupervisor({
    config,
    ptySpawnImpl: ptySpawn,
    panicState: durablePanicState,
    boundaryControl,
    recovered: true,
  });
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen({ fd: config.fd, exclusive: false }, resolve);
  });
  if (socketPathForFd(config.fd) !== config.spec.socket) {
    await runtime.close();
    throw new Error('Provider supervisor adopted the wrong socket.');
  }
  return runtime;
}

if (require.main === module) {
  let runtime;
  startProviderSupervisor().then((started) => {
    runtime = started;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => void runtime.close().then(
        () => process.exit(0),
        () => process.exit(1)
      ));
    }
  }).catch((error) => {
    process.stderr.write(`Provider supervisor startup failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  PROVIDERS,
  createBoundaryControl,
  createFilePanicState,
  createMemoryPanicState,
  createProviderSupervisor,
  execBoundary,
  normalizeLaunch,
  normalizeProviderSupervisorConfig,
  socketPathForFd,
  startProviderSupervisor,
  validateProviderPlaneStorageBoundary,
};
