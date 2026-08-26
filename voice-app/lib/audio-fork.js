const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const WebSocket = require('ws');

const AUDIO_DEBUG = String(process.env.AUDIO_DEBUG || '').toLowerCase() === 'true';
const MAX_BUFFERED_PLAYOUT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_PLAYOUT_MARKERS = 30;
const AUDIO_ATTACH_TOKEN_BYTES = 32;
const AUDIO_ATTACH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_AUDIO_EXPECTATION_MS = 30000;
const MAX_AUDIO_FORK_FRAME_BYTES = 256 * 1024;

function audioDebugLog(...args) {
  if (AUDIO_DEBUG) {
    console.log(...args);
  }
}

function normalizeIpAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) {
    address = address.slice(7);
  }
  return address;
}

function isLoopbackAddress(value) {
  const address = normalizeIpAddress(value);
  if (address === 'localhost' || address === '::1') return true;
  if (net.isIP(address) !== 4) return false;
  return Number(address.split('.')[0]) === 127;
}

function normalizeNetworkHost(value, fieldName) {
  const host = String(value || '').trim().toLowerCase();
  if (!host || (host !== 'localhost' && net.isIP(host) === 0)) {
    throw new Error(`${fieldName} must be localhost or a literal IP address`);
  }
  return host;
}

function normalizeAllowedPeers(value, { allowNonLoopback, nonLoopbackConfigured }) {
  const supplied = Array.isArray(value) ? value : String(value || '').split(',');
  const peers = [...new Set(supplied.map(normalizeIpAddress).filter(Boolean))];
  if (peers.length === 0) {
    if (nonLoopbackConfigured) {
      throw new Error('WS_ALLOWED_PEERS must list exact peer IPs in non-loopback mode');
    }
    return ['127.0.0.1', '::1'];
  }
  for (const peer of peers) {
    if (net.isIP(peer) === 0 || peer === '0.0.0.0' || peer === '::') {
      throw new Error('WS_ALLOWED_PEERS entries must be exact IP addresses');
    }
    if (!allowNonLoopback && !isLoopbackAddress(peer)) {
      throw new Error('Non-loopback WS_ALLOWED_PEERS require WS_NON_LOOPBACK_ENABLED=true');
    }
  }
  return peers;
}

function normalizeAudioForkServerOptions({
  port = 3001,
  host = '127.0.0.1',
  connectHost = '127.0.0.1',
  allowNonLoopback = false,
  allowedPeers,
} = {}) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 0 || normalizedPort > 65535) {
    throw new Error('WS_PORT must be an integer between 0 and 65535');
  }
  const normalizedHost = normalizeNetworkHost(host, 'WS_HOST');
  const normalizedConnectHost = normalizeNetworkHost(connectHost, 'WS_CONNECT_HOST');
  if (normalizedConnectHost === '0.0.0.0' || normalizedConnectHost === '::') {
    throw new Error('WS_CONNECT_HOST must identify a concrete interface');
  }
  const nonLoopbackConfigured =
    !isLoopbackAddress(normalizedHost) || !isLoopbackAddress(normalizedConnectHost);
  const optIn = allowNonLoopback === true;
  if (nonLoopbackConfigured && !optIn) {
    throw new Error('Non-loopback audio WebSocket networking requires WS_NON_LOOPBACK_ENABLED=true');
  }
  const normalizedPeers = normalizeAllowedPeers(allowedPeers, {
    allowNonLoopback: optIn,
    nonLoopbackConfigured,
  });
  return {
    port: normalizedPort,
    host: normalizedHost,
    connectHost: normalizedConnectHost,
    allowNonLoopback: optIn,
    allowedPeers: normalizedPeers,
  };
}

function redactAudioForkSecrets(value) {
  return String(value || '').replace(
    /\/v1\/audio\/([^/?#\s]+)\/[A-Za-z0-9_-]{43}/g,
    '/v1/audio/$1/[redacted-credential]'
  );
}

function createAudioForkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function debugGlobStatesAfterPrefix(pattern, prefix) {
  const glob = String(pattern || '');
  const addStarEpsilonClosure = (input) => {
    const output = new Set(input);
    const pending = [...input];
    while (pending.length > 0) {
      const position = pending.pop();
      if (glob[position] === '*' && !output.has(position + 1)) {
        output.add(position + 1);
        pending.push(position + 1);
      }
    }
    return output;
  };

  let states = addStarEpsilonClosure(new Set([0]));
  for (const character of prefix) {
    const next = new Set();
    for (const position of states) {
      if (glob[position] === '*') next.add(position);
      else if (glob[position] === character) next.add(position + 1);
    }
    states = addStarEpsilonClosure(next);
    if (states.size === 0) break;
  }
  return { glob, states };
}

function debugPatternCanMatchPrefix(pattern, prefix) {
  // If the glob can consume the fixed prefix, every remaining literal can be
  // supplied by a suffix and every remaining wildcard can be empty.
  return debugGlobStatesAfterPrefix(pattern, prefix).states.size > 0;
}

function debugPatternCoversPrefix(pattern, prefix) {
  const { glob, states } = debugGlobStatesAfterPrefix(pattern, prefix);
  // A reachable trailing wildcard is the only glob form that can exclude
  // every possible suffix beneath this namespace prefix.
  return [...states].some((position) => (
    glob[position] === '*' && [...glob.slice(position)].every((character) => character === '*')
  ));
}

function assertAudioForkDebugSafe(debugNamespaces = process.env.DEBUG) {
  const patterns = String(debugNamespaces || '')
    .trim()
    .replace(/\s+/g, ',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const protectedPrefix = 'drachtio:';
  const allProtectedNamespacesSkipped = patterns
    .filter((pattern) => pattern.startsWith('-'))
    .some((pattern) => debugPatternCoversPrefix(pattern.slice(1), protectedPrefix));
  const couldEnableProtectedNamespace = patterns
    .filter((pattern) => !pattern.startsWith('-'))
    .some((pattern) => debugPatternCanMatchPrefix(pattern, protectedPrefix));
  if (!allProtectedNamespacesSkipped && couldEnableProtectedNamespace) {
    throw new Error(
      'DEBUG must not enable any drachtio:* namespace because dependency traces can expose SIP or AudioFork credentials'
    );
  }
  return true;
}

function pcmStats(buf, endian = 'LE') {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount <= 0) {
    return { sampleCount: 0, rms: 0, maxAbs: 0, nearZeroRatio: 1 };
  }

  let sumSquares = 0;
  let maxAbs = 0;
  let nearZero = 0;
  const read = endian === 'BE' ? Buffer.prototype.readInt16BE : Buffer.prototype.readInt16LE;

  for (let i = 0; i < sampleCount; i++) {
    const sample = read.call(buf, i * 2);
    const abs = Math.abs(sample);
    sumSquares += abs * abs;
    if (abs > maxAbs) maxAbs = abs;
    if (abs < 200) nearZero++;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return { sampleCount, rms, maxAbs, nearZeroRatio: nearZero / sampleCount };
}

class AudioForkSession extends EventEmitter {
  constructor({
    ws,
    callUuid,
    sampleRate = 16000,
    bidirectionalStreaming = false,
    endSilenceMs = 1500,
    minSpeechMs = 350,
    maxUtteranceMs = 120000
  }) {
    super();
    this.ws = ws;
    this.callUuid = callUuid;
    this.sampleRate = sampleRate;
    this.bidirectionalStreaming = Boolean(bidirectionalStreaming);

    this.endSilenceMs = endSilenceMs;
    this.minSpeechMs = minSpeechMs;
    this.maxUtteranceMs = maxUtteranceMs;

    this.captureEnabled = true;
    this._pcmEndian = null;

    this._preRollChunks = [];
    this._preRollBytes = 0;
    this._preRollMaxBytes = Math.floor((this.sampleRate * 0.2) * 2);

    this._inSpeech = false;
    this._utteranceChunks = [];
    this._utteranceBytes = 0;
    this._speechBytes = 0;
    this._silenceMs = 0;

    this._playout = null;
    this._lastPlaybackOutcome = null;
    this._pendingPlaybackMarkers = new Map();

    // DEBUG: Track message counts
    this._messageCount = 0;
    this._binaryCount = 0;
    this._lastLogTime = Date.now();

    ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
    ws.on('close', () => {
      this._failPendingPlaybackMarkers('websocket_closed');
      audioDebugLog('[AUDIO-DEBUG] WebSocket CLOSED for ' + callUuid + '. Total messages: ' + this._messageCount + ', binary: ' + this._binaryCount);
      this.emit('close');
    });
    ws.on('error', (err) => {
      this._failPendingPlaybackMarkers('websocket_error');
      audioDebugLog('[AUDIO-DEBUG] WebSocket ERROR for ' + callUuid + ': ' + err.message);
      this.emit('error', err);
    });

    audioDebugLog('[AUDIO-DEBUG] AudioForkSession created for ' + callUuid);
  }

  setCaptureEnabled(enabled) {
    const was = this.captureEnabled;
    this.captureEnabled = Boolean(enabled);
    audioDebugLog('[AUDIO-DEBUG] setCaptureEnabled: ' + was + ' -> ' + this.captureEnabled + ' for ' + this.callUuid);
    if (!this.captureEnabled) this._resetUtterance();
  }

  sendAudio(audio, { sampleRate = 24000, itemId = null } = {}) {
    const buffer = Buffer.from(audio || []);
    if (buffer.length === 0) return false;
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.emit('playout_unavailable', { itemId, reason: 'websocket_not_open' });
      return false;
    }
    if (Number(this.ws.bufferedAmount || 0) > MAX_BUFFERED_PLAYOUT_BYTES) {
      this.emit('playout_backpressure', { bufferedAmount: this.ws.bufferedAmount });
      return false;
    }

    if (!this._playout || (itemId && this._playout.itemId !== itemId)) {
      this._playout = {
        itemId,
        sampleRate,
        bytes: 0,
        startedAt: Date.now(),
        sourceComplete: false,
      };
      this._lastPlaybackOutcome = null;
    }
    this._playout.bytes += buffer.length;

    if (this.bidirectionalStreaming) {
      this.ws.send(buffer, { binary: true });
    } else {
      this.ws.send(JSON.stringify({
        type: 'playAudio',
        data: {
          audioContentType: 'raw',
          sampleRate,
          audioContent: buffer.toString('base64'),
        },
      }));
    }
    return true;
  }

  sendPlaybackMarker(name, { itemId = null } = {}) {
    const markerName = String(name || '').trim();
    const bufferedAmount = Number(this.ws.bufferedAmount || 0);
    const valid = /^[A-Za-z0-9:_.-]{1,180}$/.test(markerName);
    const preconditionsMet = valid && itemId && this.ws.readyState === WebSocket.OPEN &&
      bufferedAmount <= MAX_BUFFERED_PLAYOUT_BYTES &&
      this._pendingPlaybackMarkers.size < MAX_PENDING_PLAYOUT_MARKERS &&
      this._playout?.itemId === itemId && this._playout.sourceComplete;
    if (!preconditionsMet) {
      this.emit('playout_marker_failed', {
        name: markerName || null,
        itemId,
        reason: this.ws.readyState !== WebSocket.OPEN
          ? 'websocket_not_open'
          : (bufferedAmount > MAX_BUFFERED_PLAYOUT_BYTES
            ? 'websocket_backpressure'
            : 'marker_precondition_failed'),
      });
      return false;
    }
    this._pendingPlaybackMarkers.set(markerName, {
      name: markerName,
      itemId,
      queuedAt: new Date().toISOString(),
    });
    try {
      this.ws.send(JSON.stringify({ type: 'mark', data: { name: markerName } }));
    } catch {
      this._pendingPlaybackMarkers.delete(markerName);
      this.emit('playout_marker_failed', {
        name: markerName,
        itemId,
        reason: 'marker_send_failed',
      });
      return false;
    }
    return true;
  }

  clearPlaybackMarkers(reason = 'playback_cleared') {
    const markers = [...this._pendingPlaybackMarkers.values()];
    this._pendingPlaybackMarkers.clear();
    if (markers.length > 0 && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'clearMarks' }));
      } catch {
        // Local authorization already fails closed when the queue is cleared.
      }
    }
    if (markers.length > 0) this.emit('playout_markers_cleared', { reason, markers });
    return markers.length;
  }

  markPlaybackComplete(itemId = null) {
    if (!this._playout) return false;
    if (itemId && this._playout.itemId && itemId !== this._playout.itemId) return false;
    this._playout.sourceComplete = true;
    return true;
  }

  isPlaybackActive() {
    return Boolean(this.getPlaybackStatus()?.active);
  }

  getPlaybackStatus() {
    if (!this._playout) return this._lastPlaybackOutcome;
    const totalAudioMs = (this._playout.bytes / 2 / this._playout.sampleRate) * 1000;
    const elapsedMs = Math.max(0, Date.now() - this._playout.startedAt);
    const remainingMs = this._playout.sourceComplete
      ? Math.max(0, totalAudioMs + 100 - elapsedMs)
      : null;
    const authorizationMarkerPending = [...this._pendingPlaybackMarkers.values()]
      .some((marker) => marker.itemId === this._playout.itemId);
    if (this._playout.sourceComplete && remainingMs === 0 && !authorizationMarkerPending) {
      this._lastPlaybackOutcome = {
        itemId: this._playout.itemId,
        active: false,
        completed: true,
        interrupted: false,
        totalAudioMs,
        elapsedMs,
        remainingMs: 0,
      };
      this._playout = null;
      return this._lastPlaybackOutcome;
    }
    return {
      itemId: this._playout.itemId,
      active: true,
      completed: false,
      interrupted: false,
      sourceComplete: this._playout.sourceComplete,
      authorizationMarkerPending,
      totalAudioMs,
      elapsedMs,
      remainingMs,
    };
  }

  hasPlaybackCompleted(itemId = null) {
    const status = this.getPlaybackStatus();
    return Boolean(status?.completed && (!itemId || !status.itemId || status.itemId === itemId));
  }

  stopPlayback() {
    const playout = this._playout;
    if (!playout) {
      this.clearPlaybackMarkers('playback_interrupted');
      return null;
    }
    const totalAudioMs = (playout.bytes / 2 / playout.sampleRate) * 1000;
    const elapsedMs = Math.max(0, Date.now() - playout.startedAt);
    this._playout = null;
    if (playout.sourceComplete && elapsedMs >= totalAudioMs + 100) {
      this._lastPlaybackOutcome = {
        itemId: playout.itemId,
        active: false,
        completed: true,
        interrupted: false,
        totalAudioMs,
        elapsedMs,
        remainingMs: 0,
      };
      this.clearPlaybackMarkers('playback_stopped');
      return null;
    }
    this._lastPlaybackOutcome = {
      itemId: playout.itemId,
      active: false,
      completed: false,
      interrupted: true,
      totalAudioMs,
      elapsedMs,
      remainingMs: Math.max(0, totalAudioMs + 100 - elapsedMs),
    };
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'killAudio' }));
    }
    this.clearPlaybackMarkers('playback_interrupted');
    return {
      itemId: playout.itemId,
      audioEndMs: Math.min(totalAudioMs, elapsedMs),
      totalAudioMs,
      interrupted: true,
    };
  }

  close(code = 1000, reason = 'call ended') {
    this.captureEnabled = false;
    this.clearPlaybackMarkers('audio_session_closed');
    this._playout = null;
    this._lastPlaybackOutcome = null;
    this._resetUtterance();
    if (typeof this.ws?.close !== 'function') return false;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
      return true;
    }
    return false;
  }

  _chunkDurationMs(byteLen) {
    const samples = Math.floor(byteLen / 2);
    return (samples / this.sampleRate) * 1000;
  }

  _rememberPreRoll(buf) {
    if (buf.length === 0) return;
    this._preRollChunks.push(buf);
    this._preRollBytes += buf.length;
    while (this._preRollBytes > this._preRollMaxBytes && this._preRollChunks.length > 1) {
      const removed = this._preRollChunks.shift();
      this._preRollBytes -= removed.length;
    }
  }

  _startUtteranceWithPreRoll() {
    this._inSpeech = true;
    this._utteranceChunks = [];
    this._utteranceBytes = 0;
    this._speechBytes = 0;
    this._silenceMs = 0;

    if (this._preRollChunks.length) {
      for (const chunk of this._preRollChunks) this._appendUtterance(chunk, false);
      this._preRollChunks = [];
      this._preRollBytes = 0;
    }
    audioDebugLog('[AUDIO-DEBUG] Started utterance with pre-roll for ' + this.callUuid);
  }

  _appendUtterance(buf, countsAsSpeech) {
    this._utteranceChunks.push(buf);
    this._utteranceBytes += buf.length;
    if (countsAsSpeech) this._speechBytes += buf.length;
  }

  _resetUtterance() {
    this._inSpeech = false;
    this._utteranceChunks = [];
    this._utteranceBytes = 0;
    this._speechBytes = 0;
    this._silenceMs = 0;
  }

  _finalizeUtterance(reason) {
    const durationMs = this._chunkDurationMs(this._utteranceBytes);
    const speechMs = this._chunkDurationMs(this._speechBytes);
    const speechRatio = this._utteranceBytes > 0 ? this._speechBytes / this._utteranceBytes : 0;

    const audio = Buffer.concat(this._utteranceChunks);
    this._resetUtterance();

    audioDebugLog('[AUDIO-DEBUG] Finalizing utterance: ' + audio.length + ' bytes, ' + Math.round(durationMs) + 'ms duration, ' + Math.round(speechMs) + 'ms speech, ratio=' + speechRatio.toFixed(2) + ', reason=' + reason);

    // For DTMF-triggered finalization, be more lenient with requirements
    const isDtmfTriggered = reason === 'dtmf_trigger';
    const minSpeechRequired = isDtmfTriggered ? 100 : this.minSpeechMs;
    const minRatioRequired = isDtmfTriggered ? 0.05 : 0.12;

    if (speechMs < minSpeechRequired || speechRatio < minRatioRequired) {
      audioDebugLog('[AUDIO-DEBUG] Utterance REJECTED: speechMs=' + Math.round(speechMs) + ' < ' + minSpeechRequired + ' OR speechRatio=' + speechRatio.toFixed(2) + ' < ' + minRatioRequired);
      return false;
    }
    audioDebugLog('[AUDIO-DEBUG] Utterance ACCEPTED, emitting event');
    this.emit('utterance', { callUuid: this.callUuid, audio, durationMs, speechMs, reason });
    return true;
  }

  /**
   * Force immediate finalization of current utterance (e.g., when # is pressed)
   * Returns true if an utterance was finalized, false if there was nothing to finalize
   */
  forceFinalize() {
    audioDebugLog('[AUDIO-DEBUG] forceFinalize called for ' + this.callUuid + ', inSpeech=' + this._inSpeech + ', bytes=' + this._utteranceBytes);

    if (!this._inSpeech || this._utteranceBytes === 0) {
      audioDebugLog('[AUDIO-DEBUG] forceFinalize: No speech to finalize');
      return false;
    }

    return this._finalizeUtterance('dtmf_trigger');
  }

  _detectEndian(buf) {
    const le = pcmStats(buf, 'LE');
    const be = pcmStats(buf, 'BE');
    const leScore = le.maxAbs + le.rms;
    const beScore = be.maxAbs + be.rms;
    const result = leScore >= beScore ? 'LE' : 'BE';
    audioDebugLog('[AUDIO-DEBUG] Detected endian: ' + result + ' (LE score=' + Math.round(leScore) + ', BE score=' + Math.round(beScore) + ')');
    return result;
  }

  _isSpeech(buf) {
    if (!this._pcmEndian) this._pcmEndian = this._detectEndian(buf);
    const stats = pcmStats(buf, this._pcmEndian);

    const rmsThreshold = 650;
    const maxThreshold = 2200;

    const looksSilent = stats.nearZeroRatio > 0.94 && stats.rms < rmsThreshold;
    if (looksSilent) return false;
    return stats.maxAbs >= maxThreshold || stats.rms >= rmsThreshold;
  }

  _onMessage(data, isBinary) {
    this._messageCount++;

    if (typeof data === 'string' || isBinary === false) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
      try {
        const meta = JSON.parse(text);
        audioDebugLog(
          '[AUDIO-DEBUG] Received metadata message #' + this._messageCount +
          ', type=' + String(meta?.type || 'unknown').slice(0, 40) +
          ', event=' + String(meta?.data?.event || meta?.event || 'none').slice(0, 40)
        );
        this.emit('metadata', meta);
        this._handlePlayoutMetadata(meta);
        if (meta && meta.sampleRate && Number.isFinite(Number(meta.sampleRate))) {
          this.sampleRate = Number(meta.sampleRate);
          this._preRollMaxBytes = Math.floor((this.sampleRate * 0.2) * 2);
          audioDebugLog('[AUDIO-DEBUG] Updated sampleRate to ' + this.sampleRate);
        }
      } catch {
        audioDebugLog(
          '[AUDIO-DEBUG] Received non-JSON metadata message #' + this._messageCount +
          ', bytes=' + Buffer.byteLength(String(text || ''), 'utf8')
        );
        this.emit('metadata', text);
      }
      return;
    }

    if (!Buffer.isBuffer(data)) {
      audioDebugLog('[AUDIO-DEBUG] Received non-buffer, non-string message type: ' + typeof data);
      return;
    }

    this._binaryCount++;
    this.emit('audio', data);

    // Log periodically (every 50 chunks or every 5 seconds)
    const now = Date.now();
    if (this._binaryCount % 50 === 1 || now - this._lastLogTime > 5000) {
      const stats = pcmStats(data, this._pcmEndian || 'LE');
      audioDebugLog('[AUDIO-DEBUG] Binary chunk #' + this._binaryCount + ': ' + data.length + ' bytes, RMS=' + Math.round(stats.rms) + ', max=' + stats.maxAbs + ', nearZero=' + (stats.nearZeroRatio*100).toFixed(1) + '%, captureEnabled=' + this.captureEnabled);
      this._lastLogTime = now;
    }

    if (!this.captureEnabled) {
      return;
    }

    if (data.length < 2) return;

    const isSpeech = this._isSpeech(data);
    const chunkMs = this._chunkDurationMs(data.length);

    // Log speech detection periodically
    if (this._binaryCount % 50 === 1) {
      const stats = pcmStats(data, this._pcmEndian || 'LE');
      audioDebugLog('[AUDIO-DEBUG] VAD: isSpeech=' + isSpeech + ', inSpeech=' + this._inSpeech + ', silenceMs=' + Math.round(this._silenceMs) + ', RMS=' + Math.round(stats.rms) + ', max=' + stats.maxAbs);
    }

    if (!this._inSpeech) {
      this._rememberPreRoll(data);
      if (!isSpeech) return;
      this._startUtteranceWithPreRoll();
    }

    this._appendUtterance(data, isSpeech);

    if (isSpeech) this._silenceMs = 0;
    else this._silenceMs += chunkMs;

    const utteranceMs = this._chunkDurationMs(this._utteranceBytes);
    if (utteranceMs >= this.maxUtteranceMs) return this._finalizeUtterance('max_utterance');
    if (this._silenceMs >= this.endSilenceMs) return this._finalizeUtterance('end_silence');
  }

  _handlePlayoutMetadata(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
    const type = String(meta.type || '').trim().toLowerCase();
    const event = String(meta.data?.event || meta.event || '').trim().toLowerCase();
    if (type && type !== 'mark') return false;
    if (event === 'playout') {
      const name = String(meta.name || meta.data?.name || '').trim();
      const marker = this._pendingPlaybackMarkers.get(name);
      if (!marker) {
        this.emit('playout_marker_unmatched', { name: name || null });
        return false;
      }
      this._pendingPlaybackMarkers.delete(name);
      const acknowledgedAt = new Date().toISOString();
      this._lastPlaybackOutcome = {
        itemId: marker.itemId,
        active: false,
        completed: true,
        interrupted: false,
        markerName: name,
        acknowledgedAt,
        remainingMs: 0,
      };
      if (this._playout?.itemId === marker.itemId) this._playout = null;
      this.emit('playout_marker', { ...marker, acknowledgedAt });
      return true;
    }
    if (event === 'cleared') {
      const markers = [...this._pendingPlaybackMarkers.values()];
      this._pendingPlaybackMarkers.clear();
      if (markers.length > 0) {
        this.emit('playout_markers_cleared', { reason: 'module_cleared', markers });
      }
      return true;
    }
    return false;
  }

  _failPendingPlaybackMarkers(reason) {
    const markers = [...this._pendingPlaybackMarkers.values()];
    this._pendingPlaybackMarkers.clear();
    if (markers.length > 0) this.emit('playout_markers_cleared', { reason, markers });
  }

  waitForUtterance({ timeoutMs = 30000, logTimeout = true } = {}) {
    audioDebugLog('[AUDIO-DEBUG] waitForUtterance called, timeoutMs=' + timeoutMs + ', captureEnabled=' + this.captureEnabled);
    return new Promise((resolve, reject) => {
      const onUtterance = (u) => {
        cleanup();
        audioDebugLog('[AUDIO-DEBUG] waitForUtterance resolved with ' + u.audio.length + ' bytes');
        resolve(u);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('AudioForkSession closed for call ' + this.callUuid));
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        cleanup();
        if (logTimeout) {
          audioDebugLog('[AUDIO-DEBUG] waitForUtterance TIMEOUT after ' + timeoutMs + 'ms. Binary chunks received: ' + this._binaryCount);
        }
        reject(new Error('Timed out waiting for utterance (' + timeoutMs + 'ms) for call ' + this.callUuid));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.off('utterance', onUtterance);
        this.off('close', onClose);
        this.off('error', onError);
      };

      this.on('utterance', onUtterance);
      this.on('close', onClose);
      this.on('error', onError);
    });
  }
}

class AudioForkServer extends EventEmitter {
  constructor(options = {}) {
    super();
    assertAudioForkDebugSafe(process.env.DEBUG);
    const normalized = normalizeAudioForkServerOptions(options);
    this.port = normalized.port;
    this.host = normalized.host;
    this.connectHost = normalized.connectHost;
    this.allowNonLoopback = normalized.allowNonLoopback;
    this.allowedPeers = new Set(normalized.allowedPeers);
    this.wss = null;
    this._pendingByCall = new Map();
    this._sessions = new Map();
  }

  start() {
    if (this.wss) return;
    this.wss = new WebSocket.Server({
      port: this.port,
      host: this.host,
      maxPayload: MAX_AUDIO_FORK_FRAME_BYTES,
    });

    this.wss.on('connection', (ws, req) => {
      const pending = this._consumeAuthorizedExpectation(req);
      if (!pending) {
        audioDebugLog('[AUDIO-DEBUG] Rejected unauthorized audio WebSocket attachment');
        ws.close(1008, 'Unauthorized audio session');
        return;
      }
      clearTimeout(pending.timeout);
      const session = new AudioForkSession({
        ws,
        callUuid: pending.callUuid,
        ...(pending.sessionOptions || {}),
      });
      this._sessions.set(pending.callUuid, session);
      const removeExactSession = () => {
        if (this._sessions.get(pending.callUuid) === session) {
          this._sessions.delete(pending.callUuid);
        }
      };
      session.on('close', removeExactSession);
      session.on('error', removeExactSession);

      this.emit('session', session);
      pending.resolve(session);
    });

    this.wss.on('listening', () => {
      const actualPort = this._listeningPort();
      audioDebugLog('[AUDIO-DEBUG] WebSocket server listening on ' + this.host + ':' + actualPort);
      this.emit('listening', { host: this.host, port: actualPort });
    });
    this.wss.on('error', (err) => this.emit('error', err));
  }

  stop() {
    if (!this.wss) return;
    for (const pending of this._pendingByCall.values()) {
      clearTimeout(pending.timeout);
      pending.tokenHash.fill(0);
      pending.reject(createAudioForkError(
        'AUDIO_FORK_SERVER_STOPPED',
        `Audio fork server stopped before call ${pending.callUuid} connected`
      ));
    }
    this._pendingByCall.clear();
    for (const session of this._sessions.values()) session.close(1001, 'audio fork server stopping');
    this._sessions.clear();
    this.wss.close();
    this.wss = null;
  }

  /**
   * Cancel a pending session expectation (call this when a call ends before session connects)
   */
  cancelExpectation(callUuid) {
    const normalizedCallUuid = this._normalizeCallUuid(callUuid);
    const pending = this._pendingByCall.get(normalizedCallUuid);
    if (!pending) return false;
    this._pendingByCall.delete(normalizedCallUuid);
    clearTimeout(pending.timeout);
    pending.tokenHash.fill(0);
    pending.reject(createAudioForkError(
      'AUDIO_FORK_EXPECTATION_CANCELED',
      `Audio fork expectation canceled for call ${normalizedCallUuid}`
    ));
    audioDebugLog('[AUDIO-DEBUG] Cancelled pending expectation for ' + normalizedCallUuid);
    return true;
  }

  expectSession(callUuid, {
    timeoutMs = 5000,
    sampleRate = 16000,
    bidirectionalStreaming = false,
  } = {}) {
    if (!this.wss) {
      throw createAudioForkError('AUDIO_FORK_NOT_LISTENING', 'Audio fork server is not listening');
    }
    const normalizedCallUuid = this._normalizeCallUuid(callUuid);
    const normalizedTimeoutMs = Number(timeoutMs);
    if (!Number.isInteger(normalizedTimeoutMs) || normalizedTimeoutMs < 1 ||
        normalizedTimeoutMs > MAX_AUDIO_EXPECTATION_MS) {
      throw createAudioForkError(
        'AUDIO_FORK_TIMEOUT_INVALID',
        `Audio fork expectation timeout must be between 1 and ${MAX_AUDIO_EXPECTATION_MS} milliseconds`
      );
    }
    if (this._pendingByCall.has(normalizedCallUuid) || this._sessions.has(normalizedCallUuid)) {
      throw createAudioForkError(
        'AUDIO_FORK_EXPECTATION_EXISTS',
        `An audio fork expectation or session already exists for call ${normalizedCallUuid}`
      );
    }

    const attachToken = crypto.randomBytes(AUDIO_ATTACH_TOKEN_BYTES).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(attachToken).digest();
    const connectionUrl = this._buildConnectionUrl(normalizedCallUuid, attachToken);
    let pending;
    const session = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this._pendingByCall.get(normalizedCallUuid) !== pending) return;
        this._pendingByCall.delete(normalizedCallUuid);
        pending.tokenHash.fill(0);
        audioDebugLog('[AUDIO-DEBUG] expectSession TIMEOUT for ' + normalizedCallUuid + ' (handled)');
        reject(createAudioForkError(
          'AUDIO_FORK_EXPECTATION_TIMEOUT',
          `Timed out waiting for WebSocket audio session (${normalizedTimeoutMs}ms) for call ${normalizedCallUuid}`
        ));
      }, normalizedTimeoutMs);

      pending = {
        callUuid: normalizedCallUuid,
        resolve,
        reject,
        timeout,
        tokenHash,
        expiresAt: Date.now() + normalizedTimeoutMs,
        sessionOptions: { sampleRate, bidirectionalStreaming },
      };
    });
    // The FreeSWITCH ESL start call and the WebSocket attachment race. Mark the
    // original promise observed immediately so an expectation timeout, cancel,
    // or shutdown cannot become a process-wide unhandled rejection while the
    // caller is still awaiting ESL. Callers still await this original promise
    // and receive its rejection unchanged.
    void session.catch(() => {});
    this._pendingByCall.set(normalizedCallUuid, pending);
    audioDebugLog(
      '[AUDIO-DEBUG] expectSession registered for ' + normalizedCallUuid +
      ', timeoutMs=' + normalizedTimeoutMs
    );

    const expectation = { session };
    // The one-time URL is intentionally non-enumerable so routine object logging
    // cannot expose the attach credential. Callers pass it directly to
    // FreeSWITCH and must never persist or log it.
    Object.defineProperty(expectation, 'connectionUrl', {
      value: connectionUrl,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.freeze(expectation);
  }

  getSession(callUuid) {
    return this._sessions.get(callUuid);
  }

  _normalizeCallUuid(callUuid) {
    const value = String(callUuid || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value)) {
      throw createAudioForkError('AUDIO_FORK_CALL_ID_INVALID', 'Audio fork call ID is invalid');
    }
    return value;
  }

  _listeningPort() {
    const address = this.wss?.address?.();
    return Number(address?.port || this.port);
  }

  _buildConnectionUrl(callUuid, attachToken) {
    const host = net.isIP(this.connectHost) === 6 ? `[${this.connectHost}]` : this.connectHost;
    return `ws://${host}:${this._listeningPort()}/v1/audio/` +
      `${encodeURIComponent(callUuid)}/${attachToken}`;
  }

  _parseAttachRequest(urlValue) {
    try {
      const parsed = new URL(String(urlValue || '/'), 'ws://audio-fork.invalid');
      if (parsed.search || parsed.hash) return null;
      const parts = parsed.pathname.split('/');
      if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'v1' || parts[2] !== 'audio') {
        return null;
      }
      const callUuid = this._normalizeCallUuid(decodeURIComponent(parts[3]));
      const attachToken = parts[4];
      if (!AUDIO_ATTACH_TOKEN_RE.test(attachToken)) return null;
      return { callUuid, attachToken };
    } catch {
      return null;
    }
  }

  _consumeAuthorizedExpectation(req) {
    const remoteAddress = normalizeIpAddress(req?.socket?.remoteAddress);
    if (!remoteAddress || !this.allowedPeers.has(remoteAddress)) return null;
    const candidate = this._parseAttachRequest(req?.url);
    if (!candidate) return null;
    const pending = this._pendingByCall.get(candidate.callUuid);
    if (!pending || this._sessions.has(candidate.callUuid) || pending.expiresAt < Date.now()) {
      return null;
    }
    const candidateHash = crypto.createHash('sha256').update(candidate.attachToken).digest();
    const matches = candidateHash.length === pending.tokenHash.length &&
      crypto.timingSafeEqual(candidateHash, pending.tokenHash);
    candidateHash.fill(0);
    if (!matches) return null;

    // JavaScript runs each connection callback to completion. Removing the
    // pending row before creating a session makes this credential one-use even
    // if two upgrade requests race in the same event-loop turn.
    this._pendingByCall.delete(candidate.callUuid);
    pending.tokenHash.fill(0);
    return pending;
  }
}

module.exports = {
  assertAudioForkDebugSafe,
  AudioForkServer,
  AudioForkSession,
  isLoopbackAddress,
  normalizeAudioForkServerOptions,
  redactAudioForkSecrets,
};
