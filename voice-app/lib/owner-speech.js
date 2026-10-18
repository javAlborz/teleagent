'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {realtimeWebSocketOptions} = require('./voice-egress-transport');

const MODEL = 'gpt-4o-mini-tts';
const MAX_AUDIO = 8 * 1024 * 1024;
const codeError = code => Object.assign(new Error(code), {code});

// Text is the input to speech synthesis, never a conversational instruction.
// Reuse the admitted OpenAI TLS connector; no new network or credential path.
class OwnerSpeechClient {
  constructor({apiKey, project, organization, voice = 'marin', request = https.request,
    connectionOptions = realtimeWebSocketOptions, timeoutMs = 30000} = {}) {
    Object.assign(this, {apiKey, project, organization, voice, request, connectionOptions, timeoutMs});
  }
  synthesize(text, {signal} = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1800 || !this.apiKey || this.voice !== 'marin') {
      return Promise.reject(codeError('OWNER_SPEECH_CONFIG'));
    }
    const body = Buffer.from(JSON.stringify({model: MODEL, voice: this.voice, input: text,
      response_format: 'pcm', instructions: 'Read the supplied text clearly and faithfully. Do not add commentary.'}));
    const agent = new https.Agent({keepAlive: false, maxSockets: 1, maxTotalSockets: 1});
    try {
      const connect = this.connectionOptions().createConnection;
      if (typeof connect !== 'function') throw new Error('missing connector');
      agent.createConnection = connect;
    } catch { agent.destroy(); return Promise.reject(codeError('OWNER_SPEECH_EGRESS_UNAVAILABLE')); }
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); agent.destroy();
        if (error) reject(error); else resolve(result);
      };
      const req = this.request({hostname: 'api.openai.com', port: 443, path: '/v1/audio/speech',
        method: 'POST', agent, signal, headers: {Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json', 'Content-Length': body.length,
          ...(this.project ? {'OpenAI-Project': this.project} : {}),
          ...(this.organization ? {'OpenAI-Organization': this.organization} : {})}}, res => {
        let bytes = 0; const chunks = [];
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_AUDIO) req.destroy(codeError('OWNER_SPEECH_TOO_LARGE'));
          else chunks.push(chunk);
        });
        res.on('error', () => finish(codeError('OWNER_SPEECH_RESPONSE_FAILED')));
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(codeError(`OWNER_SPEECH_HTTP_${res.statusCode}`));
          if (!bytes || bytes % 2 || /json|text/i.test(res.headers?.['content-type'] || '')) {
            return finish(codeError('OWNER_SPEECH_INVALID_AUDIO'));
          }
          finish(null, Buffer.concat(chunks));
        });
      });
      timer = setTimeout(() => req.destroy(codeError('OWNER_SPEECH_TIMEOUT')), this.timeoutMs);
      req.on('error', error => finish(codeError(signal?.aborted ? 'OWNER_SPEECH_ABORTED'
        : /^OWNER_SPEECH_[A-Z_]+$/.test(error?.code || '') ? error.code : 'OWNER_SPEECH_REQUEST_FAILED')));
      req.end(body);
    });
  }
}

function speechChunks(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 48000) throw codeError('OWNER_SPEECH_TEXT_LIMIT');
  const chunks = [];
  let rest = text.trim();
  while (rest) {
    let end = Math.min(rest.length, 1800);
    if (end < rest.length) {
      const boundary = rest.lastIndexOf(' ', end);
      if (boundary > 900) end = boundary;
    }
    chunks.push(rest.slice(0, end)); rest = rest.slice(end).trimStart();
  }
  return chunks;
}

function playPcm(audioSession, pcm, itemId, signal, wait = delay) {
  return new Promise((resolve, reject) => {
    const name = 'speech:' + crypto.randomBytes(16).toString('hex');
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      audioSession.removeListener('playout_marker', marked);
      audioSession.removeListener('playout_markers_cleared', cleared);
      if (error) { audioSession.stopPlayback?.(); reject(error); } else resolve();
    };
    const aborted = () => finish(codeError('OWNER_SPEECH_INTERRUPTED'));
    const marked = marker => {
      if (marker.name !== name) return;
      finish(marker.itemId === itemId ? null : codeError('OWNER_SPEECH_MARKER_MISMATCH'));
    };
    const cleared = event => {
      if (event.markers?.some(marker => marker.name === name)) finish(codeError('OWNER_SPEECH_INTERRUPTED'));
    };
    // Bound missing-marker uncertainty by this PCM's duration and a small grace.
    const timer = setTimeout(() => finish(codeError('OWNER_SPEECH_PLAYOUT_TIMEOUT')), pcm.length / 48 + 5000);
    audioSession.on('playout_marker', marked);
    audioSession.on('playout_markers_cleared', cleared);
    signal?.addEventListener('abort', aborted, {once: true});
    if (signal?.aborted) return aborted();
    void (async () => {
      // Pace PCM into the existing media path to bound its queue and memory.
      for (let offset = 0; offset < pcm.length; offset += 4800) {
        if (settled) return;
        const chunk = pcm.subarray(offset, offset + 4800);
        if (!audioSession.sendAudio(chunk, {sampleRate: 24000, itemId})) throw codeError('OWNER_SPEECH_PLAYOUT_FAILED');
        if (offset + chunk.length < pcm.length) await wait(chunk.length / 48, undefined, {signal});
      }
      if (!audioSession.markPlaybackComplete(itemId) || !audioSession.sendPlaybackMarker(name, {itemId})) {
        throw codeError('OWNER_SPEECH_MARKER_FAILED');
      }
    })().catch(error => finish(signal?.aborted ? codeError('OWNER_SPEECH_INTERRUPTED') : error));
  });
}

function createOwnerSpeech({client, audioSession, onState = () => {}, wait = delay}) {
  return async ({text, id, signal}) => {
    let state = 'rendering', playedChunks = 0;
    const report = (next, code = null) => { state = next; onState({id, state, code, playedChunks}); };
    try {
      for (const [index, chunk] of speechChunks(text).entries()) {
        report('rendering');
        let pcm;
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          try { pcm = await client.synthesize(chunk, {signal}); break; }
          catch (error) {
            // A retry is safe only before any audio from this chunk was queued.
            if (signal.aborted || attempt || !/TIMEOUT|REQUEST_FAILED|RESPONSE_FAILED|HTTP_5\d\d/.test(error.code || '')) throw error;
          }
        }
        signal.throwIfAborted(); report('playing');
        await playPcm(audioSession, pcm, `tts_${id}_${index}`, signal, wait);
        playedChunks++;
      }
      report('played'); return {state, playedChunks};
    } catch (error) {
      report(signal.aborted || error.code === 'OWNER_SPEECH_INTERRUPTED' ? 'interrupted' : 'failed',
        /^OWNER_SPEECH_[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'OWNER_SPEECH_FAILED');
      return {state, playedChunks};
    }
  };
}

module.exports = {OwnerSpeechClient, createOwnerSpeech, playPcm, speechChunks, MODEL};
