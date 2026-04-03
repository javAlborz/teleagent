const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clearRecentSessions,
  forgetRecentSession,
  getRecentSession,
  getResumeTtlSeconds,
  rememberRecentSession,
} = require('../lib/recent-session-cache');

test.afterEach(() => {
  clearRecentSessions();
});

test('rememberRecentSession and getRecentSession return the cached session', () => {
  const stored = rememberRecentSession({
    callerId: '1001',
    extension: '3',
    sessionKey: '11111111-1111-1111-1111-111111111111',
    sessionType: 'phone-opus',
    deviceName: 'Opus',
    ttlSeconds: 10,
  });

  assert.equal(stored.sessionKey, '11111111-1111-1111-1111-111111111111');

  const lookup = getRecentSession('1001', '3');
  assert.equal(lookup.hit, true);
  assert.equal(lookup.reason, 'hit');
  assert.equal(lookup.entry.sessionKey, '11111111-1111-1111-1111-111111111111');
  assert.equal(lookup.entry.sessionType, 'phone-opus');
  assert.equal(lookup.entry.deviceName, 'Opus');
});

test('getRecentSession returns miss for unknown caller or extension', () => {
  const lookup = getRecentSession('1001', '9');
  assert.equal(lookup.hit, false);
  assert.equal(lookup.reason, 'miss');
  assert.equal(lookup.entry, null);
});

test('rememberRecentSession overwrites an older session for the same caller and extension', () => {
  rememberRecentSession({
    callerId: '1001',
    extension: '2',
    sessionKey: '22222222-2222-2222-2222-222222222222',
    ttlSeconds: 10,
  });

  rememberRecentSession({
    callerId: '1001',
    extension: '2',
    sessionKey: '33333333-3333-3333-3333-333333333333',
    ttlSeconds: 10,
  });

  const lookup = getRecentSession('1001', '2');
  assert.equal(lookup.hit, true);
  assert.equal(lookup.entry.sessionKey, '33333333-3333-3333-3333-333333333333');
});

test('forgetRecentSession removes a cached session', () => {
  rememberRecentSession({
    callerId: '1001',
    extension: '1',
    sessionKey: '44444444-4444-4444-4444-444444444444',
    ttlSeconds: 10,
  });

  assert.equal(forgetRecentSession('1001', '1', 'test_cleanup'), true);

  const lookup = getRecentSession('1001', '1');
  assert.equal(lookup.hit, false);
  assert.equal(lookup.reason, 'miss');
});

test('getResumeTtlSeconds falls back safely', () => {
  assert.equal(getResumeTtlSeconds({ resumeTtlSeconds: 900 }), 900);
  assert.equal(getResumeTtlSeconds({ resumeTtlSeconds: '0' }), 600);
  assert.equal(getResumeTtlSeconds(null), 600);
});

test('getRecentSession expires stale entries', async () => {
  rememberRecentSession({
    callerId: '1001',
    extension: '3',
    sessionKey: '55555555-5555-5555-5555-555555555555',
    ttlSeconds: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const lookup = getRecentSession('1001', '3');
  assert.equal(lookup.hit, false);
  assert.ok(['miss', 'expired'].includes(lookup.reason));
});
