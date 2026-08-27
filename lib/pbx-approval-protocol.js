'use strict';

const crypto = require('node:crypto');

const ARM_PREFIX = 'telereq1';
const ARM_TYPE = 'TELEAGENT_PBX_ARM';
const ARM_PURPOSE = 'teleagent.pbx-approval-arm.v1';
const EVIDENCE_PREFIX = 'teleattest1';
const EVIDENCE_TYPE = 'TELEAGENT_PBX_EVIDENCE';
const EVIDENCE_PURPOSE = 'teleagent.pbx-handset-approval-evidence.v1';
const EVIDENCE_METHOD = 'pbx-handset-rfc4733-pound-v1';
const VERSION = 1;
const ALGORITHM = 'EdDSA';
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_TTL_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 10;
const HASH = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]{1,96}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/u;
const PBX_IDENTIFIER = /^[A-Za-z0-9+][A-Za-z0-9_.:@/+%-]{0,255}$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const DTMF_SOURCE = 'asterisk-pjsip-handset-channel-rfc4733-v1';

const ARM_KEYS = Object.freeze([
  'v', 'purpose', 'approval_id', 'job_id', 'operation', 'request_sha256',
  'plan_sha256', 'target', 'provider', 'profile', 'prompt', 'prompt_sha256',
  'pbx_call_handle', 'iat', 'nbf', 'exp', 'nonce',
]);
const EVIDENCE_KEYS = Object.freeze([
  'v', 'purpose', 'arm_sha256', 'arm_key_id', 'arm_key_fingerprint',
  'approval_id', 'job_id', 'operation', 'request_sha256', 'plan_sha256',
  'target', 'provider', 'profile', 'prompt_sha256', 'pbx_call_handle',
  'call_leg', 'call_leg_sha256', 'prompt_audio_sha256', 'method',
  'playback_id', 'playback_started_at_ms', 'playback_completed_at_ms',
  'digit', 'dtmf_source', 'dtmf_event_id', 'dtmf_received_at_ms', 'iat',
  'exp', 'nonce',
]);
const CALL_LEG_KEYS = Object.freeze([
  'pbx_instance_id', 'linkedid', 'handset_uniqueid', 'handset_endpoint',
  'channel_birth_ms', 'trunk_uniqueid', 'bridge_id', 'dialed_route',
]);
const OBSERVATION_KEYS = Object.freeze([
  'pbx_call_handle', 'call_leg', 'prompt_sha256', 'prompt_audio_sha256',
  'playback_id', 'playback_started_at_ms', 'playback_completed_at_ms',
  'digit', 'dtmf_source', 'dtmf_event_id', 'dtmf_received_at_ms',
]);

class PbxApprovalProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PbxApprovalProtocolError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PbxApprovalProtocolError(code, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function object(value, label) {
  if (!plainObject(value)) fail('PBX_PROTOCOL_INVALID_ARGUMENT', `${label} must be a plain object.`);
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) {
    fail('PBX_PROTOCOL_MALFORMED', `${label} has an unsupported schema.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (ownKeys.some(key => !descriptors[key]?.enumerable ||
      !Object.hasOwn(descriptors[key], 'value'))) {
    fail('PBX_PROTOCOL_MALFORMED', `${label} must contain only enumerable own data properties.`);
  }
  const actual = ownKeys.sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('PBX_PROTOCOL_MALFORMED', `${label} has an unsupported schema.`);
  }
  return value;
}

function string(value, label, { max = 512, pattern = null, controls = false } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
      value.trim() !== value || (pattern && !pattern.test(value)) ||
      (!controls && /[\u0000-\u001f\u007f-\u009f]/u.test(value))) {
    fail('PBX_PROTOCOL_INVALID_ARGUMENT', `${label} is invalid.`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('PBX_PROTOCOL_INVALID_ARGUMENT', `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('PBX_PROTOCOL_INVALID_ARGUMENT', `${label} must be a safe integer.`);
  }
  return value;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'Canonical JSON rejects non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'Canonical JSON rejects cycles.');
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (plainObject(value)) {
    if (seen.has(value)) fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'Canonical JSON rejects cycles.');
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key], 'value'))) {
      fail('PBX_PROTOCOL_INVALID_ARGUMENT',
        'Canonical JSON requires enumerable own data properties.');
    }
    const result = `{${keys.sort().map((key) => {
      const item = descriptors[key].value;
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'Canonical JSON rejects non-JSON values.');
      }
      return `${JSON.stringify(key)}:${canonicalJson(item, seen)}`;
    }).join(',')}}`;
    seen.delete(value);
    return result;
  }
  fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'Canonical JSON accepts only JSON-compatible values.');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableCanonical(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function hashText(value) {
  return crypto.createHash('sha256').update(string(value, 'text', { max: 4096 }), 'utf8').digest('hex');
}

function digestToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function normalizePrivateKey(value) {
  let key;
  try { key = value?.type === 'private' ? value : crypto.createPrivateKey(value); } catch {
    fail('PBX_PROTOCOL_INVALID_KEY', 'A valid Ed25519 private key is required.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail('PBX_PROTOCOL_INVALID_KEY', 'The signing key must be Ed25519.');
  }
  return key;
}

function normalizePublicKey(value) {
  let key;
  try { key = value?.type === 'public' ? value : crypto.createPublicKey(value); } catch {
    fail('PBX_PROTOCOL_INVALID_KEY', 'A valid Ed25519 public key is required.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail('PBX_PROTOCOL_INVALID_KEY', 'The verification key must be Ed25519.');
  }
  return key;
}

function normalizeKeys(keys) {
  const entries = keys instanceof Map ? [...keys.entries()] : Object.entries(object(keys, 'publicKeys'));
  if (entries.length < 1) fail('PBX_PROTOCOL_INVALID_KEY', 'At least one verification key is required.');
  return new Map(entries.map(([keyId, key]) => [string(keyId, 'keyId', { pattern: KEY_ID }), normalizePublicKey(key)]));
}

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(normalizePublicKey(key).export({
    type: 'spki', format: 'der',
  })).digest('hex');
}

function nowSeconds(now, label) {
  if (typeof now !== 'function') fail('PBX_PROTOCOL_INVALID_ARGUMENT', `${label} clock is invalid.`);
  const value = Number(now());
  if (!Number.isFinite(value) || value < 0) fail('PBX_PROTOCOL_INVALID_ARGUMENT', `${label} clock is invalid.`);
  return Math.floor(value / 1000);
}

function randomNonce(randomBytes) {
  if (typeof randomBytes !== 'function') fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'The random source is invalid.');
  const value = Buffer.from(randomBytes(32));
  if (value.length !== 32) fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'The random source returned the wrong size.');
  return value.toString('base64url');
}

function validateNonce(value) {
  if (typeof value !== 'string' || !BASE64URL_32.test(value) ||
      Buffer.from(value, 'base64url').length !== 32 ||
      Buffer.from(value, 'base64url').toString('base64url') !== value) {
    fail('PBX_PROTOCOL_MALFORMED', 'The protocol nonce is invalid.');
  }
  return value;
}

function encodeToken(prefix, type, keyId, claims, privateKey) {
  const header = { alg: ALGORITHM, kid: string(keyId, 'keyId', { pattern: KEY_ID }), typ: type };
  const headerSegment = Buffer.from(canonicalJson(header), 'utf8').toString('base64url');
  const claimSegment = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url');
  const input = `${headerSegment}.${claimSegment}`;
  const signature = crypto.sign(null, Buffer.from(input, 'ascii'), privateKey).toString('base64url');
  return `${prefix}.${input}.${signature}`;
}

function decodeSegment(segment, label) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(segment)) {
    fail('PBX_PROTOCOL_MALFORMED', `${label} is malformed.`);
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) fail('PBX_PROTOCOL_MALFORMED', `${label} is not canonical.`);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch {
    fail('PBX_PROTOCOL_MALFORMED', `${label} is not JSON.`);
  }
  object(value, label);
  if (Buffer.from(canonicalJson(value), 'utf8').toString('base64url') !== segment) {
    fail('PBX_PROTOCOL_MALFORMED', `${label} JSON is not canonical.`);
  }
  return value;
}

function verifyToken(token, { prefix, type, publicKeys }) {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    fail('PBX_PROTOCOL_MALFORMED', 'The signed artifact is malformed.');
  }
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== prefix) fail('PBX_PROTOCOL_MALFORMED', 'The artifact prefix is invalid.');
  const header = exactKeys(decodeSegment(parts[1], 'header'), ['alg', 'kid', 'typ'], 'header');
  if (header.alg !== ALGORITHM || header.typ !== type) fail('PBX_PROTOCOL_MALFORMED', 'The artifact header is invalid.');
  const keyId = string(header.kid, 'keyId', { pattern: KEY_ID });
  const key = publicKeys.get(keyId);
  if (!key) fail('PBX_PROTOCOL_UNKNOWN_KEY', 'The artifact key is not trusted.');
  const signature = Buffer.from(parts[3], 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== parts[3] ||
      !crypto.verify(null, Buffer.from(`${parts[1]}.${parts[2]}`, 'ascii'), key, signature)) {
    fail('PBX_PROTOCOL_BAD_SIGNATURE', 'The artifact signature is invalid.');
  }
  return { claims: decodeSegment(parts[2], 'claims'), key, keyId };
}

function validateLifetime(claims, { now, maxTtlSeconds, skewSeconds }) {
  integer(claims.iat, 'iat');
  integer(claims.exp, 'exp');
  if (Object.hasOwn(claims, 'nbf')) integer(claims.nbf, 'nbf');
  const nbf = Object.hasOwn(claims, 'nbf') ? claims.nbf : claims.iat;
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxTtlSeconds || nbf < claims.iat) {
    fail('PBX_PROTOCOL_LIFETIME', 'The artifact lifetime is invalid.');
  }
  const current = nowSeconds(now, 'verifier');
  if (current + skewSeconds < nbf || current - skewSeconds > claims.exp) {
    fail('PBX_PROTOCOL_EXPIRED', 'The artifact is not currently valid.');
  }
}

function validateVerifierSettings(maxTtlSeconds, clockSkewSeconds) {
  integer(maxTtlSeconds, 'maxTtlSeconds', 1);
  integer(clockSkewSeconds, 'clockSkewSeconds');
  if (maxTtlSeconds > MAX_TTL_SECONDS || clockSkewSeconds > 300) {
    fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'The verifier timing limits are invalid.');
  }
}

function normalizeReplayStore(replayStore, label) {
  if (!replayStore || typeof replayStore.consume !== 'function') {
    fail('PBX_PROTOCOL_REPLAY_STORE_REQUIRED', `${label} requires an atomic replay consumer.`);
  }
  return replayStore;
}

function exactString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(left).digest(),
    crypto.createHash('sha256').update(right).digest(),
  );
}

function validateCallLeg(input) {
  exactKeys(input, CALL_LEG_KEYS, 'PBX call leg');
  const result = {
    pbx_instance_id: string(input.pbx_instance_id, 'pbx_instance_id', { max: 128, pattern: PBX_IDENTIFIER }),
    linkedid: string(input.linkedid, 'linkedid', { max: 256, pattern: PBX_IDENTIFIER }),
    handset_uniqueid: string(input.handset_uniqueid, 'handset_uniqueid', { max: 256, pattern: PBX_IDENTIFIER }),
    handset_endpoint: string(input.handset_endpoint, 'handset_endpoint', { max: 256, pattern: PBX_IDENTIFIER }),
    channel_birth_ms: integer(input.channel_birth_ms, 'channel_birth_ms', 1),
    trunk_uniqueid: string(input.trunk_uniqueid, 'trunk_uniqueid', { max: 256, pattern: PBX_IDENTIFIER }),
    bridge_id: string(input.bridge_id, 'bridge_id', { max: 256, pattern: PBX_IDENTIFIER }),
    dialed_route: string(input.dialed_route, 'dialed_route', { max: 256, pattern: PBX_IDENTIFIER }),
  };
  if (result.handset_uniqueid === result.trunk_uniqueid) {
    fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'The handset and trunk legs must be distinct.');
  }
  return immutableCanonical(result);
}

function validatePbxObservation(input, armClaims, { now = Date.now } = {}) {
  exactKeys(input, OBSERVATION_KEYS, 'PBX observation');
  object(armClaims, 'verified PBX arm claims');
  const callLeg = validateCallLeg(input.call_leg);
  const result = {
    pbx_call_handle: string(input.pbx_call_handle, 'pbx_call_handle', {
      max: 43, pattern: BASE64URL_32,
    }),
    call_leg: callLeg,
    prompt_sha256: hash(input.prompt_sha256, 'prompt_sha256'),
    prompt_audio_sha256: hash(input.prompt_audio_sha256, 'prompt_audio_sha256'),
    playback_id: string(input.playback_id, 'playback_id', { max: 256, pattern: PBX_IDENTIFIER }),
    playback_started_at_ms: integer(input.playback_started_at_ms, 'playback_started_at_ms', 1),
    playback_completed_at_ms: integer(input.playback_completed_at_ms, 'playback_completed_at_ms', 1),
    digit: string(input.digit, 'digit', { max: 1 }),
    dtmf_source: string(input.dtmf_source, 'dtmf_source', { max: 96, pattern: IDENTIFIER }),
    dtmf_event_id: string(input.dtmf_event_id, 'dtmf_event_id', { max: 256, pattern: PBX_IDENTIFIER }),
    dtmf_received_at_ms: integer(input.dtmf_received_at_ms, 'dtmf_received_at_ms', 1),
  };
  validateNonce(result.pbx_call_handle);
  if (!exactString(result.pbx_call_handle, armClaims.pbx_call_handle) ||
      !exactString(result.prompt_sha256, armClaims.prompt_sha256)) {
    fail('PBX_PROTOCOL_BINDING', 'The PBX observation is bound to a different arm.');
  }
  if (result.digit !== '#' || result.dtmf_source !== DTMF_SOURCE) {
    fail('PBX_PROTOCOL_METHOD', 'The PBX observation is not handset RFC4733 pound evidence.');
  }
  if (!(callLeg.channel_birth_ms <= result.playback_started_at_ms &&
      result.playback_started_at_ms < result.playback_completed_at_ms &&
      result.playback_completed_at_ms < result.dtmf_received_at_ms)) {
    fail('PBX_PROTOCOL_SEQUENCE', 'The PBX playback and DTMF sequence is invalid.');
  }
  const observedNow = Number(now());
  if (!Number.isFinite(observedNow) || observedNow < 0 ||
      result.playback_started_at_ms < armClaims.nbf * 1000 ||
      result.dtmf_received_at_ms >= armClaims.exp * 1000 ||
      result.dtmf_received_at_ms > observedNow) {
    fail('PBX_PROTOCOL_SEQUENCE', 'The PBX observation is outside the arm lifetime.');
  }
  return immutableCanonical(result);
}

function validateArmClaims(claims, settings) {
  exactKeys(claims, ARM_KEYS, 'PBX arm claims');
  if (claims.v !== VERSION || !exactString(claims.purpose, ARM_PURPOSE)) {
    fail('PBX_PROTOCOL_WRONG_PURPOSE', 'The PBX arm has the wrong version or purpose.');
  }
  string(claims.approval_id, 'approval_id', { max: 128, pattern: IDENTIFIER });
  string(claims.job_id, 'job_id', { max: 256, pattern: IDENTIFIER });
  string(claims.operation, 'operation', { max: 128, pattern: IDENTIFIER });
  hash(claims.request_sha256, 'request_sha256');
  hash(claims.plan_sha256, 'plan_sha256');
  string(claims.target, 'target', { max: 512 });
  string(claims.provider, 'provider', { max: 96, pattern: IDENTIFIER });
  string(claims.profile, 'profile', { max: 128, pattern: IDENTIFIER });
  string(claims.prompt, 'prompt', { max: 4096 });
  hash(claims.prompt_sha256, 'prompt_sha256');
  if (hashText(claims.prompt) !== claims.prompt_sha256) {
    fail('PBX_PROTOCOL_BINDING', 'The PBX arm prompt digest is invalid.');
  }
  string(claims.pbx_call_handle, 'pbx_call_handle', { max: 43, pattern: BASE64URL_32 });
  validateNonce(claims.pbx_call_handle);
  validateNonce(claims.nonce);
  validateLifetime(claims, settings);
  return claims;
}

function createPbxArmIssuer({
  privateKey, keyId, now = Date.now, randomBytes = crypto.randomBytes,
  ttlSeconds = 120,
} = {}) {
  const key = normalizePrivateKey(privateKey);
  string(keyId, 'keyId', { pattern: KEY_ID });
  integer(ttlSeconds, 'ttlSeconds', 1);
  if (ttlSeconds > MAX_TTL_SECONDS) fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'The PBX arm TTL is too long.');
  return Object.freeze({
    issue(input) {
      object(input, 'PBX arm input');
      const issued = nowSeconds(now, 'issuer');
      const prompt = string(input.prompt, 'prompt', { max: 4096 });
      const claims = {
        v: VERSION,
        purpose: ARM_PURPOSE,
        approval_id: string(input.approvalId, 'approvalId', { max: 128, pattern: IDENTIFIER }),
        job_id: string(input.jobId, 'jobId', { max: 256, pattern: IDENTIFIER }),
        operation: string(input.operation, 'operation', { max: 128, pattern: IDENTIFIER }),
        request_sha256: hash(input.requestHash, 'requestHash'),
        plan_sha256: hash(input.planHash, 'planHash'),
        target: string(input.target, 'target', { max: 512 }),
        provider: string(input.provider, 'provider', { max: 96, pattern: IDENTIFIER }),
        profile: string(input.profile, 'profile', { max: 128, pattern: IDENTIFIER }),
        prompt,
        prompt_sha256: hashText(prompt),
        pbx_call_handle: string(input.pbxCallHandle, 'pbxCallHandle', { max: 43, pattern: BASE64URL_32 }),
        iat: issued,
        nbf: issued,
        exp: issued + ttlSeconds,
        nonce: randomNonce(randomBytes),
      };
      validateNonce(claims.pbx_call_handle);
      return encodeToken(ARM_PREFIX, ARM_TYPE, keyId, claims, key);
    },
  });
}

function createPbxArmVerifier({
  publicKeys, now = Date.now, maxTtlSeconds = MAX_TTL_SECONDS,
  clockSkewSeconds = CLOCK_SKEW_SECONDS,
} = {}) {
  const keys = normalizeKeys(publicKeys);
  validateVerifierSettings(maxTtlSeconds, clockSkewSeconds);
  return Object.freeze({
    verify(token, expected = null) {
      const verified = verifyToken(token, { prefix: ARM_PREFIX, type: ARM_TYPE, publicKeys: keys });
      const claims = validateArmClaims(verified.claims, {
        now, maxTtlSeconds, skewSeconds: clockSkewSeconds,
      });
      if (expected !== null) {
        object(expected, 'expected PBX arm');
        for (const [claim, field] of [
          ['approval_id', 'approvalId'], ['job_id', 'jobId'], ['operation', 'operation'],
          ['request_sha256', 'requestHash'], ['plan_sha256', 'planHash'],
          ['target', 'target'], ['provider', 'provider'], ['profile', 'profile'],
          ['prompt_sha256', 'promptHash'], ['pbx_call_handle', 'pbxCallHandle'],
        ]) {
          if (expected[field] !== undefined && !exactString(claims[claim], expected[field])) {
            fail('PBX_PROTOCOL_BINDING', `The PBX arm ${claim} binding is wrong.`);
          }
        }
      }
      return immutableCanonical({
        claims,
        keyId: verified.keyId,
        keyFingerprint: keyFingerprint(verified.key),
        armSha256: digestToken(token),
      });
    },
  });
}

function validateEvidenceClaims(claims, settings) {
  exactKeys(claims, EVIDENCE_KEYS, 'PBX evidence claims');
  if (claims.v !== VERSION || !exactString(claims.purpose, EVIDENCE_PURPOSE) ||
      claims.method !== EVIDENCE_METHOD) {
    fail('PBX_PROTOCOL_WRONG_PURPOSE', 'The PBX evidence has the wrong version, purpose, or method.');
  }
  for (const field of ['arm_sha256', 'arm_key_fingerprint', 'request_sha256',
    'plan_sha256', 'prompt_sha256', 'call_leg_sha256', 'prompt_audio_sha256']) {
    hash(claims[field], field);
  }
  string(claims.arm_key_id, 'arm_key_id', { max: 96, pattern: KEY_ID });
  string(claims.pbx_call_handle, 'pbx_call_handle', { max: 43, pattern: BASE64URL_32 });
  validateNonce(claims.pbx_call_handle);
  const callLeg = validateCallLeg(claims.call_leg);
  if (hashCanonical(callLeg) !== claims.call_leg_sha256) {
    fail('PBX_PROTOCOL_BINDING', 'The PBX evidence call-leg digest is invalid.');
  }
  for (const field of ['approval_id', 'job_id', 'operation', 'provider', 'profile',
    'playback_id', 'dtmf_event_id']) string(claims[field], field, { max: 256, pattern: IDENTIFIER });
  string(claims.target, 'target', { max: 512 });
  string(claims.digit, 'digit', { max: 1 });
  string(claims.dtmf_source, 'dtmf_source', { max: 96, pattern: IDENTIFIER });
  if (claims.digit !== '#' || claims.dtmf_source !== DTMF_SOURCE) {
    fail('PBX_PROTOCOL_METHOD', 'The PBX evidence has the wrong DTMF source.');
  }
  for (const field of ['playback_started_at_ms', 'playback_completed_at_ms', 'dtmf_received_at_ms']) {
    integer(claims[field], field, 1);
  }
  if (!(callLeg.channel_birth_ms <= claims.playback_started_at_ms &&
      claims.playback_started_at_ms < claims.playback_completed_at_ms &&
      claims.playback_completed_at_ms < claims.dtmf_received_at_ms)) {
    fail('PBX_PROTOCOL_SEQUENCE', 'The PBX playback and DTMF sequence is invalid.');
  }
  validateNonce(claims.nonce);
  validateLifetime(claims, settings);
  return claims;
}

function createPbxEvidenceIssuer({
  privateKey, keyId, controllerArmPublicKeys, now = Date.now,
  randomBytes = crypto.randomBytes, ttlSeconds = 120,
  armMaxTtlSeconds = MAX_TTL_SECONDS, clockSkewSeconds = CLOCK_SKEW_SECONDS,
} = {}) {
  const key = normalizePrivateKey(privateKey);
  string(keyId, 'keyId', { pattern: KEY_ID });
  integer(ttlSeconds, 'ttlSeconds', 1);
  if (ttlSeconds > MAX_TTL_SECONDS) fail('PBX_PROTOCOL_INVALID_ARGUMENT', 'The evidence TTL is too long.');
  const armVerifier = createPbxArmVerifier({
    publicKeys: controllerArmPublicKeys,
    now,
    maxTtlSeconds: armMaxTtlSeconds,
    clockSkewSeconds,
  });
  return Object.freeze({
    issue(input) {
      exactKeys(input, ['armToken', 'observation'], 'PBX evidence input');
      const armToken = string(input.armToken, 'armToken', { max: MAX_TOKEN_BYTES });
      const arm = armVerifier.verify(armToken);
      const armClaims = arm.claims;
      const issued = nowSeconds(now, 'issuer');
      const observation = validatePbxObservation(input.observation, armClaims, { now });
      if (issued >= armClaims.exp) {
        fail('PBX_PROTOCOL_EXPIRED', 'The PBX arm expired before evidence issuance.');
      }
      const claims = {
        v: VERSION,
        purpose: EVIDENCE_PURPOSE,
        arm_sha256: arm.armSha256,
        arm_key_id: arm.keyId,
        arm_key_fingerprint: arm.keyFingerprint,
        approval_id: armClaims.approval_id,
        job_id: armClaims.job_id,
        operation: armClaims.operation,
        request_sha256: armClaims.request_sha256,
        plan_sha256: armClaims.plan_sha256,
        target: armClaims.target,
        provider: armClaims.provider,
        profile: armClaims.profile,
        prompt_sha256: armClaims.prompt_sha256,
        pbx_call_handle: armClaims.pbx_call_handle,
        call_leg: observation.call_leg,
        call_leg_sha256: hashCanonical(observation.call_leg),
        prompt_audio_sha256: observation.prompt_audio_sha256,
        method: EVIDENCE_METHOD,
        playback_id: observation.playback_id,
        playback_started_at_ms: observation.playback_started_at_ms,
        playback_completed_at_ms: observation.playback_completed_at_ms,
        digit: observation.digit,
        dtmf_source: observation.dtmf_source,
        dtmf_event_id: observation.dtmf_event_id,
        dtmf_received_at_ms: observation.dtmf_received_at_ms,
        iat: issued,
        exp: Math.min(issued + ttlSeconds, armClaims.exp),
        nonce: randomNonce(randomBytes),
      };
      validateEvidenceClaims(claims, { now, maxTtlSeconds: MAX_TTL_SECONDS, skewSeconds: CLOCK_SKEW_SECONDS });
      return encodeToken(EVIDENCE_PREFIX, EVIDENCE_TYPE, keyId, claims, key);
    },
  });
}

function createPbxEvidenceVerifier({
  publicKeys, controllerArmPublicKeys, replayStore, now = Date.now,
  maxTtlSeconds = MAX_TTL_SECONDS, clockSkewSeconds = CLOCK_SKEW_SECONDS,
  armMaxTtlSeconds = MAX_TTL_SECONDS,
} = {}) {
  const keys = normalizeKeys(publicKeys);
  const armVerifier = createPbxArmVerifier({
    publicKeys: controllerArmPublicKeys,
    now,
    maxTtlSeconds: armMaxTtlSeconds,
    clockSkewSeconds,
  });
  const replay = normalizeReplayStore(replayStore, 'PBX evidence verification');
  validateVerifierSettings(maxTtlSeconds, clockSkewSeconds);
  function verify(token, expected = {}) {
    exactKeys(
      expected,
      Object.hasOwn(expected, 'callLeg') ? ['armToken', 'callLeg'] : ['armToken'],
      'expected PBX evidence context',
    );
    const armToken = string(expected.armToken, 'expected armToken', { max: MAX_TOKEN_BYTES });
    const callLeg = Object.hasOwn(expected, 'callLeg') ? expected.callLeg : null;
    const expectedArm = armVerifier.verify(armToken);
    const verified = verifyToken(token, {
      prefix: EVIDENCE_PREFIX, type: EVIDENCE_TYPE, publicKeys: keys,
    });
    const claims = validateEvidenceClaims(verified.claims, {
      now, maxTtlSeconds, skewSeconds: clockSkewSeconds,
    });
    const armClaims = expectedArm.claims;
    const expectedBindings = {
      arm_sha256: expectedArm.armSha256,
      arm_key_id: expectedArm.keyId,
      arm_key_fingerprint: expectedArm.keyFingerprint,
      approval_id: armClaims.approval_id,
      job_id: armClaims.job_id,
      operation: armClaims.operation,
      request_sha256: armClaims.request_sha256,
      plan_sha256: armClaims.plan_sha256,
      target: armClaims.target,
      provider: armClaims.provider,
      profile: armClaims.profile,
      prompt_sha256: armClaims.prompt_sha256,
      pbx_call_handle: armClaims.pbx_call_handle,
    };
    if (callLeg !== null) {
      expectedBindings.call_leg_sha256 = hashCanonical(validateCallLeg(callLeg));
    }
    for (const [field, value] of Object.entries(expectedBindings)) {
      if (!exactString(claims[field], value)) {
        fail('PBX_PROTOCOL_BINDING', `The PBX evidence ${field} binding is wrong.`);
      }
    }
    if (claims.iat < armClaims.iat || claims.exp > armClaims.exp ||
        claims.playback_started_at_ms < armClaims.nbf * 1000 ||
        claims.dtmf_received_at_ms >= armClaims.exp * 1000 ||
        claims.dtmf_received_at_ms >= (claims.iat + 1) * 1000) {
      fail('PBX_PROTOCOL_SEQUENCE', 'The PBX evidence is outside the bound arm lifetime.');
    }
    const frozenClaims = immutableCanonical(claims);
    const frozenCallLeg = frozenClaims.call_leg;
    return Object.freeze({
      claims: frozenClaims,
      callLeg: frozenCallLeg,
      keyId: verified.keyId,
      keyFingerprint: keyFingerprint(verified.key),
      evidenceSha256: digestToken(token),
    });
  }
  return Object.freeze({
    verify,
    consume(token, expected) {
      const result = verify(token, expected);
      const consumedAt = nowSeconds(now, 'verifier');
      if (consumedAt >= result.claims.exp) {
        fail('PBX_PROTOCOL_EXPIRED', 'The PBX evidence expired before consumption.');
      }
      let consumed;
      try {
        consumed = replay.consume(Object.freeze({
          keyId: result.keyId,
          nonce: result.claims.nonce,
          approvalId: result.claims.approval_id,
          evidenceSha256: result.evidenceSha256,
          expiresAt: result.claims.exp,
          consumedAt,
        }));
      } catch {
        fail('PBX_PROTOCOL_REPLAY_STORE_ERROR', 'PBX evidence replay protection is unavailable.');
      }
      if (consumed && typeof consumed.then === 'function') {
        fail('PBX_PROTOCOL_REPLAY_STORE_ERROR', 'PBX evidence replay consumption must be synchronous.');
      }
      if (consumed !== true) fail('PBX_PROTOCOL_REPLAYED', 'The PBX evidence was already consumed.');
      return result;
    },
  });
}

module.exports = {
  ARM_PURPOSE,
  EVIDENCE_METHOD,
  EVIDENCE_PURPOSE,
  DTMF_SOURCE,
  PbxApprovalProtocolError,
  canonicalJson,
  createPbxArmIssuer,
  createPbxArmVerifier,
  createPbxEvidenceIssuer,
  createPbxEvidenceVerifier,
  digestToken,
  hashCanonical,
  hashText,
  keyFingerprint,
  validateCallLeg,
  validatePbxObservation,
};
