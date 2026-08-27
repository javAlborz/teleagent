'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  DTMF_SOURCE,
  EVIDENCE_METHOD,
  canonicalJson,
  createPbxArmIssuer,
  createPbxArmVerifier,
  createPbxEvidenceIssuer,
  createPbxEvidenceVerifier,
  digestToken,
  hashCanonical,
  hashText,
  validatePbxObservation,
} = require('../../lib/pbx-approval-protocol');

const BASE_TIME = Date.parse('2026-08-26T12:00:00.000Z');
const HASH_A = crypto.createHash('sha256').update('request').digest('hex');
const HASH_B = crypto.createHash('sha256').update('plan').digest('hex');
const AUDIO_HASH = crypto.createHash('sha256').update('rendered prompt audio').digest('hex');
const CALL_HANDLE = Buffer.alloc(32, 0x41).toString('base64url');

function keyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function armInput(overrides = {}) {
  return {
    approvalId: 'approval_fixture_1',
    jobId: 'job_fixture_1',
    operation: 'tmux-delivery',
    requestHash: HASH_A,
    planHash: HASH_B,
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
    pbx_instance_id: 'asterisk-fixture-1',
    linkedid: '1710000000.1',
    handset_uniqueid: 'PJSIP-owner-00000001',
    handset_endpoint: 'PJSIP/owner',
    channel_birth_ms: BASE_TIME + 100,
    trunk_uniqueid: 'PJSIP-trunk-00000002',
    bridge_id: 'bridge-fixture-1',
    dialed_route: '+15551234567',
    ...overrides,
  };
}

function observation(promptHash, overrides = {}) {
  return {
    pbx_call_handle: CALL_HANDLE,
    call_leg: callLeg(),
    prompt_sha256: promptHash,
    prompt_audio_sha256: AUDIO_HASH,
    playback_id: 'playback-fixture-1',
    playback_started_at_ms: BASE_TIME + 1000,
    playback_completed_at_ms: BASE_TIME + 2000,
    digit: '#',
    dtmf_source: DTMF_SOURCE,
    dtmf_event_id: 'dtmf-fixture-1',
    dtmf_received_at_ms: BASE_TIME + 3000,
    ...overrides,
  };
}

function memoryReplayStore() {
  const seen = new Set();
  return {
    records: [],
    consume(record) {
      const key = `${record.keyId}\u0000${record.nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      this.records.push({ ...record });
      return true;
    },
  };
}

function fixture({ now = () => BASE_TIME + 4000, replayStore = memoryReplayStore() } = {}) {
  const controllerKeys = keyPair();
  const attesterKeys = keyPair();
  const armIssuer = createPbxArmIssuer({
    privateKey: controllerKeys.privateKey,
    keyId: 'controller-arm-2026-08',
    now: () => BASE_TIME,
    randomBytes: size => Buffer.alloc(size, 0x42),
  });
  const armVerifier = createPbxArmVerifier({
    publicKeys: { 'controller-arm-2026-08': controllerKeys.publicKey },
    now,
  });
  const evidenceIssuer = createPbxEvidenceIssuer({
    privateKey: attesterKeys.privateKey,
    keyId: 'pbx-attester-2026-08',
    controllerArmPublicKeys: { 'controller-arm-2026-08': controllerKeys.publicKey },
    now,
    randomBytes: size => Buffer.alloc(size, 0x43),
  });
  const evidenceVerifier = createPbxEvidenceVerifier({
    publicKeys: { 'pbx-attester-2026-08': attesterKeys.publicKey },
    controllerArmPublicKeys: { 'controller-arm-2026-08': controllerKeys.publicKey },
    replayStore,
    now,
  });
  return {
    armIssuer, armVerifier, evidenceIssuer, evidenceVerifier,
    controllerKeys, attesterKeys, replayStore,
  };
}

function resign(token, privateKey, mutate) {
  const segments = token.split('.');
  const header = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(segments[2], 'base64url').toString('utf8'));
  mutate(claims, header);
  segments[1] = Buffer.from(canonicalJson(header), 'utf8').toString('base64url');
  segments[2] = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url');
  const input = `${segments[1]}.${segments[2]}`;
  segments[3] = crypto.sign(null, Buffer.from(input, 'ascii'), privateKey).toString('base64url');
  return segments.join('.');
}

function issuedChain(options = {}) {
  const built = fixture(options);
  const armToken = built.armIssuer.issue(armInput());
  const arm = built.armVerifier.verify(armToken, {
    ...armInput(),
    promptHash: hashText(armInput().prompt),
  });
  const evidenceToken = built.evidenceIssuer.issue({
    armToken,
    observation: observation(arm.claims.prompt_sha256),
  });
  return { ...built, armToken, arm, evidenceToken };
}

test('controller arm and independent PBX evidence bind the exact call and consume once', () => {
  const chain = issuedChain();
  assert.match(chain.armToken, /^telereq1\./u);
  assert.match(chain.evidenceToken, /^teleattest1\./u);
  assert.notEqual(chain.arm.keyFingerprint, chain.evidenceVerifier.verify(chain.evidenceToken, {
    armToken: chain.armToken,
    callLeg: callLeg(),
  }).keyFingerprint);

  const accepted = chain.evidenceVerifier.consume(chain.evidenceToken, {
    armToken: chain.armToken,
    callLeg: callLeg(),
  });
  assert.equal(accepted.evidenceSha256, digestToken(chain.evidenceToken));
  assert.equal(accepted.claims.method, EVIDENCE_METHOD);
  assert.equal(accepted.claims.digit, '#');
  assert.equal(accepted.claims.dtmf_source, DTMF_SOURCE);
  assert.deepEqual(accepted.callLeg, callLeg());
  assert.equal(accepted.claims.call_leg_sha256, hashCanonical(callLeg()));
  assert.equal(chain.replayStore.records.length, 1);
  assert.throws(
    () => chain.evidenceVerifier.consume(chain.evidenceToken, { armToken: chain.armToken }),
    error => error.code === 'PBX_PROTOCOL_REPLAYED',
  );
});

test('arm verification rejects prompt, scope, schema, signature, and key confusion', () => {
  const built = fixture();
  const token = built.armIssuer.issue(armInput());
  const wrongPrompt = resign(token, built.controllerKeys.privateKey, claims => {
    claims.prompt = 'A different spoken scope.';
  });
  assert.throws(() => built.armVerifier.verify(wrongPrompt), error => error.code === 'PBX_PROTOCOL_BINDING');

  const extraClaim = resign(token, built.controllerKeys.privateKey, claims => { claims.extra = true; });
  assert.throws(() => built.armVerifier.verify(extraClaim), error => error.code === 'PBX_PROTOCOL_MALFORMED');

  const changed = token.split('.');
  const signature = Buffer.from(changed[3], 'base64url');
  signature[0] ^= 1;
  changed[3] = signature.toString('base64url');
  assert.throws(() => built.armVerifier.verify(changed.join('.')), error => error.code === 'PBX_PROTOCOL_BAD_SIGNATURE');

  const wrongExpected = { ...armInput(), target: 'hera:session:phone' };
  assert.throws(() => built.armVerifier.verify(token, wrongExpected), error => error.code === 'PBX_PROTOCOL_BINDING');
  assert.throws(
    () => createPbxArmVerifier({
      publicKeys: { 'controller-arm-2026-08': built.attesterKeys.publicKey },
      now: () => BASE_TIME,
    }).verify(token),
    error => error.code === 'PBX_PROTOCOL_BAD_SIGNATURE',
  );
});

test('PBX observation requires the armed prompt, exact handset leg, completed playback, and later pound', () => {
  const built = fixture();
  const arm = built.armVerifier.verify(built.armIssuer.issue(armInput()));
  const valid = observation(arm.claims.prompt_sha256);
  assert.equal(validatePbxObservation(valid, arm.claims, { now: () => BASE_TIME + 4000 }).digit, '#');

  const cases = [
    [{ ...valid, pbx_call_handle: Buffer.alloc(32, 0x55).toString('base64url') }, 'PBX_PROTOCOL_BINDING'],
    [{ ...valid, prompt_sha256: HASH_A }, 'PBX_PROTOCOL_BINDING'],
    [{ ...valid, digit: '*' }, 'PBX_PROTOCOL_METHOD'],
    [{ ...valid, dtmf_source: 'asterisk-trunk-dtmf-v1' }, 'PBX_PROTOCOL_METHOD'],
    [{ ...valid, playback_completed_at_ms: valid.playback_started_at_ms },
      'PBX_PROTOCOL_SEQUENCE'],
    [{ ...valid, dtmf_received_at_ms: valid.playback_completed_at_ms }, 'PBX_PROTOCOL_SEQUENCE'],
    [{ ...valid, playback_started_at_ms: BASE_TIME - 1 }, 'PBX_PROTOCOL_SEQUENCE'],
    [{ ...valid, dtmf_received_at_ms: BASE_TIME + 5000 }, 'PBX_PROTOCOL_SEQUENCE'],
    [{ ...valid, call_leg: callLeg({ handset_uniqueid: 'PJSIP-trunk-00000002' }) },
      'PBX_PROTOCOL_INVALID_ARGUMENT'],
  ];
  for (const [candidate, code] of cases) {
    assert.throws(
      () => validatePbxObservation(candidate, arm.claims, { now: () => BASE_TIME + 4000 }),
      error => error.code === code,
    );
  }
});

test('signed PBX evidence rejects semantic tampering and a different arm or call leg', () => {
  const chain = issuedChain();
  for (const [mutation, code] of [
    [claims => { claims.call_leg.handset_endpoint = 'PJSIP/attacker'; }, 'PBX_PROTOCOL_BINDING'],
    [claims => { claims.digit = '*'; }, 'PBX_PROTOCOL_METHOD'],
    [claims => { claims.dtmf_received_at_ms = claims.playback_completed_at_ms; }, 'PBX_PROTOCOL_SEQUENCE'],
    [claims => { claims.method = 'voice-model-said-approved'; }, 'PBX_PROTOCOL_WRONG_PURPOSE'],
  ]) {
    const changed = resign(chain.evidenceToken, chain.attesterKeys.privateKey, mutation);
    assert.throws(
      () => chain.evidenceVerifier.verify(changed, { armToken: chain.armToken }),
      error => error.code === code,
    );
  }

  assert.throws(
    () => chain.evidenceVerifier.verify(chain.evidenceToken, {
      armToken: chain.armToken,
      callLeg: callLeg({ bridge_id: 'bridge-other' }),
    }),
    error => error.code === 'PBX_PROTOCOL_BINDING',
  );
  const otherArmToken = chain.armIssuer.issue(armInput({ approvalId: 'approval_fixture_2' }));
  assert.throws(
    () => chain.evidenceVerifier.verify(chain.evidenceToken, { armToken: otherArmToken }),
    error => error.code === 'PBX_PROTOCOL_BINDING',
  );
});

test('artifact lifetime and replay-store failures remain fail closed', () => {
  const expired = fixture({ now: () => BASE_TIME + 131000 });
  const expiredToken = expired.armIssuer.issue(armInput());
  assert.throws(() => expired.armVerifier.verify(expiredToken), error => error.code === 'PBX_PROTOCOL_EXPIRED');

  const future = fixture({ now: () => BASE_TIME - 11000 });
  const futureToken = future.armIssuer.issue(armInput());
  assert.throws(() => future.armVerifier.verify(futureToken), error => error.code === 'PBX_PROTOCOL_EXPIRED');

  const keys = keyPair();
  assert.throws(
    () => createPbxEvidenceVerifier({
      publicKeys: { attester: keys.publicKey },
      controllerArmPublicKeys: { controller: keyPair().publicKey },
    }),
    error => error.code === 'PBX_PROTOCOL_REPLAY_STORE_REQUIRED',
  );

  const chain = issuedChain({ replayStore: { consume: () => Promise.resolve(true) } });
  assert.throws(
    () => chain.evidenceVerifier.consume(chain.evidenceToken, { armToken: chain.armToken }),
    error => error.code === 'PBX_PROTOCOL_REPLAY_STORE_ERROR',
  );
});

test('PBX evidence issuance and consumption require the raw controller-signed arm', () => {
  const chain = issuedChain();
  assert.equal(chain.evidenceVerifier.verify(chain.evidenceToken, {
    armToken: chain.armToken,
  }).claims.arm_key_id, chain.arm.keyId);
  assert.equal(chain.evidenceVerifier.verify(chain.evidenceToken, {
    armToken: chain.armToken,
  }).claims.arm_key_fingerprint, chain.arm.keyFingerprint);

  assert.throws(
    () => chain.evidenceIssuer.issue({
      arm: chain.arm,
      observation: observation(chain.arm.claims.prompt_sha256),
    }),
    error => error.code === 'PBX_PROTOCOL_MALFORMED',
  );
  assert.throws(
    () => chain.evidenceVerifier.verify(chain.evidenceToken, { arm: chain.arm }),
    error => error.code === 'PBX_PROTOCOL_MALFORMED',
  );

  const wrongSignature = resign(chain.armToken, chain.attesterKeys.privateKey, () => {});
  assert.throws(
    () => chain.evidenceIssuer.issue({
      armToken: wrongSignature,
      observation: observation(chain.arm.claims.prompt_sha256),
    }),
    error => error.code === 'PBX_PROTOCOL_BAD_SIGNATURE',
  );
  assert.throws(
    () => chain.evidenceVerifier.verify(chain.evidenceToken, { armToken: wrongSignature }),
    error => error.code === 'PBX_PROTOCOL_BAD_SIGNATURE',
  );
});
