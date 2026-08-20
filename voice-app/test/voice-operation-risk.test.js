'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RISK_LEVELS,
  buildAuthorizationEnvelope,
  classifyVoiceOperation,
  requestHash,
} = require('../../lib/voice-operation-risk');

const cases = [
  ['show the latest commits', RISK_LEVELS.READ_ONLY, 'read'],
  ['show the release history', RISK_LEVELS.READ_ONLY, 'read'],
  ['how do I use sudo safely?', RISK_LEVELS.READ_ONLY, 'read'],
  ['check the deployment and then restart the service', RISK_LEVELS.MUTATING, 'write'],
  ['implement the transcript viewer', RISK_LEVELS.MUTATING, 'write'],
  ['build the application', RISK_LEVELS.MUTATING, 'write'],
  ['show the build status', RISK_LEVELS.READ_ONLY, 'read'],
  ['deploy the preview', RISK_LEVELS.HIGH, 'admin'],
  ['run sudo systemctl restart voice-app', RISK_LEVELS.PRIVILEGED, 'admin'],
  ['kubectl apply the manifest', RISK_LEVELS.PRIVILEGED, 'admin'],
];

for (const [request, level, capability] of cases) {
  test(`classifies ${JSON.stringify(request)} as ${level}`, () => {
    const classification = classifyVoiceOperation(request);
    assert.equal(classification.level, level);
    assert.equal(classification.capability, capability);
    assert.equal(classification.requiresApproval, level !== RISK_LEVELS.READ_ONLY);
    assert.equal(classification.requestHash, requestHash(request));
  });
}

test('authorization envelopes are scoped to an approved running job', () => {
  assert.equal(buildAuthorizationEnvelope({ status: 'queued', requiresApproval: true }), null);
  const envelope = buildAuthorizationEnvelope({
    id: 'job_abc123',
    status: 'running',
    requiresApproval: true,
    request: 'Deploy the preview.',
    risk_level: 'high',
    approval_method: 'dtmf-pound',
    approved_at: '2026-08-13T12:00:00.000Z',
    approval_summary: 'codex-sol requests high authorization for: Deploy the preview.',
  });
  assert.deepEqual(envelope, {
    approved: true,
    job_id: 'job_abc123',
    method: 'dtmf-pound',
    approved_at: '2026-08-13T12:00:00.000Z',
    risk_level: 'high',
    request_sha256: requestHash('Deploy the preview.'),
    scope: 'codex-sol requests high authorization for: Deploy the preview.',
  });
});

test('target-session authorization binds the stable pane and provider fingerprint', () => {
  const envelope = buildAuthorizationEnvelope({
    id: 'job_target123',
    jobKind: 'tmux_agent_message',
    status: 'running',
    requiresApproval: true,
    request: 'Continue the exact fix.',
    risk_level: 'mutating',
    approval_method: 'dtmf-pound',
    approved_at: '2026-08-20T12:00:00.000Z',
    operation: {
      target: '%12',
      sessionFingerprint: 'provider-session-fingerprint',
      conversationName: '8player-tooling',
    },
  });

  assert.equal(envelope.target, '%12');
  assert.equal(envelope.target_session_fingerprint, 'provider-session-fingerprint');
  assert.equal(envelope.target_conversation_name, '8player-tooling');
});
