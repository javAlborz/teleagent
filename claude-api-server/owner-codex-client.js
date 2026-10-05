'use strict';

const net = require('node:net');
const WebSocket = require('ws');
const { sessionError, endpointIdentity, assertSameIdentity } = require('./owner-session-endpoint');
const { boundedMessages, validateSelection, selectMessage } = require('./owner-session-history');
const METHODS = new Set(['initialize', 'thread/loaded/list', 'thread/read',
  'thread/turns/list', 'turn/start', 'turn/steer']);

// This is intentionally not a generic app-server proxy. No process/spawn,
// shellCommand, permission response, resume, fork, configuration, or login RPC.
class OwnerCodexClient {
  constructor({ endpoint, timeoutMs = 5000, maxPayload = 1024 * 1024 } = {}) {
    this.endpoint = Object.freeze({ ...endpoint });
    this.timeoutMs = Math.min(10000, Math.max(100, timeoutMs));
    this.maxPayload = Math.min(4 * 1024 * 1024, Math.max(1024, maxPayload));
    this.sequence = 0;
    this.pending = new Map();
    this.socket = null;
    this.identity = null;
  }

  async connect() {
    if (this.socket) throw sessionError('OWNER_SESSION_ALREADY_CONNECTED');
    this.identity = endpointIdentity(this.endpoint);
    this.socket = new WebSocket('ws://localhost/', {
      createConnection: () => net.createConnection({ path: this.endpoint.socketPath }),
      handshakeTimeout: this.timeoutMs,
      maxPayload: this.maxPayload,
      perMessageDeflate: false,
      followRedirects: false,
    });
    const fail = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(sessionError('OWNER_SESSION_TRANSPORT_LOST'));
      }
      this.pending.clear();
    };
    this.socket.on('error', fail);
    this.socket.on('close', fail);
    this.socket.on('message', (buffer) => {
      let response;
      try { response = JSON.parse(buffer.toString()); } catch { this.close(); return; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        this.close(); return;
      }
      // Server requests, including approvals, are never answered by this client.
      if ('method' in response || !this.pending.has(response.id)) return;
      const pending = this.pending.get(response.id);
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error || !Object.hasOwn(response, 'result')) {
        // Never propagate provider errors containing paths, inputs, or secrets.
        pending.reject(sessionError('OWNER_SESSION_RPC_REFUSED'));
      } else pending.resolve(response.result);
    });
    try {
      await new Promise((resolve, reject) => {
        this.socket.once('open', resolve);
        this.socket.once('error', () => reject(sessionError('OWNER_SESSION_CONNECT_FAILED')));
        this.socket.once('close', () => reject(sessionError('OWNER_SESSION_CONNECT_FAILED')));
      });
      this.assertIdentity();
      await this._request('initialize', {
        clientInfo: { name: 'teleagent-owner-session', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      this.socket.send(JSON.stringify({ method: 'initialized' }));
      return this;
    } catch (error) { this.close(); throw error; }
  }

  assertIdentity() {
    assertSameIdentity(this.identity, endpointIdentity(this.endpoint));
  }

  _request(method, params) {
    if (!METHODS.has(method)) return Promise.reject(sessionError('OWNER_SESSION_METHOD_DENIED'));
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(sessionError('OWNER_SESSION_TRANSPORT_LOST'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(sessionError('OWNER_SESSION_RPC_TIMEOUT'));
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { this.close(); }
    });
  }

  async loaded() {
    this.assertIdentity();
    const ids = [];
    let cursor;
    for (let page = 0; page < 4; page++) {
      const result = await this._request('thread/loaded/list', { limit: 64, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data) || result.data.some((id) => !validId(id))) {
        throw sessionError('OWNER_SESSION_RESPONSE_INVALID');
      }
      ids.push(...result.data);
      if (ids.length > 256) break;
      if (!result.nextCursor) return [...new Set(ids)];
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048 ||
          result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    throw sessionError('OWNER_SESSION_INVENTORY_TOO_LARGE');
  }

  async read(threadId) {
    if (!validId(threadId)) throw sessionError('OWNER_SESSION_TARGET_INVALID');
    this.assertIdentity();
    const result = await this._request('thread/read', { threadId, includeTurns: false });
    const thread = result?.thread;
    if (!thread || thread.id !== threadId || typeof thread.cwd !== 'string' ||
        !['idle', 'active', 'notLoaded', 'systemError'].includes(thread.status?.type)) {
      throw sessionError('OWNER_SESSION_RESPONSE_INVALID');
    }
    // No preview, transcript, title, configuration, or log path leaves the client.
    return { id: thread.id, cwd: thread.cwd, status: thread.status.type,
      canAcceptDirectInput: thread.canAcceptDirectInput === true };
  }

  async activeTurn(threadId) {
    if (!validId(threadId)) throw sessionError('OWNER_SESSION_TARGET_INVALID');
    this.assertIdentity();
    const result = await this._request('thread/turns/list', {
      threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    });
    if (!Array.isArray(result?.data) || result.data.length > 1) {
      throw sessionError('OWNER_SESSION_RESPONSE_INVALID');
    }
    const turn = result.data[0];
    if (!turn || turn.status !== 'inProgress') return null;
    if (!validId(turn.id)) throw sessionError('OWNER_SESSION_RESPONSE_INVALID');
    return turn.id;
  }

  async history(threadId, binding = null, selection = null) {
    validateSelection(selection);
    if (binding && selection) throw sessionError('OWNER_HISTORY_SELECTION_INVALID');
    if (!(await this.loaded()).includes(threadId)) throw sessionError('OWNER_SESSION_NOT_LOADED');
    const result = await this._request('thread/turns/list', {
      // Native summary contains user/assistant messages without tool-output payloads.
      threadId, limit: selection ? 6 : 3, sortDirection: selection?.anchor === 'start' ? 'asc' : 'desc', itemsView: 'summary',
    });
    if (!Array.isArray(result?.data) || result.data.length > (selection ? 6 : 3)) {
      throw sessionError('OWNER_SESSION_RESPONSE_INVALID');
    }
    this.assertIdentity();
    const messages = [];
    for (const turn of (selection?.anchor === 'start' ? result.data : [...result.data].reverse())) {
      if (!Array.isArray(turn.items)) throw sessionError('OWNER_SESSION_RESPONSE_INVALID');
      for (const item of turn.items) {
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          messages.push({ role: 'assistant', text: item.text });
        } else if (item.type === 'userMessage' && Array.isArray(item.content)) {
          messages.push({ role: 'user', text: item.content.filter((part) => part.type === 'text' &&
            typeof part.text === 'string').map((part) => part.text).join('\n') });
        }
      }
    }
    if (selection) return selectMessage(messages, selection, { limited: Boolean(result.nextCursor) });
    // Never identify a reply from an older turn as the latest turn's result.
    // Use the same redaction/bounds as history, and expose no native IDs.
    const latest = binding ? result.data.find(turn => turn.id === binding.turnId) : result.data[0];
    // A steered turn can contain earlier answers. Only accept a reply after
    // this operation's exact user marker, with no intervening user message.
    let replyItems = latest?.items || [];
    if (binding) {
      const marker = `[teleagent-operation:${binding.operationId}]`;
      const userItems = replyItems.filter(item => item.type === 'userMessage');
      const lastUser = userItems.at(-1);
      const matches = lastUser?.content?.some(part => part.type === 'text' &&
        typeof part.text === 'string' && part.text.endsWith('\n' + marker));
      replyItems = matches ? replyItems.slice(replyItems.indexOf(lastUser) + 1) : [];
      if (!matches) return { messages: [], limited: true, latestTurn: { status: 'unknown', reply: null } };
    }
    const latestReplies = boundedMessages(replyItems
      .filter((item) => item.type === 'agentMessage')
      .map((item) => ({ role: 'assistant', text: item.text })));
    return { messages: binding ? [] : boundedMessages(messages), limited: true,
      latestTurn: {
        status: ['completed', 'inProgress', 'failed', 'interrupted'].includes(latest?.status)
          ? latest.status : 'unknown',
        reply: latestReplies.at(-1) || null,
      } };
  }

  async deliver({ threadId, message, expectedTurnId = null }) {
    if (!validId(threadId) || (expectedTurnId !== null && !validId(expectedTurnId)) ||
        typeof message !== 'string' || Buffer.byteLength(message) > 20000) {
      throw sessionError('OWNER_SESSION_TARGET_INVALID');
    }
    this.assertIdentity();
    const input = [{ type: 'text', text: message }];
    const result = expectedTurnId === null
      ? await this._request('turn/start', { threadId, input })
      : await this._request('turn/steer', { threadId, input, expectedTurnId });
    const turnId = expectedTurnId === null ? result?.turn?.id : result?.turnId;
    if (!validId(turnId) || (expectedTurnId !== null && turnId !== expectedTurnId)) {
      throw sessionError('OWNER_SESSION_RESPONSE_INVALID');
    }
    return { state: 'accepted', turnId, completed: false };
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(sessionError('OWNER_SESSION_TRANSPORT_LOST'));
    }
    this.pending.clear();
    this.socket?.terminate();
  }
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

module.exports = { OwnerCodexClient, validId };
