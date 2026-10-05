'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { sessionError, endpointIdentity, assertSameIdentity } = require('./owner-session-endpoint');
const { boundedMessages, validateSelection, selectMessage } = require('./owner-session-history');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

// The registration file, not the pane name or command line, identifies the
// current session after /resume. Only operator-selected registrations are read.
function readClaudeRegistration({ registryRoot, socketRoot, pid, uid, procRoot = '/proc' }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(registryRoot) ||
      !path.isAbsolute(socketRoot) || fs.realpathSync(registryRoot) !== registryRoot) {
    throw sessionError('OWNER_SESSION_REGISTRATION_UNSAFE');
  }
  const directory = fs.lstatSync(registryRoot);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077)) {
    throw sessionError('OWNER_SESSION_REGISTRATION_UNSAFE');
  }
  const fd = fs.openSync(path.join(registryRoot, `${pid}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let record;
  try {
    const stat = fs.fstatSync(fd);
    // Claude inherits the owner's umask and can write 0664 registrations inside
    // its 0700 registry. The private parent and single link prevent another
    // user from reaching that group-writable file. Do not chmod live state.
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o002) ||
        stat.nlink !== 1 || stat.size > 16384) {
      throw sessionError('OWNER_SESSION_REGISTRATION_UNSAFE');
    }
    const buffer = Buffer.alloc(16385);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 16384) throw sessionError('OWNER_SESSION_REGISTRATION_UNSAFE');
    record = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
  } finally { fs.closeSync(fd); }
  const socketPath = path.join(socketRoot, `${pid}.sock`);
  const identity = endpointIdentity({ socketPath, pid, uid, procRoot });
  if (record.pid !== pid || !UUID.test(record.sessionId) ||
      record.procStart !== identity.process.start || record.messagingSocketPath !== socketPath ||
      record.peerProtocol !== 1 || record.kind !== 'interactive' ||
      typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd)) {
    throw sessionError('OWNER_SESSION_REGISTRATION_CHANGED');
  }
  return { id: record.sessionId, cwd: record.cwd,
    status: ['idle', 'busy'].includes(record.status) ? record.status : 'unknown', identity };
}

class OwnerClaudeClient {
  constructor({ registration, timeoutMs = 5000 } = {}) {
    this.registration = Object.freeze({ ...registration });
    this.timeoutMs = Math.min(10000, Math.max(100, timeoutMs));
    this.identity = null;
    this.session = null;
    this.socket = null;
  }

  async connect() {
    if (this.socket) throw sessionError('OWNER_SESSION_ALREADY_CONNECTED');
    this.session = readClaudeRegistration(this.registration);
    this.identity = this.session.identity;
    this.socket = net.createConnection({ path: this.identity.socket.path });
    this.socket.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(sessionError('OWNER_SESSION_CONNECT_TIMEOUT'));
          this.close();
        }, this.timeoutMs);
        this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
        this.socket.once('error', () => {
          clearTimeout(timer); reject(sessionError('OWNER_SESSION_CONNECT_FAILED'));
        });
        this.socket.once('close', () => {
          clearTimeout(timer); reject(sessionError('OWNER_SESSION_CONNECT_FAILED'));
        });
      });
      this.assertIdentity();
      return this;
    } catch (error) { this.close(); throw error; }
  }

  assertIdentity() {
    const current = readClaudeRegistration(this.registration);
    assertSameIdentity({ identity: this.identity, id: this.session.id, cwd: this.session.cwd },
      { identity: current.identity, id: current.id, cwd: current.cwd });
  }

  read(sessionId) {
    this.assertIdentity();
    if (sessionId !== this.session.id) throw sessionError('OWNER_SESSION_TARGET_INVALID');
    const current = readClaudeRegistration(this.registration);
    return { id: current.id, cwd: current.cwd, status: current.status };
  }

  history(sessionId, binding = null, selection = null) {
    validateSelection(selection);
    if (binding && selection) throw sessionError('OWNER_HISTORY_SELECTION_INVALID');
    const current = this.read(sessionId);
    const projectsRoot = path.join(path.dirname(this.registration.registryRoot), 'projects');
    const directory = path.join(projectsRoot, current.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    if (fs.realpathSync(directory) !== directory) throw sessionError('OWNER_SESSION_HISTORY_UNSAFE');
    const fd = fs.openSync(path.join(directory, `${sessionId}.jsonl`),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const messages = [];
    let limited = false;
    let latestReply = null;
    let completed = false;
    let bound = !binding;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== this.registration.uid || (stat.mode & 0o022)) {
        throw sessionError('OWNER_SESSION_HISTORY_UNSAFE');
      }
      const start = selection?.anchor === 'start' ? 0 : Math.max(0, stat.size - 256 * 1024);
      limited = stat.size > 256 * 1024;
      const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
      if (start) lines.shift(); // Never interpret a partial leading JSON record.
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.sessionId !== sessionId || !['user', 'assistant'].includes(record.type) ||
            record.isMeta || record.toolUseResult) continue;
        const content = record.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text).join('\n') : '';
        // Tool-result records are not a new caller turn. A real new user
        // message clears the previous reply, including when the tail is clipped.
        if (text.trim() && record.type === 'user') {
          latestReply = null;
          completed = false;
          bound = !binding || text.endsWith(`\n[teleagent-operation:${binding.operationId}]`);
        } else if (bound && text.trim() && record.type === 'assistant') {
          latestReply = boundedMessages([{ role: 'assistant', text }])[0] || null;
          completed = record.message?.stop_reason === 'end_turn';
        }
        messages.push({ role: record.type, text });
      }
    } finally { fs.closeSync(fd); }
    this.assertIdentity();
    if (selection) return selectMessage(messages, selection, { limited });
    const status = this.read(sessionId).status;
    return { messages: binding ? [] : boundedMessages(messages), limited: true,
      latestTurn: { status: status === 'busy' ? 'inProgress'
        : status === 'idle' && completed ? 'completed' : 'unknown', reply: latestReply } };
  }

  async deliver({ threadId, message, messageId = crypto.randomUUID() }) {
    this.assertIdentity();
    if (threadId !== this.session.id || !UUID.test(messageId) ||
        typeof message !== 'string' || !message || Buffer.byteLength(message) > 20000) {
      throw sessionError('OWNER_SESSION_TARGET_INVALID');
    }
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw sessionError('OWNER_SESSION_TRANSPORT_LOST');
    }
    // Do not borrow the target's token or impersonate its child/permission
    // class. Its native inbound controls can legitimately hold or refuse this.
    const frame = { msgV: 1, msg_id: messageId, type: 'user', session_id: threadId,
      priority: 'next', message: { role: 'user', content: message } };
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        this.socket.removeListener('close', onClose);
        this.socket.removeListener('error', onClose);
        if (error) reject(sessionError('OWNER_SESSION_TRANSPORT_LOST')); else resolve();
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => { finish(true); this.close(); }, this.timeoutMs);
      this.socket.once('close', onClose);
      this.socket.once('error', onClose);
      this.socket.write(`${JSON.stringify(frame)}\n`, finish);
    });
    // A successful socket write proves neither acceptance nor completion.
    return { state: 'submitted_unconfirmed', messageId, completed: false };
  }

  close() { this.socket?.destroy(); }
}

module.exports = { OwnerClaudeClient, readClaudeRegistration };
