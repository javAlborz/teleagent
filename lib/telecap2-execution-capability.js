'use strict';

// Dormant controller-side protocol substrate. This module is not imported by
// a production service and does not activate phone mutation. telecap2 is a
// separate execution capability; it is not a new meaning for legacy telecap1.

const crypto = require('node:crypto');
const {
  createPbxEvidenceVerifier,
} = require('./pbx-approval-protocol');

const TOKEN_PREFIX = 'telecap2';
const TOKEN_TYPE = 'TELEAGENT_EXECUTION_CAPABILITY';
const TOKEN_PURPOSE = 'teleagent.controller-execution-capability.v2';
const TOKEN_VERSION = 2;
const SIGNATURE_ALGORITHM = 'EdDSA';
const PBX_EVIDENCE_PURPOSE = 'teleagent.pbx-handset-approval-evidence.v1';
const PBX_EVIDENCE_METHOD = 'pbx-handset-rfc4733-pound-v1';
const DEFAULT_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 5;
const NONCE_BYTES = 32;
const MAX_TOKEN_BYTES = 16 * 1024;

const HASH_RE = /^[a-f0-9]{64}$/u;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/u;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/u;

const EVIDENCE_CLAIM_KEYS = Object.freeze([
  'v', 'purpose', 'arm_sha256', 'arm_key_id', 'arm_key_fingerprint',
  'approval_id', 'job_id', 'operation', 'request_sha256', 'plan_sha256',
  'target', 'provider', 'profile', 'prompt_sha256', 'pbx_call_handle',
  'call_leg', 'call_leg_sha256', 'prompt_audio_sha256', 'method',
  'playback_id', 'playback_started_at_ms', 'playback_completed_at_ms',
  'digit', 'dtmf_source', 'dtmf_event_id', 'dtmf_received_at_ms', 'iat',
  'exp', 'nonce',
]);
const CAPABILITY_CLAIM_KEYS = Object.freeze([
  'v', 'purpose', 'controller_key_id', 'approval_id', 'evidence_sha256',
  'controller_arm_key_id', 'controller_arm_key_fingerprint',
  'pbx_attester_key_id', 'pbx_attester_key_fingerprint', 'evidence_method',
  'job_id', 'operation', 'request_sha256', 'plan_sha256', 'target',
  'provider', 'profile', 'iat', 'exp', 'nonce',
]);
const EXPECTED_BINDING_KEYS = Object.freeze([
  'controllerKeyId', 'approvalId', 'evidenceSha256', 'controllerArmKeyId',
  'controllerArmKeyFingerprint', 'pbxAttesterKeyId', 'pbxAttesterKeyFingerprint',
  'evidenceMethod', 'jobId', 'operation', 'requestHash', 'planHash', 'target',
  'provider', 'profile',
]);
const CALL_LEG_KEYS = Object.freeze([
  'pbx_instance_id', 'linkedid', 'handset_uniqueid', 'handset_endpoint',
  'channel_birth_ms', 'trunk_uniqueid', 'bridge_id', 'dialed_route',
]);

class Telecap2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Telecap2Error';
    this.code = code;
  }
}

function fail(code, message) {
  throw new Telecap2Error(code, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireObject(value, label, code = 'TELECAP2_INVALID_ARGUMENT') {
  if (!plainObject(value)) fail(code, `${label} must be a plain object.`);
  return value;
}

function requireExactKeys(value, keys, label, code = 'TELECAP2_MALFORMED') {
  requireObject(value, label, code);
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (ownKeys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable ||
      !Object.hasOwn(descriptors[key], 'value'))) {
    fail(code, `${label} must contain only enumerable own data properties.`);
  }
  const actual = ownKeys.sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} has an unsupported schema.`);
  }
  return value;
}

function requireAllowedKeys(value, required, optional, label) {
  requireObject(value, label);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable ||
      !Object.hasOwn(descriptors[key], 'value'))) {
    fail('TELECAP2_INVALID_ARGUMENT',
      `${label} must contain only enumerable own data properties.`);
  }
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail('TELECAP2_INVALID_ARGUMENT', `${label} has an unsupported schema.`);
  }
}

function requireString(value, label, { max = 512, pattern = null } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
      value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
      (pattern && !pattern.test(value))) {
    fail('TELECAP2_INVALID_ARGUMENT', `${label} is invalid.`);
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    fail('TELECAP2_INVALID_ARGUMENT', `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireKeyId(value, label = 'keyId') {
  return requireString(value, label, { max: 96, pattern: KEY_ID_RE });
}

function requireIdentifier(value, label, max = 256) {
  return requireString(value, label, { max, pattern: IDENTIFIER_RE });
}

function requireInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('TELECAP2_INVALID_ARGUMENT', `${label} must be a safe integer.`);
  }
  return value;
}

function requireNonce(value, label = 'nonce') {
  if (typeof value !== 'string' || !NONCE_RE.test(value)) {
    fail('TELECAP2_MALFORMED', `${label} is invalid.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== NONCE_BYTES || decoded.toString('base64url') !== value) {
    fail('TELECAP2_MALFORMED', `${label} is invalid.`);
  }
  return value;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail('TELECAP2_INVALID_ARGUMENT', 'Canonical JSON accepts only safe integers.');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('TELECAP2_INVALID_ARGUMENT', 'Canonical JSON rejects cycles.');
    seen.add(value);
    const encoded = `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`;
    seen.delete(value);
    return encoded;
  }
  if (plainObject(value)) {
    if (seen.has(value)) fail('TELECAP2_INVALID_ARGUMENT', 'Canonical JSON rejects cycles.');
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key], 'value'))) {
      fail('TELECAP2_INVALID_ARGUMENT',
        'Canonical JSON requires enumerable own data properties.');
    }
    const encoded = `{${keys.sort().map((key) => {
      const entry = descriptors[key].value;
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
        fail('TELECAP2_INVALID_ARGUMENT', 'Canonical JSON rejects non-JSON values.');
      }
      return `${JSON.stringify(key)}:${canonicalJson(entry, seen)}`;
    }).join(',')}}`;
    seen.delete(value);
    return encoded;
  }
  fail('TELECAP2_INVALID_ARGUMENT', 'Canonical JSON accepts only JSON-compatible values.');
  return '';
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

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(left, 'utf8').digest(),
    crypto.createHash('sha256').update(right, 'utf8').digest(),
  );
}

function normalizePrivateKey(value) {
  let key;
  try {
    key = value?.type === 'private' ? value : crypto.createPrivateKey(value);
  } catch {
    fail('TELECAP2_INVALID_KEY', 'A valid Ed25519 controller execution private key is required.');
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    fail('TELECAP2_INVALID_KEY', 'The controller execution signing key must be Ed25519.');
  }
  return key;
}

function normalizePublicKey(value, label) {
  let key;
  try {
    key = value?.type === 'public' ? value : crypto.createPublicKey(value);
  } catch {
    fail('TELECAP2_INVALID_KEY', `${label} must contain valid Ed25519 public keys.`);
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    fail('TELECAP2_INVALID_KEY', `${label} must contain only Ed25519 public keys.`);
  }
  return key;
}

function fingerprintPublicKey(value) {
  const key = normalizePublicKey(value, 'public key');
  return digest(key.export({ type: 'spki', format: 'der' }));
}

function normalizePublicKeyMap(value, label) {
  const entries = value instanceof Map
    ? [...value.entries()]
    : Object.entries(requireObject(value, label));
  if (entries.length < 1) fail('TELECAP2_INVALID_KEY', `${label} must not be empty.`);
  const result = new Map();
  const fingerprints = new Set();
  for (const [rawKeyId, rawKey] of entries) {
    const keyId = requireKeyId(rawKeyId, `${label} key ID`);
    const key = normalizePublicKey(rawKey, label);
    const fingerprint = fingerprintPublicKey(key);
    if (result.has(keyId) || fingerprints.has(fingerprint)) {
      fail('TELECAP2_KEY_ROLE_REUSE', `${label} contains a reused key identity.`);
    }
    result.set(keyId, Object.freeze({ key, fingerprint }));
    fingerprints.add(fingerprint);
  }
  return result;
}

function assertDisjointKeyRoles(executionKeyId, executionFingerprint, armKeys, attesterKeys) {
  const armIds = new Set(armKeys.keys());
  const attesterIds = new Set(attesterKeys.keys());
  const armFingerprints = new Set([...armKeys.values()].map((entry) => entry.fingerprint));
  const attesterFingerprints = new Set(
    [...attesterKeys.values()].map((entry) => entry.fingerprint),
  );
  if (armIds.has(executionKeyId) || attesterIds.has(executionKeyId) ||
      armFingerprints.has(executionFingerprint) || attesterFingerprints.has(executionFingerprint) ||
      [...armIds].some((keyId) => attesterIds.has(keyId)) ||
      [...armFingerprints].some((fingerprint) => attesterFingerprints.has(fingerprint))) {
    fail(
      'TELECAP2_KEY_ROLE_REUSE',
      'Execution, controller-arm, and PBX-attester key roles must be pairwise distinct.',
    );
  }
}

function clockSeconds(now, label) {
  if (typeof now !== 'function') fail('TELECAP2_INVALID_ARGUMENT', `${label} clock is invalid.`);
  const milliseconds = Number(now());
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    fail('TELECAP2_INVALID_ARGUMENT', `${label} clock is invalid.`);
  }
  return Math.floor(milliseconds / 1000);
}

function randomNonce(randomBytes) {
  if (typeof randomBytes !== 'function') {
    fail('TELECAP2_INVALID_ARGUMENT', 'The controller nonce source is invalid.');
  }
  let bytes;
  try {
    bytes = Buffer.from(randomBytes(NONCE_BYTES));
  } catch {
    fail('TELECAP2_ISSUE_FAILED', 'Controller capability nonce generation failed.');
  }
  if (bytes.length !== NONCE_BYTES) {
    bytes.fill(0);
    fail('TELECAP2_ISSUE_FAILED', 'Controller capability nonce generation failed.');
  }
  const nonce = bytes.toString('base64url');
  bytes.fill(0);
  return nonce;
}

function trustedRoleReceipt(receipt, keys, role, code) {
  const keyId = requireKeyId(receipt.keyId, `${role}.keyId`);
  const fingerprint = requireHash(receipt.keyFingerprint, `${role}.keyFingerprint`);
  const trusted = keys.get(keyId);
  if (!trusted || !exactString(trusted.fingerprint, fingerprint)) {
    fail(code, `${role} did not use the configured trust role.`);
  }
}

function trustedClaimRole(keyIdValue, fingerprintValue, keys, role, code) {
  const keyId = requireKeyId(keyIdValue, `${role}.keyId`);
  const fingerprint = requireHash(fingerprintValue, `${role}.keyFingerprint`);
  const trusted = keys.get(keyId);
  if (!trusted || !exactString(trusted.fingerprint, fingerprint)) {
    fail(code, `${role} did not use the configured trust role.`);
  }
}

function validateConsumedEvidenceReceipt(receipt, armKeys, attesterKeys) {
  requireExactKeys(
    receipt, ['claims', 'callLeg', 'keyId', 'keyFingerprint', 'evidenceSha256'],
    'Consumed PBX evidence', 'TELECAP2_PBX_RESULT_INVALID',
  );
  if (!Object.isFrozen(receipt) || !Object.isFrozen(receipt.claims) ||
      !Object.isFrozen(receipt.callLeg) || !Object.isFrozen(receipt.claims.call_leg) ||
      receipt.callLeg !== receipt.claims.call_leg) {
    fail('TELECAP2_PBX_RESULT_INVALID', 'Consumed PBX evidence must be immutable.');
  }
  trustedRoleReceipt(
    receipt, attesterKeys, 'PBX evidence', 'TELECAP2_PBX_ATTESTER_UNTRUSTED',
  );
  requireHash(receipt.evidenceSha256, 'evidence.evidenceSha256');
  const claims = requireExactKeys(
    receipt.claims, EVIDENCE_CLAIM_KEYS, 'Consumed PBX evidence claims',
    'TELECAP2_PBX_RESULT_INVALID',
  );
  if (claims.v !== 1 || claims.purpose !== PBX_EVIDENCE_PURPOSE ||
      claims.method !== PBX_EVIDENCE_METHOD || claims.digit !== '#') {
    fail('TELECAP2_PBX_RESULT_INVALID', 'Consumed PBX evidence has the wrong purpose or method.');
  }
  for (const field of [
    'arm_sha256', 'arm_key_fingerprint', 'request_sha256', 'plan_sha256', 'prompt_sha256',
    'call_leg_sha256', 'prompt_audio_sha256',
  ]) requireHash(claims[field], `evidence.${field}`);
  trustedClaimRole(
    claims.arm_key_id,
    claims.arm_key_fingerprint,
    armKeys,
    'Controller arm',
    'TELECAP2_PBX_ARM_UNTRUSTED',
  );
  requireIdentifier(claims.approval_id, 'evidence.approval_id', 128);
  requireIdentifier(claims.job_id, 'evidence.job_id');
  requireIdentifier(claims.operation, 'evidence.operation', 128);
  requireString(claims.target, 'evidence.target');
  requireIdentifier(claims.provider, 'evidence.provider', 96);
  requireIdentifier(claims.profile, 'evidence.profile', 128);
  requireInteger(claims.iat, 'evidence.iat');
  requireInteger(claims.exp, 'evidence.exp');
  requireNonce(claims.nonce, 'evidence.nonce');
  if (claims.exp <= claims.iat) {
    fail('TELECAP2_PBX_RESULT_INVALID', 'Consumed PBX evidence lifetime is invalid.');
  }
  requireExactKeys(
    claims.call_leg, CALL_LEG_KEYS, 'Consumed PBX evidence call leg',
    'TELECAP2_PBX_RESULT_INVALID',
  );

  // Copy only canonical own data. This converts the internally verified result
  // into a controller-owned immutable receipt and prevents a callback from
  // retaining accessors or mutable aliases across admission and issuance.
  const frozenClaims = immutableCanonical(claims);
  return Object.freeze({
    claims: frozenClaims,
    callLeg: frozenClaims.call_leg,
    keyId: receipt.keyId,
    keyFingerprint: receipt.keyFingerprint,
    evidenceSha256: receipt.evidenceSha256,
  });
}

function canonicalEvidenceSnapshot(receipt) {
  // Snapshot the complete receipt, not only fields copied into telecap2. This
  // keeps every signed PBX fact (arm digest, call leg, playback, audio, DTMF,
  // lifetime, and both upstream key identities) invariant after admission.
  return canonicalJson(receipt);
}

function encodeToken(keyId, claims, signingKey) {
  const header = { alg: SIGNATURE_ALGORITHM, kid: keyId, typ: TOKEN_TYPE };
  const encodedHeader = Buffer.from(canonicalJson(header), 'utf8').toString('base64url');
  const encodedClaims = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  let signature;
  try {
    signature = crypto.sign(null, Buffer.from(signingInput, 'ascii'), signingKey);
  } catch {
    fail('TELECAP2_ISSUE_FAILED', 'Controller capability signing failed.');
  }
  return `${TOKEN_PREFIX}.${signingInput}.${signature.toString('base64url')}`;
}

function createTelecap2ControllerAuthority({
  executionPrivateKey,
  executionKeyId,
  controllerArmPublicKeys,
  pbxAttesterPublicKeys,
  pbxEvidenceReplayStore,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  defaultTtlSeconds = DEFAULT_TTL_SECONDS,
  maxTtlSeconds = MAX_TTL_SECONDS,
} = {}) {
  const signingKey = normalizePrivateKey(executionPrivateKey);
  const signingKeyId = requireKeyId(executionKeyId, 'executionKeyId');
  const executionFingerprint = fingerprintPublicKey(crypto.createPublicKey(signingKey));
  const armKeys = normalizePublicKeyMap(controllerArmPublicKeys, 'controllerArmPublicKeys');
  const attesterKeys = normalizePublicKeyMap(pbxAttesterPublicKeys, 'pbxAttesterPublicKeys');
  assertDisjointKeyRoles(signingKeyId, executionFingerprint, armKeys, attesterKeys);
  if (!pbxEvidenceReplayStore || typeof pbxEvidenceReplayStore.consume !== 'function') {
    fail(
      'TELECAP2_INVALID_ARGUMENT',
      'A synchronous controller-owned PBX evidence replay store is required.',
    );
  }
  let evidenceVerifier;
  try {
    evidenceVerifier = createPbxEvidenceVerifier({
      publicKeys: new Map(
        [...attesterKeys].map(([keyId, entry]) => [keyId, entry.key]),
      ),
      controllerArmPublicKeys: new Map(
        [...armKeys].map(([keyId, entry]) => [keyId, entry.key]),
      ),
      replayStore: pbxEvidenceReplayStore,
      now,
    });
  } catch {
    fail('TELECAP2_INVALID_ARGUMENT', 'The controller PBX evidence verifier is invalid.');
  }
  clockSeconds(now, 'controller authority');
  requireInteger(defaultTtlSeconds, 'defaultTtlSeconds', 1, MAX_TTL_SECONDS);
  requireInteger(maxTtlSeconds, 'maxTtlSeconds', 1, MAX_TTL_SECONDS);
  if (defaultTtlSeconds > maxTtlSeconds) {
    fail('TELECAP2_INVALID_ARGUMENT', 'Controller capability TTL limits are invalid.');
  }
  if (typeof randomBytes !== 'function') {
    fail('TELECAP2_INVALID_ARGUMENT', 'The controller nonce source is invalid.');
  }

  const admittedEvidence = new WeakMap();
  const spentEvidence = new WeakSet();

  return Object.freeze({
    executionKeyId: signingKeyId,
    executionKeyFingerprint: executionFingerprint,

    consumePbxEvidence(token, expected) {
      requireAllowedKeys(expected, ['armToken'], ['callLeg'], 'Expected PBX evidence context');
      const context = {
        armToken: requireString(expected.armToken, 'expected.armToken', { max: 32 * 1024 }),
      };
      if (Object.hasOwn(expected, 'callLeg')) context.callLeg = expected.callLeg;
      const canonicalContext = immutableCanonical(context);
      let rawReceipt;
      try {
        rawReceipt = evidenceVerifier.consume(token, canonicalContext);
      } catch {
        fail('TELECAP2_PBX_CONSUME_FAILED', 'PBX evidence verification or consumption failed.');
      }
      const receipt = validateConsumedEvidenceReceipt(rawReceipt, armKeys, attesterKeys);
      admittedEvidence.set(receipt, canonicalEvidenceSnapshot(receipt));
      return receipt;
    },

    issue(input) {
      requireAllowedKeys(input, ['consumedPbxEvidence'], ['ttlSeconds'], 'Capability issue input');
      const receipt = input.consumedPbxEvidence;
      const admission = (receipt !== null && typeof receipt === 'object')
        ? admittedEvidence.get(receipt)
        : null;
      if (!admission) {
        fail(
          'TELECAP2_EVIDENCE_UNBRANDED',
          'Only PBX evidence consumed by this controller authority can issue a capability.',
        );
      }
      if (spentEvidence.has(receipt)) {
        fail('TELECAP2_EVIDENCE_SPENT', 'Consumed PBX evidence has already issued a capability.');
      }
      validateConsumedEvidenceReceipt(receipt, armKeys, attesterKeys);
      const currentSnapshot = canonicalEvidenceSnapshot(receipt);
      if (!exactString(admission, currentSnapshot)) {
        fail('TELECAP2_PBX_RESULT_INVALID', 'Consumed PBX evidence changed after admission.');
      }
      const ttlSeconds = input.ttlSeconds === undefined ? defaultTtlSeconds : input.ttlSeconds;
      requireInteger(ttlSeconds, 'ttlSeconds', 1, maxTtlSeconds);
      const issuedAt = clockSeconds(now, 'controller authority');
      if (issuedAt >= receipt.claims.exp) {
        fail('TELECAP2_EVIDENCE_EXPIRED', 'PBX evidence expired before capability issuance.');
      }
      const expiresAt = Math.min(issuedAt + ttlSeconds, receipt.claims.exp);
      if (expiresAt <= issuedAt) {
        fail('TELECAP2_EVIDENCE_EXPIRED', 'PBX evidence has no remaining capability lifetime.');
      }

      // Spend the private object-identity brand before every fallible signing
      // step. A nonce or signing failure burns this receipt rather than making
      // a second capability attempt ambiguous.
      spentEvidence.add(receipt);
      const claims = {
        v: TOKEN_VERSION,
        purpose: TOKEN_PURPOSE,
        controller_key_id: signingKeyId,
        approval_id: receipt.claims.approval_id,
        evidence_sha256: receipt.evidenceSha256,
        controller_arm_key_id: receipt.claims.arm_key_id,
        controller_arm_key_fingerprint: receipt.claims.arm_key_fingerprint,
        pbx_attester_key_id: receipt.keyId,
        pbx_attester_key_fingerprint: receipt.keyFingerprint,
        evidence_method: receipt.claims.method,
        job_id: receipt.claims.job_id,
        operation: receipt.claims.operation,
        request_sha256: receipt.claims.request_sha256,
        plan_sha256: receipt.claims.plan_sha256,
        target: receipt.claims.target,
        provider: receipt.claims.provider,
        profile: receipt.claims.profile,
        iat: issuedAt,
        exp: expiresAt,
        nonce: randomNonce(randomBytes),
      };
      return encodeToken(signingKeyId, claims, signingKey);
    },
  });
}

function decodeCanonicalObject(segment, label) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(segment)) {
    fail('TELECAP2_MALFORMED', `Capability ${label} is malformed.`);
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) {
    fail('TELECAP2_MALFORMED', `Capability ${label} is not canonically encoded.`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('TELECAP2_MALFORMED', `Capability ${label} is not JSON.`);
  }
  requireObject(value, `Capability ${label}`, 'TELECAP2_MALFORMED');
  if (Buffer.from(canonicalJson(value), 'utf8').toString('base64url') !== segment) {
    fail('TELECAP2_MALFORMED', `Capability ${label} JSON is not canonical.`);
  }
  return value;
}

function validateCapabilityClaims(claims, keyId, nowSeconds, maxTtlSeconds, clockSkewSeconds) {
  requireExactKeys(claims, CAPABILITY_CLAIM_KEYS, 'Capability claims');
  if (claims.v !== TOKEN_VERSION || claims.purpose !== TOKEN_PURPOSE) {
    fail('TELECAP2_WRONG_PURPOSE', 'Capability has the wrong version or purpose.');
  }
  requireKeyId(claims.controller_key_id, 'claims.controller_key_id');
  if (!exactString(claims.controller_key_id, keyId)) {
    fail('TELECAP2_KEY_BINDING', 'Capability controller key ID differs from its signature header.');
  }
  requireIdentifier(claims.approval_id, 'claims.approval_id', 128);
  requireHash(claims.evidence_sha256, 'claims.evidence_sha256');
  requireKeyId(claims.controller_arm_key_id, 'claims.controller_arm_key_id');
  requireHash(
    claims.controller_arm_key_fingerprint,
    'claims.controller_arm_key_fingerprint',
  );
  requireKeyId(claims.pbx_attester_key_id, 'claims.pbx_attester_key_id');
  requireHash(claims.pbx_attester_key_fingerprint, 'claims.pbx_attester_key_fingerprint');
  if (claims.evidence_method !== PBX_EVIDENCE_METHOD) {
    fail('TELECAP2_WRONG_PURPOSE', 'Capability PBX evidence method is unsupported.');
  }
  requireIdentifier(claims.job_id, 'claims.job_id');
  requireIdentifier(claims.operation, 'claims.operation', 128);
  requireHash(claims.request_sha256, 'claims.request_sha256');
  requireHash(claims.plan_sha256, 'claims.plan_sha256');
  requireString(claims.target, 'claims.target');
  requireIdentifier(claims.provider, 'claims.provider', 96);
  requireIdentifier(claims.profile, 'claims.profile', 128);
  requireInteger(claims.iat, 'claims.iat');
  requireInteger(claims.exp, 'claims.exp');
  requireNonce(claims.nonce, 'claims.nonce');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxTtlSeconds) {
    fail('TELECAP2_INVALID_LIFETIME', 'Capability lifetime is invalid.');
  }
  if (claims.iat > nowSeconds + clockSkewSeconds) {
    fail('TELECAP2_NOT_YET_VALID', 'Capability is not yet valid.');
  }
  // Expiration is strict. Clock skew never extends execution authority.
  if (nowSeconds >= claims.exp) fail('TELECAP2_EXPIRED', 'Capability has expired.');
  return claims;
}

function normalizeExpectedBindings(expected) {
  requireExactKeys(
    expected, EXPECTED_BINDING_KEYS, 'Expected capability bindings',
    'TELECAP2_EXPECTED_BINDINGS_REQUIRED',
  );
  return {
    controller_key_id: requireKeyId(expected.controllerKeyId, 'expected.controllerKeyId'),
    approval_id: requireIdentifier(expected.approvalId, 'expected.approvalId', 128),
    evidence_sha256: requireHash(expected.evidenceSha256, 'expected.evidenceSha256'),
    controller_arm_key_id: requireKeyId(
      expected.controllerArmKeyId, 'expected.controllerArmKeyId',
    ),
    controller_arm_key_fingerprint: requireHash(
      expected.controllerArmKeyFingerprint, 'expected.controllerArmKeyFingerprint',
    ),
    pbx_attester_key_id: requireKeyId(
      expected.pbxAttesterKeyId, 'expected.pbxAttesterKeyId',
    ),
    pbx_attester_key_fingerprint: requireHash(
      expected.pbxAttesterKeyFingerprint, 'expected.pbxAttesterKeyFingerprint',
    ),
    evidence_method: requireString(expected.evidenceMethod, 'expected.evidenceMethod', { max: 96 }),
    job_id: requireIdentifier(expected.jobId, 'expected.jobId'),
    operation: requireIdentifier(expected.operation, 'expected.operation', 128),
    request_sha256: requireHash(expected.requestHash, 'expected.requestHash'),
    plan_sha256: requireHash(expected.planHash, 'expected.planHash'),
    target: requireString(expected.target, 'expected.target'),
    provider: requireIdentifier(expected.provider, 'expected.provider', 96),
    profile: requireIdentifier(expected.profile, 'expected.profile', 128),
  };
}

function createTelecap2Verifier({
  publicKeys,
  consumeReplay,
  now = Date.now,
  maxTtlSeconds = MAX_TTL_SECONDS,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
} = {}) {
  const verificationKeys = normalizePublicKeyMap(publicKeys, 'publicKeys');
  if (typeof consumeReplay !== 'function') {
    fail(
      'TELECAP2_REPLAY_CONSUMER_REQUIRED',
      'A synchronous atomic execution-capability replay consumer is required.',
    );
  }
  clockSeconds(now, 'execution verifier');
  requireInteger(maxTtlSeconds, 'maxTtlSeconds', 1, MAX_TTL_SECONDS);
  requireInteger(clockSkewSeconds, 'clockSkewSeconds', 0, 30);

  return Object.freeze({
    authorize(token, expected) {
      if (typeof token !== 'string' || token.length < 1 ||
          Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
        fail('TELECAP2_MALFORMED', 'Capability token is missing or too large.');
      }
      const segments = token.split('.');
      if (segments.length !== 4 || segments[0] !== TOKEN_PREFIX) {
        fail('TELECAP2_MALFORMED', 'Capability prefix or segment count is invalid.');
      }
      const header = requireExactKeys(
        decodeCanonicalObject(segments[1], 'header'), ['alg', 'kid', 'typ'],
        'Capability header',
      );
      if (header.alg !== SIGNATURE_ALGORITHM || header.typ !== TOKEN_TYPE) {
        fail('TELECAP2_MALFORMED', 'Capability header is invalid.');
      }
      const keyId = requireKeyId(header.kid, 'header.kid');
      const verification = verificationKeys.get(keyId);
      if (!verification) fail('TELECAP2_UNKNOWN_KEY', 'Capability signing key is not trusted.');
      const signature = Buffer.from(segments[3], 'base64url');
      if (signature.length !== 64 || signature.toString('base64url') !== segments[3] ||
          !crypto.verify(
            null,
            Buffer.from(`${segments[1]}.${segments[2]}`, 'ascii'),
            verification.key,
            signature,
          )) {
        fail('TELECAP2_BAD_SIGNATURE', 'Capability signature is invalid.');
      }
      const claims = decodeCanonicalObject(segments[2], 'claims');
      validateCapabilityClaims(
        claims, keyId, clockSeconds(now, 'execution verifier'),
        maxTtlSeconds, clockSkewSeconds,
      );
      const bindings = normalizeExpectedBindings(expected);
      let matches = true;
      for (const [claim, value] of Object.entries(bindings)) {
        matches = exactString(claims[claim], value) && matches;
      }
      if (!matches) {
        fail('TELECAP2_BINDING_MISMATCH', 'Capability does not match the exact execution request.');
      }

      const consumedAt = clockSeconds(now, 'execution verifier');
      if (consumedAt >= claims.exp) {
        fail('TELECAP2_EXPIRED', 'Capability expired before replay consumption.');
      }
      const tokenSha256 = digest(Buffer.from(token, 'utf8'));
      let consumed;
      try {
        consumed = consumeReplay(Object.freeze({
          controllerKeyId: keyId,
          controllerKeyFingerprint: verification.fingerprint,
          nonce: claims.nonce,
          approvalId: claims.approval_id,
          evidenceSha256: claims.evidence_sha256,
          tokenSha256,
          expiresAt: claims.exp,
          consumedAt,
        }));
      } catch {
        fail('TELECAP2_REPLAY_UNAVAILABLE', 'Capability replay protection is unavailable.');
      }
      if (consumed && typeof consumed.then === 'function') {
        fail(
          'TELECAP2_REPLAY_UNAVAILABLE',
          'Capability replay consumption must be synchronous at authorization.',
        );
      }
      if (consumed !== true) {
        fail('TELECAP2_REPLAYED', 'Capability has already been consumed.');
      }
      return Object.freeze({
        authorized: true,
        ...claims,
        controller_key_fingerprint: verification.fingerprint,
        token_sha256: tokenSha256,
      });
    },
  });
}

module.exports = {
  PBX_EVIDENCE_METHOD,
  TOKEN_PREFIX,
  TOKEN_PURPOSE,
  Telecap2Error,
  canonicalJson,
  createTelecap2ControllerAuthority,
  createTelecap2Verifier,
  fingerprintPublicKey,
};
