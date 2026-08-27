'use strict';

const {
  createApprovalCapabilityIssuer,
  createApprovalCapabilityVerifier,
  generateApprovalCapabilityKeyPair,
  hashApprovalPlan,
} = require('../../lib/voice-approval-capability');
const {
  PRIVILEGED_ACTION_PROFILE,
  PRIVILEGED_ACTION_PROVIDER,
  buildPrivilegedActionApprovalPlan,
  buildPrivilegedActionPlan,
  privilegedActionRequestHash,
} = require('../../lib/privileged-action-plan');
const { PrivilegedActionBroker } = require('../broker');
const { PrivilegedActionStore } = require('../store');
const { createHashedSqliteCapabilityReplayStore } = require('../verifier');

function policy(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    max_timeout_seconds: 300,
    adapters: {
      systemctl: {
        enabled: true,
        executable: '/usr/bin/systemctl',
        units: { 'teleagent.service': ['status', 'restart'] },
      },
      journalctl: {
        enabled: true,
        executable: '/usr/bin/journalctl',
        units: ['teleagent.service'],
        max_lines: 200,
      },
      ssh: {
        enabled: true,
        executable: '/usr/bin/ssh',
        hosts: {
          hera: {
            os: 'linux', actions: ['hostname', 'uptime', 'exact_argv'],
            systemd_units: [], exact_rules: [['/usr/bin/hostname']],
            allowed_remote_executable_roots: ['/usr/bin', '/usr/local/bin'],
          },
          zeus: {
            os: 'windows', actions: ['hostname', 'exact_argv'], systemd_units: [],
            exact_rules: [['C:/Windows/System32/hostname.exe']],
            allowed_remote_executable_roots: ['C:/Windows/System32'],
          },
        },
      },
      kubectl: {
        enabled: true,
        ssh_executable: '/usr/bin/ssh',
        host: 'hera',
        remote_kubectl: '/usr/local/bin/kubectl',
        namespaces: {
          default: {
            get: ['pod/*'], rollout_restart: ['deployment/teleagent'],
            scale: ['deployment/teleagent'], max_replicas: 3,
          },
        },
      },
      argv: {
        enabled: true,
        allowed_executable_roots: ['/usr/bin'],
        exact_rules: [
          { argv: ['/usr/bin/true'], cwd: '/' },
          { argv: ['/usr/bin/false'], cwd: '/' },
          { argv: ['/usr/bin/printf', 'hello'], cwd: '/' },
        ],
      },
    },
    ...overrides,
  };
}

function actionPlan(argv = ['/usr/bin/true']) {
  return buildPrivilegedActionPlan({ adapter: 'argv', argv, cwd: '/', timeoutSeconds: 30 });
}

function capabilityFixture({ store = new PrivilegedActionStore(), nowMs = 1_800_000_000_000 } = {}) {
  const keyId = 'test-controller-key';
  const { privateKey, publicKey } = generateApprovalCapabilityKeyPair();
  let nonceCounter = 0;
  const issuer = createApprovalCapabilityIssuer({
    privateKey,
    keyId,
    now: () => nowMs,
    randomBytes: () => {
      const value = Buffer.alloc(24, 7);
      value.writeUInt32BE(++nonceCounter, 20);
      return value;
    },
  });
  const replayStore = createHashedSqliteCapabilityReplayStore(store.db, Buffer.alloc(32, 9));
  const verifier = createApprovalCapabilityVerifier({
    publicKeys: { [keyId]: publicKey },
    replayStore,
    now: () => nowMs,
  });
  const broker = new PrivilegedActionBroker({ store, policy: policy(), verifier });
  function issue({
    jobId = 'job_test123',
    callId = 'call-test',
    plan = actionPlan(),
  } = {}) {
    const approvalPlan = buildPrivilegedActionApprovalPlan({ jobId, callId, actionPlan: plan });
    return issuer.issue({
      jobId,
      requestHash: privilegedActionRequestHash(plan),
      planHash: hashApprovalPlan(approvalPlan),
      target: plan.target,
      provider: PRIVILEGED_ACTION_PROVIDER,
      profile: PRIVILEGED_ACTION_PROFILE,
    });
  }
  return { broker, issue, policy: policy(), store, verifier };
}

module.exports = { actionPlan, capabilityFixture, policy };
