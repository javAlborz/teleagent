'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
      activeApprovalIndexSql: db.prepare(
        "SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND name = ?",
      ).get('pbx_approval_attestations_active_approval_idx').sql,
    };
  } finally {
    db.close();
  }
}

function attesterFixture({
  store = new MemoryPbxApprovalAttesterStore(), adapterOverride = null, nowOverride = null,
} = {}) {
  const controllerKeys = crypto.generateKeyPairSync('ed25519');
  const attesterKeys = crypto.generateKeyPairSync('ed25519');
  const now = nowOverride || (() => BASE_TIME + 4000);
  let armNonceByte = 0x32;
  const armIssuer = createPbxArmIssuer({
    privateKey: controllerKeys.privateKey,
    keyId: 'controller-arm-key',
    now: () => BASE_TIME,
    randomBytes: size => Buffer.alloc(size, armNonceByte++),
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
      name: 'missing active approval uniqueness',
      tableSql: canonical.tableSql,
      indexSql: canonical.indexSql,
      activeApprovalIndexSql: canonical.activeApprovalIndexSql.replace('UNIQUE INDEX', 'INDEX'),
    },
    {
      name: 'missing state transition check',
      tableSql: canonical.tableSql.replace(
        "state TEXT NOT NULL CHECK (state IN ('pending', 'observed', 'issued', 'superseded'))",
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
        db.exec(`${fixture.tableSql};\n${fixture.indexSql};\n` +
          `${fixture.activeApprovalIndexSql || canonical.activeApprovalIndexSql};`);
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

function storeClaim(number = 1, overrides = {}) {
  return {
    armSha256: crypto.createHash('sha256').update(`replacement-arm-${number}`).digest('hex'),
    armKeyId: 'controller-key', approvalId: 'approval-replacement',
    armNonce: callHandle(number), pbxCallHandle: callHandle(number + 32),
    expiresAt: 200, claimedAt: 100 + number * 10,
    ...overrides,
  };
}

function storeObservation(claim, suffix = 'one') {
  return {
    armSha256: claim.armSha256, playbackId: `playback-${suffix}`,
    dtmfEventId: `dtmf-${suffix}`, callLegSha256: 'a'.repeat(64), observedAt: claim.claimedAt + 1,
  };
}

function storeFinal(claim) {
  return { armSha256: claim.armSha256, evidenceSha256: 'b'.repeat(64), issuedAt: claim.claimedAt + 2 };
}

for (const kind of ['memory', 'SQLite']) {
  test(`${kind} supersession preserves tombstones and fences late old-call evidence`, () => {
    const db = kind === 'SQLite' ? new Database(':memory:') : null;
    try {
      const store = db ? createSqlitePbxApprovalAttesterStore(db) : new MemoryPbxApprovalAttesterStore();
      const first = storeClaim();
      const next = storeClaim(2);
      const last = storeClaim(3);
      assert.equal(store.claimArm(first), true);
      assert.equal(store.claimArm(next), false, 'ordinary claims cannot bypass a live approval');
      assert.equal(store.recordObservation(storeObservation(first)), true);
      assert.equal(store.supersedeArm({ previousArmSha256: first.armSha256, replacement: next }), true);
      assert.equal(store.recordObservation(storeObservation(first, 'late')), false);
      assert.equal(store.finalizeEvidence(storeFinal(first)), false);
      assert.equal(store.claimArm(first), false, 'old arm cannot be replayed');
      assert.equal(store.claimArm({ ...storeClaim(4), approvalId: 'other', armNonce: first.armNonce }), false);
      assert.equal(store.claimArm({ ...storeClaim(5), approvalId: 'other', pbxCallHandle: first.pbxCallHandle }), false);
      assert.equal(store.supersedeArm({ previousArmSha256: first.armSha256, replacement: last }), false);
      assert.equal(store.supersedeArm({ previousArmSha256: next.armSha256, replacement: last }), true);
      assert.equal(store.recordObservation(storeObservation(last)), false, 'old playback/DTMF stays spent');
      assert.equal(store.recordObservation(storeObservation(last, 'new')), true);
      assert.equal(store.finalizeEvidence(storeFinal(last)), true);
      assert.equal(store.supersedeArm({ previousArmSha256: last.armSha256, replacement: storeClaim(4) }), false);
      assert.equal(store.purgeExpired(199), 0, 'no unexpired tombstone can be collected');
      if (db) {
        const reopened = createSqlitePbxApprovalAttesterStore(db);
        assert.equal(reopened.claimArm(first), false);
        assert.equal(db.prepare('SELECT count(*) AS n FROM pbx_approval_attestations').get().n, 3);
      }
    } finally { db?.close(); }
  });

  test(`${kind} a rejected replacement leaves the original approval unchanged`, () => {
    const db = kind === 'SQLite' ? new Database(':memory:') : null;
    try {
      const store = db ? createSqlitePbxApprovalAttesterStore(db) : new MemoryPbxApprovalAttesterStore();
      const first = storeClaim();
      assert.equal(store.claimArm(first), true);
      for (const change of [
        { approvalId: 'unrelated' }, { armKeyId: 'unrelated-key' }, { armNonce: first.armNonce },
        { pbxCallHandle: first.pbxCallHandle }, { claimedAt: 100 },
        { expiresAt: 201 },
        { claimedAt: 200, expiresAt: 300 },
      ]) {
        assert.equal(store.supersedeArm({
          previousArmSha256: first.armSha256, replacement: storeClaim(2, change),
        }), false);
      }
      assert.equal(store.recordObservation(storeObservation(first)), true);
      assert.equal(store.supersedeArm({
        previousArmSha256: first.armSha256,
        replacement: storeClaim(2, { claimedAt: first.claimedAt }),
      }), false, 'replacement cannot predate an already recorded observation');
      assert.equal(store.finalizeEvidence(storeFinal(first)), true);
    } finally { db?.close(); }
  });
}

test('attester commits supersession before the replacement adapter and rejects a late old callback', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSqlitePbxApprovalAttesterStore(db);
    const requests = [];
    let releaseOld;
    const built = attesterFixture({ store, adapterOverride: {
      collectApproval(request) {
        requests.push(request);
        if (requests.length === 1) return new Promise(resolve => { releaseOld = resolve; });
        assert.equal(db.inTransaction, false);
        const rows = db.prepare('SELECT state FROM pbx_approval_attestations ORDER BY claimed_at, rowid').all();
        assert.deepEqual(rows.map(row => row.state), ['superseded', 'pending']);
        return approvalObservation(request.promptSha256, { pbx_call_handle: request.pbxCallHandle });
      },
    } });
    const oldToken = built.armIssuer.issue(armInput());
    const nextToken = built.armIssuer.issue(armInput({ pbxCallHandle: callHandle(0x61) }));
    const oldResult = built.attester.attest(oldToken);
    const late = assert.rejects(oldResult, error => error.code === 'PBX_ATTESTER_OBSERVATION_REPLAYED');
    const result = await built.attester.attest(nextToken, oldToken);
    assert.match(result.evidenceToken, /^teleattest1\./u);
    releaseOld(approvalObservation(requests[0].promptSha256));
    await late;
    await assert.rejects(built.attester.attest(nextToken, oldToken),
      error => error.code === 'PBX_ATTESTER_SUPERSESSION_REFUSED');
    assert.equal(requests.length, 2);
  } finally { db.close(); }
});

test('replacement checks every signed request binding before any store or PBX action', async (t) => {
  const changes = [
    { approvalId: 'other' }, { jobId: 'other' }, { operation: 'other' },
    { requestHash: 'a'.repeat(64) }, { planHash: 'b'.repeat(64) },
    { target: 'other' }, { provider: 'other' }, { profile: 'other' },
    { prompt: 'A different command. Press pound to approve.' },
    { pbxCallHandle: callHandle() },
  ];
  for (const change of changes) {
    await t.test(Object.keys(change)[0], async () => {
      const built = attesterFixture();
      const previous = built.armIssuer.issue(armInput());
      const next = built.armIssuer.issue(armInput({ pbxCallHandle: callHandle(0x71), ...change }));
      await assert.rejects(built.attester.attest(next, previous),
        error => error.code === 'PBX_ATTESTER_SUPERSESSION_BINDING');
      assert.equal(built.store.records.size, 0);
      assert.equal(built.adapterRequests.length, 0);
    });
  }
});

test('supersession verifies the raw old signature and never replaces an unclaimed or issued arm', async () => {
  const built = attesterFixture();
  const previous = built.armIssuer.issue(armInput());
  const next = built.armIssuer.issue(armInput({ pbxCallHandle: callHandle(0x71) }));
  const pieces = previous.split('.');
  pieces[3] = `${pieces[3][0] === 'A' ? 'B' : 'A'}${pieces[3].slice(1)}`;
  await assert.rejects(built.attester.attest(next, pieces.join('.')),
    error => error.code === 'PBX_PROTOCOL_BAD_SIGNATURE');
  await assert.rejects(built.attester.attest(next, previous),
    error => error.code === 'PBX_ATTESTER_SUPERSESSION_REFUSED');
  assert.equal(built.adapterRequests.length, 0);
  await built.attester.attest(previous);
  await assert.rejects(built.attester.attest(next, previous),
    error => error.code === 'PBX_ATTESTER_SUPERSESSION_REFUSED');
  assert.equal(built.adapterRequests.length, 1);
});

test('SQLite stores refuse writes inside an outer transaction before reporting durability', () => {
  const db = new Database(':memory:');
  try {
    const store = createSqlitePbxApprovalAttesterStore(db);
    db.exec('BEGIN');
    for (const operation of [
      () => store.claimArm(storeClaim()),
      () => store.supersedeArm({ previousArmSha256: storeClaim().armSha256, replacement: storeClaim(2) }),
      () => store.recordObservation(storeObservation(storeClaim())),
      () => store.finalizeEvidence(storeFinal(storeClaim())),
      () => store.purgeExpired(300),
    ]) assert.throws(operation, error => error.code === 'PBX_ATTESTER_STORE_TRANSACTION_UNSAFE');
    db.exec('ROLLBACK');
    assert.equal(store.claimArm(storeClaim()), true);
  } finally { db.close(); }
});

test('SQLite replacement rolls back failed publication and poisons a failed rollback connection', async (t) => {
  for (const boundary of ['begin', 'claim', 'commit-before', 'commit-after', 'rollback']) {
    await t.test(boundary, () => {
      const db = new Database(':memory:');
      try {
        const initial = createSqlitePbxApprovalAttesterStore(db);
        assert.equal(initial.claimArm(storeClaim()), true);
        const wrapped = {
          get inTransaction() { return db.inTransaction; },
          exec(sql) {
            if ((boundary === 'begin' && sql === 'BEGIN IMMEDIATE') ||
                (boundary === 'commit-before' && sql === 'COMMIT') ||
                (boundary === 'rollback' && sql === 'ROLLBACK')) throw new Error('injected failure');
            const result = db.exec(sql);
            if (boundary === 'commit-after' && sql === 'COMMIT') throw new Error('lost commit receipt');
            return result;
          },
          prepare(sql) {
            const statement = db.prepare(sql);
            if (!/INSERT OR IGNORE INTO main\./u.test(sql)) return statement;
            return {
              run(...args) {
                if (['claim', 'rollback'].includes(boundary)) throw new Error('injected failure');
                return statement.run(...args);
              },
            };
          },
        };
        const store = createSqlitePbxApprovalAttesterStore(wrapped);
        assert.throws(() => store.supersedeArm({
          previousArmSha256: storeClaim().armSha256, replacement: storeClaim(2),
        }));
        if (boundary === 'rollback') {
          assert.equal(db.inTransaction, true);
          db.exec('ROLLBACK');
          assert.throws(() => store.claimArm(storeClaim(3)),
            error => error.code === 'PBX_ATTESTER_STORE_TRANSACTION_UNSAFE');
        } else assert.equal(db.inTransaction, false);
        const states = db.prepare('SELECT state FROM pbx_approval_attestations ORDER BY claimed_at').all();
        assert.deepEqual(states.map(row => row.state), boundary === 'commit-after'
          ? ['superseded', 'pending'] : ['pending']);
      } finally { db.close(); }
    });
  }
});

test('replacement refuses changed key epochs, reused nonce, or an extended approval deadline', async (t) => {
  for (const field of ['keyId', 'keyFingerprint', 'nonce', 'exp', 'iat', 'nbf']) {
    await t.test(field, async () => {
      const built = attesterFixture();
      const previousToken = built.armIssuer.issue(armInput());
      const nextToken = built.armIssuer.issue(armInput({ pbxCallHandle: callHandle(0x71) }));
      const previous = built.armVerifier.verify(previousToken);
      const next = JSON.parse(JSON.stringify(built.armVerifier.verify(nextToken)));
      if (field === 'keyId') next.keyId = 'different-controller-key';
      else if (field === 'keyFingerprint') next.keyFingerprint = 'f'.repeat(64);
      else if (field === 'nonce') next.claims.nonce = previous.claims.nonce;
      else if (field === 'exp') next.claims.exp = previous.claims.exp + 1;
      else next.claims[field] = previous.claims[field] - 1;
      let effects = 0;
      const attester = createPbxApprovalAttester({
        armVerifier: { verify: token => token === previousToken ? previous : next },
        evidenceIssuer: { issue() { effects++; throw new Error('unexpected issuance'); } },
        adapter: { collectApproval() { effects++; throw new Error('unexpected collection'); } },
        store: new MemoryPbxApprovalAttesterStore(), now: () => BASE_TIME + 4000,
      });
      await assert.rejects(attester.attest(nextToken, previousToken),
        error => error.code === 'PBX_ATTESTER_SUPERSESSION_BINDING');
      assert.equal(effects, 0);
    });
  }
});

test('a failed or asynchronous supersession cannot reach the replacement adapter', async () => {
  for (const failure of [() => { throw new Error('disk error'); }, () => Promise.resolve(true)]) {
    const store = new MemoryPbxApprovalAttesterStore();
    store.supersedeArm = failure;
    const built = attesterFixture({ store });
    const previous = built.armIssuer.issue(armInput());
    const next = built.armIssuer.issue(armInput({ pbxCallHandle: callHandle(0x71) }));
    await assert.rejects(built.attester.attest(next, previous),
      error => error.code === 'PBX_ATTESTER_STORE_ERROR');
    assert.equal(built.adapterRequests.length, 0);
  }
});

test('durable claim or replacement delay cannot start a call outside its approval window', async (t) => {
  for (const operation of ['claimArm', 'supersedeArm']) {
    for (const afterCommitMs of [BASE_TIME - 1, BASE_TIME + 120000]) {
      await t.test(`${operation}-${afterCommitMs < BASE_TIME ? 'early' : 'expired'}`, async () => {
        let clock = BASE_TIME + 4000;
        const store = new MemoryPbxApprovalAttesterStore();
        let delayCommit = false;
        const commit = store[operation].bind(store);
        store[operation] = record => {
          const result = commit(record);
          if (delayCommit) clock = afterCommitMs;
          return result;
        };
        const built = attesterFixture({ store, nowOverride: () => clock });
        const previousToken = built.armIssuer.issue(armInput());
        const nextToken = built.armIssuer.issue(armInput({ pbxCallHandle: callHandle(0x71) }));
        if (operation === 'supersedeArm') {
          const previous = built.armVerifier.verify(previousToken);
          assert.equal(store.claimArm({
            armSha256: previous.armSha256, armKeyId: previous.keyId,
            approvalId: previous.claims.approval_id, armNonce: previous.claims.nonce,
            pbxCallHandle: previous.claims.pbx_call_handle,
            expiresAt: previous.claims.exp, claimedAt: Math.floor(clock / 1000),
          }), true);
        }
        delayCommit = true;
        await assert.rejects(built.attester.attest(
          operation === 'supersedeArm' ? nextToken : previousToken,
          operation === 'supersedeArm' ? previousToken : null,
        ), error => error.code === 'PBX_ATTESTER_ARM_WINDOW');
        assert.equal(built.adapterRequests.length, 0);
        assert.equal(store.records.size, operation === 'supersedeArm' ? 2 : 1);
      });
    }
  }
});

test('SQLite rejects the old schema and a partial index that releases issued approvals', () => {
  const canonical = canonicalSqliteStoreSchema();
  const oldTableSql = canonical.tableSql
    .replace('approval_id TEXT NOT NULL,', 'approval_id TEXT NOT NULL UNIQUE,')
    .replace("'issued', 'superseded'", "'issued'")
    .replace(',\n      superseded_by_arm_sha256 TEXT,\n      superseded_at INTEGER', '');
  assert.notEqual(oldTableSql, canonical.tableSql);
  for (const [tableSql, indexSql] of [
    [oldTableSql, null],
    [canonical.tableSql, null],
    [canonical.tableSql, canonical.activeApprovalIndexSql.replace(
      "state <> 'superseded'", "state = 'pending'",
    )],
  ]) {
    const db = new Database(':memory:');
    try {
      db.exec(`${tableSql}; ${canonical.indexSql}; ${indexSql ? `${indexSql};` : ''}`);
      assert.throws(() => createSqlitePbxApprovalAttesterStore(db),
        error => error.code === 'PBX_ATTESTER_STORE_SCHEMA_INVALID');
    } finally { db.close(); }
  }
});

test('SQLite replacement is crash-atomic at both mutations and the committed boundary', async (t) => {
  for (const boundary of ['supersede', 'claim', 'commit']) {
    await t.test(boundary, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-pbx-replace-'));
      const filename = path.join(directory, 'fixture.sqlite');
      try {
        const db = new Database(filename);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        const store = createSqlitePbxApprovalAttesterStore(db);
        assert.equal(store.claimArm(storeClaim()), true);
        db.close();
        const child = spawnSync(process.execPath, [
          path.join(__dirname, 'fixtures/pbx-supersession-crash-child.js'),
          filename, boundary, JSON.stringify(storeClaim()), JSON.stringify(storeClaim(2)),
        ], { encoding: 'utf8', timeout: 5000 });
        assert.equal(child.error, undefined, 'a watchdog timeout is not an injected kill');
        assert.equal(child.signal, 'SIGKILL');
        assert.equal(child.status, null);
        assert.equal(child.stdout, `PBX_TEST_BOUNDARY:${boundary}\n`, 'the exact injected boundary must be reached');
        const recovered = new Database(filename);
        try {
          const reopened = createSqlitePbxApprovalAttesterStore(recovered);
          const rows = recovered.prepare('SELECT arm_sha256, state FROM pbx_approval_attestations ORDER BY claimed_at').all();
          assert.deepEqual(rows, boundary === 'commit' ? [
            { arm_sha256: storeClaim().armSha256, state: 'superseded' },
            { arm_sha256: storeClaim(2).armSha256, state: 'pending' },
          ] : [{ arm_sha256: storeClaim().armSha256, state: 'pending' }]);
          assert.equal(reopened.claimArm(storeClaim()), false);
          assert.equal(reopened.claimArm(storeClaim(2)), false);
          assert.equal(reopened.supersedeArm({
            previousArmSha256: storeClaim().armSha256, replacement: storeClaim(2),
          }), boundary !== 'commit');
          assert.equal(recovered.pragma('integrity_check', { simple: true }), 'ok');
        } finally { recovered.close(); }
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
