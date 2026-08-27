'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  MemoryCapabilityReplayStore,
  createApprovalCapabilityIssuer,
  createApprovalCapabilityVerifier,
  createSqliteCapabilityReplayStore,
  generateApprovalCapabilityKeyPair,
  hashApprovalPlan,
} = require('../../lib/voice-approval-capability');
const {
  buildManagedAgentApprovalPlan,
  buildTargetSessionApprovalPlan,
  managedAgentTarget,
} = require('../../lib/voice-authorization-plan');
const { requestHash } = require('../../lib/voice-operation-risk');
const {
  authorizeManagedVoiceRequest,
  authorizeTargetSessionRequest,
  executeWithCurrentApprovalAuthority,
  loadApprovalPublicKeys,
} = require('../voice-approval-verifier');

function fixture() {
  const { privateKey, publicKey } = generateApprovalCapabilityKeyPair();
  const issuer = createApprovalCapabilityIssuer({ privateKey, keyId: 'test-key' });
  const verifier = createApprovalCapabilityVerifier({
    publicKeys: { 'test-key': publicKey },
    replayStore: new MemoryCapabilityReplayStore(),
  });
  return { issuer, verifier };
}

test('read-only phone work does not require an approval capability', async () => {
  const result = await authorizeManagedVoiceRequest({
    verifier: null,
    profile: { provider: 'codex', sessionType: 'phone-codex-luna' },
    prompt: 'Inspect git status.',
    callId: 'job_readonly',
    sessionKey: 'thread:codex-luna',
    sessionType: 'phone-codex-luna',
    timeoutSeconds: 600,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.authorization, null);
});

test('absent phone authority never instructs the caller to approve with DTMF', () => {
  const result = authorizeTargetSessionRequest({ verifier: null });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'VOICE_APPROVAL_VERIFIER_UNAVAILABLE');
  assert.match(result.userMessage, /disabled pending an independent PBX attester/);
  assert.doesNotMatch(result.userMessage, /pound|DTMF/i);
});

test('execution-time authority gate blocks provider and tmux effects after verifier revocation', async () => {
  let effects = 0;
  const execute = async () => { effects += 1; };
  const managedTask = {
    taskType: 'managed_ask',
    request: {
      ask: { prompt: 'Edit the phone configuration.' },
      voiceAuthorization: {
        authorization: { capability_key_id: 'retired-key' },
      },
    },
  };
  const targetTask = {
    taskType: 'target_session_message',
    request: {
      targetAuthorization: {
        authorization: { capability_key_id: 'retired-key' },
      },
    },
  };

  await assert.rejects(
    executeWithCurrentApprovalAuthority({
      task: managedTask,
      verifier: null,
      currentKeyId: '',
      execute,
    }),
    { code: 'VOICE_APPROVAL_AUTHORITY_REVOKED' }
  );
  await assert.rejects(
    executeWithCurrentApprovalAuthority({
      task: targetTask,
      verifier: null,
      currentKeyId: '',
      execute,
    }),
    { code: 'VOICE_APPROVAL_AUTHORITY_REVOKED' }
  );
  await assert.rejects(
    executeWithCurrentApprovalAuthority({
      task: managedTask,
      verifier: { keyFingerprint: () => 'a'.repeat(64) },
      currentKeyId: 'retired-key',
      execute,
    }),
    { code: 'VOICE_APPROVAL_AUTHORITY_REVOKED' }
  );
  assert.equal(effects, 0);
});

test('execution-time authority gate requires the exact current key epoch', async () => {
  let effects = 0;
  const admittingFingerprint = 'a'.repeat(64);
  const tasks = [{
    taskType: 'managed_ask',
    request: {
      ask: { prompt: 'Edit the phone configuration.' },
      voiceAuthorization: {
        authorization: {
          capability_key_id: 'admitting-key',
          capability_key_fingerprint: admittingFingerprint,
        },
      },
    },
  }, {
    taskType: 'target_session_message',
    request: {
      targetAuthorization: {
        authorization: {
          capability_key_id: 'admitting-key',
          capability_key_fingerprint: admittingFingerprint,
        },
      },
    },
  }];
  for (const task of tasks) {
    await assert.rejects(
      executeWithCurrentApprovalAuthority({
        task,
        verifier: { keyFingerprint: () => 'b'.repeat(64) },
        currentKeyId: 'admitting-key',
        execute: async () => { effects += 1; },
      }),
      { code: 'VOICE_APPROVAL_AUTHORITY_REVOKED' }
    );
  }
  assert.equal(effects, 0);

  const result = await executeWithCurrentApprovalAuthority({
    task: tasks[0],
    verifier: { keyFingerprint: () => admittingFingerprint },
    currentKeyId: 'admitting-key',
    execute: async () => {
      effects += 1;
      return 'executed';
    },
  });
  assert.equal(result, 'executed');
  assert.equal(effects, 1);
});

test('execution-time authority gate preserves read-only provider work without a verifier', async () => {
  let effects = 0;
  const result = await executeWithCurrentApprovalAuthority({
    task: {
      taskType: 'managed_ask',
      request: {
        ask: { prompt: 'Inspect git status.' },
        voiceAuthorization: { allowed: true, authorization: null },
      },
    },
    verifier: null,
    currentKeyId: '',
    execute: async () => {
      effects += 1;
      return 'read-only';
    },
  });
  assert.equal(result, 'read-only');
  assert.equal(effects, 1);
});

test('managed mutation consumes one exact plan-bound capability', async () => {
  const { issuer, verifier } = fixture();
  const request = 'Restart the voice app service.';
  const jobId = 'job_abc123';
  const sessionKey = 'thread:codex-sol';
  const plan = buildManagedAgentApprovalPlan({
    jobId,
    request,
    sessionKey,
    sessionType: 'phone-codex-sol',
    timeoutSeconds: 3600,
  });
  const capability = issuer.issue({
    jobId,
    requestHash: requestHash(request),
    planHash: hashApprovalPlan(plan),
    target: managedAgentTarget(sessionKey),
    provider: 'codex',
    profile: 'codex-sol',
  });
  const input = {
    verifier,
    profile: { provider: 'codex', sessionType: 'phone-codex-deploy' },
    prompt: request,
    callId: jobId,
    sessionKey,
    sessionType: 'phone-codex-sol',
    timeoutSeconds: 3600,
    authorization: { capability, scope: 'untrusted display text' },
  };
  const accepted = await authorizeManagedVoiceRequest(input);
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.authorization.job_id, jobId);
  assert.equal(accepted.authorization.scope, request);
  assert.equal(accepted.authorization.request_sha256, requestHash(request));
  assert.equal(accepted.authorization.plan_sha256, hashApprovalPlan(plan));
  assert.equal(accepted.authorization.target, managedAgentTarget(sessionKey));
  assert.equal(accepted.authorization.provider, 'codex');
  assert.equal(accepted.authorization.profile, 'codex-sol');
  assert.match(accepted.authorization.capability_key_fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(
    accepted.authorization.capability_key_fingerprint,
    verifier.keyFingerprint('test-key')
  );
  assert.equal(Object.hasOwn(accepted.authorization, 'capability'), false);
  assert.equal(Object.hasOwn(accepted.authorization, 'nonce'), false);

  const replay = await authorizeManagedVoiceRequest(input);
  assert.equal(replay.allowed, false);
  assert.equal(replay.internalCode, 'CAPABILITY_REPLAYED');
});

test('an enclosing SQLite transaction rolls nonce consumption back with a failed task insert', t => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const { privateKey, publicKey } = generateApprovalCapabilityKeyPair();
  const issuer = createApprovalCapabilityIssuer({ privateKey, keyId: 'transaction-test-key' });
  const verifier = createApprovalCapabilityVerifier({
    publicKeys: { 'transaction-test-key': publicKey },
    replayStore: createSqliteCapabilityReplayStore(database),
  });
  const request = 'Restart the voice app service.';
  const jobId = 'job_transaction123';
  const sessionKey = 'thread:transaction';
  const plan = buildManagedAgentApprovalPlan({
    jobId,
    request,
    sessionKey,
    sessionType: 'phone-codex-sol',
    timeoutSeconds: 3600,
  });
  const capability = issuer.issue({
    jobId,
    requestHash: requestHash(request),
    planHash: hashApprovalPlan(plan),
    target: managedAgentTarget(sessionKey),
    provider: 'codex',
    profile: 'codex-sol',
  });
  const input = {
    verifier,
    profile: { provider: 'codex', sessionType: 'phone-codex-sol' },
    prompt: request,
    callId: jobId,
    sessionKey,
    sessionType: 'phone-codex-sol',
    timeoutSeconds: 3600,
    authorization: { capability },
  };

  const failedSubmission = database.transaction(() => {
    assert.equal(authorizeManagedVoiceRequest(input).allowed, true);
    throw new Error('forced task insert failure');
  });
  assert.throws(() => failedSubmission.immediate(), /forced task insert failure/);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM voice_approval_capability_nonces').get().count,
    0
  );

  assert.equal(authorizeManagedVoiceRequest(input).allowed, true);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM voice_approval_capability_nonces').get().count,
    1
  );
});

test('managed capability fails when the resolved execution plan changes', async () => {
  const { issuer, verifier } = fixture();
  const request = 'Edit the phone configuration.';
  const jobId = 'job_plan123';
  const sessionKey = 'thread:codex-terra';
  const approvedPlan = buildManagedAgentApprovalPlan({
    jobId,
    request,
    sessionKey,
    sessionType: 'phone-codex-terra',
    timeoutSeconds: 1800,
  });
  const capability = issuer.issue({
    jobId,
    requestHash: requestHash(request),
    planHash: hashApprovalPlan(approvedPlan),
    target: managedAgentTarget(sessionKey),
    provider: 'codex',
    profile: 'codex-terra',
  });
  const result = await authorizeManagedVoiceRequest({
    verifier,
    profile: { provider: 'codex', sessionType: 'phone-codex-terra' },
    prompt: request,
    callId: jobId,
    sessionKey,
    sessionType: 'phone-codex-terra',
    timeoutSeconds: 3600,
    authorization: { capability },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.internalCode, 'CAPABILITY_BINDING_MISMATCH');
});

test('target-session delivery binds stable pane, fingerprint, provider, and tier', async () => {
  const { issuer, verifier } = fixture();
  const jobId = 'job_target123';
  const target = '%42';
  const message = 'Run sudo systemctl restart voice-app.';
  const fingerprint = 'fingerprint-abc';
  const timeoutSeconds = 3600;
  const plan = buildTargetSessionApprovalPlan({
    jobId,
    target,
    message,
    sessionFingerprint: fingerprint,
    timeoutSeconds,
  });
  const capability = issuer.issue({
    jobId,
    requestHash: requestHash(message),
    planHash: hashApprovalPlan(plan),
    target,
    provider: 'codex',
    profile: 'codex-sol',
  });
  const result = await authorizeTargetSessionRequest({
    verifier,
    operationId: jobId,
    target,
    message,
    sessionFingerprint: fingerprint,
    timeoutSeconds,
    prepared: {
      target: 'main:codex.0',
      stable_target: target,
      provider: 'codex',
      session_fingerprint: fingerprint,
    },
    authorization: { capability },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.profile, 'codex-sol');
});

test('target-session capability rejects a changed stable pane before consumption', async () => {
  const { verifier } = fixture();
  const result = await authorizeTargetSessionRequest({
    verifier,
    operationId: 'job_target456',
    target: '%43',
    message: 'Edit one file.',
    sessionFingerprint: 'same-fingerprint',
    timeoutSeconds: 1800,
    prepared: {
      target: 'main:codex.0',
      stable_target: '%42',
      provider: 'codex',
      session_fingerprint: 'same-fingerprint',
    },
    authorization: { capability: 'not-used' },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'VOICE_APPROVAL_REQUIRED');
});

test('public-key configuration rejects symlinks and writable trust anchors', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-verifier-key-'));
  const keyFile = path.join(directory, 'public.pem');
  const symlink = path.join(directory, 'linked.pem');
  const { publicKey } = generateApprovalCapabilityKeyPair();
  fs.writeFileSync(keyFile, publicKey, { mode: 0o600 });
  fs.symlinkSync(keyFile, symlink);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const environment = {
    VOICE_APPROVAL_KEY_ID: 'test-key',
    VOICE_APPROVAL_PUBLIC_KEY_FILE: keyFile,
  };
  assert.deepEqual(Object.keys(loadApprovalPublicKeys(environment)), ['test-key']);
  fs.chmodSync(keyFile, 0o666);
  assert.throws(() => loadApprovalPublicKeys(environment), /must not be group- or world-writable/);
  fs.chmodSync(keyFile, 0o600);
  assert.throws(
    () => loadApprovalPublicKeys({ ...environment, VOICE_APPROVAL_PUBLIC_KEY_FILE: symlink }),
    /ELOOP|symbolic link/i
  );
});
