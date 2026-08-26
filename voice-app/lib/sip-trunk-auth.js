'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const INGRESS_AUTH_USERNAME = 'teleagent-asterisk';
const CALLBACK_AUTH_USERNAME = 'teleagent-voice';
const AUTH_REALM = 'teleagent-voice';
const INGRESS_PASSWORD_FILE = '/run/secrets/teleagent-sip-ingress-password';
const CALLBACK_PASSWORD_FILE = '/run/secrets/teleagent-sip-callback-password';
const CREDENTIAL_MIN_BYTES = 32;
const CREDENTIAL_MAX_BYTES = 4096;
const DEFAULT_NONCE_TTL_MS = 30_000;
const DEFAULT_MAX_NONCES = 1024;
const PLACEHOLDER_PATTERN = /(?:replace[-_ ]?with|changeme|placeholder|example|your[-_ ]?(?:password|secret|token))/i;

class SipTrunkAuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SipTrunkAuthConfigError';
    this.code = 'SIP_TRUNK_AUTH_CONFIG_INVALID';
  }
}

function normalizeCredential(value, name) {
  let credential = value;
  if (Buffer.isBuffer(credential)) {
    credential = credential.toString('utf8');
  }
  if (typeof credential !== 'string') {
    throw new SipTrunkAuthConfigError(`${name} is missing or unreadable`);
  }
  credential = credential.replace(/\r?\n$/u, '');
  if (Buffer.byteLength(credential, 'utf8') < CREDENTIAL_MIN_BYTES ||
      Buffer.byteLength(credential, 'utf8') > CREDENTIAL_MAX_BYTES ||
      !/^[A-Za-z0-9._~-]+$/u.test(credential) || PLACEHOLDER_PATTERN.test(credential)) {
    throw new SipTrunkAuthConfigError(
      `${name} must be a non-placeholder 32-4096 byte base64url-safe credential`
    );
  }
  return credential;
}

function hasSafeCredentialFileMetadata(metadata, {
  effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : -1,
  effectiveGid = typeof process.getegid === 'function' ? process.getegid() : -1,
} = {}) {
  if (!metadata?.isFile?.() || metadata.uid !== 0 || metadata.nlink !== 1) return false;
  const permissions = metadata.mode & 0o777;
  if (effectiveUid === 0) return permissions === 0o400 || permissions === 0o440;
  return metadata.gid === effectiveGid && permissions === 0o440;
}

function readCredentialFile(filename, name) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const metadata = fs.fstatSync(descriptor);
    if (!hasSafeCredentialFileMetadata(metadata) ||
        metadata.size < CREDENTIAL_MIN_BYTES || metadata.size > CREDENTIAL_MAX_BYTES + 1) {
      throw new SipTrunkAuthConfigError(`${name} has unsafe file metadata`);
    }
    return normalizeCredential(fs.readFileSync(descriptor), name);
  } catch (error) {
    if (error instanceof SipTrunkAuthConfigError) throw error;
    throw new SipTrunkAuthConfigError(`${name} is missing or unreadable`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function sipDigestHex(value) {
  // The deployed Ubuntu 24.04 Asterisk 20.6/PJProject 2.13 UAC supports the
  // interoperable MD5 SIP Digest algorithm, but not RFC 7616 SHA-256. Security
  // therefore comes from two random 256-bit credentials, one-use nonces, qop,
  // short nonce lifetime, and timing-safe comparison—not a human password.
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function timingSafeDigestEqual(left, right) {
  if (!/^[a-f0-9]{32}$/i.test(String(left || '')) ||
      !/^[a-f0-9]{32}$/i.test(String(right || ''))) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(String(left).toLowerCase(), 'hex'),
    Buffer.from(String(right).toLowerCase(), 'hex')
  );
}

function timingSafeCredentialEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(right, 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function parseDigestAuthorization(header) {
  if (typeof header !== 'string' || header.length < 8 || header.length > 8192 ||
      !/^Digest\s+/i.test(header)) {
    return null;
  }
  const fields = Object.create(null);
  const source = header.replace(/^Digest\s+/i, '');
  const pattern = /(?:^|,)\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gy;
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match || match.index !== offset) return null;
    const key = match[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(fields, key)) return null;
    fields[key] = match[2] !== undefined
      ? match[2].replace(/\\(["\\])/g, '$1')
      : match[3];
    offset = pattern.lastIndex;
  }
  return fields;
}

function requestUri(req) {
  const value = req?.uri;
  if (typeof value === 'string') return value;
  if (value && typeof value.toString === 'function') return value.toString();
  return '';
}

function createInboundDigestAuthenticator({
  username = INGRESS_AUTH_USERNAME,
  password,
  realm = AUTH_REALM,
  nonceTtlMs = DEFAULT_NONCE_TTL_MS,
  maxNonces = DEFAULT_MAX_NONCES,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const normalizedPassword = normalizeCredential(password, 'SIP ingress credential');
  if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(username) ||
      !/^[A-Za-z0-9._~-]{1,128}$/u.test(realm)) {
    throw new SipTrunkAuthConfigError('SIP ingress username or realm is invalid');
  }
  if (!Number.isInteger(nonceTtlMs) || nonceTtlMs < 1000 || nonceTtlMs > 300_000 ||
      !Number.isInteger(maxNonces) || maxNonces < 1 || maxNonces > 10_000) {
    throw new SipTrunkAuthConfigError('SIP ingress nonce bounds are invalid');
  }

  const nonces = new Map();
  const admissions = new WeakSet();
  const opaque = randomBytes(24).toString('base64url');
  const ha1 = sipDigestHex(`${username}:${realm}:${normalizedPassword}`);

  function pruneNonces(currentTime) {
    for (const [nonce, expiresAt] of nonces) {
      if (expiresAt <= currentTime) nonces.delete(nonce);
    }
    while (nonces.size >= maxNonces) {
      nonces.delete(nonces.keys().next().value);
    }
  }

  function challenge(res) {
    const currentTime = now();
    pruneNonces(currentTime);
    const nonce = randomBytes(24).toString('base64url');
    nonces.set(nonce, currentTime + nonceTtlMs);
    const header = `Digest realm="${realm}", nonce="${nonce}", opaque="${opaque}", algorithm=MD5, qop="auth"`;
    try {
      res.send(401, { headers: { 'WWW-Authenticate': header } });
    } catch {}
    return null;
  }

  function authenticateInvite(req, res) {
    const method = String(req?.method || '').toUpperCase();
    const uri = requestUri(req);
    if (method !== 'INVITE' || !uri || uri.length > 2048) return challenge(res);

    const authorization = parseDigestAuthorization(req.get?.('Authorization'));
    if (!authorization) return challenge(res);
    const expiresAt = nonces.get(authorization.nonce);
    // Every presented nonce is one-use, including a failed guess. A retry must
    // answer a fresh challenge and a captured Authorization value cannot replay.
    nonces.delete(authorization.nonce);
    const currentTime = now();
    if (!expiresAt || expiresAt <= currentTime ||
        authorization.username !== username || authorization.realm !== realm ||
        authorization.uri !== uri || authorization.opaque !== opaque ||
        String(authorization.algorithm || 'MD5').toUpperCase() !== 'MD5' ||
        authorization.qop !== 'auth' || !/^[a-f0-9]{8}$/i.test(authorization.nc || '') ||
        !/^[\x21-\x7e]{8,256}$/u.test(authorization.cnonce || '')) {
      return challenge(res);
    }

    const ha2 = sipDigestHex(`${method}:${uri}`);
    const expected = sipDigestHex(
      `${ha1}:${authorization.nonce}:${authorization.nc}:${authorization.cnonce}:auth:${ha2}`
    );
    if (!timingSafeDigestEqual(authorization.response, expected)) return challenge(res);

    const admission = Object.freeze({ authenticated: true });
    admissions.add(admission);
    return admission;
  }

  function consumeAdmission(admission) {
    if (!admission || !admissions.has(admission)) return false;
    admissions.delete(admission);
    return true;
  }

  return Object.freeze({ authenticateInvite, consumeAdmission });
}

function loadSipTrunkSecurityConfig({
  env = process.env,
  credentialReader = readCredentialFile,
} = {}) {
  // Require the fixed in-container credential mounts. Host paths remain Compose
  // interpolation only and never enter the voice process environment.
  const ingressPassword = credentialReader(
    INGRESS_PASSWORD_FILE,
    'SIP ingress credential'
  );
  const callbackPassword = credentialReader(
    CALLBACK_PASSWORD_FILE,
    'SIP callback credential'
  );
  const normalizedIngressPassword = normalizeCredential(ingressPassword, 'SIP ingress credential');
  const normalizedCallbackPassword = normalizeCredential(callbackPassword, 'SIP callback credential');
  if (timingSafeCredentialEqual(normalizedIngressPassword, normalizedCallbackPassword)) {
    throw new SipTrunkAuthConfigError('SIP ingress and callback credentials must be distinct');
  }

  // Load lazily to keep routing normalization independent from credential I/O.
  const { createOutboundRoutingConfig, requiredSetting } = require('./outbound-routing-config');
  const outboundRouting = createOutboundRoutingConfig({
    host: requiredSetting(env, 'SIP_TRUNK_HOST'),
    port: requiredSetting(env, 'SIP_TRUNK_PORT'),
    transport: requiredSetting(env, 'SIP_TRUNK_TRANSPORT'),
    callbackAuth: {
      username: CALLBACK_AUTH_USERNAME,
      password: normalizedCallbackPassword,
    },
  });

  return Object.freeze({
    inboundAuthenticator: createInboundDigestAuthenticator({
      username: INGRESS_AUTH_USERNAME,
      password: normalizedIngressPassword,
    }),
    outboundRouting,
  });
}

module.exports = {
  AUTH_REALM,
  CALLBACK_AUTH_USERNAME,
  CALLBACK_PASSWORD_FILE,
  INGRESS_AUTH_USERNAME,
  INGRESS_PASSWORD_FILE,
  SipTrunkAuthConfigError,
  createInboundDigestAuthenticator,
  hasSafeCredentialFileMetadata,
  loadSipTrunkSecurityConfig,
  normalizeCredential,
  parseDigestAuthorization,
  readCredentialFile,
};
