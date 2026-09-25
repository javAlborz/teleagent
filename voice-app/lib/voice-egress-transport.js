'use strict';
const tls = require('node:tls');
const http = require('node:http');
const net = require('node:net');
const { SOCKETS, assertVoiceEgressRuntime } = require('../../lib/voice-egress-runtime');
let runtime = null;
const shutdown = new AbortController();
const sockets = new Set();
const speechAgent = new http.Agent({ keepAlive: false, maxSockets: 8, maxTotalSockets: 8, maxFreeSockets: 0 });
function speechEndpoint(options) {
  const name = ['tts', 'stt'].find((service) => SOCKETS[service] === options.socketPath);
  if (!name) throw new Error('speech agent receiver differs from its fixed Unix path');
  return current().endpoint(name);
}
// Node can assign a freed socket directly to a queued request even with
// keepAlive disabled. Re-admit before its built-in free handler can dispatch.
speechAgent.prependListener('free', (socket, options) => {
  try { speechEndpoint(options); }
  catch { socket.destroy(); }
});
speechAgent.createConnection = (options, callback) => {
  try {
    // Agent capacity may defer this until long after request construction.
    // Re-admit here, and never inherit host/port/proxy options into the socket.
    return net.createConnection({ path: speechEndpoint(options) });
  } catch (error) {
    process.nextTick(callback, error);
    return undefined;
  }
};
function configureVoiceEgress(value) {
  assertVoiceEgressRuntime(value);
  if (shutdown.signal.aborted || (runtime && runtime !== value)) throw new Error('voice egress generation cannot be replaced');
  runtime = value;
}
function current() {
  if (shutdown.signal.aborted) throw new Error('voice egress is stopped');
  return assertVoiceEgressRuntime(runtime);
}
function realtimeWebSocketOptions() {
  const admission = current();
  admission.endpoint('realtime');
  return Object.freeze({
    followRedirects: false, maxRedirects: 0, agent: undefined,
    createConnection() {
      current();
      const socket = tls.connect({ path: admission.endpoint('realtime'), servername: 'api.openai.com',
        rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity, ca: admission.caCertificates,
        minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('secureConnect', () => {
        try { current(); admission.endpoint('realtime'); }
        catch { socket.destroy(new Error('voice egress generation changed during TLS')); }
      });
      return socket;
    },
  });
}
function speechRequestOptions(name, signal) {
  if (!['tts', 'stt'].includes(name)) throw new Error('unknown speech receiver');
  return Object.freeze({ socketPath: current().endpoint(name), proxy: false, maxRedirects: 0, httpAgent: speechAgent,
    signal: signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal });
}
function stopVoiceEgress() {
  shutdown.abort();
  speechAgent.destroy();
  for (const socket of sockets) socket.destroy();
}
module.exports = { configureVoiceEgress, realtimeWebSocketOptions, speechRequestOptions, stopVoiceEgress };
