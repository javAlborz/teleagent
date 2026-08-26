'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  MemoryCapabilityReplayStore,
  createApprovalCapabilityIssuer,
  createApprovalCapabilityVerifier,
  createSqliteCapabilityReplayStore,
  generateApprovalCapabilityKeyPair,
  hashApprovalPlan,
} = require('../../lib/voice-approval-capability');

const BASE_TIME = Date.parse('2026-08-25T16:00:00.000Z');
const REQUEST_HASH = crypto.createHash('sha256').update('Restart the preview service.').digest('hex');
const PLAN = Object.freeze({
  command: ['systemctl', 'restart', 'teleagent-preview.service'],
  host: 'hermes',
});
const PLAN_HASH = hashApprovalPlan(PLAN);

function bindings(overrides = {}) {
  return {
    jobId: 'job_capability_test_1',
    requestHash: REQUEST_HASH,
    planHash: PLAN_HASH,
    target: 'hermes',
    provider: 'codex',
    profile: 'codex-sol',
    ...overrides,
  };
}

function fixture({
  issuerNow = () => BASE_TIME,
  verifierNow = () => BASE_TIME,
  replayStore = new MemoryCapabilityReplayStore(),
  keyId = 'approval-2026-08',
  keys = generateApprovalCapabilityKeyPair(),
  publicKeys,
  issuerOptions = {},
  verifierOptions = {},
} = {}) {
  const issuer = createApprovalCapabilityIssuer({
    privateKey: keys.privateKey,
    keyId,
    now: issuerNow,
    ...issuerOptions,
  });
  const verifier = createApprovalCapabilityVerifier({
    publicKeys: publicKeys || { [keyId]: keys.publicKey },
    replayStore,
    now: verifierNow,
    ...verifierOptions,
  });
  return { issuer, verifier, keys, replayStore };
}

function mutateTokenClaims(token, mutation) {
  const segments = token.split('.');
  const claims = JSON.parse(Buffer.from(segments[2], 'base64url').toString('utf8'));
  mutation(claims);
  segments[2] = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return segments.join('.');
}

function flipTokenSignature(token) {
  const segments = token.split('.');
  const signature = Buffer.from(segments[3], 'base64url');
  signature[0] ^= 0x01;
  segments[3] = signature.toString('base64url');
  return segments.join('.');
}

test('issued capabilities bind the exact operation and are consumable only once', async () => {
  const { issuer, verifier } = fixture();
  const token = issuer.issue({ ...bindings(), ttlSeconds: 90 });

  const verified = verifier.verify(token);
  assert.deepEqual(
    {
      jobId: verified.job_id,
      requestHash: verified.request_sha256,
      planHash: verified.plan_sha256,
      target: verified.target,
      provider: verified.provider,
      profile: verified.profile,
      keyId: verified.key_id,
      lifetime: verified.exp - verified.iat,
    },
    {
      ...bindings(),
      keyId: 'approval-2026-08',
      lifetime: 90,
    }
  );
  assert.match(verified.nonce, /^[A-Za-z0-9_-]{32}$/);

  const consumed = await verifier.consume(token, bindings());
  assert.equal(consumed.job_id, bindings().jobId);
  await assert.rejects(
    verifier.consume(token, bindings()),
    error => error.code === 'CAPABILITY_REPLAYED'
  );
});

test('claim and signature tampering fail without disclosing token or bound scope', () => {
  const { issuer, verifier } = fixture();
  const token = issuer.issue(bindings());
  const changedTarget = mutateTokenClaims(token, claims => { claims.target = 'hera'; });

  for (const tampered of [changedTarget, flipTokenSignature(token)]) {
    assert.throws(
      () => verifier.verify(tampered),
      error => {
        assert.equal(error.code, 'CAPABILITY_BAD_SIGNATURE');
        const serialized = JSON.stringify(error);
        assert.equal(serialized.includes(token), false);
        assert.equal(serialized.includes(bindings().jobId), false);
        assert.equal(serialized.includes(bindings().target), false);
        return true;
      }
    );
  }
});

test('every execution binding is checked before the nonce is consumed', async () => {
  const mismatchCases = {
    jobId: 'job_capability_test_2',
    requestHash: crypto.createHash('sha256').update('different request').digest('hex'),
    planHash: hashApprovalPlan({ ...PLAN, host: 'hera' }),
    target: 'hera',
    provider: 'claude',
    profile: 'claude-opus',
  };

  for (const [field, changedValue] of Object.entries(mismatchCases)) {
    const { issuer, verifier } = fixture();
    const token = issuer.issue(bindings());
    await assert.rejects(
      verifier.consume(token, bindings({ [field]: changedValue })),
      error => error.code === 'CAPABILITY_BINDING_MISMATCH'
    );
    const accepted = await verifier.consume(token, bindings());
    assert.equal(accepted.job_id, bindings().jobId);
  }
});

test('expiry, future issuance, purpose, lifetime, and key rotation are enforced', () => {
  let verifierTime = BASE_TIME;
  const first = fixture({ verifierNow: () => verifierTime });
  const expiring = first.issuer.issue({ ...bindings(), ttlSeconds: 30 });
  verifierTime = BASE_TIME + 29000;
  assert.equal(first.verifier.verify(expiring).job_id, bindings().jobId);
  verifierTime = BASE_TIME + 30000;
  assert.throws(() => first.verifier.verify(expiring), error => error.code === 'CAPABILITY_EXPIRED');

  const future = fixture({
    issuerNow: () => BASE_TIME + 16000,
    verifierNow: () => BASE_TIME,
  });
  const futureToken = future.issuer.issue(bindings());
  assert.throws(() => future.verifier.verify(futureToken), error => error.code === 'CAPABILITY_NOT_YET_VALID');

  const differentPurpose = createApprovalCapabilityVerifier({
    publicKeys: { 'approval-2026-08': first.keys.publicKey },
    replayStore: new MemoryCapabilityReplayStore(),
    purpose: 'teleagent.tmux-delivery.v1',
    now: () => BASE_TIME,
  });
  const ordinaryToken = first.issuer.issue(bindings());
  assert.throws(
    () => differentPurpose.verify(ordinaryToken),
    error => error.code === 'CAPABILITY_WRONG_PURPOSE'
  );

  const longLived = fixture({
    issuerOptions: { defaultTtlSeconds: 600, maxTtlSeconds: 600 },
    verifierOptions: { maxTtlSeconds: 300 },
  });
  assert.throws(
    () => longLived.verifier.verify(longLived.issuer.issue(bindings())),
    error => error.code === 'CAPABILITY_INVALID_LIFETIME'
  );

  const replacementKeys = generateApprovalCapabilityKeyPair();
  const wrongKeyVerifier = createApprovalCapabilityVerifier({
    publicKeys: { 'approval-2026-08': replacementKeys.publicKey },
    replayStore: new MemoryCapabilityReplayStore(),
    now: () => BASE_TIME,
  });
  assert.throws(
    () => wrongKeyVerifier.verify(ordinaryToken),
    error => error.code === 'CAPABILITY_BAD_SIGNATURE'
  );
});

test('a capability expiring between verification and atomic consumption fails closed', async () => {
  const replayStore = new MemoryCapabilityReplayStore();
  const verifierTimes = [BASE_TIME, BASE_TIME + 120000];
  const { issuer, verifier } = fixture({
    replayStore,
    verifierNow: () => verifierTimes.shift(),
  });
  const token = issuer.issue(bindings());

  await assert.rejects(
    verifier.consume(token, bindings()),
    error => error.code === 'CAPABILITY_EXPIRED'
  );
  assert.equal(replayStore.consumed.size, 0);
});

test('plan hashes are canonical and change when the privileged plan changes', () => {
  const reordered = {
    host: 'hermes',
    command: ['systemctl', 'restart', 'teleagent-preview.service'],
  };
  assert.equal(hashApprovalPlan(reordered), PLAN_HASH);
  assert.notEqual(
    hashApprovalPlan({ ...reordered, command: ['systemctl', 'stop', 'teleagent-preview.service'] }),
    PLAN_HASH
  );
  assert.throws(() => hashApprovalPlan({ command: undefined }), /JSON-compatible/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => hashApprovalPlan(cyclic), /cycles/);
});

test('the injected replay-store contract supports atomic asynchronous persistence', async () => {
  const nonces = new Set();
  const records = [];
  const replayStore = {
    async consume(record) {
      const key = `${record.keyId}:${record.nonce}`;
      if (nonces.has(key)) return false;
      nonces.add(key);
      records.push(record);
      return true;
    },
  };
  const { issuer, verifier } = fixture({ replayStore });
  const token = issuer.issue(bindings());
  await verifier.consume(token, bindings());

  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    'consumedAt',
    'expiresAt',
    'jobId',
    'keyId',
    'nonce',
    'purpose',
    'tokenSha256',
  ]);
  assert.equal(JSON.stringify(records[0]).includes(token), false);
  assert.match(records[0].tokenSha256, /^[a-f0-9]{64}$/);
});

test('SQLite replay consumption remains one-time across verifier restarts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-capability-'));
  const dbPath = path.join(directory, 'replay.sqlite');
  const keys = generateApprovalCapabilityKeyPair();
  const issuer = createApprovalCapabilityIssuer({
    privateKey: keys.privateKey,
    keyId: 'sqlite-test-key',
    now: () => BASE_TIME,
  });
  const token = issuer.issue(bindings());
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let db = new Database(dbPath);
  let replayStore = createSqliteCapabilityReplayStore(db);
  let verifier = createApprovalCapabilityVerifier({
    publicKeys: { 'sqlite-test-key': keys.publicKey },
    replayStore,
    now: () => BASE_TIME,
  });
  await verifier.consume(token, bindings());
  const persisted = db.prepare('SELECT * FROM voice_approval_capability_nonces').get();
  assert.equal(persisted.job_id, bindings().jobId);
  assert.equal(JSON.stringify(persisted).includes(token), false);
  assert.match(persisted.token_sha256, /^[a-f0-9]{64}$/);
  db.close();

  db = new Database(dbPath);
  replayStore = createSqliteCapabilityReplayStore(db);
  verifier = createApprovalCapabilityVerifier({
    publicKeys: { 'sqlite-test-key': keys.publicKey },
    replayStore,
    now: () => BASE_TIME,
  });
  await assert.rejects(
    verifier.consume(token, bindings()),
    error => error.code === 'CAPABILITY_REPLAYED'
  );
  assert.equal(replayStore.purgeExpired(Math.floor(BASE_TIME / 1000) + 121), 1);
  db.close();
});

test('issuers require complete bindings and verifiers fail closed without replay persistence', () => {
  const keys = generateApprovalCapabilityKeyPair();
  const issuer = createApprovalCapabilityIssuer({
    privateKey: keys.privateKey,
    keyId: 'fail-closed-test',
    now: () => BASE_TIME,
  });
  assert.throws(
    () => issuer.issue({ ...bindings(), planHash: undefined }),
    error => error.code === 'CAPABILITY_INVALID_ARGUMENT'
  );
  assert.throws(
    () => createApprovalCapabilityVerifier({
      publicKeys: { 'fail-closed-test': keys.publicKey },
      now: () => BASE_TIME,
    }),
    error => error.code === 'CAPABILITY_REPLAY_STORE_REQUIRED'
  );
});
