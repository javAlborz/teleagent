#!/usr/bin/env node
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SOCKETS = Object.freeze({
  claude: '/run/teleagent-provider-launch/claude.sock',
  codex: '/run/teleagent-provider-launch/codex.sock',
});
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_DECODED_FRAME_BYTES = 64 * 1024;
const MAX_LAUNCH_OUTPUT_BYTES = 8 * 1024 * 1024;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROOT_BOUNDARY = '/usr/local/libexec/teleagent-provider-boundary';

function fail(message, code = 78) {
  const error = Object.assign(new Error(message), { exitCode: code });
  throw error;
}

function take(options, name, { required = true } = {}) {
  const indexes = options.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length === 0 && !required) return null;
  if (indexes.length !== 1 || indexes[0] + 1 >= options.length) fail(`${name} is invalid`);
  const index = indexes[0];
  const value = options[index + 1];
  options.splice(index, 2);
  return value;
}

function parseInvocation(argv) {
  const separator = argv.indexOf('--');
  const options = separator >= 0 ? argv.slice(0, separator) : [...argv];
  const args = separator >= 0 ? argv.slice(separator + 1) : [];
  const provider = take(options, '--provider');
  const mode = take(options, '--mode');
  const accessMode = take(options, '--access-mode');
  const cwd = path.resolve(take(options, '--workspace'));
  const taskId = take(options, '--task-id', { required: false });
  const sessionId = take(options, '--session-id', { required: false });
  if (options.length !== 0 || !SOCKETS[provider] || !['managed', 'interactive'].includes(mode) ||
      !['read-only', 'mutating'].includes(accessMode) ||
      mode === 'interactive') {
    fail('only one exact provider, mode, workspace, task, and session may be supplied');
  }
  if (!cwd.startsWith('/srv/teleagent-agent-workspaces/') ||
      !/^[A-Za-z0-9_./-]+$/.test(cwd)) fail('workspace is outside the fixed root');
  if (taskId && !SAFE_TASK_ID.test(taskId)) fail('task ID is invalid');
  if (mode === 'interactive') fail('persistent interactive provider sessions are disabled');
  if (mode === 'managed' && sessionId) fail('managed mode cannot accept a provider session ID');
  if (args.length > 256 || args.some((arg) => (
    arg.length > 8192 || /[\0\r\n]/.test(arg)
  ))) fail('provider arguments exceed the fixed bound');
  return {
    provider, mode, accessMode, cwd,
    taskId: taskId || null, sessionId: sessionId || null, args,
  };
}

function frame(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

function decodeOutputFrame(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_DECODED_FRAME_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('provider output frame encoding is invalid');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_DECODED_FRAME_BYTES || bytes.toString('base64') !== value) {
    throw new Error('provider output frame exceeded decoded bound');
  }
  return bytes;
}

function writeStatusAndAwaitParentAck(value, {
  statusFd = 3,
  acknowledgementFd = 4,
} = {}) {
  fs.writeSync(statusFd, `${JSON.stringify(value)}\n`);
  if (value?.accepted !== true) return true;
  const chunks = [];
  let bytes = 0;
  while (bytes <= 1024) {
    const buffer = Buffer.alloc(Math.min(256, 1025 - bytes));
    const count = fs.readSync(acknowledgementFd, buffer, 0, buffer.length, null);
    if (count <= 0) return false;
    chunks.push(buffer.subarray(0, count));
    bytes += count;
    const joined = Buffer.concat(chunks);
    const newline = joined.indexOf(0x0a);
    if (newline < 0) continue;
    if (newline !== joined.length - 1) return false;
    try {
      const ack = JSON.parse(joined.subarray(0, newline).toString('utf8'));
      return ack?.version === 1 && ack.statusPersisted === true &&
        ack.launchId === value.launchId;
    } catch {
      return false;
    }
  }
  return false;
}

function requestProviderControl(provider, control, { timeoutMs = 7000 } = {}) {
  if (!SOCKETS[provider] || !control || typeof control !== 'object') {
    return Promise.reject(new Error('provider supervisor control request is invalid'));
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: SOCKETS[provider] });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(
      () => socket.destroy(new Error('provider supervisor control request timed out')),
      timeoutMs
    );
    socket.once('close', () => clearTimeout(timer));
    socket.once('connect', () => frame(socket, { version: 1, ...control }));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) socket.destroy(new Error('provider supervisor health exceeded bound'));
      else chunks.push(chunk);
    });
    socket.once('error', reject);
    socket.once('end', () => {
      clearTimeout(timer);
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function probeProvider(provider, options = {}) {
  const payload = await requestProviderControl(provider, { type: 'health' }, options);
  if (payload?.success !== true || payload?.provider !== provider || payload?.ready !== true) {
    throw new Error('provider supervisor health identity mismatch');
  }
  return payload;
}

async function probeProviderSupervisors(options) {
  const [claude, codex] = await Promise.all([
    probeProvider('claude', options),
    probeProvider('codex', options),
  ]);
  return { ready: true, claude, codex };
}

async function panicProviderSupervisors({
  reason = 'worker_session_panic',
  source = 'controller',
  timeoutMs = 7000,
} = {}) {
  const results = await Promise.all(['claude', 'codex'].map(async (provider) => {
    const payload = await requestProviderControl(provider, {
      type: 'panic',
      reason: String(reason).slice(0, 160),
      source: String(source).slice(0, 80),
    }, { timeoutMs });
    return [provider, payload];
  }));
  const providers = Object.fromEntries(results);
  const accepted = results.every(([, result]) => (
    result?.accepted === true && result?.persisted === true
  ));
  const quiesced = accepted && results.every(([, result]) => result?.quiesced === true);
  return { success: quiesced, accepted, persisted: accepted, quiesced, providers };
}

async function unlockProviderSupervisors({ timeoutMs = 7000 } = {}) {
  const results = await Promise.all(['claude', 'codex'].map(async (provider) => {
    const payload = await requestProviderControl(provider, { type: 'unlock' }, { timeoutMs });
    return [provider, payload];
  }));
  const providers = Object.fromEntries(results);
  const success = results.every(([, result]) => (
    result?.success === true && result?.persisted === true && result?.quiesced === true
  ));
  return { success, quiesced: success, providers };
}

function requestRootProviderPlane(action, {
  execFileImpl = execFile,
  timeoutMs = 60_000,
} = {}) {
  if (!['panic-all', 'recover-root-panic'].includes(action)) {
    return Promise.reject(new Error('root provider-plane action is invalid'));
  }
  return new Promise((resolve, reject) => {
    execFileImpl('/usr/bin/sudo', ['-n', ROOT_BOUNDARY, '--action', action], {
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      encoding: 'utf8',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    }, (error, stdout) => {
      let payload;
      try { payload = JSON.parse(String(stdout || '').trim()); }
      catch { return reject(new Error('root provider-plane response is invalid')); }
      if (error && payload?.quiesced !== true) {
        return reject(new Error('root provider-plane control failed'));
      }
      resolve(payload);
    });
  });
}

const panicProviderPlaneRoot = (options) => requestRootProviderPlane('panic-all', options);
const unlockProviderPlaneRoot = (options) => requestRootProviderPlane(
  'recover-root-panic', options
);

function runClient(invocation, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  createSocket = (socketPath) => net.createConnection({ path: socketPath }),
  statusWriter = null,
} = {}) {
  const socket = createSocket(SOCKETS[invocation.provider]);
  let buffer = Buffer.alloc(0);
  let terminal = false;
  let accepted = false;
  let statusReported = false;
  let inputForwarding = false;
  let outputBytes = 0;
  const reportStatus = (value) => {
    if (statusReported) return false;
    statusReported = true;
    if (typeof statusWriter === 'function') return statusWriter(value) === true;
    else {
      try { return writeStatusAndAwaitParentAck(value); }
      catch { return false; }
    }
  };
  const startInputForwarding = () => {
    if (inputForwarding || terminal || socket.destroyed) return;
    inputForwarding = true;
    stdin.on('data', (chunk) => frame(socket, {
      version: 1,
      type: 'stdin',
      data: Buffer.from(chunk).toString('base64'),
    }));
    stdin.once('end', () => frame(socket, { version: 1, type: 'stdin_end' }));
    stdin.resume();
  };
  socket.once('connect', () => {
    frame(socket, { version: 1, type: 'start', ...invocation });
    if (invocation.mode === 'interactive' && stdout.columns && stdout.rows) {
      frame(socket, { version: 1, type: 'resize', columns: stdout.columns, rows: stdout.rows });
    }
  });
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES) return socket.destroy(new Error('provider frame exceeded bound'));
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      let payload;
      try { payload = JSON.parse(line.toString('utf8')); }
      catch { return socket.destroy(new Error('provider supervisor returned invalid JSON')); }
      if (payload.type === 'accepted') {
        accepted = true;
        const acknowledged = reportStatus({
          version: 1,
          accepted: true,
          launchId: String(payload.launchId || ''),
        });
        if (!acknowledged) {
          accepted = false;
          terminal = true;
          process.exitCode = 78;
          frame(socket, { version: 1, type: 'signal', signal: 'SIGTERM' });
          socket.end();
          continue;
        }
        startInputForwarding();
      }
      else if (['stdout', 'stderr'].includes(payload.type)) {
        let bytes;
        try { bytes = decodeOutputFrame(payload.data); }
        catch {
          terminal = true;
          process.exitCode = 78;
          frame(socket, { version: 1, type: 'signal', signal: 'SIGTERM' });
          socket.destroy();
          continue;
        }
        outputBytes += bytes.length;
        if (outputBytes > MAX_LAUNCH_OUTPUT_BYTES) {
          terminal = true;
          process.exitCode = 78;
          frame(socket, { version: 1, type: 'signal', signal: 'SIGTERM' });
          socket.destroy();
          continue;
        }
        (payload.type === 'stdout' ? stdout : stderr).write(bytes);
      } else if (payload.type === 'exit') {
        terminal = true;
        process.exitCode = Number.isInteger(payload.code) ? payload.code : 1;
        socket.end();
      } else if (payload.type === 'error') {
        terminal = true;
        reportStatus({
          version: 1,
          accepted: false,
          code: String(payload.code || 'PROVIDER_LAUNCH_DENIED'),
          providerStarted: payload.providerStarted === true,
          providerExecutionAttempted:
            payload.code === 'PROVIDER_EXECUTION_OUTCOME_UNKNOWN',
          retrySafe: payload.retrySafe === true,
          quiesced: payload.quiesced === true,
          launchId: typeof payload.launchId === 'string' ? payload.launchId : null,
        });
        stderr.write(`Provider supervisor refused the launch (${String(payload.code || 'DENIED')}).\n`);
        process.exitCode = 78;
        socket.end();
      }
    }
  });
  socket.once('error', () => {
    if (!terminal) process.exitCode = 78;
  });
  socket.once('close', () => {
    if (!terminal) process.exitCode = accepted ? 75 : 78;
  });
  process.on('SIGWINCH', () => {
    if (stdout.columns && stdout.rows && !socket.destroyed) {
      frame(socket, { version: 1, type: 'resize', columns: stdout.columns, rows: stdout.rows });
    }
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      if (!socket.destroyed) frame(socket, { version: 1, type: 'signal', signal });
    });
  }
  return socket;
}

if (require.main === module) {
  try { runClient(parseInvocation(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`Provider supervisor client refused: ${error.message}\n`);
    process.exit(error.exitCode || 78);
  }
}

module.exports = {
  SOCKETS,
  panicProviderSupervisors,
  panicProviderPlaneRoot,
  unlockProviderPlaneRoot,
  decodeOutputFrame,
  parseInvocation,
  probeProvider,
  probeProviderSupervisors,
  requestProviderControl,
  requestRootProviderPlane,
  runClient,
  writeStatusAndAwaitParentAck,
  unlockProviderSupervisors,
};
