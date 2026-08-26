'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  createApprovalCapabilityVerifier,
  createSqliteCapabilityReplayStore,
  hashApprovalPlan,
} = require('../lib/voice-approval-capability');
const {
  buildManagedAgentApprovalPlan,
  buildTargetSessionApprovalPlan,
  managedAgentTarget,
  profileForSessionType,
  profileForTargetSession,
} = require('../lib/voice-authorization-plan');
const {
  RISK_LEVELS,
  classifyVoiceOperation,
  requestHash,
} = require('../lib/voice-operation-risk');

const MAX_PUBLIC_KEY_BYTES = 64 * 1024;

function approvalFailure(code = 'VOICE_APPROVAL_REQUIRED') {
  return {
    allowed: false,
    code,
    authorization: null,
    userMessage: code === 'VOICE_APPROVAL_VERIFIER_UNAVAILABLE'
      ? 'Approved phone operations are temporarily unavailable because the executor verification key is not configured.'
      : 'That exact operation needs a fresh approval. Review the spoken scope and press pound to approve it.',
  };
}

function readTrustedPublicKey(filename, fsModule = fs) {
  const resolved = path.resolve(String(filename || ''));
  let descriptor = null;
  try {
    descriptor = fsModule.openSync(
      resolved,
      fsModule.constants.O_RDONLY | (fsModule.constants.O_NOFOLLOW || 0)
    );
    const stat = fsModule.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PUBLIC_KEY_BYTES) {
      throw new Error('The approval verification key must be a non-empty regular file under 64 KiB.');
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error('The approval verification key file must not be group- or world-writable.');
    }
    const effectiveUserId = typeof process.geteuid === 'function' ? process.geteuid() : stat.uid;
    if (stat.uid !== effectiveUserId && stat.uid !== 0) {
      throw new Error('The approval verification key must be owned by the executor user or root.');
    }
    return fsModule.readFileSync(descriptor, 'utf8');
  } finally {
    if (descriptor !== null) fsModule.closeSync(descriptor);
  }
}

function loadApprovalPublicKeys(environment = process.env, fileSystem = {}) {
  const keyId = String(environment.VOICE_APPROVAL_KEY_ID || '').trim();
  const filename = String(environment.VOICE_APPROVAL_PUBLIC_KEY_FILE || '').trim();
  if (!keyId && !filename) return null;
  if (!keyId || !filename) {
    throw new Error('VOICE_APPROVAL_KEY_ID and VOICE_APPROVAL_PUBLIC_KEY_FILE must be configured together.');
  }
  return {
    [keyId]: readTrustedPublicKey(filename, Object.keys(fileSystem).length > 0 ? fileSystem : fs),
  };
}

function createConfiguredApprovalVerifier({
  environment = process.env,
  sqliteDatabase,
  fileSystem = {},
  now = Date.now,
} = {}) {
  const publicKeys = loadApprovalPublicKeys(environment, fileSystem);
  if (!publicKeys) return null;
  if (!sqliteDatabase) {
    throw new Error('The durable executor database is required for capability replay protection.');
  }
  return createApprovalCapabilityVerifier({
    publicKeys,
    replayStore: createSqliteCapabilityReplayStore(sqliteDatabase),
    now,
  });
}

function verifiedAuthorization(claims, request) {
  return Object.freeze({
    job_id: claims.job_id,
    method: 'dtmf-pound',
    approved_at: new Date(claims.iat * 1000).toISOString(),
    scope: String(request || '').trim(),
    capability_key_id: claims.key_id,
    request_sha256: claims.request_sha256,
    plan_sha256: claims.plan_sha256,
    target: claims.target,
    provider: claims.provider,
    profile: claims.profile,
  });
}

function authorizeManagedVoiceRequest({
  verifier,
  profile,
  prompt,
  callId,
  sessionKey,
  sessionType,
  timeoutSeconds = null,
  devicePrompt = null,
  executionContext = null,
  authorization = null,
} = {}) {
  const classification = classifyVoiceOperation(prompt);
  const voiceOrigin = String(profile?.sessionType || '').startsWith('phone-');
  if (!voiceOrigin || classification.level === RISK_LEVELS.READ_ONLY) {
    return { allowed: true, classification, authorization: null, voiceOrigin };
  }
  if (!verifier) {
    return { ...approvalFailure('VOICE_APPROVAL_VERIFIER_UNAVAILABLE'), classification, voiceOrigin };
  }

  const jobId = String(callId || '').trim();
  const resolvedSessionKey = String(sessionKey || callId || '').trim();
  const capabilityProfile = profileForSessionType(sessionType);
  if (!/^job_[A-Za-z0-9]+$/.test(jobId) || !resolvedSessionKey || !capabilityProfile) {
    return { ...approvalFailure(), classification, voiceOrigin };
  }
  const plan = buildManagedAgentApprovalPlan({
    jobId,
    request: prompt,
    sessionKey: resolvedSessionKey,
    sessionType,
    timeoutSeconds,
    devicePrompt,
    executionContext,
  });

  try {
    const claims = verifier.consumeSync(authorization?.capability, {
      jobId,
      requestHash: requestHash(prompt),
      planHash: hashApprovalPlan(plan),
      target: managedAgentTarget(resolvedSessionKey),
      provider: profile.provider,
      profile: capabilityProfile,
    });
    return {
      allowed: true,
      classification,
      authorization: verifiedAuthorization(claims, prompt),
      voiceOrigin,
    };
  } catch (error) {
    return {
      ...approvalFailure(),
      classification,
      voiceOrigin,
      internalCode: error?.code || 'CAPABILITY_REJECTED',
    };
  }
}

function authorizeTargetSessionRequest({
  verifier,
  operationId,
  target,
  message,
  sessionFingerprint,
  timeoutSeconds,
  prepared,
  authorization = null,
} = {}) {
  if (!verifier) return approvalFailure('VOICE_APPROVAL_VERIFIER_UNAVAILABLE');
  const jobId = String(operationId || '').trim();
  const stableTarget = String(prepared?.stable_target || prepared?.target || '').trim();
  const requestedTarget = String(target || '').trim();
  const expectedFingerprint = String(prepared?.session_fingerprint || '').trim();
  const providedFingerprint = String(sessionFingerprint || '').trim();
  const profile = profileForTargetSession(prepared?.provider, message);
  if (!/^job_[A-Za-z0-9]+$/.test(jobId) || !stableTarget || stableTarget !== requestedTarget ||
      !expectedFingerprint || expectedFingerprint !== providedFingerprint || !profile) {
    return approvalFailure();
  }
  const plan = buildTargetSessionApprovalPlan({
    jobId,
    target: stableTarget,
    message,
    sessionFingerprint: expectedFingerprint,
    timeoutSeconds,
  });
  try {
    const claims = verifier.consumeSync(authorization?.capability, {
      jobId,
      requestHash: requestHash(message),
      planHash: hashApprovalPlan(plan),
      target: stableTarget,
      provider: prepared.provider,
      profile,
    });
    return {
      allowed: true,
      authorization: verifiedAuthorization(claims, message),
      profile,
    };
  } catch (error) {
    return {
      ...approvalFailure(),
      internalCode: error?.code || 'CAPABILITY_REJECTED',
    };
  }
}

module.exports = {
  authorizeManagedVoiceRequest,
  authorizeTargetSessionRequest,
  createConfiguredApprovalVerifier,
  loadApprovalPublicKeys,
  readTrustedPublicKey,
};
