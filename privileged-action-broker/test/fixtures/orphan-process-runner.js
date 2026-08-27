#!/usr/bin/env node
'use strict';

const { PrivilegedActionDispatcher } = require('../../executor');
const { privilegedActionRequestHash } = require('../../../lib/privileged-action-plan');
const { PrivilegedActionStore } = require('../../store');
const { actionPlan, policy } = require('../helpers');

function queue(store, { key, plan }) {
  return store.submitAction({
    idempotencyKey: key,
    jobId: key,
    callId: 'call-orphan-recovery',
    target: plan.target,
    plan,
    planHash: privilegedActionRequestHash(plan),
    approval: { allowed: true, method: 'orphan-recovery-fixture' },
  }).action;
}

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('A database path is required.');
  const store = new PrivilegedActionStore({
    dbPath,
    expectedUid: process.geteuid(),
    strictOwnership: true,
  });
  const testPolicy = policy();
  testPolicy.adapters.argv.exact_rules.push({
    argv: ['/usr/bin/sleep', '60'],
    cwd: '/',
  });
  const running = queue(store, {
    key: 'job_orphan_running',
    plan: actionPlan(['/usr/bin/sleep', '60']),
  });
  const queued = queue(store, {
    key: 'job_orphan_queued',
    plan: actionPlan(['/usr/bin/true']),
  });
  const dispatcher = new PrivilegedActionDispatcher({
    store,
    policy: testPolicy,
    expectedUid: 0,
    processUid: process.geteuid(),
    terminationGraceMs: 500,
  });
  void dispatcher.runOnce().catch((error) => {
    process.send?.({ error: error.code || error.message });
  });
  const timer = setInterval(() => {
    const record = store.listProcessRecoveryRecords()
      .find((candidate) => candidate.actionId === running.id && candidate.state === 'spawned');
    if (!record) return;
    clearInterval(timer);
    process.send?.({
      ready: true,
      actionId: running.id,
      queuedActionId: queued.id,
      childPid: record.pid,
      childStartTicks: record.processStartTicks,
      processGroupId: record.processGroupId,
    });
  }, 10);
}

main().catch((error) => {
  process.send?.({ error: error.code || error.message });
  process.exitCode = 1;
});
