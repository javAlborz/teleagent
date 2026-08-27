'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  createPbxApprovalAttester,
} = require('../../lib/pbx-approval-attester');
const {
  MemoryPbxApprovalAttesterStore,
  createSqlitePbxApprovalAttesterStore,
} = require('../../lib/pbx-approval-attester-store');
const {
  DTMF_SOURCE,
  createPbxArmIssuer,
  createPbxArmVerifier,
  createPbxEvidenceIssuer,
  createPbxEvidenceVerifier,
  hashText,
} = require('../../lib/pbx-approval-protocol');

const BASE_TIME = Date.parse('2026-08-26T13:00:00.000Z');
const REQUEST_HASH = crypto.createHash('sha256').update('request').digest('hex');
const PLAN_HASH = crypto.createHash('sha256').update('plan').digest('hex');
const AUDIO_HASH = crypto.createHash('sha256').update('audio').digest('hex');

function callHandle(byte = 0x31) {
  return Buffer.alloc(32, byte).toString('base64url');
}

function callLeg() {
  return {
    pbx_instance_id: 'asterisk-fixture-1',
    linkedid: '1710001000.1',
    handset_uniqueid: 'PJSIP-owner-00000001',
    handset_endpoint: 'PJSIP/owner',
    channel_birth_ms: BASE_TIME + 100,
    trunk_uniqueid: 'PJSIP-trunk-00000002',
    bridge_id: 'bridge-fixture-1',
    dialed_route: '+15551234567',
  };
}

function armInput(overrides = {}) {
  return {
    approvalId: 'approval_attester_1',
    jobId: 'job_attester_1',
    operation: 'privileged-action',
    requestHash: REQUEST_HASH,
    planHash: PLAN_HASH,
    target: 'hermes:root:exact-argv',
    provider: 'codex',
    profile: 'codex-sol',
    prompt: 'HIGH RISK. Run the exact reviewed command on Hermes. Press pound to approve.',
    pbxCallHandle: callHandle(),
    ...overrides,
  };
}

function approvalObservation(promptSha256, overrides = {}) {
  return {
    pbx_call_handle: callHandle(),
    call_leg: callLeg(),
    prompt_sha256: promptSha256,
    prompt_audio_sha256: AUDIO_HASH,
    playback_id: 'playback-attester-1',
    playback_started_at_ms: BASE_TIME + 1000,
    playback_completed_at_ms: BASE_TIME + 2000,
    digit: '#',
    dtmf_source: DTMF_SOURCE,
    dtmf_event_id: 'dtmf-attester-1',
    dtmf_received_at_ms: BASE_TIME + 3000,
    ...overrides,
  };
}

function evidenceReplayStore() {
  const values = new Set();
  return {
    consume(record) {
      const key = `${record.keyId}\u0000${record.nonce}`;
      if (values.has(key)) return false;
      values.add(key);
      return true;
    },
  };
}

function canonicalSqliteStoreSchema() {
  const db = new Database(':memory:');
  try {
    createSqlitePbxApprovalAttesterStore(db);
    return {
      tableSql: db.prepare(
        "SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?",
      ).get('pbx_approval_attestations').sql,
      indexSql: db.prepare(
        "SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND name = ?",
      ).get('pbx_approval_attestations_expires_idx').sql,
    };
  } finally {
    db.close();
  }
}

function attesterFixture({ store = new MemoryPbxApprovalAttesterStore(), adapterOverride = null } = {}) {
  const controllerKeys = crypto.generateKeyPairSync('ed25519');
  const attesterKeys = crypto.generateKeyPairSync('ed25519');
  const now = () => BASE_TIME + 4000;
  const armIssuer = createPbxArmIssuer({
    privateKey: controllerKeys.privateKey,
    keyId: 'controller-arm-key',
    now: () => BASE_TIME,
    randomBytes: size => Buffer.alloc(size, 0x32),
  });
  const armVerifier = createPbxArmVerifier({
    publicKeys: { 'controller-arm-key': controllerKeys.publicKey },
    now,
  });
  const evidenceIssuer = createPbxEvidenceIssuer({
    privateKey: attesterKeys.privateKey,
    keyId: 'pbx-attester-key',
    controllerArmPublicKeys: { 'controller-arm-key': controllerKeys.publicKey },
    now,
    randomBytes: size => Buffer.alloc(size, 0x33),
  });
  const adapterRequests = [];
  const adapter = adapterOverride || {
    async collectApproval(request) {
      adapterRequests.push(request);
      return approvalObservation(request.promptSha256);
    },
  };
  const attester = createPbxApprovalAttester({
    armVerifier, evidenceIssuer, adapter, store, now,
  });
  const evidenceVerifier = createPbxEvidenceVerifier({
    publicKeys: { 'pbx-attester-key': attesterKeys.publicKey },
    controllerArmPublicKeys: { 'controller-arm-key': controllerKeys.publicKey },
    replayStore: evidenceReplayStore(),
    now,
  });
  return {
    armIssuer, armVerifier, evidenceVerifier, attester, adapterRequests, store,
  };
}

test('dormant attester claims the arm before PBX work and durably finalizes exact evidence', async () => {
  const built = attesterFixture();
  const armToken = built.armIssuer.issue(armInput());
  const result = await built.attester.attest(armToken);
  assert.match(result.evidenceToken, /^teleattest1\./u);
  assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/u);
  assert.equal(built.adapterRequests.length, 1);
  assert.deepEqual(Object.keys(built.adapterRequests[0]).sort(), [
    'approvalId', 'armSha256', 'expiresAtMs', 'notBeforeMs',
    'pbxCallHandle', 'prompt', 'promptSha256',
  ].sort());
  assert.equal(built.adapterRequests[0].promptSha256, hashText(armInput().prompt));

  const arm = built.armVerifier.verify(armToken);
  const evidence = built.evidenceVerifier.consume(result.evidenceToken, {
    armToken,
    callLeg: callLeg(),
  });
  assert.equal(evidence.claims.approval_id, armInput().approvalId);
  assert.equal(evidence.claims.prompt_audio_sha256, AUDIO_HASH);

  const stored = built.store.records.get(arm.armSha256);
  assert.equal(stored.status, 'issued');
  assert.equal(stored.evidenceSha256, result.evidenceSha256);
  assert.equal(Object.hasOwn(stored, 'prompt'), false);
  assert.equal(Object.hasOwn(stored, 'armToken'), false);
  assert.equal(Object.hasOwn(stored, 'evidenceToken'), false);
});

test('arm replay loses before a second adapter collection, including concurrent attempts', async () => {
  let release;
  let calls = 0;
  const adapter = {
    collectApproval(request) {
      calls += 1;
      return new Promise(resolve => {
        release = () => resolve(approvalObservation(request.promptSha256));
      });
    },
  };
  const built = attesterFixture({ adapterOverride: adapter });
  const token = built.armIssuer.issue(armInput());
  const first = built.attester.attest(token);
  await assert.rejects(
    built.attester.attest(token),
    error => error.code === 'PBX_ATTESTER_ARM_REPLAYED',
  );
  assert.equal(calls, 1);
  release();
  await first;
  await assert.rejects(
    built.attester.attest(token),
    error => error.code === 'PBX_ATTESTER_ARM_REPLAYED',
  );
  assert.equal(calls, 1);
});

test('invalid PBX evidence consumes the arm fail closed and never finalizes a token', async () => {
  const adapter = {
    collectApproval(request) {
      return approvalObservation(request.promptSha256, { digit: '*' });
    },
  };
  const built = attesterFixture({ adapterOverride: adapter });
  const token = built.armIssuer.issue(armInput());
  await assert.rejects(
    built.attester.attest(token),
    error => error.code === 'PBX_PROTOCOL_METHOD',
  );
  const arm = built.armVerifier.verify(token);
  assert.equal(built.store.records.get(arm.armSha256).status, 'pending');
  await assert.rejects(
    built.attester.attest(token),
    error => error.code === 'PBX_ATTESTER_ARM_REPLAYED',
  );
});

test('async or unavailable durability operations fail closed', async () => {
  const asyncStore = {
    claimArm: () => Promise.resolve(true),
    recordObservation: () => true,
    finalizeEvidence: () => true,
  };
  const built = attesterFixture({ store: asyncStore });
  await assert.rejects(
    built.attester.attest(built.armIssuer.issue(armInput())),
    error => error.code === 'PBX_ATTESTER_STORE_ERROR',
  );

  assert.throws(
    () => createPbxApprovalAttester({}),
    error => error.code === 'PBX_ATTESTER_INVALID_CONFIGURATION',
  );
});

test('SQLite store enforces unique arms, calls, playback, DTMF, and evidence transitions', () => {
  const db = new Database(':memory:');
  const store = createSqlitePbxApprovalAttesterStore(db);
  const first = {
    armSha256: crypto.createHash('sha256').update('arm-1').digest('hex'),
    armKeyId: 'controller-key',
    approvalId: 'approval-store-1',
    armNonce: callHandle(0x41),
    pbxCallHandle: callHandle(0x42),
    expiresAt: 200,
    claimedAt: 100,
  };
  const second = {
    ...first,
    armSha256: crypto.createHash('sha256').update('arm-2').digest('hex'),
    approvalId: 'approval-store-2',
    armNonce: callHandle(0x43),
    pbxCallHandle: callHandle(0x44),
  };
  assert.equal(store.claimArm(first), true);
  assert.equal(store.claimArm(first), false);
  assert.equal(store.claimArm(second), true);

  const observed = {
    armSha256: first.armSha256,
    playbackId: 'playback-store-1',
    dtmfEventId: 'dtmf-store-1',
    callLegSha256: crypto.createHash('sha256').update('leg').digest('hex'),
    observedAt: 110,
  };
  assert.equal(store.recordObservation(observed), true);
  assert.equal(store.recordObservation(observed), false);
  assert.equal(store.recordObservation({ ...observed, armSha256: second.armSha256 }), false);

  const final = {
    armSha256: first.armSha256,
    evidenceSha256: crypto.createHash('sha256').update('evidence').digest('hex'),
    issuedAt: 111,
  };
  assert.equal(store.finalizeEvidence(final), true);
  assert.equal(store.finalizeEvidence(final), false);
  assert.equal(db.prepare('SELECT state FROM pbx_approval_attestations WHERE arm_sha256 = ?')
    .get(first.armSha256).state, 'issued');
  assert.equal(store.purgeExpired(199), 0);
  assert.equal(store.purgeExpired(200), 2);
  assert.throws(
    () => createSqlitePbxApprovalAttesterStore(db, { tableName: 'unsafe;drop' }),
    error => error.code === 'PBX_ATTESTER_STORE_INVALID_ARGUMENT',
  );
  db.close();
});

test('SQLite store revalidates its exact schema and cannot be shadowed by a temporary table', () => {
  const db = new Database(':memory:');
  createSqlitePbxApprovalAttesterStore(db);
  db.exec('CREATE TEMP TABLE pbx_approval_attestations (arm_sha256 TEXT)');
  const reopened = createSqlitePbxApprovalAttesterStore(db);
  const record = {
    armSha256: crypto.createHash('sha256').update('shadow-proof-arm').digest('hex'),
    armKeyId: 'controller-key',
    approvalId: 'approval-shadow-proof',
    armNonce: callHandle(0x51),
    pbxCallHandle: callHandle(0x52),
    expiresAt: 200,
    claimedAt: 100,
  };
  assert.equal(reopened.claimArm(record), true);
  assert.equal(db.prepare(
    'SELECT count(*) AS count FROM main.pbx_approval_attestations',
  ).get().count, 1);
  assert.equal(db.prepare(
    'SELECT count(*) AS count FROM temp.pbx_approval_attestations',
  ).get().count, 0);
  db.close();
});

test('SQLite store rejects weaker same-name replay schemas instead of silently adopting them', async (t) => {
  const canonical = canonicalSqliteStoreSchema();
  const fixtures = [
    {
      name: 'missing arm primary key',
      tableSql: canonical.tableSql.replace('arm_sha256 TEXT PRIMARY KEY', 'arm_sha256 TEXT'),
      indexSql: canonical.indexSql,
    },
    {
      name: 'missing approval unique constraint',
      tableSql: canonical.tableSql.replace(
        'approval_id TEXT NOT NULL UNIQUE',
        'approval_id TEXT NOT NULL',
      ),
      indexSql: canonical.indexSql,
    },
    {
      name: 'missing state transition check',
      tableSql: canonical.tableSql.replace(
        "state TEXT NOT NULL CHECK (state IN ('pending', 'observed', 'issued'))",
        'state TEXT NOT NULL',
      ),
      indexSql: canonical.indexSql,
    },
    {
      name: 'same-name expiry index on the wrong column',
      tableSql: canonical.tableSql,
      indexSql: canonical.indexSql.replace('(expires_at)', '(claimed_at)'),
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const db = new Database(':memory:');
      try {
        db.exec(`${fixture.tableSql};\n${fixture.indexSql};`);
        assert.throws(
          () => createSqlitePbxApprovalAttesterStore(db),
          error => error.code === 'PBX_ATTESTER_STORE_SCHEMA_INVALID',
        );
      } finally {
        db.close();
      }
    });
  }
});

test('SQLite store rejects main or temporary triggers that can rewrite replay state', async (t) => {
  for (const temporary of [false, true]) {
    await t.test(temporary ? 'temporary trigger' : 'main trigger', () => {
      const db = new Database(':memory:');
      try {
        createSqlitePbxApprovalAttesterStore(db);
        db.exec(`
          CREATE ${temporary ? 'TEMP ' : ''}TRIGGER pbx_replay_delete
          AFTER INSERT ON ${temporary ? 'main.' : ''}pbx_approval_attestations
          BEGIN
            DELETE FROM pbx_approval_attestations WHERE arm_sha256 = NEW.arm_sha256;
          END;
        `);
        assert.throws(
          () => createSqlitePbxApprovalAttesterStore(db),
          error => error.code === 'PBX_ATTESTER_STORE_SCHEMA_INVALID',
        );
      } finally {
        db.close();
      }
    });
  }
});
