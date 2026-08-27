'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PrivilegedActionBridge,
  terminal,
} = require('../lib/privileged-action-bridge');
const { loadPrivilegedActionConfig } = require('../lib/privileged-action-config');

const TOKEN = 'p'.repeat(40);

function matchingAction({
  id = 'pact_recovered',
  idempotencyKey = 'job_recover',
  jobId = idempotencyKey,
  callId = 'call',
  plan = {},
  state = 'queued',
} = {}) {
  return {
    id, idempotencyKey, jobId, callId, target: plan.target, plan, state,
  };
}

test('privileged voice path requires its dedicated scoped token and signed approvals', () => {
  assert.throws(() => new PrivilegedActionBridge({ apiToken: '' }), {
    code: 'PRIVILEGED_ACTION_AUTH_NOT_CONFIGURED',
  });
  assert.throws(() => loadPrivilegedActionConfig({
    env: { VOICE_PRIVILEGED_ACTIONS_ENABLED: 'true', PRIVILEGED_ACTION_API_TOKEN: TOKEN },
    approvalCapability: { enabled: false, issuer: null },
  }), { code: 'PRIVILEGED_ACTION_APPROVAL_DISABLED' });
  assert.throws(() => loadPrivilegedActionConfig({
    env: { VOICE_PRIVILEGED_ACTIONS_ENABLED: 'true', PRIVILEGED_ACTION_API_TOKEN: 'short' },
    approvalCapability: { enabled: true, issuer: { issue() {} } },
  }), { code: 'PRIVILEGED_ACTION_AUTH_NOT_CONFIGURED' });
  assert.equal(loadPrivilegedActionConfig({ env: {} }).enabled, false);
});

test('submit uses one POST with dedicated bearer and recovers no-response by GET only', async () => {
  const calls = [];
  const axiosClient = {
    async post(url, body, config) {
      calls.push({ method: 'POST', url, body, config });
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    },
    async get(url, config) {
      calls.push({ method: 'GET', url, config });
      return { data: { action: matchingAction() } };
    },
  };
  const bridge = new PrivilegedActionBridge({
    apiUrl: 'http://127.0.0.1:3333', apiToken: TOKEN, axiosClient,
  });
  const action = await bridge.submit({
    idempotencyKey: 'job_recover', jobId: 'job_recover', callId: 'call',
    plan: {}, authorization: { capability: 'one-time-token' },
  });
  assert.equal(action.id, 'pact_recovered');
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET']);
  assert.equal(calls[0].config.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].config.headers['Idempotency-Key'], 'job_recover');
  assert.equal(calls[1].config.headers.Authorization, `Bearer ${TOKEN}`);
});

test('ambiguous controller proxy 503 performs GET-only recovery and never repeats POST', async () => {
  const methods = [];
  const axiosClient = {
    async post() {
      methods.push('POST');
      throw Object.assign(new Error('proxy lost broker response'), {
        response: {
          status: 503,
          data: { code: 'PRIVILEGED_BROKER_UNAVAILABLE' },
        },
      });
    },
    async get() {
      methods.push('GET');
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    },
  };
  const bridge = new PrivilegedActionBridge({ apiToken: TOKEN, axiosClient });
  await assert.rejects(() => bridge.submit({
    idempotencyKey: 'job_unknown', jobId: 'job_unknown', callId: 'call',
    plan: {}, authorization: { capability: 'one-time-token' },
  }), { code: 'PRIVILEGED_SUBMISSION_OUTCOME_UNKNOWN' });
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('every controller 5xx is ambiguous and performs exact GET-only recovery', async () => {
  const methods = [];
  const plan = { target: 'hermes:root', argv: ['/usr/bin/true'] };
  const axiosClient = {
    async post() {
      methods.push('POST');
      throw Object.assign(new Error('serialization failed after commit'), {
        response: { status: 500, data: { code: 'PRIVILEGED_BROKER_ERROR' } },
      });
    },
    async get() {
      methods.push('GET');
      return { data: { action: matchingAction({
        id: 'pact_committed', idempotencyKey: 'job_500', callId: 'call', plan,
      }) } };
    },
  };
  const bridge = new PrivilegedActionBridge({ apiToken: TOKEN, axiosClient });
  const action = await bridge.submit({
    idempotencyKey: 'job_500', jobId: 'job_500', callId: 'call', plan,
    authorization: { capability: 'one-time-token' },
  });
  assert.equal(action.id, 'pact_committed');
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('ambiguous recovery refuses an action with a different exact plan', async () => {
  const plan = { target: 'hermes:root', argv: ['/usr/bin/true'] };
  const axiosClient = {
    async post() { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); },
    async get() {
      return { data: { action: matchingAction({
        idempotencyKey: 'job_mismatch', callId: 'call',
        plan: { target: 'hermes:root', argv: ['/usr/bin/false'] },
      }) } };
    },
  };
  const bridge = new PrivilegedActionBridge({ apiToken: TOKEN, axiosClient });
  await assert.rejects(() => bridge.submit({
    idempotencyKey: 'job_mismatch', jobId: 'job_mismatch', callId: 'call', plan,
    authorization: { capability: 'one-time-token' },
  }), { code: 'PRIVILEGED_SUBMISSION_OUTCOME_UNKNOWN' });
});

test('explicit broker policy response is terminal and performs no recovery GET', async () => {
  let gets = 0;
  const axiosClient = {
    async post() {
      throw Object.assign(new Error('denied'), {
        response: { status: 400, data: { code: 'PRIVILEGED_ACTION_DENIED' } },
      });
    },
    async get() { gets += 1; },
  };
  const bridge = new PrivilegedActionBridge({ apiToken: TOKEN, axiosClient });
  await assert.rejects(() => bridge.submit({ idempotencyKey: 'job_denied' }), /denied/);
  assert.equal(gets, 0);
});

test('outcome_unknown is a terminal root-broker state', () => {
  assert.equal(terminal({ state: 'outcome_unknown' }), true);
  assert.equal(terminal({ state: 'running' }), false);
});
