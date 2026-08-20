'use strict';

const crypto = require('node:crypto');
const fsNative = require('node:fs');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const readline = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const {
  extractClaudeMessage,
  extractCodexMessage,
  redactSensitiveText,
} = require('./operator-inspector');

const execFileAsync = promisify(execFile);
const EXACT_TMUX_TARGET = /^(?:%[0-9]+|[A-Za-z0-9_.+-]+:[A-Za-z0-9_.+-]+(?:\.[0-9]+)?)$/;
const MAX_TARGET_MESSAGE_CHARS = 4000;
const MAX_WATCH_CHUNK_BYTES = 1024 * 1024;
const MAX_WATCH_LINE_CHARS = 4 * 1024 * 1024;
const MAX_SESSION_LOG_BYTES = 256 * 1024 * 1024;

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeTargetMessage(message) {
  const value = String(message || '').trim();
  if (!value) throw codedError('A message for the target agent session is required.', 'TARGET_MESSAGE_REQUIRED');
  if (value.includes('\0')) throw codedError('The target message contains unsupported control data.', 'INVALID_TARGET_MESSAGE');
  if (value.length > MAX_TARGET_MESSAGE_CHARS) {
    throw codedError(
      `The target message exceeds ${MAX_TARGET_MESSAGE_CHARS} characters.`,
      'TARGET_MESSAGE_TOO_LONG'
    );
  }
  return value;
}

function normalizeMessageForMatch(message) {
  return String(message || '')
    .normalize('NFKC')
    .replaceAll(/[\u200B-\u200D\uFEFF]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function clipVerifiedResponse(message, max = 8000) {
  const redacted = redactSensitiveText(message).trim();
  return redacted.length > max ? `${redacted.slice(0, max)}\n[response clipped]` : redacted;
}

function spawnWithInput(command, args, input, { timeoutMs = 5000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(codedError(`${command} timed out while receiving private input.`, 'TMUX_INPUT_TIMEOUT'));
    }, timeoutMs);
    child.once('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('close', (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) finish(null, result);
      else {
        const error = codedError(`${command} exited with status ${code}.`, 'TMUX_INPUT_FAILED');
        Object.assign(error, result);
        finish(error);
      }
    });
    child.stdin.once('error', (error) => finish(error));
    child.stdin.end(Buffer.from(input, 'utf8'));
  });
}

function finalProviderMessage(record, provider) {
  if (provider === 'codex') {
    if (record?.type === 'response_item' && record.payload?.type === 'message' &&
        record.payload?.role === 'assistant' && record.payload?.phase === 'final_answer') {
      return extractCodexMessage(record);
    }
    return null;
  }
  if (record?.type === 'assistant' && record.message?.role === 'assistant' &&
      record.message?.stop_reason === 'end_turn') {
    return extractClaudeMessage(record);
  }
  return null;
}

function updateProviderActivityState(state, record, provider) {
  const next = state || { busy: false, observed: false };
  if (provider === 'codex') {
    const eventType = record?.type === 'event_msg' ? record.payload?.type : null;
    if (eventType === 'task_started') {
      next.busy = true;
      next.observed = true;
      next.taskMarkersObserved = true;
      return next;
    }
    if (['task_complete', 'turn_aborted', 'task_canceled', 'task_cancelled'].includes(eventType)) {
      next.busy = false;
      next.observed = true;
      next.taskMarkersObserved = true;
      return next;
    }
    const message = extractCodexMessage(record);
    if (message?.role === 'user') {
      next.busy = true;
      next.observed = true;
    } else if (!next.taskMarkersObserved && finalProviderMessage(record, provider)) {
      next.busy = false;
      next.observed = true;
    }
    return next;
  }

  const message = extractClaudeMessage(record);
  if (message?.role === 'user') {
    next.busy = true;
    next.observed = true;
  } else if (message?.role === 'assistant') {
    next.busy = record.message?.stop_reason !== 'end_turn';
    next.observed = true;
  }
  return next;
}

async function readProviderActivityState(filename, provider) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) {
    throw codedError('The provider session log is unavailable.', 'SESSION_LOG_NOT_FOUND');
  }
  if (stat.size > MAX_SESSION_LOG_BYTES) {
    throw codedError('The provider session log exceeds the activity-check limit.', 'SESSION_LOG_TOO_LARGE');
  }
  const state = { busy: false, observed: false, taskMarkersObserved: false, parseErrors: 0 };
  const stream = fsNative.createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line || line.length > MAX_WATCH_LINE_CHARS) continue;
      try {
        updateProviderActivityState(state, JSON.parse(line), provider);
      } catch {
        state.parseErrors += 1;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { ...state, offset: stat.size };
}

class JsonlAppendReader {
  constructor(filename, offset) {
    this.filename = filename;
    this.offset = offset;
    this.carry = '';
    this.decoder = new StringDecoder('utf8');
    this.parseErrors = 0;
  }

  async read() {
    const stat = await fs.stat(this.filename);
    if (stat.size < this.offset) {
      throw codedError('The provider session log changed while waiting for a response.', 'TARGET_SESSION_LOG_CHANGED');
    }
    if (stat.size === this.offset) return [];

    const records = [];
    const handle = await fs.open(this.filename, 'r');
    try {
      while (this.offset < stat.size) {
        const length = Math.min(MAX_WATCH_CHUNK_BYTES, stat.size - this.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const decoded = `${this.carry}${this.decoder.write(buffer.subarray(0, bytesRead))}`;
        const lines = decoded.split('\n');
        this.carry = lines.pop() || '';
        for (const line of lines) {
          if (!line || line.length > MAX_WATCH_LINE_CHARS) continue;
          try {
            records.push(JSON.parse(line));
          } catch {
            this.parseErrors += 1;
          }
        }
      }
    } finally {
      await handle.close();
    }
    return records;
  }
}

class TmuxAgentController {
  constructor({
    inspector,
    execFileImpl = execFileAsync,
    inputCommandImpl = spawnWithInput,
    pollIntervalMs = 250,
  } = {}) {
    if (!inspector) throw new Error('TmuxAgentController requires an OperatorInspector');
    this.inspector = inspector;
    this.execFile = execFileImpl;
    this.inputCommand = inputCommandImpl;
    this.pollIntervalMs = Math.max(25, Number.parseInt(pollIntervalMs, 10) || 250);
  }

  _validateTarget(target) {
    const value = String(target || '').trim();
    if (!EXACT_TMUX_TARGET.test(value)) {
      throw codedError(
        'An exact tmux session/window target or stable pane ID is required, such as main:phone or %42.',
        'EXACT_TMUX_TARGET_REQUIRED'
      );
    }
    return value;
  }

  async prepare({ target } = {}) {
    const requestedTarget = this._validateTarget(target);
    const resolved = await this.inspector.resolveAgentSessionTarget(requestedTarget);
    const activity = await readProviderActivityState(
      resolved.resolved.filename,
      resolved.inspected.pane.agent
    );
    return {
      requested_target: requestedTarget,
      target: resolved.inspected.pane.target,
      stable_target: resolved.inspected.pane.stable_target || resolved.inspected.pane.pane_id,
      named_target: resolved.inspected.pane.named_target || null,
      provider: resolved.inspected.pane.agent,
      conversation_name: resolved.inspected.pane.ai_session_name ||
        resolved.inspected.pane.window_name || null,
      agent_running: true,
      agent_busy: activity.busy,
      ready_for_message: !activity.busy,
      session_fingerprint: resolved.sessionFingerprint,
      resolution: resolved.resolved.resolution,
    };
  }

  async _pasteAndSubmit(target, message) {
    const bufferName = `teleagent-${crypto.randomBytes(8).toString('hex')}`;
    let loaded = false;
    try {
      await this.inputCommand('tmux', ['load-buffer', '-b', bufferName, '-'], message, { timeoutMs: 5000 });
      loaded = true;
      await this.execFile('tmux', ['paste-buffer', '-p', '-b', bufferName, '-t', target], {
        timeout: 5000,
        maxBuffer: 4096,
      });
      await delay(75);
      await this.execFile('tmux', ['send-keys', '-t', target, 'Enter'], {
        timeout: 5000,
        maxBuffer: 4096,
      });
    } catch (error) {
      const wrapped = codedError(
        `The message could not be submitted to ${target}: ${error.message}`,
        'TARGET_MESSAGE_SUBMIT_FAILED'
      );
      wrapped.cause = error;
      throw wrapped;
    } finally {
      if (loaded) {
        try {
          await this.execFile('tmux', ['delete-buffer', '-b', bufferName], {
            timeout: 5000,
            maxBuffer: 4096,
          });
        } catch {
          // The private buffer may already have been removed; never mask the primary result.
        }
      }
    }
  }

  async interrupt(target) {
    const exactTarget = this._validateTarget(target);
    try {
      await this.execFile('tmux', ['send-keys', '-t', exactTarget, 'C-c'], {
        timeout: 5000,
        maxBuffer: 4096,
      });
      return true;
    } catch {
      return false;
    }
  }

  async send({
    target,
    message,
    sessionFingerprint,
    timeoutMs = 1800000,
    signal = null,
  } = {}) {
    const normalizedMessage = normalizeTargetMessage(message);
    const safeTimeoutMs = Math.max(30000, Math.min(Number.parseInt(timeoutMs, 10) || 1800000, 3600000));
    const deadline = Date.now() + safeTimeoutMs;
    const startedAt = Date.now();
    const prepared = await this.prepare({ target });
    if (!sessionFingerprint || prepared.session_fingerprint !== sessionFingerprint) {
      throw codedError(
        'The tmux pane no longer owns the provider session that was approved.',
        'TARGET_SESSION_CHANGED'
      );
    }
    if (signal?.aborted) throw codedError('The target-session operation was canceled.', 'TARGET_MESSAGE_CANCELED');

    const stableTarget = prepared.stable_target || prepared.target;
    const targetSession = await this.inspector.resolveAgentSessionTarget(stableTarget);
    if (targetSession.sessionFingerprint !== sessionFingerprint) {
      throw codedError(
        'The tmux pane changed provider sessions before message delivery.',
        'TARGET_SESSION_CHANGED'
      );
    }
    const filename = targetSession.resolved.filename;
    const provider = targetSession.inspected.pane.agent;
    const activity = await readProviderActivityState(filename, provider);
    const activityReader = new JsonlAppendReader(filename, activity.offset);
    while (activity.busy && Date.now() < deadline) {
      if (signal?.aborted) {
        throw codedError('The target-session operation was canceled before delivery.', 'TARGET_MESSAGE_CANCELED');
      }
      try {
        await delay(this.pollIntervalMs, undefined, signal ? { signal } : undefined);
      } catch (error) {
        if (signal?.aborted || error.code === 'ABORT_ERR') {
          throw codedError('The target-session operation was canceled before delivery.', 'TARGET_MESSAGE_CANCELED');
        }
        throw error;
      }
      for (const record of await activityReader.read()) {
        updateProviderActivityState(activity, record, provider);
      }
    }
    if (activity.busy) {
      throw codedError(
        `The existing task in ${prepared.target} did not become idle before timeout.`,
        'TARGET_IDLE_TIMEOUT'
      );
    }

    const readyTarget = await this.inspector.resolveAgentSessionTarget(stableTarget);
    if (readyTarget.sessionFingerprint !== sessionFingerprint) {
      throw codedError(
        'The tmux pane changed provider sessions while waiting for it to become idle.',
        'TARGET_SESSION_CHANGED'
      );
    }
    const stat = await fs.stat(filename);
    const reader = new JsonlAppendReader(filename, stat.size);
    const expectedMessage = normalizeMessageForMatch(normalizedMessage);
    let submitted = false;
    let delivered = null;
    let lastAssistantMessage = null;

    const verifiedResult = async (finalMessage, { cancellationArrivedAfterCompletion = false } = {}) => {
      const current = await this.inspector.resolveAgentSessionTarget(stableTarget);
      if (current.sessionFingerprint !== sessionFingerprint) {
        throw codedError(
          'The target provider session changed before its response was verified.',
          'TARGET_SESSION_CHANGED'
        );
      }
      return {
        success: true,
        target: current.inspected.pane.target,
        stable_target: stableTarget,
        named_target: current.inspected.pane.named_target || prepared.named_target || null,
        conversation_name: prepared.conversation_name || null,
        provider,
        delivered: true,
        delivered_at: delivered?.at || null,
        response_verified: true,
        response: clipVerifiedResponse(finalMessage.text),
        response_at: finalMessage.at || null,
        cancellation_arrived_after_completion: cancellationArrivedAfterCompletion,
        duration_ms: Date.now() - startedAt,
        parse_errors: reader.parseErrors,
      };
    };

    const consumeProviderRecords = async (options = {}) => {
      for (const record of await reader.read()) {
        const extracted = provider === 'codex'
          ? extractCodexMessage(record)
          : extractClaudeMessage(record);
        if (!delivered && extracted?.role === 'user' &&
            normalizeMessageForMatch(extracted.text) === expectedMessage) {
          delivered = { at: extracted.at || null };
          continue;
        }
        if (!delivered) continue;
        if (extracted?.role === 'assistant') lastAssistantMessage = extracted;
        const finalMessage = finalProviderMessage(record, provider);
        if (finalMessage?.text) return verifiedResult(finalMessage, options);
        if (provider === 'codex' && record?.type === 'event_msg' &&
            record.payload?.type === 'task_complete' && lastAssistantMessage?.text) {
          return verifiedResult(lastAssistantMessage, options);
        }
      }
      return null;
    };

    const reconcileCancellation = async () => {
      let outcome = await consumeProviderRecords({ cancellationArrivedAfterCompletion: true });
      if (outcome) return outcome;

      if (submitted) await this.interrupt(stableTarget);
      await delay(Math.max(50, Math.min(this.pollIntervalMs * 2, 500)));
      outcome = await consumeProviderRecords({ cancellationArrivedAfterCompletion: true });
      if (outcome) return outcome;

      if (delivered) {
        const current = await this.inspector.resolveAgentSessionTarget(stableTarget);
        return {
          success: true,
          target: current.inspected.pane.target,
          stable_target: stableTarget,
          named_target: current.inspected.pane.named_target || prepared.named_target || null,
          conversation_name: prepared.conversation_name || null,
          provider,
          delivered: true,
          delivered_at: delivered.at,
          response_verified: false,
          response: null,
          response_at: null,
          canceled_after_delivery: true,
          duration_ms: Date.now() - startedAt,
          parse_errors: reader.parseErrors,
        };
      }
      throw codedError('The target-session operation was canceled before delivery.', 'TARGET_MESSAGE_CANCELED');
    };

    await this._pasteAndSubmit(stableTarget, normalizedMessage);
    submitted = true;
    if (signal?.aborted) return reconcileCancellation();

    while (Date.now() < deadline) {
      if (signal?.aborted) return reconcileCancellation();
      const outcome = await consumeProviderRecords();
      if (outcome) return outcome;
      try {
        await delay(this.pollIntervalMs, undefined, signal ? { signal } : undefined);
      } catch (error) {
        if (signal?.aborted || error.code === 'ABORT_ERR') return reconcileCancellation();
        throw error;
      }
    }

    if (!delivered) {
      throw codedError(
        `The message was not verified in provider history for ${prepared.target}.`,
        'TARGET_DELIVERY_TIMEOUT'
      );
    }
    throw codedError(
      `The message reached ${prepared.target}, but no final provider response was verified before timeout.`,
      'TARGET_RESPONSE_TIMEOUT'
    );
  }
}

module.exports = {
  EXACT_TMUX_TARGET,
  JsonlAppendReader,
  MAX_TARGET_MESSAGE_CHARS,
  TmuxAgentController,
  finalProviderMessage,
  normalizeMessageForMatch,
  normalizeTargetMessage,
  readProviderActivityState,
  spawnWithInput,
  updateProviderActivityState,
};
