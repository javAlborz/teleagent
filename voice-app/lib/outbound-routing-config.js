'use strict';

const net = require('node:net');

const VALID_TRANSPORTS = new Set(['udp', 'tcp', 'tls']);

class OutboundRoutingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutboundRoutingConfigError';
    this.code = 'OUTBOUND_ROUTING_CONFIG_INVALID';
  }
}

function requiredSetting(env, name) {
  const raw = env?.[name];
  if (typeof raw !== 'string' || !raw || raw !== raw.trim() ||
      /[\u0000-\u001F\u007F]/.test(raw)) {
    throw new OutboundRoutingConfigError(`${name} must be explicitly configured without whitespace or control characters`);
  }
  return raw;
}

function normalizeCallbackAuth(value) {
  const username = String(value?.username || '');
  const password = String(value?.password || '');
  if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(username)) {
    throw new OutboundRoutingConfigError('SIP callback authentication username is invalid');
  }
  if (Buffer.byteLength(password, 'utf8') < 32 || Buffer.byteLength(password, 'utf8') > 4096 ||
      !/^[\x21-\x7e]+$/u.test(password)) {
    throw new OutboundRoutingConfigError('SIP callback authentication credential is invalid');
  }
  return Object.freeze({ username, password });
}

function normalizeHost(value) {
  const host = String(value || '').toLowerCase();
  if (host.length > 253 || /[\s\[\]:\/@;?#\\]/.test(host)) {
    throw new OutboundRoutingConfigError(
      'SIP_TRUNK_HOST must be one exact hostname or IPv4 address, without a port, URI, or parameters'
    );
  }
  if (net.isIP(host) === 4) return host;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host)) {
    throw new OutboundRoutingConfigError('SIP_TRUNK_HOST is not a valid exact hostname or IPv4 address');
  }
  return host;
}

function normalizePort(value) {
  const text = String(value || '');
  if (!/^\d{1,5}$/.test(text)) {
    throw new OutboundRoutingConfigError('SIP_TRUNK_PORT must be an explicit integer from 1 to 65535');
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OutboundRoutingConfigError('SIP_TRUNK_PORT must be an explicit integer from 1 to 65535');
  }
  return port;
}

function normalizeTransport(value) {
  const transport = String(value || '').toLowerCase();
  if (!VALID_TRANSPORTS.has(transport)) {
    throw new OutboundRoutingConfigError('SIP_TRUNK_TRANSPORT must be exactly udp, tcp, or tls');
  }
  return transport;
}

function normalizeDialUser(to) {
  const target = String(to || '');
  if (!/^\+[1-9]\d{1,14}$/.test(target) && !/^\d{1,15}$/.test(target)) {
    throw new Error('Outbound target must be a valid phone number or extension');
  }
  return target.startsWith('+') ? `9${target.replace(/^\+1?/, '')}` : target;
}

function createOutboundRoutingConfig({ host, port, transport, callbackAuth }) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = normalizePort(port);
  const normalizedTransport = normalizeTransport(transport);
  const normalizedCallbackAuth = normalizeCallbackAuth(callbackAuth);
  const authority = `${normalizedHost}:${normalizedPort}`;
  return Object.freeze({
    host: normalizedHost,
    port: normalizedPort,
    transport: normalizedTransport,
    authority,
    buildSipUri(to) {
      return `sip:${normalizeDialUser(to)}@${authority};transport=${normalizedTransport}`;
    },
    buildFromUri(user) {
      const cleanUser = String(user || '').trim();
      if (!/^[+a-zA-Z0-9_.!~*'()-]{1,100}$/.test(cleanUser)) {
        throw new Error('Outbound From user is invalid');
      }
      return `sip:${cleanUser}@${authority}`;
    },
    getCallbackAuth() {
      return { ...normalizedCallbackAuth };
    },
  });
}

function verifyOutboundRoutingConfig(value) {
  if (!value || typeof value !== 'object' || typeof value.getCallbackAuth !== 'function') {
    throw new OutboundRoutingConfigError('A validated authenticated outbound SIP route is required');
  }
  return createOutboundRoutingConfig({
    host: value.host,
    port: value.port,
    transport: value.transport,
    callbackAuth: value.getCallbackAuth(),
  });
}

module.exports = {
  OutboundRoutingConfigError,
  createOutboundRoutingConfig,
  normalizeDialUser,
  requiredSetting,
  verifyOutboundRoutingConfig,
};
