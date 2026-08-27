import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GatewayStateStore } from '../src/gateway-state-store.js';
import { SipStateStorageError } from '../src/state-storage-boundary.js';

async function makeStore(t, clock = () => 1_000, storageGuard = null) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-state-store-'));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  const stateStore = new GatewayStateStore({ filePath, clock, storageGuard });
  await stateStore.init();
  if (t) t.after(() => stateStore.close());
  return { stateStore, filePath };
}

function metadata() {
  return {
    eventId: 'evt_test_1',
    eventType: 'realtime.call.incoming',
    callId: 'rtc_test_1',
  };
}

test('state store uses WAL and FULL synchronization with private database permissions', async (t) => {
  const { stateStore, filePath } = await makeStore(t);
  assert.deepEqual(stateStore.durability(), { journalMode: 'wal', synchronous: 2 });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal(stateStore.healthy, true);
});

test('verified webhook and accept intent survive restart before any remote action', async () => {
  const { stateStore, filePath } = await makeStore(null);
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  stateStore.reserveCall({
    webhookId: 'wh_test_1',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  await stateStore.close();

  const reloaded = new GatewayStateStore({ filePath, clock: () => 1_001 });
  await reloaded.init();
  assert.equal(reloaded.getWebhook('wh_test_1').state, 'processing');
  assert.equal(reloaded.getCall('rtc_test_1').state, 'accept_intent');
  assert.equal(reloaded.getCall('rtc_test_1').authenticatedPrincipal, 'hermes-test-pbx');
  await reloaded.close();
});

test('completed webhook dedupe and terminal call state survive restart', async () => {
  const { stateStore, filePath } = await makeStore(null);
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  stateStore.reserveCall({
    webhookId: 'wh_test_1',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'reject',
    reason: 'caller_not_allowed',
    statusCode: 403,
    maxActiveCalls: 1,
  });
  stateStore.updateCall('rtc_test_1', 'rejected');
  stateStore.completeWebhook('wh_test_1', 'rejected');
  await stateStore.close();

  const reloaded = new GatewayStateStore({ filePath });
  await reloaded.init();
  const duplicate = reloaded.recordVerifiedWebhook('wh_test_1', metadata());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.outcome, 'rejected');
  assert.equal(reloaded.getCall('rtc_test_1').state, 'rejected');
  await reloaded.close();
});

test('one transaction reserves durable capacity across different calls', async (t) => {
  const { stateStore } = await makeStore(t);
  stateStore.recordVerifiedWebhook('wh_first', metadata());
  const first = stateStore.reserveCall({
    webhookId: 'wh_first',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  stateStore.recordVerifiedWebhook('wh_second', {
    ...metadata(),
    eventId: 'evt_test_2',
    callId: 'rtc_test_2',
  });
  const second = stateStore.reserveCall({
    webhookId: 'wh_second',
    callId: 'rtc_test_2',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  assert.equal(first.record.state, 'accept_intent');
  assert.equal(second.record.state, 'reject_intent');
  assert.equal(second.record.decision, 'capacity_reached');
  assert.equal(stateStore.summary().active, 2, 'capacity rejection remains active until confirmed');
});

test('webhook identifier reuse with changed signed metadata fails closed', async (t) => {
  const { stateStore } = await makeStore(t);
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  assert.throws(() => stateStore.recordVerifiedWebhook('wh_test_1', {
    ...metadata(),
    callId: 'rtc_different',
  }), /reused with different verified metadata/u);
  assert.equal(stateStore.healthy, true);
});

test('database stores the authenticated principal but never receives the PBX secret', async () => {
  const { stateStore, filePath } = await makeStore(null);
  const secret = 'pbx-secret-must-never-be-persisted-123456';
  stateStore.recordVerifiedWebhook('wh_test_1', metadata());
  stateStore.reserveCall({
    webhookId: 'wh_test_1',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  await stateStore.close();
  assert.equal((await readFile(filePath)).includes(Buffer.from(secret)), false);
  assert.equal((await readFile(filePath)).includes(Buffer.from('hermes-test-pbx')), true);
});

test('startup capacity admission precedes directory creation and SQLite open', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sip-state-start-order-'));
  const filePath = path.join(parent, 'not-created', 'gateway-state.sqlite3');
  const storageGuard = {
    assertOpen() {
      throw new SipStateStorageError(
        'SIP_STATE_CAPACITY_EXHAUSTED',
        'test capacity refusal',
        { phase: 'sqlite_open' },
      );
    },
    assertNewRecord() { assert.fail('new-record admission must not run'); },
    inspect: () => ({ admitted: false }),
  };
  t.after(() => rm(parent, { recursive: true, force: true }));
  const stateStore = new GatewayStateStore({ filePath, storageGuard });
  await assert.rejects(() => stateStore.init(), {
    code: 'SIP_STATE_CAPACITY_EXHAUSTED',
    details: { phase: 'sqlite_open' },
  });
  assert.equal(existsSync(path.dirname(filePath)), false);
  assert.equal(existsSync(filePath), false);
});

test('strict production storage refuses a missing initialized database', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-state-strict-missing-'));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateStore = new GatewayStateStore({
    filePath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    strictOwnership: true,
    storageGuard: {
      assertOpen() {},
      assertNewRecord() {},
      inspect: () => ({ admitted: true }),
    },
  });
  await assert.rejects(() => stateStore.init(), { code: 'ENOENT' });
  assert.equal(existsSync(filePath), false);
});

test('strict production storage opens an exact preinitialized zero-length database', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-state-strict-empty-'));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  await writeFile(filePath, '', { mode: 0o600 });
  await chmod(filePath, 0o600);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateStore = new GatewayStateStore({
    filePath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    strictOwnership: true,
    storageGuard: {
      assertOpen() {},
      assertNewRecord() {},
      inspect: () => ({ admitted: true }),
    },
  });
  await stateStore.init();
  t.after(() => stateStore.close());
  assert.deepEqual(stateStore.durability(), { journalMode: 'wal', synchronous: 2 });
});

test('database replacement during the native SQLite open is refused', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sip-state-open-swap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'gateway-state.sqlite3');
  fs.writeFileSync(filePath, '', { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  const replacementPath = path.join(directory, 'replacement.sqlite3');
  fs.writeFileSync(replacementPath, '', { mode: 0o600 });
  fs.chmodSync(replacementPath, 0o600);
  const initialized = fs.statSync(filePath, { bigint: true });
  let databaseClosed = false;
  const storageGuard = {
    assertOpen() {},
    assertNewRecord() {},
    inspect: () => ({ admitted: true }),
    assertFileIdentity() {
      const current = fs.statSync(filePath, { bigint: true });
      if (current.ino !== initialized.ino || current.birthtimeNs !== initialized.birthtimeNs) {
        throw new SipStateStorageError(
          'SIP_STATE_INITIALIZATION_INVALID',
          'main database replacement detected',
        );
      }
      return initialized;
    },
  };
  const stateStore = new GatewayStateStore({
    filePath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    strictOwnership: true,
    storageGuard,
    databaseFactory() {
      fs.renameSync(replacementPath, filePath);
      return {
        close() { databaseClosed = true; },
      };
    },
  });

  await assert.rejects(() => stateStore.init(), /main database replacement detected/u);
  assert.equal(databaseClosed, true);
  assert.equal(stateStore.healthy, false);
});

test('reserve exhaustion refuses only new durable identities and preserves recovery truth', async (t) => {
  let admitted = true;
  let newRecordAdmissions = 0;
  const storageGuard = {
    assertOpen() {},
    assertNewRecord() {
      newRecordAdmissions += 1;
      if (!admitted) {
        throw new SipStateStorageError(
          'SIP_STATE_CAPACITY_EXHAUSTED',
          'test capacity refusal',
          { phase: 'new_record' },
        );
      }
    },
    inspect: () => ({ admitted }),
  };
  const { stateStore } = await makeStore(t, () => 2_000, storageGuard);
  stateStore.recordVerifiedWebhook('wh_existing', metadata());
  stateStore.reserveCall({
    webhookId: 'wh_existing',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  });
  stateStore.recordVerifiedWebhook('wh_pending_call', {
    ...metadata(),
    eventId: 'evt_pending_call',
    callId: 'rtc_pending_call',
  });
  assert.equal(newRecordAdmissions, 3);

  admitted = false;
  assert.equal(stateStore.capacityAvailable, false);
  assert.equal(stateStore.recordVerifiedWebhook('wh_existing', metadata()).inserted, false);
  assert.equal(stateStore.reserveCall({
    webhookId: 'wh_existing',
    callId: 'rtc_test_1',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 1,
  }).inserted, false);
  assert.equal(newRecordAdmissions, 3, 'exact retries bypass new-record admission');

  assert.throws(() => stateStore.recordVerifiedWebhook('wh_new', {
    ...metadata(),
    eventId: 'evt_new',
    callId: 'rtc_new',
  }), { code: 'SIP_STATE_CAPACITY_EXHAUSTED' });
  assert.equal(stateStore.getWebhook('wh_new'), null);

  assert.throws(() => stateStore.reserveCall({
    webhookId: 'wh_pending_call',
    callId: 'rtc_pending_call',
    authenticatedPrincipal: 'hermes-test-pbx',
    decision: 'accept',
    reason: 'canary_allowed',
    maxActiveCalls: 2,
  }), { code: 'SIP_STATE_CAPACITY_EXHAUSTED' });
  assert.equal(stateStore.getCall('rtc_pending_call'), null);
  assert.equal(stateStore.getWebhook('wh_pending_call').state, 'verified');

  stateStore.updateCall('rtc_test_1', 'outcome_unknown', { recoveryReason: 'restart_probe_failed' });
  stateStore.updateCall('rtc_test_1', 'closed', {
    closeReason: 'recovered',
    hangupConfirmed: true,
  });
  stateStore.completeWebhook('wh_existing', 'recovered');
  assert.equal(stateStore.getCall('rtc_test_1').hangupConfirmed, true);
  assert.equal(stateStore.getWebhook('wh_existing').state, 'completed');
  assert.equal(stateStore.healthy, true, 'capacity refusal is not database corruption');
});
