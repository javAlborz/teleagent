'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FORBIDDEN_EXACT_EXECUTABLES, validatePlanAgainstPolicy } = require('./policy');

const MAX_OUTPUT_BYTES = 64 * 1024;
const PROCESS_MARKER_BYTES = 32;
const PROCESS_MARKER_NAME = 'TELEAGENT_PRIVILEGED_ACTION_MARKER';
const FIXED_ENVIRONMENT = Object.freeze({
  HOME: '/root',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  TELEAGENT_PRIVILEGED_ACTION_CHILD: '1',
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function processMarker() {
  return crypto.randomBytes(PROCESS_MARKER_BYTES).toString('base64url');
}

function assertProcessMarker(value) {
  const marker = String(value || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(marker)) {
    executionError('PRIVILEGED_PROCESS_MARKER_INVALID', 'The internal process marker is invalid.');
  }
  return marker;
}

function linuxProcError(error, pid) {
  if (['ENOENT', 'ESRCH'].includes(error?.code)) return null;
  const wrapped = new PrivilegedActionExecutionError(
    'PRIVILEGED_PROCESS_INSPECTION_FAILED',
    `Linux process identity ${pid} could not be verified.`
  );
  wrapped.cause = error;
  throw wrapped;
}

function parseLinuxProcStat(statText, expectedPid = null) {
  const text = String(statText || '').trim();
  const close = text.lastIndexOf(')');
  const open = text.indexOf('(');
  if (open <= 0 || close <= open || text[close + 1] !== ' ') {
    executionError('PRIVILEGED_PROCESS_IDENTITY_INVALID', 'Linux process stat data is malformed.');
  }
  const pid = Number(text.slice(0, open).trim());
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const processState = fields[0];
  const processGroupId = Number(fields[2]);
  const processStartTicks = fields[19];
  if (!Number.isInteger(pid) || pid <= 1 ||
      (expectedPid !== null && pid !== Number(expectedPid)) ||
      !Number.isInteger(processGroupId) || processGroupId <= 1 ||
      !/^\d+$/.test(String(processStartTicks || ''))) {
    executionError('PRIVILEGED_PROCESS_IDENTITY_INVALID', 'Linux process stat identity is invalid.');
  }
  return { pid, processGroupId, processStartTicks: String(processStartTicks), processState };
}

function markerFromEnvironment(buffer) {
  let staticMarker = false;
  let marker = null;
  for (const entry of Buffer.from(buffer || []).toString('utf8').split('\0')) {
    if (entry === 'TELEAGENT_PRIVILEGED_ACTION_CHILD=1') staticMarker = true;
    if (entry.startsWith(`${PROCESS_MARKER_NAME}=`)) {
      marker = entry.slice(PROCESS_MARKER_NAME.length + 1);
    }
  }
  return {
    staticMarker,
    markerHash: marker && /^[A-Za-z0-9_-]{43}$/.test(marker) ? sha256(marker) : null,
  };
}

function createLinuxProcessOperations({
  procRoot = '/proc',
  expectedUid = 0,
  strictUnreadable = expectedUid === 0,
  signalProcessGroup = (processGroupId, signalName) => process.kill(-processGroupId, signalName),
} = {}) {
  if (process.platform !== 'linux') {
    executionError(
      'PRIVILEGED_PROCESS_RECOVERY_UNSUPPORTED',
      'Privileged process recovery requires Linux /proc semantics.'
    );
  }
  const normalizedRoot = path.resolve(procRoot);
  const identity = (pid) => {
    const normalizedPid = Number(pid);
    if (!Number.isInteger(normalizedPid) || normalizedPid <= 1) {
      executionError('PRIVILEGED_PROCESS_IDENTITY_INVALID', 'A Linux process ID is invalid.');
    }
    const directory = path.join(normalizedRoot, String(normalizedPid));
    try {
      const owner = fs.statSync(directory).uid;
      const parsed = parseLinuxProcStat(
        fs.readFileSync(path.join(directory, 'stat'), 'utf8'),
        normalizedPid
      );
      let markers;
      try {
        markers = markerFromEnvironment(fs.readFileSync(path.join(directory, 'environ')));
      } catch (error) {
        if (error.code !== 'EACCES') throw error;
        let finalState = parsed.processState;
        try {
          finalState = parseLinuxProcStat(
            fs.readFileSync(path.join(directory, 'stat'), 'utf8'),
            normalizedPid
          ).processState;
        } catch (recheckError) {
          if (!['ENOENT', 'ESRCH'].includes(recheckError.code)) throw error;
          finalState = 'X';
        }
        if (!['Z', 'X'].includes(finalState)) throw error;
        parsed.processState = finalState;
        markers = { staticMarker: false, markerHash: null, environmentReadable: false };
      }
      return { environmentReadable: true, ...parsed, uid: owner, ...markers };
    } catch (error) {
      return linuxProcError(error, normalizedPid);
    }
  };
  const scan = () => {
    const marked = [];
    const unreadable = [];
    let entries;
    try {
      entries = fs.readdirSync(normalizedRoot, { withFileTypes: true });
    } catch (error) {
      return linuxProcError(error, 'all');
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        const directory = path.join(normalizedRoot, entry.name);
        if (fs.statSync(directory).uid !== expectedUid) continue;
        const current = identity(pid);
        if (current?.staticMarker) marked.push(current);
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error?.code)) continue;
        unreadable.push(pid);
      }
    }
    if (strictUnreadable && unreadable.length > 0) {
      const error = new PrivilegedActionExecutionError(
        'PRIVILEGED_PROCESS_SCAN_INCOMPLETE',
        'One or more same-identity Linux processes could not be inspected.'
      );
      error.unreadablePids = unreadable;
      throw error;
    }
    return marked;
  };
  const groupExists = (processGroupId) => {
    try {
      signalProcessGroup(Number(processGroupId), 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  };
  const signalGroup = (processGroupId, signalName) => {
    const group = Number(processGroupId);
    if (!Number.isInteger(group) || group <= 1 || group === process.pid) {
      executionError('PRIVILEGED_PROCESS_GROUP_INVALID', 'Refusing an unsafe process-group signal.');
    }
    try {
      signalProcessGroup(group, signalName);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  return Object.freeze({ expectedUid, groupExists, identity, scan, signalGroup });
}

class PrivilegedActionExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrivilegedActionExecutionError';
    this.code = code;
  }
}

function executionError(code, message) {
  throw new PrivilegedActionExecutionError(code, message);
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function assertSecureRootPath(filename, { executable = false, expectedUid = 0 } = {}) {
  const resolved = path.resolve(filename);
  if (resolved !== filename) {
    executionError('PRIVILEGED_EXECUTABLE_UNSAFE', 'A privileged path is not canonical.');
  }
  let real;
  let stat;
  try {
    real = fs.realpathSync(resolved);
    stat = fs.lstatSync(resolved);
  } catch {
    executionError('PRIVILEGED_EXECUTABLE_UNSAFE', 'A privileged path is unavailable.');
  }
  if (real !== resolved || stat.isSymbolicLink() || stat.uid !== expectedUid ||
      (stat.mode & 0o022) !== 0 ||
      (executable ? (!stat.isFile() || (stat.mode & 0o111) === 0) : !stat.isDirectory())) {
    executionError(
      executable ? 'PRIVILEGED_EXECUTABLE_UNSAFE' : 'PRIVILEGED_CWD_UNSAFE',
      'A privileged execution path has unsafe type, ownership, permissions, or indirection.'
    );
  }
  let cursor = executable ? path.dirname(resolved) : resolved;
  while (true) {
    const component = fs.lstatSync(cursor);
    if (!component.isDirectory() || component.isSymbolicLink() || component.uid !== expectedUid ||
        (component.mode & 0o022) !== 0) {
      executionError('PRIVILEGED_PATH_ANCESTOR_UNSAFE', 'A privileged path ancestor is unsafe.');
    }
    if (cursor === '/') break;
    cursor = path.dirname(cursor);
  }
  return resolved;
}

function executableRoots(plan, policy) {
  if (plan.adapter === 'argv') return policy.adapters.argv.allowed_executable_roots || [];
  return [path.dirname(plan.argv[0])];
}

function validateExecutionBoundary(actionPlan, policy, { expectedUid = 0 } = {}) {
  const plan = validatePlanAgainstPolicy(actionPlan, policy);
  const executable = assertSecureRootPath(plan.argv[0], { executable: true, expectedUid });
  const roots = executableRoots(plan, policy).map((root) =>
    assertSecureRootPath(root, { executable: false, expectedUid })
  );
  if (!roots.some((root) => isWithin(executable, root))) {
    executionError('PRIVILEGED_EXECUTABLE_DENIED', 'The executable is outside approved root-owned roots.');
  }
  if (plan.adapter === 'argv' && FORBIDDEN_EXACT_EXECUTABLES.has(executable)) {
    executionError('PRIVILEGED_EXECUTABLE_DENIED', 'Shells, interpreters, env, sudo, and su are denied.');
  }
  assertSecureRootPath(plan.cwd, { executable: false, expectedUid });
  return plan;
}

function outputCollector(maxBytes = MAX_OUTPUT_BYTES) {
  const chunks = [];
  let bytes = 0;
  let totalBytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const accepted = buffer.subarray(0, maxBytes - bytes);
      chunks.push(accepted);
      bytes += accepted.length;
      if (accepted.length !== buffer.length) truncated = true;
    },
    value() {
      const text = Buffer.concat(chunks).toString('utf8')
        .replaceAll(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      const redacted = text
        .replaceAll(/-----BEGIN [^-]{1,80} PRIVATE KEY-----[\s\S]*?-----END [^-]{1,80} PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
        .replaceAll(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED OPENAI KEY]')
        .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
        .replaceAll(/\b(?:gh[opusr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED CREDENTIAL]')
        .replaceAll(/\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');
      return {
        text: redacted,
        truncated,
        bytes: totalBytes,
        capturedBytes: bytes,
        redacted: redacted !== text,
        sha256: crypto.createHash('sha256').update(redacted).digest('hex'),
      };
    },
  };
}

function persistedOutput(output) {
  if (!output) return null;
  return {
    bytes: output.bytes,
    captured_bytes: output.capturedBytes,
    truncated: Boolean(output.truncated),
    redacted: Boolean(output.redacted),
    sha256: output.sha256,
  };
}

function persistedExecution(result) {
  if (!result) return null;
  return {
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: Boolean(result.timedOut),
    aborted: Boolean(result.aborted),
    duration_ms: result.durationMs,
    stdout: persistedOutput(result.stdout),
    stderr: persistedOutput(result.stderr),
  };
}

function killProcessTree(child, signalName) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signalName);
    else child.kill(signalName);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function runExactProcess(argv, {
  cwd,
  timeoutSeconds,
  signal = null,
  spawnImpl = spawn,
  onSpawn = null,
  childMarker = null,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const stdout = outputCollector(maxOutputBytes);
    const stderr = outputCollector(maxOutputBytes);
    const startedAt = Date.now();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer = null;
    let timeoutTimer = null;
    let child;
    let postSpawnError = null;
    const requestStop = (reason) => {
      if (!child || settled) return;
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      killProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 2000);
      killTimer.unref?.();
    };
    const abortHandler = () => requestStop('abort');
    let environment;
    try {
      environment = childMarker
        ? { ...FIXED_ENVIRONMENT, [PROCESS_MARKER_NAME]: assertProcessMarker(childMarker) }
        : { ...FIXED_ENVIRONMENT };
      child = spawnImpl(argv[0], argv.slice(1), {
        cwd,
        env: environment,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abortHandler);
      reject(error);
    });
    child.once('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abortHandler);
      if (postSpawnError) {
        reject(postSpawnError);
        return;
      }
      resolve({
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: Date.now() - startedAt,
      });
    });
    if (signal?.aborted) requestStop('abort');
    else signal?.addEventListener('abort', abortHandler, { once: true });
    timeoutTimer = setTimeout(() => requestStop('timeout'), timeoutSeconds * 1000);
    timeoutTimer.unref?.();
    try {
      onSpawn?.(child);
    } catch (error) {
      // The external process exists even when persisting its exact spawn stage
      // fails. Stop and reap it, but surface a distinct post-spawn error so the
      // dispatcher can record outcome_unknown rather than an ordinary failure.
      postSpawnError = new PrivilegedActionExecutionError(
        'PRIVILEGED_PROCESS_SPAWN_RECORD_FAILED',
        'The privileged process started before its durable spawn record could be verified.'
      );
      postSpawnError.cause = error;
      postSpawnError.processSpawned = true;
      requestStop('abort');
    }
  });
}

function executionDigest(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan.argv)).digest('hex');
}

function argvDigest(argv) {
  return crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class PrivilegedActionDispatcher {
  constructor({
    store,
    policy,
    spawnImpl = spawn,
    workerId = `root-broker-${process.pid}`,
    pollMs = 250,
    expectedUid = 0,
    processUid = typeof process.geteuid === 'function' ? process.geteuid() : expectedUid,
    processOperations = null,
    terminationGraceMs = 2000,
    terminationPollMs = 50,
  } = {}) {
    if (!store || !policy) throw new Error('PrivilegedActionDispatcher requires store and policy.');
    this.store = store;
    this.policy = policy;
    this.spawnImpl = spawnImpl;
    this.workerId = workerId;
    this.pollMs = Math.max(25, Math.min(Number.parseInt(pollMs, 10) || 250, 5000));
    this.expectedUid = expectedUid;
    this.processUid = processUid;
    this.processOperations = processOperations || spawnImpl.processOperations || createLinuxProcessOperations({
      expectedUid: processUid,
    });
    this.terminationGraceMs = Math.max(
      50,
      Math.min(Number.parseInt(terminationGraceMs, 10) || 2000, 30000)
    );
    this.terminationPollMs = Math.max(
      10,
      Math.min(Number.parseInt(terminationPollMs, 10) || 50, 1000)
    );
    this.active = new Map();
    this.activeRuns = new Set();
    this.timer = null;
    this.started = false;
    this.runningLoop = false;
    this.recoveryAttempted = false;
    this.recoveryResolved = false;
    this.recoveryResult = null;
  }

  start() {
    if (this.started) return;
    if (!this.recoveryAttempted) {
      throw new PrivilegedActionExecutionError(
        'PRIVILEGED_RECOVERY_NOT_RUN',
        'Startup recovery must complete before privileged work can be claimed.'
      );
    }
    this.started = true;
    this.wake();
  }

  async close() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const hadActiveWork = this.active.size > 0 ||
      this.store.listProcessRecoveryRecords().length > 0;
    if (hadActiveWork) {
      this.store.setRecoveryBarrier({
        reason: 'privileged_broker_shutdown_with_active_process',
        source: 'root_broker_shutdown',
        details: { activeRunCount: this.active.size },
      });
    }
    this.cancelAll();
    await Promise.allSettled([...this.activeRuns]);
    const barrierWasSet = hadActiveWork || this.store.getPanicStatus().recoveryBlocked;
    const recovery = await this._recoverProcessRecords({
      actor: 'root_broker_shutdown',
      clearBarrier: barrierWasSet,
    });
    if (!recovery.quiesced) {
      this.store.setRecoveryBarrier({
        reason: 'privileged_broker_shutdown_quiescence_unresolved',
        source: 'root_broker_shutdown',
        details: { unresolvedProcessCount: recovery.unresolvedProcessIds.length },
      });
    }
    return {
      safeToClose: recovery.quiesced,
      quiesced: recovery.quiesced,
      unresolvedProcessIds: recovery.unresolvedProcessIds,
    };
  }

  getReadiness() {
    const panic = this.store.getPanicStatus();
    const ready = this.recoveryAttempted && this.recoveryResolved &&
      !panic.locked && !panic.recoveryBlocked;
    return {
      ready,
      recoveryAttempted: this.recoveryAttempted,
      recoveryResolved: this.recoveryResolved,
      panicLocked: panic.locked,
      recoveryBlocked: panic.recoveryBlocked,
    };
  }

  async recoverStartup() {
    if (this.recoveryAttempted) return this.recoveryResult;
    this.recoveryAttempted = true;
    let scan;
    let scanError = null;
    try {
      scan = this.processOperations.scan();
    } catch (error) {
      scan = [];
      scanError = error;
    }
    const activeActionCount = this.store.countActiveActions();
    const processRecords = this.store.listProcessRecoveryRecords();
    const existingPanic = this.store.getPanicStatus();
    const needsRecovery = activeActionCount > 0 || processRecords.length > 0 ||
      scan.length > 0 || scanError || existingPanic.recoveryBlocked;
    if (!needsRecovery) {
      this.recoveryResolved = true;
      this.recoveryResult = {
        attempted: true,
        required: false,
        quiesced: true,
        recoveredActionIds: [],
        unresolvedProcessIds: [],
      };
      return this.recoveryResult;
    }

    this.store.setRecoveryBarrier({
      reason: 'privileged_child_recovery_required',
      source: 'root_broker_recovery',
      details: {
        activeActionCount,
        durableProcessCount: processRecords.length,
        markedProcessCount: scan.length,
        scanFailed: Boolean(scanError),
        recoveryBarrierReasserted: existingPanic.recoveryBlocked,
      },
    });
    const recoveredActionIds = this.store.recoverInterrupted();
    if (scanError) {
      this.recoveryResolved = false;
      this.recoveryResult = {
        attempted: true,
        required: true,
        quiesced: false,
        recoveredActionIds,
        unresolvedProcessIds: processRecords.map((record) => record.processId),
        errorCode: scanError.code || 'PRIVILEGED_PROCESS_SCAN_INCOMPLETE',
      };
      return this.recoveryResult;
    }
    const recovery = await this._recoverProcessRecords({
      actor: 'root_broker_recovery',
      initialScan: scan,
      clearBarrier: true,
    });
    this.recoveryResolved = recovery.quiesced;
    this.recoveryResult = {
      attempted: true,
      required: true,
      recoveredActionIds,
      ...recovery,
    };
    return this.recoveryResult;
  }

  wake() {
    if (!this.started || this.timer || this.runningLoop) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this._loop();
    }, 0);
    this.timer.unref?.();
  }

  async _loop() {
    if (!this.started || this.runningLoop) return;
    this.runningLoop = true;
    try {
      while (this.started) {
        const handled = await this.runOnce();
        if (!handled) break;
      }
    } finally {
      this.runningLoop = false;
      if (this.started && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this._loop();
        }, this.pollMs);
        this.timer.unref?.();
      }
    }
  }

  cancel(actionId) {
    this.active.get(actionId)?.abort();
  }

  cancelAll(actionIds = null) {
    const allowed = actionIds ? new Set(actionIds) : null;
    for (const [actionId, controller] of this.active.entries()) {
      if (!allowed || allowed.has(actionId)) controller.abort();
    }
  }

  _inspectProcessRecord(record, scan = null) {
    const marked = scan || this.processOperations.scan();
    const matches = marked.filter((entry) => entry.markerHash === record.markerHash);
    let direct = null;
    if (record.pid) direct = this.processOperations.identity(record.pid);
    let trustedDirect = false;
    if (direct && record.processStartTicks) {
      trustedDirect = direct.uid === this.processUid &&
        direct.processStartTicks === record.processStartTicks &&
        direct.processGroupId === record.processGroupId;
      if (direct.processStartTicks === record.processStartTicks && !trustedDirect) {
        return { status: 'blocked', reason: 'persisted_process_identity_mismatch' };
      }
    }
    for (const entry of matches) {
      if (entry.uid !== this.processUid || !entry.staticMarker || !entry.markerHash) {
        return { status: 'blocked', reason: 'marked_process_identity_mismatch' };
      }
    }
    const groups = new Set(matches.map((entry) => entry.processGroupId));
    if (trustedDirect) groups.add(direct.processGroupId);
    if (groups.size > 1) {
      return { status: 'blocked', reason: 'marker_spans_multiple_process_groups' };
    }
    let processGroupId = groups.size === 1 ? [...groups][0] : null;
    if (record.processGroupId) {
      if (processGroupId && processGroupId !== record.processGroupId) {
        return { status: 'blocked', reason: 'persisted_process_group_mismatch' };
      }
      processGroupId = record.processGroupId;
    }
    if (!processGroupId) {
      return matches.length === 0
        ? { status: 'quiesced', observedLive: false }
        : { status: 'blocked', reason: 'process_group_unavailable' };
    }
    const groupExists = this.processOperations.groupExists(processGroupId);
    if (!groupExists) {
      return matches.length === 0
        ? { status: 'quiesced', observedLive: false, processGroupId }
        : { status: 'blocked', reason: 'marker_present_without_process_group' };
    }
    if (!trustedDirect && matches.length === 0) {
      return { status: 'blocked', reason: 'live_process_group_has_no_bound_identity' };
    }
    return {
      status: 'live',
      observedLive: true,
      processGroupId,
      matchingPids: matches.map((entry) => entry.pid),
    };
  }

  async _waitForProcessGroupExit(processGroupId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.processOperations.groupExists(processGroupId)) {
      if (Date.now() >= deadline) return false;
      await delay(this.terminationPollMs);
    }
    return true;
  }

  async _terminateProcessRecord(record, { actor, initialScan = null } = {}) {
    let inspection;
    try {
      inspection = this._inspectProcessRecord(record, initialScan);
      if (inspection.status === 'live') {
        let killEscalated = false;
        this.processOperations.signalGroup(inspection.processGroupId, 'SIGTERM');
        let exited = await this._waitForProcessGroupExit(
          inspection.processGroupId,
          this.terminationGraceMs
        );
        if (!exited) {
          killEscalated = true;
          this.processOperations.signalGroup(inspection.processGroupId, 'SIGKILL');
          exited = await this._waitForProcessGroupExit(
            inspection.processGroupId,
            this.terminationGraceMs
          );
        }
        if (!exited) {
          inspection = { ...inspection, status: 'blocked', reason: 'process_group_survived_sigkill' };
        } else {
          const remaining = this.processOperations.scan()
            .filter((entry) => entry.markerHash === record.markerHash);
          inspection = remaining.length === 0
            ? { ...inspection, status: 'quiesced', terminated: true, killEscalated }
            : { ...inspection, status: 'blocked', reason: 'marked_process_survived_group_exit' };
        }
      }
    } catch (error) {
      inspection = {
        status: 'blocked',
        reason: error.code || 'process_recovery_inspection_failed',
      };
    }
    if (inspection.status === 'quiesced') {
      this.store.recordProcessQuiesced({
        processId: record.processId,
        markerHash: record.markerHash,
        actor,
        evidence: {
          verified_zero: true,
          process_group_id: inspection.processGroupId || record.processGroupId || null,
          terminated: Boolean(inspection.terminated),
          sigkill_escalated: Boolean(inspection.killEscalated),
        },
      });
      return {
        quiesced: true,
        observedLive: Boolean(inspection.observedLive),
        terminated: Boolean(inspection.terminated),
        killEscalated: Boolean(inspection.killEscalated),
      };
    }
    if (record.state !== 'quiesced') {
      this.store.markProcessRecoveryBlocked({
        processId: record.processId,
        actor,
        reason: inspection.reason || 'process_quiescence_unverified',
        evidence: { verified_zero: false },
      });
    }
    return {
      quiesced: false,
      observedLive: Boolean(inspection.observedLive),
      reason: inspection.reason || 'process_quiescence_unverified',
    };
  }

  async _recoverProcessRecords({ actor, initialScan = null, clearBarrier = false } = {}) {
    let scan = initialScan;
    try {
      if (!scan) scan = this.processOperations.scan();
    } catch (error) {
      return {
        quiesced: false,
        unresolvedProcessIds: this.store.listProcessRecoveryRecords()
          .map((record) => record.processId),
        errorCode: error.code || 'PRIVILEGED_PROCESS_SCAN_INCOMPLETE',
      };
    }
    const everyRecord = this.store.listProcessRecoveryRecords({ includeQuiesced: true });
    const recordsByMarker = new Map(everyRecord.map((record) => [record.markerHash, record]));
    const unknownMarked = scan.filter((entry) =>
      !entry.markerHash || !recordsByMarker.has(entry.markerHash)
    );
    const pending = this.store.listProcessRecoveryRecords();
    const pendingIds = new Set(pending.map((record) => record.processId));
    for (const entry of scan) {
      const record = entry.markerHash ? recordsByMarker.get(entry.markerHash) : null;
      if (record && !pendingIds.has(record.processId)) {
        pending.push(record);
        pendingIds.add(record.processId);
      }
    }
    const unresolved = [];
    for (const record of pending) {
      const result = await this._terminateProcessRecord(record, { actor, initialScan: scan });
      if (!result.quiesced) unresolved.push(record.processId);
      try {
        scan = this.processOperations.scan();
      } catch {
        unresolved.push(record.processId);
      }
    }
    let finalScan = [];
    try {
      finalScan = this.processOperations.scan();
    } catch {
      unresolved.push('process_scan');
    }
    const remainingRecords = this.store.listProcessRecoveryRecords();
    const finalUnknown = finalScan.filter((entry) =>
      !entry.markerHash || !recordsByMarker.has(entry.markerHash)
    );
    const unresolvedProcessIds = [...new Set([
      ...unresolved,
      ...remainingRecords.map((record) => record.processId),
      ...unknownMarked.map((entry) => `unknown:${entry.pid}`),
      ...finalUnknown.map((entry) => `unknown:${entry.pid}`),
    ])];
    const quiesced = unresolvedProcessIds.length === 0 && finalScan.length === 0;
    if (quiesced && clearBarrier) {
      this.store.clearRecoveryBarrier({
        source: actor,
        activeChildCount: 0,
        details: { verifiedMarkedChildCount: 0 },
      });
    }
    return { quiesced, unresolvedProcessIds };
  }

  _assertSpawnIdentity(child, markerHash) {
    const identity = this.processOperations.identity(child?.pid);
    const markerVerified = identity?.staticMarker && identity.markerHash === markerHash;
    const exitedBeforeMarkerRead = ['Z', 'X'].includes(identity?.processState) &&
      identity.environmentReadable === false;
    if (!identity || identity.uid !== this.processUid ||
        (!markerVerified && !exitedBeforeMarkerRead) || identity.processGroupId !== child.pid) {
      executionError(
        'PRIVILEGED_PROCESS_IDENTITY_INVALID',
        'The spawned root process could not be bound to its exact Linux identity and marker.'
      );
    }
    return identity;
  }

  async _runTrackedProcess({
    action,
    leaseToken,
    purpose,
    argv,
    cwd,
    timeoutSeconds,
    signal,
  }) {
    const marker = processMarker();
    const markerHash = sha256(marker);
    const processId = `pproc_${crypto.randomUUID().replaceAll('-', '')}`;
    const digest = argvDigest(argv);
    this.store.prepareProcessExecution({
      actionId: action.id,
      leaseToken,
      workerId: this.workerId,
      processId,
      purpose,
      markerHash,
      argvHash: digest,
    });
    let processSpawned = false;
    try {
      const result = await runExactProcess(argv, {
        cwd,
        timeoutSeconds,
        signal,
        spawnImpl: this.spawnImpl,
        childMarker: marker,
        onSpawn: (child) => {
          processSpawned = true;
          const identity = this._assertSpawnIdentity(child, markerHash);
          this.store.recordProcessSpawned({
            actionId: action.id,
            leaseToken,
            workerId: this.workerId,
            processId,
            markerHash,
            pid: identity.pid,
            processStartTicks: identity.processStartTicks,
            processGroupId: identity.processGroupId,
          });
        },
      });
      const recovery = await this._terminateProcessRecord(
        this.store.getProcessRecord(processId),
        { actor: this.workerId }
      );
      if (!recovery.quiesced) {
        this.store.setRecoveryBarrier({
          reason: 'privileged_child_quiescence_unverified',
          source: this.workerId,
          details: { actionId: action.id, processId, purpose },
        });
        const error = new PrivilegedActionExecutionError(
          'PRIVILEGED_PROCESS_QUIESCENCE_UNVERIFIED',
          'The privileged process group could not be verified quiescent.'
        );
        error.processSpawned = true;
        throw error;
      }
      return {
        ...result,
        residualProcessGroupTerminated: recovery.terminated,
      };
    } catch (error) {
      const record = this.store.getProcessRecord(processId);
      if (record?.state !== 'quiesced') {
        const recovery = await this._terminateProcessRecord(record, { actor: this.workerId });
        if (!recovery.quiesced) {
          this.store.setRecoveryBarrier({
            reason: 'privileged_child_quiescence_unverified',
            source: this.workerId,
            details: { actionId: action.id, processId, purpose },
          });
        }
        if (recovery.observedLive) processSpawned = true;
      }
      if (processSpawned) error.processSpawned = true;
      throw error;
    }
  }

  runOnce() {
    const promise = this._runOnce();
    this.activeRuns.add(promise);
    promise.finally(() => this.activeRuns.delete(promise)).catch(() => {});
    return promise;
  }

  async _runOnce() {
    const claim = this.store.claimNext({ workerId: this.workerId });
    if (!claim) return false;
    const { action, leaseToken } = claim;
    const controller = new AbortController();
    this.active.set(action.id, controller);
    try {
      const current = this.store.getAction(action.id);
      if (current.state === 'cancel_requested') {
        this.store.acknowledgeCanceled({
          actionId: action.id, leaseToken, workerId: this.workerId,
          result: { success: false, canceled: true, before_spawn: true },
        });
        return true;
      }
      const plan = validateExecutionBoundary(action.plan, this.policy, {
        expectedUid: this.expectedUid,
      });
      const main = await this._runTrackedProcess({
        action,
        leaseToken,
        purpose: 'main',
        argv: plan.argv,
        cwd: plan.cwd,
        timeoutSeconds: plan.timeout_seconds,
        signal: controller.signal,
      });
      if (main.aborted || main.timedOut || main.residualProcessGroupTerminated ||
          this.store.getAction(action.id)?.state === 'cancel_requested') {
        this.store.markOutcomeUnknown({
          actionId: action.id, leaseToken, workerId: this.workerId,
          errorCode: main.timedOut
            ? 'PRIVILEGED_ACTION_TIMEOUT_OUTCOME_UNKNOWN'
            : (main.residualProcessGroupTerminated
              ? 'PRIVILEGED_RESIDUAL_PROCESS_OUTCOME_UNKNOWN'
              : 'PRIVILEGED_ACTION_CANCELED_OUTCOME_UNKNOWN'),
          errorMessage: main.timedOut
            ? 'The privileged process exceeded its timeout after execution began; its effect is unknown.'
            : (main.residualProcessGroupTerminated
              ? 'The approved process left a live process group that was terminated; its effect is unknown.'
              : 'Cancellation arrived after privileged execution began; its effect is unknown.'),
          result: {
            success: false,
            outcome_unknown: true,
            cancellation_requested: Boolean(main.aborted),
            execution: persistedExecution(main),
          },
        });
        return true;
      }
      if (main.exitCode !== plan.expected_result.require_exit_code) {
        this.store.markOutcomeUnknown({
          actionId: action.id,
          leaseToken,
          workerId: this.workerId,
          errorCode: 'PRIVILEGED_ACTION_EXIT_NONZERO_OUTCOME_UNKNOWN',
          errorMessage: `The exact privileged process exited with code ${main.exitCode} after execution began; its effect is unknown.`,
          result: {
            success: false,
            outcome_unknown: true,
            argv_sha256: executionDigest(plan),
            execution: persistedExecution(main),
          },
        });
        return true;
      }
      let observation = null;
      if (plan.expected_result.observe_argv) {
        assertSecureRootPath(plan.expected_result.observe_argv[0], {
          executable: true,
          expectedUid: this.expectedUid,
        });
        observation = await this._runTrackedProcess({
          action,
          leaseToken,
          purpose: 'observation',
          argv: plan.expected_result.observe_argv,
          cwd: plan.cwd,
          timeoutSeconds: Math.min(plan.timeout_seconds, 60),
          signal: controller.signal,
        });
        if (observation.aborted || observation.timedOut ||
            observation.residualProcessGroupTerminated ||
            observation.exitCode !== plan.expected_result.require_exit_code) {
          this.store.markOutcomeUnknown({
            actionId: action.id,
            leaseToken,
            workerId: this.workerId,
            errorCode: observation.timedOut
              ? 'PRIVILEGED_OBSERVATION_TIMEOUT_OUTCOME_UNKNOWN'
              : 'PRIVILEGED_OBSERVATION_FAILED_OUTCOME_UNKNOWN',
            errorMessage: 'The action process exited zero, but the approved postcondition could not be verified.',
            result: {
              success: false,
              outcome_unknown: true,
              main_execution_succeeded: true,
              argv_sha256: executionDigest(plan),
              execution: persistedExecution(main),
              observable: persistedExecution(observation),
            },
          });
          return true;
        }
      }
      this.store.completeAction({
        actionId: action.id,
        leaseToken,
        workerId: this.workerId,
        result: {
          success: true,
          argv_sha256: executionDigest(plan),
          execution: persistedExecution(main),
          observable: persistedExecution(observation),
          expected: plan.expected_result.description,
        },
      });
    } catch (error) {
      const latest = this.store.getAction(action.id);
      if (latest && !latest.terminal) {
        try {
          if (error.processSpawned === true || latest.execution?.stage === 'process_spawned') {
            this.store.markOutcomeUnknown({
              actionId: action.id, leaseToken, workerId: this.workerId,
              errorCode: 'PRIVILEGED_ACTION_OUTCOME_UNKNOWN',
              errorMessage: 'Privileged execution began, but its exact terminal outcome was not verified.',
              result: {
                success: false,
                outcome_unknown: true,
                cancellation_requested: latest.state === 'cancel_requested' || controller.signal.aborted,
              },
            });
          } else {
            this.store.failAction({
              actionId: action.id,
              leaseToken,
              workerId: this.workerId,
              errorCode: error.code || 'PRIVILEGED_ACTION_EXECUTION_FAILED',
              errorMessage: error.message,
              result: { success: false },
            });
          }
        } catch {
          // A concurrent terminal CAS wins. Never retry the external action.
        }
      }
    } finally {
      this.active.delete(action.id);
    }
    return true;
  }
}

module.exports = {
  FIXED_ENVIRONMENT,
  MAX_OUTPUT_BYTES,
  PROCESS_MARKER_NAME,
  PrivilegedActionDispatcher,
  PrivilegedActionExecutionError,
  assertSecureRootPath,
  createLinuxProcessOperations,
  markerFromEnvironment,
  outputCollector,
  parseLinuxProcStat,
  persistedExecution,
  runExactProcess,
  validateExecutionBoundary,
};
