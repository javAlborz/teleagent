import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { assertCallId, extractDtmfDigit } from './sip-event.js';

function defaultWebSocketFactory(url, options) {
  return new WebSocket(url, options);
}

function byteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return Buffer.byteLength(String(data));
}

export class SidebandSession extends EventEmitter {
  #callId;
  #config;
  #webSocketFactory;
  #socket = null;
  #connectTimer = null;
  #state = 'idle';

  constructor({ callId, config, webSocketFactory = defaultWebSocketFactory }) {
    super();
    this.#callId = assertCallId(callId);
    this.#config = config;
    this.#webSocketFactory = webSocketFactory;
  }

  get callId() {
    return this.#callId;
  }

  get state() {
    return this.#state;
  }

  async connect() {
    if (this.#state !== 'idle') throw new Error(`Cannot connect sideband in state ${this.#state}`);
    this.#state = 'connecting';

    const url = new URL(this.#config.realtimeWsUrl);
    url.searchParams.set('call_id', this.#callId);
    const socket = this.#webSocketFactory(url.toString(), {
      headers: { Authorization: `Bearer ${this.#config.apiKey}` },
      maxPayload: this.#config.maxRealtimeEventBytes,
    });
    this.#socket = socket;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.#connectTimer);
        reject(error);
      };

      this.#connectTimer = setTimeout(() => {
        const error = new Error('Realtime sideband connection timed out');
        error.code = 'SIDEBAND_CONNECT_TIMEOUT';
        this.#state = 'failed';
        socket.close?.(1000, 'connect timeout');
        settleError(error);
      }, this.#config.sidebandConnectTimeoutMs);
      this.#connectTimer.unref?.();

      socket.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(this.#connectTimer);
        this.#state = 'open';
        this.emit('open');
        resolve();
      });

      socket.on('message', (data) => this.#handleMessage(data));
      socket.on('error', (error) => {
        this.emit('socket_error', error);
        if (this.#state === 'connecting') {
          this.#state = 'failed';
          settleError(error);
        }
      });
      socket.on('close', (code, reason) => {
        clearTimeout(this.#connectTimer);
        const previousState = this.#state;
        this.#state = 'closed';
        this.emit('close', {
          code,
          reason: Buffer.isBuffer(reason) ? reason.toString('utf8').slice(0, 256) : String(reason ?? '').slice(0, 256),
          previousState,
        });
        if (previousState === 'connecting') {
          settleError(new Error(`Realtime sideband closed before opening (${code})`));
        }
      });
    });
  }

  #handleMessage(data) {
    if (byteLength(data) > this.#config.maxRealtimeEventBytes) {
      this.emit('protocol_error', new Error('Realtime event exceeded configured size limit'));
      this.#socket?.close?.(1009, 'event too large');
      return;
    }

    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      this.emit('protocol_error', new Error('Realtime event was not valid JSON'));
      return;
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      this.emit('protocol_error', new Error('Realtime event was missing a type'));
      return;
    }

    this.emit('raw_event', event);
    const digit = extractDtmfDigit(event);
    if (digit) {
      this.emit('dtmf', {
        digit,
        receivedAt: Number.isFinite(event.received_at) ? event.received_at : null,
        rawEvent: event,
      });
    }
    if (event.type === 'error') this.emit('realtime_error', event.error ?? event);
  }

  sendEvent(event) {
    if (this.#state !== 'open' || !this.#socket) {
      throw new Error('Realtime sideband is not open');
    }
    if (!event || typeof event.type !== 'string') throw new TypeError('Realtime event requires a type');
    this.#socket.send(JSON.stringify(event));
  }

  requestResponse() {
    this.sendEvent({ type: 'response.create' });
  }

  close(code = 1000, reason = 'gateway shutdown') {
    clearTimeout(this.#connectTimer);
    if (this.#state === 'idle') {
      this.#state = 'closed';
      return;
    }
    this.#socket?.close?.(code, reason);
  }
}
