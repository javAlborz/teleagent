'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildPrivilegedActionPlan,
  privilegedActionApprovalText,
  validateCanonicalPrivilegedActionPlan,
} = require('../../lib/privileged-action-plan');
const { validatePlanAgainstPolicy } = require('../policy');
const { policy } = require('./helpers');

test('named host plans use Hera pivot and preserve target OS boundaries', () => {
  const linux = buildPrivilegedActionPlan({ adapter: 'ssh', host: 'atlas', remoteAction: 'uptime' });
  assert.equal(linux.target, 'homelab:atlas');
  assert.deepEqual(linux.argv.slice(0, 12), [
    '/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ClearAllForwardings=yes', 'hera', '/usr/bin/ssh', '-T', '-o',
  ]);
  assert.ok(linux.argv.includes('atlas'));

  const windows = buildPrivilegedActionPlan({ adapter: 'ssh', host: 'zeus', remoteAction: 'hostname' });
  assert.ok(windows.argv.includes('C:/Windows/System32/hostname.exe'));
  assert.throws(
    () => buildPrivilegedActionPlan({ adapter: 'ssh', host: 'zeus', remoteAction: 'uptime' }),
    { code: 'PRIVILEGED_PLAN_INVALID' }
  );
  assert.throws(
    () => buildPrivilegedActionPlan({
      adapter: 'ssh',
      host: 'zeus',
      remoteAction: 'exact_argv',
      remoteArgv: ['C:/Windows/System32/hostname.exe', '%COMSPEC%'],
    }),
    { code: 'PRIVILEGED_PLAN_INVALID' },
    'Windows shell environment expansion must not change the signed exact argv'
  );
});

test('typed local systemctl plans use an exact absolute argv and postcondition probe', () => {
  const plan = buildPrivilegedActionPlan({
    adapter: 'systemctl', action: 'restart', unit: 'teleagent.service',
  });
  assert.deepEqual(plan.argv, [
    '/usr/bin/systemctl', 'restart', '--', 'teleagent.service',
  ]);
  assert.equal(plan.target, 'hermes:systemd:teleagent.service');
  assert.deepEqual(plan.expected_result.observe_argv.slice(0, 2), [
    '/usr/bin/systemctl', 'show',
  ]);
});

test('exact argv rejects shell syntax, split credential flags, credential headers, and trust paths', () => {
  const rejected = [
    ['/usr/bin/printf', 'hello world'],
    ['/usr/bin/curl', '--token', 'not-even-secret-looking'],
    ['/usr/bin/curl', '-H', 'Authorization:BearerABCDEF12345'],
    ['/usr/bin/curl', '-u', 'operator:credential'],
    ['/usr/bin/cat', '/etc/shadow'],
    ['/usr/bin/find', '/root/.ssh'],
    ['/usr/bin/find', '/tmp', '-exec', '/bin/sh'],
    ['/usr/bin/xargs', '/bin/sh'],
    ['/usr/bin/systemd-run', '/bin/sh'],
    ['/usr/bin/printf', 'token=credential'],
  ];
  for (const argv of rejected) {
    assert.throws(
      () => buildPrivilegedActionPlan({ adapter: 'argv', argv, cwd: '/' }),
      { code: 'PRIVILEGED_PLAN_INVALID' },
      JSON.stringify(argv)
    );
  }
});

test('voice approval scope is exact, high risk, and bounded before job creation', () => {
  const plan = buildPrivilegedActionPlan({
    adapter: 'argv', argv: ['/usr/bin/printf', 'hello'], cwd: '/', timeoutSeconds: 30,
  });
  const approval = privilegedActionApprovalText(plan);
  assert.match(approval.spoken, /^HIGH RISK\./);
  assert.match(approval.spoken, /\["\/usr\/bin\/printf","hello"\]/);
  assert.match(approval.spoken, /Exact target: hermes:root:exact-argv/);
  const long = Array.from({ length: 16 }, (_, index) => index === 0
    ? '/usr/bin/printf'
    : `arg${index}${'x'.repeat(60)}`);
  assert.throws(
    () => buildPrivilegedActionPlan({ adapter: 'argv', argv: long, cwd: '/' }),
    { code: 'PRIVILEGED_PLAN_INVALID' }
  );
});

test('policy permits only exact pre-reviewed argv and permanently denies dispatcher escapes', () => {
  const unlisted = buildPrivilegedActionPlan({ adapter: 'argv', argv: ['/usr/bin/id'], cwd: '/' });
  assert.throws(() => validatePlanAgainstPolicy(unlisted, policy()), {
    code: 'PRIVILEGED_ACTION_DENIED',
  });
  const legacyOptIn = policy();
  legacyOptIn.adapters.argv.unlisted_mode = 'high_risk_root_owned';
  assert.throws(() => validatePlanAgainstPolicy(unlisted, legacyOptIn), {
    code: 'PRIVILEGED_POLICY_INVALID',
  });
  const reviewed = policy();
  reviewed.adapters.argv.exact_rules.push({ argv: unlisted.argv, cwd: unlisted.cwd });
  assert.deepEqual(validatePlanAgainstPolicy(unlisted, reviewed), unlisted);

  const unlistedRemote = buildPrivilegedActionPlan({
    adapter: 'ssh', host: 'hera', remoteAction: 'exact_argv',
    remoteArgv: ['/usr/bin/id'],
  });
  assert.throws(() => validatePlanAgainstPolicy(unlistedRemote, policy()), {
    code: 'PRIVILEGED_ACTION_DENIED',
  });
  const remoteOptIn = policy();
  remoteOptIn.adapters.ssh.hosts.hera.allow_unlisted_exact_argv = true;
  assert.throws(() => validatePlanAgainstPolicy(unlistedRemote, remoteOptIn), {
    code: 'PRIVILEGED_POLICY_INVALID',
  });

  const tampered = structuredClone(unlisted);
  tampered.target = 'hermes:root:other';
  assert.throws(() => validateCanonicalPrivilegedActionPlan(tampered), {
    code: 'PRIVILEGED_PLAN_NONCANONICAL',
  });
});
