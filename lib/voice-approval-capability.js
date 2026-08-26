'use strict';

const crypto = require('node:crypto');

const TOKEN_PREFIX = 'telecap1';
const TOKEN_TYPE = 'TELEAGENT_APPROVAL';
const TOKEN_VERSION = 1;
const SIGNATURE_ALGORITHM = 'EdDSA';
const DEFAULT_PURPOSE = 'teleagent.privileged-execution.v1';
const DEFAULT_TTL_SECONDS = 120;
const DEFAULT_MAX_TTL_SECONDS = 300;
const DEFAULT_CLOCK_SKEW_SECONDS = 15;
const NONCE_BYTES = 24;
const MAX_TOKEN_BYTES = 16384;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const CLAIM_KEYS = Object.freeze([
  'v',
  'purpose',
  'job_id',
  'request_sha256',
  'plan_sha256',
  'target',
  'provider',
  'profile',
  'iat',
  'exp',
  'nonce',
]);

// Capabilities are bearer credentials. This module deliberately never logs a
// token, signing key, or raw plan. Persist only the token digest emitted to the
// replay store, and keep the issuer's private key outside worker processes.

class ApprovalCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalCapabilityError';
    this.code = code;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

function capabilityError(code, message) {
  return new ApprovalCapabilityError(code, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requirePlainObject(value, label) {
  if (!plainObject(value)) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', `${label} must be a plain object.`);
  }
  return value;
}

function requireBoundedString(value, label, { min = 1, max = 512 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.trim() !== value) {
    throw capabilityError(
      'CAPABILITY_INVALID_ARGUMENT',
      `${label} must be a trimmed string between ${min} and ${max} characters.`
    );
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', `${label} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', `${label} must be a safe integer.`);
  }
  return value;
}

function requireKeyId(value) {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'keyId has an invalid format.');
  }
  return value;
}

function normalizePrivateKey(value) {
  let key;
  try {
    key = value?.type === 'private' ? value : crypto.createPrivateKey(value);
  } catch {
    throw capabilityError('CAPABILITY_INVALID_KEY', 'A valid Ed25519 private signing key is required.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw capabilityError('CAPABILITY_INVALID_KEY', 'The capability signing key must be Ed25519.');
  }
  return key;
}

function normalizePublicKey(value) {
  let key;
  try {
    key = value?.type === 'public' ? value : crypto.createPublicKey(value);
  } catch {
    throw capabilityError('CAPABILITY_INVALID_KEY', 'A valid Ed25519 public verification key is required.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw capabilityError('CAPABILITY_INVALID_KEY', 'Capability verification keys must be Ed25519.');
  }
  return key;
}

function normalizePublicKeys(publicKeys) {
  const entries = publicKeys instanceof Map
    ? [...publicKeys.entries()]
    : Object.entries(requirePlainObject(publicKeys, 'publicKeys'));
  if (entries.length === 0) {
    throw capabilityError('CAPABILITY_INVALID_KEY', 'At least one public verification key is required.');
  }

  const result = new Map();
  for (const [keyId, publicKey] of entries) {
    result.set(requireKeyId(keyId), normalizePublicKey(publicKey));
  }
  return result;
}

function base64UrlDecode(segment, label) {
  if (typeof segment !== 'string' || segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw capabilityError('CAPABILITY_MALFORMED', `Capability ${label} is malformed.`);
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) {
    throw capabilityError('CAPABILITY_MALFORMED', `Capability ${label} is not canonically encoded.`);
  }
  return decoded;
}

function parseJsonSegment(segment, label) {
  const decoded = base64UrlDecode(segment, label);
  try {
    return requirePlainObject(JSON.parse(decoded.toString('utf8')), `Capability ${label}`);
  } catch (error) {
    if (error instanceof ApprovalCapabilityError) throw error;
    throw capabilityError('CAPABILITY_MALFORMED', `Capability ${label} is not valid JSON.`);
  }
}

function safeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftDigest = crypto.createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(right, 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function canonicalizePlan(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'Approval plans cannot contain non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'Approval plans cannot contain cycles.');
    }
    seen.add(value);
    const encoded = `[${value.map(entry => canonicalizePlan(entry, seen)).join(',')}]`;
    seen.delete(value);
    return encoded;
  }
  if (plainObject(value)) {
    if (seen.has(value)) {
      throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'Approval plans cannot contain cycles.');
    }
    seen.add(value);
    const keys = Object.keys(value).sort();
    const entries = keys.map(key => {
      if (value[key] === undefined || typeof value[key] === 'function' || typeof value[key] === 'symbol') {
        throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'Approval plans must contain JSON-compatible values.');
      }
      return `${JSON.stringify(key)}:${canonicalizePlan(value[key], seen)}`;
    });
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }
  throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'Approval plans must contain only JSON-compatible values.');
}

function hashApprovalPlan(plan) {
  return crypto.createHash('sha256').update(canonicalizePlan(plan), 'utf8').digest('hex');
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function clockSeconds(now, owner) {
  const timestampMilliseconds = Number(now());
  if (!Number.isFinite(timestampMilliseconds) || timestampMilliseconds < 0) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', `The ${owner} clock returned an invalid timestamp.`);
  }
  return Math.floor(timestampMilliseconds / 1000);
}

function generateApprovalCapabilityKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

function normalizeIssuedClaims(input, { purpose, nowSeconds, nonce }) {
  requirePlainObject(input, 'Capability claims');
  const claims = {
    v: TOKEN_VERSION,
    purpose,
    job_id: requireBoundedString(input.jobId, 'jobId', { max: 256 }),
    request_sha256: requireHash(input.requestHash, 'requestHash'),
    plan_sha256: requireHash(input.planHash, 'planHash'),
    target: requireBoundedString(input.target, 'target', { max: 512 }),
    provider: requireBoundedString(input.provider, 'provider', { max: 96 }),
    profile: requireBoundedString(input.profile, 'profile', { max: 128 }),
    iat: nowSeconds,
    exp: 0,
    nonce,
  };
  return claims;
}

function createApprovalCapabilityIssuer({
  privateKey,
  keyId,
  purpose = DEFAULT_PURPOSE,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  defaultTtlSeconds = DEFAULT_TTL_SECONDS,
  maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS,
} = {}) {
  const signingKey = normalizePrivateKey(privateKey);
  const signingKeyId = requireKeyId(keyId);
  const tokenPurpose = requireBoundedString(purpose, 'purpose', { max: 128 });
  if (typeof now !== 'function' || typeof randomBytes !== 'function') {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'now and randomBytes must be functions.');
  }
  requireInteger(defaultTtlSeconds, 'defaultTtlSeconds');
  requireInteger(maxTtlSeconds, 'maxTtlSeconds');
  if (defaultTtlSeconds < 1 || maxTtlSeconds < defaultTtlSeconds) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'Capability TTL limits are invalid.');
  }

  return Object.freeze({
    issue(input) {
      requirePlainObject(input, 'Capability input');
      const ttlSeconds = input.ttlSeconds === undefined ? defaultTtlSeconds : input.ttlSeconds;
      requireInteger(ttlSeconds, 'ttlSeconds');
      if (ttlSeconds < 1 || ttlSeconds > maxTtlSeconds) {
        throw capabilityError(
          'CAPABILITY_INVALID_ARGUMENT',
          `ttlSeconds must be between 1 and ${maxTtlSeconds}.`
        );
      }

      const issuedAt = clockSeconds(now, 'issuer');
      const nonceBuffer = Buffer.from(randomBytes(NONCE_BYTES));
      if (nonceBuffer.length < NONCE_BYTES) {
        throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'The nonce source returned insufficient entropy.');
      }
      const nonce = nonceBuffer.toString('base64url');
      const claims = normalizeIssuedClaims(input, { purpose: tokenPurpose, nowSeconds: issuedAt, nonce });
      claims.exp = issuedAt + ttlSeconds;

      const header = {
        alg: SIGNATURE_ALGORITHM,
        kid: signingKeyId,
        typ: TOKEN_TYPE,
      };
      const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
      const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      const signature = crypto.sign(null, Buffer.from(signingInput, 'ascii'), signingKey);
      return `${TOKEN_PREFIX}.${signingInput}.${signature.toString('base64url')}`;
    },
  });
}

function validateHeader(header) {
  const keys = Object.keys(header).sort();
  if (keys.join(',') !== 'alg,kid,typ' || header.alg !== SIGNATURE_ALGORITHM || header.typ !== TOKEN_TYPE) {
    throw capabilityError('CAPABILITY_MALFORMED', 'Capability header is invalid.');
  }
  return requireKeyId(header.kid);
}

function validateVerifiedClaims(claims, { purpose, nowSeconds, maxTtlSeconds, clockSkewSeconds }) {
  if (Object.keys(claims).sort().join(',') !== [...CLAIM_KEYS].sort().join(',')) {
    throw capabilityError('CAPABILITY_MALFORMED', 'Capability claims are invalid.');
  }
  if (claims.v !== TOKEN_VERSION || !safeStringEqual(claims.purpose, purpose)) {
    throw capabilityError('CAPABILITY_WRONG_PURPOSE', 'Capability has the wrong version or purpose.');
  }
  requireBoundedString(claims.job_id, 'job_id', { max: 256 });
  requireHash(claims.request_sha256, 'request_sha256');
  requireHash(claims.plan_sha256, 'plan_sha256');
  requireBoundedString(claims.target, 'target', { max: 512 });
  requireBoundedString(claims.provider, 'provider', { max: 96 });
  requireBoundedString(claims.profile, 'profile', { max: 128 });
  requireInteger(claims.iat, 'iat');
  requireInteger(claims.exp, 'exp');
  if (typeof claims.nonce !== 'string' || !NONCE_PATTERN.test(claims.nonce)) {
    throw capabilityError('CAPABILITY_MALFORMED', 'Capability nonce is invalid.');
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxTtlSeconds) {
    throw capabilityError('CAPABILITY_INVALID_LIFETIME', 'Capability lifetime is invalid.');
  }
  if (claims.iat > nowSeconds + clockSkewSeconds) {
    throw capabilityError('CAPABILITY_NOT_YET_VALID', 'Capability is not yet valid.');
  }
  if (nowSeconds >= claims.exp) {
    throw capabilityError('CAPABILITY_EXPIRED', 'Capability has expired.');
  }
  return claims;
}

function normalizeExpectedBindings(expected) {
  requirePlainObject(expected, 'Expected capability bindings');
  return {
    job_id: requireBoundedString(expected.jobId, 'expected.jobId', { max: 256 }),
    request_sha256: requireHash(expected.requestHash, 'expected.requestHash'),
    plan_sha256: requireHash(expected.planHash, 'expected.planHash'),
    target: requireBoundedString(expected.target, 'expected.target', { max: 512 }),
    provider: requireBoundedString(expected.provider, 'expected.provider', { max: 96 }),
    profile: requireBoundedString(expected.profile, 'expected.profile', { max: 128 }),
  };
}

function assertExpectedBindings(claims, expected) {
  const normalized = normalizeExpectedBindings(expected);
  let matches = true;
  for (const [claimName, expectedValue] of Object.entries(normalized)) {
    // Do every comparison even after a mismatch so field order does not create
    // an avoidable timing oracle. Each comparison uses fixed-size digests.
    matches = safeStringEqual(claims[claimName], expectedValue) && matches;
  }
  if (!matches) {
    throw capabilityError('CAPABILITY_BINDING_MISMATCH', 'Capability does not match the requested operation.');
  }
}

function normalizeReplayStore(replayStore) {
  if (!replayStore || typeof replayStore.consume !== 'function') {
    throw capabilityError(
      'CAPABILITY_REPLAY_STORE_REQUIRED',
      'A replay store with an atomic consume(record) operation is required.'
    );
  }
  return replayStore;
}

function createApprovalCapabilityVerifier({
  publicKeys,
  replayStore,
  purpose = DEFAULT_PURPOSE,
  now = Date.now,
  maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
} = {}) {
  const verificationKeys = normalizePublicKeys(publicKeys);
  const nonceStore = normalizeReplayStore(replayStore);
  const tokenPurpose = requireBoundedString(purpose, 'purpose', { max: 128 });
  if (typeof now !== 'function') {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'now must be a function.');
  }
  requireInteger(maxTtlSeconds, 'maxTtlSeconds');
  requireInteger(clockSkewSeconds, 'clockSkewSeconds');
  if (maxTtlSeconds < 1 || clockSkewSeconds < 0 || clockSkewSeconds > 300) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'Verifier timing limits are invalid.');
  }

  function verify(token) {
    if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      throw capabilityError('CAPABILITY_MALFORMED', 'Capability token is missing or too large.');
    }
    const segments = token.split('.');
    if (segments.length !== 4 || segments[0] !== TOKEN_PREFIX) {
      throw capabilityError('CAPABILITY_MALFORMED', 'Capability token format is invalid.');
    }
    const [, encodedHeader, encodedClaims, encodedSignature] = segments;
    const header = parseJsonSegment(encodedHeader, 'header');
    const keyId = validateHeader(header);
    const verificationKey = verificationKeys.get(keyId);
    if (!verificationKey) {
      throw capabilityError('CAPABILITY_UNKNOWN_KEY', 'Capability signing key is not trusted.');
    }
    const signature = base64UrlDecode(encodedSignature, 'signature');
    if (signature.length !== 64) {
      throw capabilityError('CAPABILITY_BAD_SIGNATURE', 'Capability signature is invalid.');
    }
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    if (!crypto.verify(null, Buffer.from(signingInput, 'ascii'), verificationKey, signature)) {
      throw capabilityError('CAPABILITY_BAD_SIGNATURE', 'Capability signature is invalid.');
    }

    const claims = parseJsonSegment(encodedClaims, 'claims');
    const nowSeconds = clockSeconds(now, 'verifier');
    validateVerifiedClaims(claims, {
      purpose: tokenPurpose,
      nowSeconds,
      maxTtlSeconds,
      clockSkewSeconds,
    });
    return Object.freeze({
      ...claims,
      key_id: keyId,
    });
  }

  return Object.freeze({
    // Signature verification alone is not authorization. Execution paths must
    // call consume(token, expectedBindings), which also checks the exact scope
    // and atomically claims the nonce.
    verify,

    consumeSync(token, expected) {
      const claims = verify(token);
      assertExpectedBindings(claims, expected);
      const consumedAt = clockSeconds(now, 'verifier');
      if (consumedAt >= claims.exp) {
        throw capabilityError('CAPABILITY_EXPIRED', 'Capability has expired.');
      }
      let consumed;
      try {
        consumed = nonceStore.consume(Object.freeze({
          keyId: claims.key_id,
          nonce: claims.nonce,
          jobId: claims.job_id,
          purpose: claims.purpose,
          tokenSha256: tokenDigest(token),
          expiresAt: claims.exp,
          consumedAt,
        }));
      } catch {
        throw capabilityError('CAPABILITY_REPLAY_STORE_ERROR', 'Capability replay protection is unavailable.');
      }
      if (consumed && typeof consumed.then === 'function') {
        throw capabilityError(
          'CAPABILITY_REPLAY_STORE_ERROR',
          'Capability replay protection must consume synchronously at the execution boundary.'
        );
      }
      if (consumed !== true) {
        throw capabilityError('CAPABILITY_REPLAYED', 'Capability has already been consumed.');
      }
      return claims;
    },

    async consume(token, expected) {
      const claims = verify(token);
      assertExpectedBindings(claims, expected);
      const consumedAt = clockSeconds(now, 'verifier');
      if (consumedAt >= claims.exp) {
        throw capabilityError('CAPABILITY_EXPIRED', 'Capability has expired.');
      }
      let consumed;
      try {
        consumed = await nonceStore.consume(Object.freeze({
          keyId: claims.key_id,
          nonce: claims.nonce,
          jobId: claims.job_id,
          purpose: claims.purpose,
          tokenSha256: tokenDigest(token),
          expiresAt: claims.exp,
          consumedAt,
        }));
      } catch {
        throw capabilityError('CAPABILITY_REPLAY_STORE_ERROR', 'Capability replay protection is unavailable.');
      }
      if (consumed !== true) {
        throw capabilityError('CAPABILITY_REPLAYED', 'Capability has already been consumed.');
      }
      return claims;
    },
  });
}

class MemoryCapabilityReplayStore {
  constructor() {
    this.consumed = new Map();
  }

  consume(record) {
    const key = `${record.keyId}\u0000${record.nonce}`;
    if (this.consumed.has(key)) return false;
    this.consumed.set(key, { ...record });
    return true;
  }

  purgeExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
    let removed = 0;
    for (const [key, record] of this.consumed.entries()) {
      if (record.expiresAt <= nowSeconds) {
        this.consumed.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

function createSqliteCapabilityReplayStore(db, {
  tableName = 'voice_approval_capability_nonces',
} = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'A compatible SQLite database is required.');
  }
  if (!SQLITE_IDENTIFIER_PATTERN.test(tableName)) {
    throw capabilityError('CAPABILITY_INVALID_ARGUMENT', 'SQLite replay tableName is invalid.');
  }

  // The (key_id, nonce) primary key is the atomic consume-once boundary. The
  // caller may provide another store, but its consume(record) must implement
  // the same insert-if-absent semantics and return true only for the winner.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      key_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      job_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      token_sha256 TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL,
      PRIMARY KEY (key_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS ${tableName}_expires_idx
      ON ${tableName}(expires_at);
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ${tableName} (
      key_id, nonce, job_id, purpose, token_sha256, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const purge = db.prepare(`DELETE FROM ${tableName} WHERE expires_at <= ?`);

  return Object.freeze({
    consume(record) {
      const result = insert.run(
        record.keyId,
        record.nonce,
        record.jobId,
        record.purpose,
        record.tokenSha256,
        record.expiresAt,
        record.consumedAt
      );
      return result.changes === 1;
    },

    purgeExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
      requireInteger(nowSeconds, 'nowSeconds');
      return purge.run(nowSeconds).changes;
    },
  });
}

module.exports = {
  ApprovalCapabilityError,
  DEFAULT_PURPOSE,
  MemoryCapabilityReplayStore,
  canonicalizeApprovalPlan: canonicalizePlan,
  createApprovalCapabilityIssuer,
  createApprovalCapabilityVerifier,
  createSqliteCapabilityReplayStore,
  generateApprovalCapabilityKeyPair,
  hashApprovalPlan,
};
