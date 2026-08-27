'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  DTMF_SOURCE,
  EVIDENCE_METHOD,
  createPbxArmIssuer,
  createPbxArmVerifier,
  createPbxEvidenceIssuer,
  hashText,
} = require('../../lib/pbx-approval-protocol');
const {
  PBX_EVIDENCE_METHOD,
  TOKEN_PREFIX,
  canonicalJson,
  createTelecap2ControllerAuthority,
  createTelecap2Verifier,
} = require('../../lib/telecap2-execution-capability');

const BASE_TIME = Date.parse('2026-08-26T12:00:00.000Z');
const REQUEST_HASH = crypto.createHash('sha256').update('exact request').digest('hex');
const PLAN_HASH = crypto.createHash('sha256').update('exact canonical plan').digest('hex');
const AUDIO_HASH = crypto.createHash('sha256').update('exact rendered prompt').digest('hex');
const CALL_HANDLE = Buffer.alloc(32, 0x31).toString('base64url');

function memoryReplayConsumer() {
  const seen = new Set();
  const records = [];
  return {
    records,
    consume(record) {
      const key = `${record.controllerKeyId || record.keyId}\u0000${record.nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      records.push({ ...record });
      return true;
    },
  };
}

function keyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function assertCanonicalOwnDataFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    assert.equal(typeof key, 'string');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.equal(descriptor.enumerable, true);
    assert.equal(Object.hasOwn(descriptor, 'value'), true);
    assertCanonicalOwnDataFrozen(descriptor.value, seen);
  }
}

function armInput(overrides = {}) {
  return {
    approvalId: 'approval-telecap2-fixture',
    jobId: 'job-telecap2-fixture',
    operation: 'tmux-delivery',
    requestHash: REQUEST_HASH,
    planHash: PLAN_HASH,
    target: 'hermes:session:phone',
    provider: 'codex',
    profile: 'codex-sol',
    prompt: 'Approval required. Deliver the exact reviewed request. Press pound to approve.',
    pbxCallHandle: CALL_HANDLE,
    ...overrides,
  };
}

function callLeg(overrides = {}) {
  return {
    pbx_instance_id: 'asterisk-telecap2-fixture',
    linkedid: '1710000000.11',
    handset_uniqueid: 'PJSIP-owner-telecap2-1',
    handset_endpoint: 'PJSIP/owner',
    channel_birth_ms: BASE_TIME + 100,
    trunk_uniqueid: 'PJSIP-trunk-telecap2-2',
    bridge_id: 'bridge-telecap2-fixture',
    dialed_route: '+15551234567',
    ...overrides,
  };
}

function observation(promptHash) {
  return {
    pbx_call_handle: CALL_HANDLE,
    call_leg: callLeg(),
    prompt_sha256: promptHash,
    prompt_audio_sha256: AUDIO_HASH,
    playback_id: 'playback-telecap2-fixture',
    playback_started_at_ms: BASE_TIME + 1000,
    playback_completed_at_ms: BASE_TIME + 2000,
    digit: '#',
    dtmf_source: DTMF_SOURCE,
    dtmf_event_id: 'dtmf-telecap2-fixture',
    dtmf_received_at_ms: BASE_TIME + 3000,
  };
}

function buildFixture({
  authorityOverrides = {},
  executionKeys = keyPair(),
  armKeys = keyPair(),
  attesterKeys = keyPair(),
} = {}) {
  let currentTime = BASE_TIME + 4000;
  const now = () => currentTime;
  const pbxReplay = memoryReplayConsumer();
  const armIssuer = createPbxArmIssuer({
    privateKey: armKeys.privateKey,
    keyId: 'controller-arm-2026-08',
    now: () => BASE_TIME,
    randomBytes: size => Buffer.alloc(size, 0x41),
  });
  const armVerifier = createPbxArmVerifier({
    publicKeys: { 'controller-arm-2026-08': armKeys.publicKey },
    now,
  });
  const armToken = armIssuer.issue(armInput());
  const arm = armVerifier.verify(armToken, {
    ...armInput(),
    promptHash: hashText(armInput().prompt),
  });
  const evidenceIssuer = createPbxEvidenceIssuer({
    privateKey: attesterKeys.privateKey,
    keyId: 'pbx-attester-2026-08',
    controllerArmPublicKeys: { 'controller-arm-2026-08': armKeys.publicKey },
    now,
    randomBytes: size => Buffer.alloc(size, 0x42),
  });
  const evidenceToken = evidenceIssuer.issue({
    armToken,
    observation: observation(arm.claims.prompt_sha256),
  });
  const authority = createTelecap2ControllerAuthority({
    executionPrivateKey: executionKeys.privateKey,
    executionKeyId: 'controller-execution-2026-08',
    controllerArmPublicKeys: { 'controller-arm-2026-08': armKeys.publicKey },
    pbxAttesterPublicKeys: { 'pbx-attester-2026-08': attesterKeys.publicKey },
    pbxEvidenceReplayStore: pbxReplay,
    now,
    randomBytes: size => Buffer.alloc(size, 0x43),
    ...authorityOverrides,
  });
  return {
    executionKeys,
    armKeys,
    attesterKeys,
    armToken,
    arm,
    evidenceToken,
    authority,
    pbxReplay,
    now,
    setTime(value) { currentTime = value; },
  };
}

function consumeEvidence(fixture) {
  return fixture.authority.consumePbxEvidence(fixture.evidenceToken, {
    armToken: fixture.armToken,
    callLeg: callLeg(),
  });
}

function expectedBindings(fixture, evidence) {
  return {
    controllerKeyId: fixture.authority.executionKeyId,
    approvalId: evidence.claims.approval_id,
    evidenceSha256: evidence.evidenceSha256,
    controllerArmKeyId: evidence.claims.arm_key_id,
    controllerArmKeyFingerprint: evidence.claims.arm_key_fingerprint,
    pbxAttesterKeyId: evidence.keyId,
    pbxAttesterKeyFingerprint: evidence.keyFingerprint,
    evidenceMethod: evidence.claims.method,
    jobId: evidence.claims.job_id,
    operation: evidence.claims.operation,
    requestHash: evidence.claims.request_sha256,
    planHash: evidence.claims.plan_sha256,
    target: evidence.claims.target,
    provider: evidence.claims.provider,
    profile: evidence.claims.profile,
  };
}

function decodeToken(token) {
  const segments = token.split('.');
  return {
    segments,
    header: JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(segments[2], 'base64url').toString('utf8')),
  };
}

function resign(token, privateKey, mutate) {
  const decoded = decodeToken(token);
  mutate(decoded.claims, decoded.header);
  decoded.segments[1] = Buffer.from(canonicalJson(decoded.header), 'utf8').toString('base64url');
  decoded.segments[2] = Buffer.from(canonicalJson(decoded.claims), 'utf8').toString('base64url');
  decoded.segments[3] = crypto.sign(
    null,
    Buffer.from(`${decoded.segments[1]}.${decoded.segments[2]}`, 'ascii'),
    privateKey,
  ).toString('base64url');
  return decoded.segments.join('.');
}

test('telecap2 chains one consumed PBX result into one exact replay-consumed authorization', () => {
  const fixture = buildFixture();
  const evidence = consumeEvidence(fixture);
  assertCanonicalOwnDataFrozen(evidence);
  assert.equal(fixture.pbxReplay.records.length, 1);
  assert.notEqual(fixture.authority.executionKeyFingerprint, fixture.arm.keyFingerprint);
  assert.notEqual(fixture.authority.executionKeyFingerprint, evidence.keyFingerprint);
  assert.notEqual(fixture.arm.keyFingerprint, evidence.keyFingerprint);

  const token = fixture.authority.issue({ consumedPbxEvidence: evidence });
  assert.match(token, new RegExp(`^${TOKEN_PREFIX}\\.`, 'u'));
  const decoded = decodeToken(token);
  assert.deepEqual(decoded.header, {
    alg: 'EdDSA',
    kid: 'controller-execution-2026-08',
    typ: 'TELEAGENT_EXECUTION_CAPABILITY',
  });
  assert.equal(decoded.claims.controller_key_id, fixture.authority.executionKeyId);
  assert.equal(decoded.claims.approval_id, evidence.claims.approval_id);
  assert.equal(decoded.claims.evidence_sha256, evidence.evidenceSha256);
  assert.equal(decoded.claims.controller_arm_key_id, evidence.claims.arm_key_id);
  assert.equal(
    decoded.claims.controller_arm_key_fingerprint,
    evidence.claims.arm_key_fingerprint,
  );
  assert.equal(decoded.claims.pbx_attester_key_fingerprint, evidence.keyFingerprint);
  assert.equal(decoded.claims.evidence_method, EVIDENCE_METHOD);
  assert.equal(decoded.claims.evidence_method, PBX_EVIDENCE_METHOD);
  assert.equal(decoded.claims.exp - decoded.claims.iat, 30);

  const replay = memoryReplayConsumer();
  const verifier = createTelecap2Verifier({
    publicKeys: { 'controller-execution-2026-08': fixture.executionKeys.publicKey },
    consumeReplay: record => replay.consume(record),
    now: fixture.now,
  });
  const expected = expectedBindings(fixture, evidence);
  const authorized = verifier.authorize(token, expected);
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.approval_id, expected.approvalId);
  assert.equal(authorized.operation, expected.operation);
  assert.match(authorized.controller_key_fingerprint, /^[a-f0-9]{64}$/u);
  assert.match(authorized.token_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(authorized, 'token'), false);
  assert.equal(replay.records.length, 1);
  assert.deepEqual({
    approvalId: replay.records[0].approvalId,
    evidenceSha256: replay.records[0].evidenceSha256,
  }, {
    approvalId: expected.approvalId,
    evidenceSha256: expected.evidenceSha256,
  });
  assert.throws(
    () => verifier.authorize(token, expected),
    error => error.code === 'TELECAP2_REPLAYED',
  );
});

test('issuer rejects raw voice assertions and unbranded lookalikes, then spends the real receipt once', () => {
  const fixture = buildFixture();
  assert.throws(
    () => fixture.authority.issue({ consumedPbxEvidence: { approved: true } }),
    error => error.code === 'TELECAP2_EVIDENCE_UNBRANDED',
  );
  const evidence = consumeEvidence(fixture);
  const frozenLookalike = Object.freeze({
    ...evidence,
    claims: evidence.claims,
    callLeg: evidence.callLeg,
  });
  assert.throws(
    () => fixture.authority.issue({ consumedPbxEvidence: frozenLookalike }),
    error => error.code === 'TELECAP2_EVIDENCE_UNBRANDED',
  );
  const token = fixture.authority.issue({ consumedPbxEvidence: evidence });
  assert.match(token, /^telecap2\./u);
  assert.throws(
    () => fixture.authority.issue({ consumedPbxEvidence: evidence }),
    error => error.code === 'TELECAP2_EVIDENCE_SPENT',
  );
  assert.throws(
    () => consumeEvidence(fixture),
    error => error.code === 'TELECAP2_PBX_CONSUME_FAILED',
  );
});

test('controller consumption rejects structural arms, accessors, and custom-verifier trust', () => {
  let legacyVerifierCalls = 0;
  const fixture = buildFixture({
    authorityOverrides: {
      pbxEvidenceVerifier: {
        consume() {
          legacyVerifierCalls += 1;
          return Object.freeze({ approved: true });
        },
      },
    },
  });
  assert.throws(
    () => fixture.authority.consumePbxEvidence(fixture.evidenceToken, {
      arm: fixture.arm,
      callLeg: callLeg(),
    }),
    error => error.code === 'TELECAP2_INVALID_ARGUMENT',
  );
  assert.equal(fixture.pbxReplay.records.length, 0);

  const accessorContext = {};
  Object.defineProperty(accessorContext, 'armToken', {
    enumerable: true,
    get() { return fixture.armToken; },
  });
  Object.freeze(accessorContext);
  assert.throws(
    () => fixture.authority.consumePbxEvidence(fixture.evidenceToken, accessorContext),
    error => error.code === 'TELECAP2_INVALID_ARGUMENT',
  );
  assert.equal(fixture.pbxReplay.records.length, 0);

  const wrongSignature = resign(fixture.armToken, fixture.attesterKeys.privateKey, () => {});
  assert.throws(
    () => fixture.authority.consumePbxEvidence(fixture.evidenceToken, {
      armToken: wrongSignature,
      callLeg: callLeg(),
    }),
    error => error.code === 'TELECAP2_PBX_CONSUME_FAILED',
  );
  assert.equal(fixture.pbxReplay.records.length, 0);

  const evidence = consumeEvidence(fixture);
  assertCanonicalOwnDataFrozen(evidence);
  assert.equal(legacyVerifierCalls, 0);
  assert.equal(fixture.pbxReplay.records.length, 1);
});

test('controller authority rejects arm, attester, and execution key-role confusion', () => {
  const executionKeys = keyPair();
  const armKeys = keyPair();
  const attesterKeys = keyPair();
  const base = {
    executionPrivateKey: executionKeys.privateKey,
    executionKeyId: 'controller-execution-2026-08',
    controllerArmPublicKeys: { 'controller-arm-2026-08': armKeys.publicKey },
    pbxAttesterPublicKeys: { 'pbx-attester-2026-08': attesterKeys.publicKey },
    pbxEvidenceReplayStore: memoryReplayConsumer(),
    now: () => BASE_TIME,
  };
  assert.throws(() => createTelecap2ControllerAuthority({
    ...base,
    executionPrivateKey: armKeys.privateKey,
  }), error => error.code === 'TELECAP2_KEY_ROLE_REUSE');
  assert.throws(() => createTelecap2ControllerAuthority({
    ...base,
    pbxAttesterPublicKeys: { 'pbx-attester-2026-08': armKeys.publicKey },
  }), error => error.code === 'TELECAP2_KEY_ROLE_REUSE');
  assert.throws(() => createTelecap2ControllerAuthority({
    ...base,
    executionKeyId: 'controller-arm-2026-08',
  }), error => error.code === 'TELECAP2_KEY_ROLE_REUSE');
  assert.throws(() => createTelecap2ControllerAuthority({
    ...base,
    pbxAttesterPublicKeys: { 'controller-arm-2026-08': attesterKeys.publicKey },
  }), error => error.code === 'TELECAP2_KEY_ROLE_REUSE');
  assert.throws(() => createTelecap2ControllerAuthority({
    ...base,
    pbxEvidenceReplayStore: undefined,
  }), error => error.code === 'TELECAP2_INVALID_ARGUMENT');
});

test('raw arm and attester signatures are checked before replay admission', () => {
  const fixture = buildFixture();
  const wrongArmKeys = keyPair();
  const wrongArmReplay = memoryReplayConsumer();
  const wrongArmAuthority = createTelecap2ControllerAuthority({
    executionPrivateKey: fixture.executionKeys.privateKey,
    executionKeyId: 'controller-execution-2026-08',
    controllerArmPublicKeys: { 'controller-arm-2026-08': wrongArmKeys.publicKey },
    pbxAttesterPublicKeys: { 'pbx-attester-2026-08': fixture.attesterKeys.publicKey },
    pbxEvidenceReplayStore: wrongArmReplay,
    now: fixture.now,
  });
  assert.throws(() => wrongArmAuthority.consumePbxEvidence(fixture.evidenceToken, {
    armToken: fixture.armToken,
    callLeg: callLeg(),
  }), error => error.code === 'TELECAP2_PBX_CONSUME_FAILED');
  assert.equal(wrongArmReplay.records.length, 0);

  const second = buildFixture();
  const wrongAttesterKeys = keyPair();
  const wrongAttesterReplay = memoryReplayConsumer();
  const wrongAttesterAuthority = createTelecap2ControllerAuthority({
    executionPrivateKey: second.executionKeys.privateKey,
    executionKeyId: 'controller-execution-2026-08',
    controllerArmPublicKeys: { 'controller-arm-2026-08': second.armKeys.publicKey },
    pbxAttesterPublicKeys: { 'pbx-attester-2026-08': wrongAttesterKeys.publicKey },
    pbxEvidenceReplayStore: wrongAttesterReplay,
    now: second.now,
  });
  assert.throws(() => wrongAttesterAuthority.consumePbxEvidence(second.evidenceToken, {
    armToken: second.armToken,
    callLeg: callLeg(),
  }), error => error.code === 'TELECAP2_PBX_CONSUME_FAILED');
  assert.equal(wrongAttesterReplay.records.length, 0);

  const third = buildFixture();
  const asyncAuthority = createTelecap2ControllerAuthority({
    executionPrivateKey: third.executionKeys.privateKey,
    executionKeyId: 'controller-execution-2026-08',
    controllerArmPublicKeys: { 'controller-arm-2026-08': third.armKeys.publicKey },
    pbxAttesterPublicKeys: { 'pbx-attester-2026-08': third.attesterKeys.publicKey },
    pbxEvidenceReplayStore: { consume: () => Promise.resolve(true) },
    now: third.now,
  });
  assert.throws(() => asyncAuthority.consumePbxEvidence(third.evidenceToken, {
    armToken: third.armToken,
  }), error => error.code === 'TELECAP2_PBX_CONSUME_FAILED');
});

test('verifier requires every expected semantic binding before atomic replay consumption', () => {
  const fixture = buildFixture();
  const evidence = consumeEvidence(fixture);
  const token = fixture.authority.issue({ consumedPbxEvidence: evidence });
  const replay = memoryReplayConsumer();
  const verifier = createTelecap2Verifier({
    publicKeys: { 'controller-execution-2026-08': fixture.executionKeys.publicKey },
    consumeReplay: record => replay.consume(record),
    now: fixture.now,
  });
  const expected = expectedBindings(fixture, evidence);
  const alternatives = {
    controllerKeyId: 'controller-execution-other',
    approvalId: 'approval-other',
    evidenceSha256: 'b'.repeat(64),
    controllerArmKeyId: 'controller-arm-other',
    controllerArmKeyFingerprint: 'a'.repeat(64),
    pbxAttesterKeyId: 'pbx-attester-other',
    pbxAttesterKeyFingerprint: 'c'.repeat(64),
    evidenceMethod: 'pbx-handset-other-method-v1',
    jobId: 'job-other',
    operation: 'systemctl-restart',
    requestHash: 'd'.repeat(64),
    planHash: 'e'.repeat(64),
    target: 'hera:session:other',
    provider: 'claude',
    profile: 'claude-opus',
  };
  for (const [field, value] of Object.entries(alternatives)) {
    assert.throws(
      () => verifier.authorize(token, { ...expected, [field]: value }),
      error => error.code === 'TELECAP2_BINDING_MISMATCH',
      field,
    );
  }
  const missing = { ...expected };
  delete missing.operation;
  assert.throws(
    () => verifier.authorize(token, missing),
    error => error.code === 'TELECAP2_EXPECTED_BINDINGS_REQUIRED',
  );
  assert.throws(
    () => verifier.authorize(token, { ...expected, approved: true }),
    error => error.code === 'TELECAP2_EXPECTED_BINDINGS_REQUIRED',
  );
  assert.equal(replay.records.length, 0);
  assert.equal(verifier.authorize(token, expected).authorized, true);
  assert.equal(replay.records.length, 1);
});

test('issue and authorization expiration are strict and never extended by skew', () => {
  const expiredEvidenceFixture = buildFixture();
  const expiredEvidence = consumeEvidence(expiredEvidenceFixture);
  expiredEvidenceFixture.setTime(expiredEvidence.claims.exp * 1000);
  assert.throws(
    () => expiredEvidenceFixture.authority.issue({ consumedPbxEvidence: expiredEvidence }),
    error => error.code === 'TELECAP2_EVIDENCE_EXPIRED',
  );

  const ttlFixture = buildFixture();
  const ttlEvidence = consumeEvidence(ttlFixture);
  assert.throws(
    () => ttlFixture.authority.issue({ consumedPbxEvidence: ttlEvidence, ttlSeconds: 61 }),
    error => error.code === 'TELECAP2_INVALID_ARGUMENT',
  );
  const token = ttlFixture.authority.issue({
    consumedPbxEvidence: ttlEvidence,
    ttlSeconds: 1,
  });
  const expected = expectedBindings(ttlFixture, ttlEvidence);
  const replay = memoryReplayConsumer();
  const verifier = createTelecap2Verifier({
    publicKeys: { 'controller-execution-2026-08': ttlFixture.executionKeys.publicKey },
    consumeReplay: record => replay.consume(record),
    now: ttlFixture.now,
  });
  ttlFixture.setTime(BASE_TIME + 5000);
  assert.throws(
    () => verifier.authorize(token, expected),
    error => error.code === 'TELECAP2_EXPIRED',
  );
  assert.equal(replay.records.length, 0);
});

test('signed lifetime, purpose, controller-key, and signature tampering fail before replay', () => {
  const fixture = buildFixture();
  const evidence = consumeEvidence(fixture);
  const token = fixture.authority.issue({ consumedPbxEvidence: evidence });
  const expected = expectedBindings(fixture, evidence);
  const replay = memoryReplayConsumer();
  const verifier = createTelecap2Verifier({
    publicKeys: { 'controller-execution-2026-08': fixture.executionKeys.publicKey },
    consumeReplay: record => replay.consume(record),
    now: fixture.now,
  });
  const cases = [
    [resign(token, fixture.executionKeys.privateKey, claims => {
      claims.iat += 6;
      claims.exp = claims.iat + 1;
    }), 'TELECAP2_NOT_YET_VALID'],
    [resign(token, fixture.executionKeys.privateKey, claims => {
      claims.exp = claims.iat + 61;
    }), 'TELECAP2_INVALID_LIFETIME'],
    [resign(token, fixture.executionKeys.privateKey, claims => {
      claims.purpose = 'teleagent.voice-assertion';
    }), 'TELECAP2_WRONG_PURPOSE'],
    [resign(token, fixture.executionKeys.privateKey, claims => {
      claims.controller_key_id = 'controller-execution-other';
    }), 'TELECAP2_KEY_BINDING'],
  ];
  const brokenSignature = token.split('.');
  const signature = Buffer.from(brokenSignature[3], 'base64url');
  signature[0] ^= 1;
  brokenSignature[3] = signature.toString('base64url');
  cases.push([brokenSignature.join('.'), 'TELECAP2_BAD_SIGNATURE']);
  cases.push([token.replace(/^telecap2/u, 'telecap1'), 'TELECAP2_MALFORMED']);
  for (const [candidate, code] of cases) {
    assert.throws(
      () => verifier.authorize(candidate, expected),
      error => error.code === code,
      code,
    );
  }
  assert.equal(replay.records.length, 0);

  const wrongKeyVerifier = createTelecap2Verifier({
    publicKeys: { 'controller-execution-2026-08': fixture.armKeys.publicKey },
    consumeReplay: () => true,
    now: fixture.now,
  });
  assert.throws(
    () => wrongKeyVerifier.authorize(token, expected),
    error => error.code === 'TELECAP2_BAD_SIGNATURE',
  );
});

test('replay consumer is mandatory, synchronous, atomic, and last before authorization', () => {
  const fixture = buildFixture();
  const evidence = consumeEvidence(fixture);
  const token = fixture.authority.issue({ consumedPbxEvidence: evidence });
  const expected = expectedBindings(fixture, evidence);
  assert.throws(() => createTelecap2Verifier({
    publicKeys: { 'controller-execution-2026-08': fixture.executionKeys.publicKey },
    now: fixture.now,
  }), error => error.code === 'TELECAP2_REPLAY_CONSUMER_REQUIRED');

  for (const [consumeReplay, code] of [
    [() => Promise.resolve(true), 'TELECAP2_REPLAY_UNAVAILABLE'],
    [() => { throw new Error('store down'); }, 'TELECAP2_REPLAY_UNAVAILABLE'],
    [() => false, 'TELECAP2_REPLAYED'],
  ]) {
    const verifier = createTelecap2Verifier({
      publicKeys: { 'controller-execution-2026-08': fixture.executionKeys.publicKey },
      consumeReplay,
      now: fixture.now,
    });
    assert.throws(() => verifier.authorize(token, expected), error => error.code === code);
  }
});

test('nonce-generation failure spends the branded evidence before signing', () => {
  const fixture = buildFixture({
    authorityOverrides: {
      randomBytes() { throw new Error('entropy unavailable'); },
    },
  });
  const evidence = consumeEvidence(fixture);
  assert.throws(
    () => fixture.authority.issue({ consumedPbxEvidence: evidence }),
    error => error.code === 'TELECAP2_ISSUE_FAILED',
  );
  assert.throws(
    () => fixture.authority.issue({ consumedPbxEvidence: evidence }),
    error => error.code === 'TELECAP2_EVIDENCE_SPENT',
  );
});
