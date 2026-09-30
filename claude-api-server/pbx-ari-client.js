'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { sessionError } = require('./owner-session-endpoint');
const APP = 'teleagent-approval';
const ORIGIN = 'http://127.0.0.1:8088';
const VARIABLES = new Set(['CHANNEL(endpoint)', 'CHANNEL(linkedid)',
  'CHANNEL(pjsip,call-id)', 'CHANNEL(rtp,secure,audio)',
  'PJSIP_ENDPOINT(1001,dtmf_mode)', 'PJSIP_ENDPOINT(1001,direct_media)']);

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw sessionError('PBX_ARI_IDENTIFIER_INVALID');
  }
  return value;
}

// Runs inside the isolated PBX network namespace. ARI credentials never enter
// voice or controller. No endpoint, variable, media URI or RPC passthrough.
class PbxAriClient extends EventEmitter {
  constructor({ username, password, timeoutMs = 5000 }) {
    super();
    if (username !== 'teleagent-attester' || typeof password !== 'string' || password.length < 32 ||
        /[\r\n\x00]/u.test(password)) throw sessionError('PBX_ARI_CREDENTIAL_INVALID');
    this.auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    this.timeoutMs = Math.max(100, Math.min(timeoutMs, 5000));
    this.socket = null; this.epoch = null; this.ready = false; this.heartbeat = null;
  }
  async connect() {
    if (this.socket) throw sessionError('PBX_ARI_ALREADY_CONNECTED');
    const socket = this.socket = new WebSocket(`ws://127.0.0.1:8088/ari/events?app=${APP}`, {
      headers: { authorization: this.auth }, handshakeTimeout: this.timeoutMs,
      maxPayload: 65536, followRedirects: false, perMessageDeflate: false,
    });
    const lost = () => {
      const wasReady = this.ready;
      this.ready = false; clearInterval(this.heartbeat);
      if (wasReady) this.emit('disconnect');
    };
    socket.on('error', lost); socket.on('close', lost);
    socket.on('message', (buffer) => {
      let event;
      try { event = JSON.parse(buffer.toString()); } catch { this.close(); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event) ||
          event.application !== APP || typeof event.type !== 'string') { this.close(); return; }
      this.emit('event', event, this.epoch);
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(sessionError('PBX_ARI_CONNECT_FAILED')));
      socket.once('close', () => reject(sessionError('PBX_ARI_CONNECT_FAILED')));
    });
    this.epoch = crypto.randomUUID(); this.ready = true;
    let pong = true;
    socket.on('pong', () => { pong = true; });
    this.heartbeat = setInterval(() => {
      if (!pong) { this.close(); return; }
      pong = false; socket.ping();
    }, 1000);
    return this;
  }
  assertEpoch(epoch) {
    if (!this.ready || this.epoch !== epoch) throw sessionError('PBX_ARI_CONNECTION_CHANGED');
  }
  async _request(method, route, query = {}, { missingIsSuccess = false } = {}) {
    const epoch = this.epoch; this.assertEpoch(epoch);
    const url = new URL(`/ari${route}`, ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, agent: false, headers: { authorization: this.auth } });
      const timer = setTimeout(() => req.destroy(), this.timeoutMs);
      const failed = () => { clearTimeout(timer); reject(sessionError('PBX_ARI_REQUEST_FAILED')); };
      req.once('error', failed);
      req.once('response', (res) => {
        let bytes = 0; const chunks = [];
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) { res.destroy(); return; }
          chunks.push(chunk);
        });
        res.once('error', failed);
        res.once('end', () => {
          clearTimeout(timer);
          if (res.statusCode === 404 && missingIsSuccess && method === 'DELETE') {
            try { this.assertEpoch(epoch); resolve({ absent: true }); } catch { failed(); }
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) { failed(); return; }
          try {
            this.assertEpoch(epoch);
            resolve(bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
          } catch { failed(); }
        });
      });
      req.end();
    });
  }
  channel(id) { return this._request('GET', `/channels/${identifier(id)}`); }
  bridge(id) { return this._request('GET', `/bridges/${identifier(id)}`); }
  variable(id, variable) {
    if (!VARIABLES.has(variable)) throw sessionError('PBX_ARI_VARIABLE_DENIED');
    return this._request('GET', `/channels/${identifier(id)}/variable`, { variable });
  }
  createBridge(id) {
    return this._request('POST', `/bridges/${identifier(id)}`, { type: 'mixing,proxy_media,dtmf_events' });
  }
  destroyBridge(id) { return this._request('DELETE', `/bridges/${identifier(id)}`, {}, { missingIsSuccess: true }); }
  answer(id) { return this._request('POST', `/channels/${identifier(id)}/answer`); }
  hangup(id) { return this._request('DELETE', `/channels/${identifier(id)}`, {}, { missingIsSuccess: true }); }
  originateTrunk({ id, ownerId, route }) {
    if (!['7', '77'].includes(route)) throw sessionError('PBX_ARI_ROUTE_DENIED');
    identifier(ownerId);
    return this._request('POST', '/channels', { channelId: identifier(id), app: APP,
      appArgs: `trunk,${ownerId}`, endpoint: route === '7'
        ? 'PJSIP/assistant-openai-realtime' : 'PJSIP/assistant-openai-realtime-resume', timeout: '30', originator: ownerId });
  }
  forwardStar(trunkId) {
    return this._request('POST', `/channels/${identifier(trunkId)}/dtmf`, { dtmf: '*', between: '0', duration: '100' });
  }
  removeHandset(bridgeId, handsetId) {
    return this._request('POST', `/bridges/${identifier(bridgeId)}/removeChannel`, { channel: identifier(handsetId) });
  }
  restoreHandset(bridgeId, handsetId) {
    return this._request('POST', `/bridges/${identifier(bridgeId)}/addChannel`, { channel: identifier(handsetId) });
  }
  play(handsetId, playbackId, audioHash) {
    if (!/^[a-f0-9]{64}$/.test(audioHash)) throw sessionError('PBX_ARI_MEDIA_DENIED');
    return this._request('POST', `/channels/${identifier(handsetId)}/play/${identifier(playbackId)}`,
      { media: `sound:teleagent-approval/${audioHash}` });
  }
  stopPlayback(id) { return this._request('DELETE', `/playbacks/${identifier(id)}`); }
  close() {
    const wasReady = this.ready; this.ready = false;
    clearInterval(this.heartbeat); this.socket?.terminate();
    if (wasReady) this.emit('disconnect');
  }
}
module.exports = { PbxAriClient, APP, identifier };
