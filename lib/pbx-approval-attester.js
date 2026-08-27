'use strict';

const {
  digestToken,
  hashCanonical,
  validatePbxObservation,
} = require('./pbx-approval-protocol');

class PbxApprovalAttesterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PbxApprovalAttesterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PbxApprovalAttesterError(code, message);
}

function method(owner, name, label) {
  if (!owner || typeof owner[name] !== 'function') {
    fail('PBX_ATTESTER_INVALID_CONFIGURATION', `${label} must implement ${name}().`);
  }
  return owner[name].bind(owner);
}

function timestampMilliseconds(now) {
  if (typeof now !== 'function') fail('PBX_ATTESTER_INVALID_CONFIGURATION', 'The attester clock is invalid.');
  const value = Number(now());
  if (!Number.isFinite(value) || value < 0) {
    fail('PBX_ATTESTER_CLOCK_ERROR', 'The attester clock is unavailable.');
  }
  return Math.floor(value);
}

function assertSynchronous(value, operation) {
  if (value && typeof value.then === 'function') {
    fail('PBX_ATTESTER_STORE_ERROR', `${operation} must be an atomic synchronous store operation.`);
  }
  return value;
}

function createPbxApprovalAttester({
  armVerifier,
  evidenceIssuer,
  adapter,
  store,
  now = Date.now,
} = {}) {
  const verifyArm = method(armVerifier, 'verify', 'The controller-arm verifier');
  const issueEvidence = method(evidenceIssuer, 'issue', 'The PBX evidence issuer');
  const collectApproval = method(adapter, 'collectApproval', 'The PBX adapter');
  const claimArm = method(store, 'claimArm', 'The durable attester store');
  const recordObservation = method(store, 'recordObservation', 'The durable attester store');
  const finalizeEvidence = method(store, 'finalizeEvidence', 'The durable attester store');
  timestampMilliseconds(now);

  return Object.freeze({
    async attest(armToken) {
      const arm = verifyArm(armToken);
      if (arm && typeof arm.then === 'function') {
        fail('PBX_ATTESTER_INVALID_CONFIGURATION', 'Controller-arm verification must be synchronous.');
      }
      const claims = arm?.claims;
      if (!claims || typeof claims !== 'object' || typeof arm.armSha256 !== 'string' ||
          typeof arm.keyId !== 'string') {
        fail('PBX_ATTESTER_INVALID_ARM', 'Controller-arm verification returned an invalid result.');
      }
      const claimedAtMs = timestampMilliseconds(now);
      const claimedAt = Math.floor(claimedAtMs / 1000);
      if (claimedAt >= claims.exp) {
        fail('PBX_ATTESTER_ARM_EXPIRED', 'The controller arm expired before PBX collection.');
      }
      let claimed;
      try {
        claimed = assertSynchronous(claimArm(Object.freeze({
          armSha256: arm.armSha256,
          armKeyId: arm.keyId,
          approvalId: claims.approval_id,
          armNonce: claims.nonce,
          pbxCallHandle: claims.pbx_call_handle,
          expiresAt: claims.exp,
          claimedAt,
        })), 'Controller-arm claim');
      } catch (error) {
        if (error instanceof PbxApprovalAttesterError) throw error;
        fail('PBX_ATTESTER_STORE_ERROR', 'The durable arm claim failed.');
      }
      if (claimed !== true) {
        fail('PBX_ATTESTER_ARM_REPLAYED', 'The controller arm was already claimed.');
      }

      const adapterRequest = Object.freeze({
        approvalId: claims.approval_id,
        armSha256: arm.armSha256,
        pbxCallHandle: claims.pbx_call_handle,
        prompt: claims.prompt,
        promptSha256: claims.prompt_sha256,
        notBeforeMs: claims.nbf * 1000,
        expiresAtMs: claims.exp * 1000,
      });
      let rawObservation;
      try {
        rawObservation = await collectApproval(adapterRequest);
      } catch {
        fail('PBX_ATTESTER_ADAPTER_ERROR', 'The PBX adapter did not produce approval evidence.');
      }
      const observation = validatePbxObservation(rawObservation, claims, { now });
      const observedAt = Math.floor(timestampMilliseconds(now) / 1000);
      let recorded;
      try {
        recorded = assertSynchronous(recordObservation(Object.freeze({
          armSha256: arm.armSha256,
          playbackId: observation.playback_id,
          dtmfEventId: observation.dtmf_event_id,
          callLegSha256: hashCanonical(observation.call_leg),
          observedAt,
        })), 'PBX observation recording');
      } catch (error) {
        if (error instanceof PbxApprovalAttesterError) throw error;
        fail('PBX_ATTESTER_STORE_ERROR', 'The PBX observation could not be recorded durably.');
      }
      if (recorded !== true) {
        fail('PBX_ATTESTER_OBSERVATION_REPLAYED', 'The PBX observation was already used.');
      }

      // The issuer receives the raw controller artifact and independently
      // verifies its Ed25519 signature. The structural verifier receipt above
      // is never accepted as signing authority.
      const evidenceToken = issueEvidence({ armToken, observation });
      if (typeof evidenceToken !== 'string') {
        fail('PBX_ATTESTER_ISSUER_ERROR', 'The PBX evidence issuer returned an invalid artifact.');
      }
      const evidenceSha256 = digestToken(evidenceToken);
      const issuedAt = Math.floor(timestampMilliseconds(now) / 1000);
      let finalized;
      try {
        finalized = assertSynchronous(finalizeEvidence(Object.freeze({
          armSha256: arm.armSha256,
          evidenceSha256,
          issuedAt,
        })), 'PBX evidence finalization');
      } catch (error) {
        if (error instanceof PbxApprovalAttesterError) throw error;
        fail('PBX_ATTESTER_STORE_ERROR', 'PBX evidence finalization failed.');
      }
      if (finalized !== true) {
        fail('PBX_ATTESTER_FINALIZE_FAILED', 'PBX evidence was not finalized durably.');
      }
      return Object.freeze({ evidenceToken, evidenceSha256 });
    },
  });
}

module.exports = {
  PbxApprovalAttesterError,
  createPbxApprovalAttester,
};
