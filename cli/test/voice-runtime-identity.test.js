import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertVoiceRuntimeEnvFile,
  normalizeVoiceRuntimeIdentity,
  resolveVoiceRuntimeIdentity,
  resolveVoiceRuntimeIdentityForInstallation,
  VoiceRuntimeIdentityError,
} from '../lib/voice-runtime-identity.js';

const READY = Object.freeze({
  name: 'teleagent-voice',
  uid: 989,
  gid: 989,
  home: '/var/lib/teleagent-voice',
  shell: '/usr/sbin/nologin',
});

test('resolves only the exact private non-login teleagent-voice identity', () => {
  const identity = resolveVoiceRuntimeIdentity({
    platform: 'linux',
    currentUid: 1000,
    lookup(database, name) {
      assert.equal(name, 'teleagent-voice');
      return database === 'passwd'
        ? 'teleagent-voice:x:989:989:Teleagent:/var/lib/teleagent-voice:/usr/sbin/nologin'
        : 'teleagent-voice:x:989:';
    },
    supplementaryGroups: () => '989\n',
  });
  assert.deepEqual(identity, READY);
});

test('setup/start identity routing exempts only API-only installations', () => {
  let calls = 0;
  const resolver = () => {
    calls += 1;
    return READY;
  };
  assert.equal(resolveVoiceRuntimeIdentityForInstallation('api-server', resolver), null);
  assert.equal(calls, 0);
  assert.equal(resolveVoiceRuntimeIdentityForInstallation('voice-server', resolver), READY);
  assert.equal(resolveVoiceRuntimeIdentityForInstallation('both', resolver), READY);
  assert.equal(calls, 2);
});

test('never falls back to root, UID/GID 1000, the invoking owner, or a login account', () => {
  for (const identity of [
    { ...READY, uid: 0 },
    { ...READY, uid: 1000 },
    { ...READY, gid: 1000 },
    { ...READY, home: '/home/teleagent-voice' },
    { ...READY, shell: '/bin/bash' },
  ]) {
    assert.throws(
      () => normalizeVoiceRuntimeIdentity(identity),
      error => error instanceof VoiceRuntimeIdentityError &&
        /Provision the dedicated non-login teleagent-voice/.test(error.message),
    );
  }

  assert.throws(
    () => resolveVoiceRuntimeIdentity({
      platform: 'linux',
      currentUid: 989,
      lookup: (database) => database === 'passwd'
        ? 'teleagent-voice:x:989:989:Teleagent:/var/lib/teleagent-voice:/sbin/nologin'
        : 'teleagent-voice:x:989:',
      supplementaryGroups: () => '989',
    }),
    /reuses the invoking owner identity/,
  );
});

test('fails closed for missing, duplicate, mismatched, or shared identity records', () => {
  const cases = [
    {
      lookup: () => '',
      supplementaryGroups: () => '',
      pattern: /does not exist/,
    },
    {
      lookup: (database) => database === 'passwd'
        ? 'teleagent-voice:x:989:989:x:/var/lib/teleagent-voice:/sbin/nologin\nteleagent-voice:x:990:990:x:/var/lib/teleagent-voice:/sbin/nologin'
        : 'teleagent-voice:x:989:',
      supplementaryGroups: () => '989',
      pattern: /multiple records/,
    },
    {
      lookup: (database) => database === 'passwd'
        ? 'teleagent-voice:x:989:989:x:/var/lib/teleagent-voice:/sbin/nologin'
        : 'teleagent-voice:x:990:',
      supplementaryGroups: () => '989',
      pattern: /does not match/,
    },
    {
      lookup: (database) => database === 'passwd'
        ? 'teleagent-voice:x:989:989:x:/var/lib/teleagent-voice:/sbin/nologin'
        : 'teleagent-voice:x:989:alborz',
      supplementaryGroups: () => '989',
      pattern: /supplementary members/,
    },
    {
      lookup: (database) => database === 'passwd'
        ? 'teleagent-voice:x:989:989:x:/var/lib/teleagent-voice:/sbin/nologin'
        : 'teleagent-voice:x:989:',
      supplementaryGroups: () => '989 998',
      pattern: /supplementary groups/,
    },
  ];
  for (const scenario of cases) {
    assert.throws(
      () => resolveVoiceRuntimeIdentity({
        platform: 'linux',
        currentUid: 1000,
        lookup: scenario.lookup,
        supplementaryGroups: scenario.supplementaryGroups,
      }),
      scenario.pattern,
    );
  }
});

test('generated env must be single-link mode 0600 with exact identity and paths', () => {
  const source = [
    'VOICE_APP_UID=989',
    'VOICE_APP_GID=989',
    'DEVICE_CONFIG_DIR=/etc/teleagent-voice/config',
    'VOICE_STATE_DIR=/var/lib/teleagent-voice',
    'VOICE_APPROVAL_SIGNING_KEY_HOST_FILE=/etc/teleagent-voice/credentials/voice-approval-private.pem',
    'SIP_TRUNK_INGRESS_PASSWORD_HOST_FILE=/etc/teleagent-voice/credentials/sip-ingress-password',
    'SIP_TRUNK_CALLBACK_PASSWORD_HOST_FILE=/etc/teleagent-voice/credentials/sip-callback-password',
    '',
  ].join('\n');
  const safeFs = {
    lstatSync() {
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        nlink: 1,
        mode: 0o100600,
      };
    },
    readFileSync() { return source; },
  };
  assert.deepEqual(assertVoiceRuntimeEnvFile('/safe/.env', READY, safeFs), READY);

  for (const [stat, contents] of [
    [{ isFile: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o100644 }, source],
    [{ isFile: () => true, isSymbolicLink: () => false, nlink: 2, mode: 0o100600 }, source],
    [{ isFile: () => true, isSymbolicLink: () => true, nlink: 1, mode: 0o100600 }, source],
    [{ isFile: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o100600 }, source.replace('VOICE_APP_UID=989', 'VOICE_APP_UID=1000')],
    [{ isFile: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o100600 }, source.replace('/var/lib/teleagent-voice', '/tmp/owner-state')],
  ]) {
    assert.throws(
      () => assertVoiceRuntimeEnvFile('/unsafe/.env', READY, {
        lstatSync: () => stat,
        readFileSync: () => contents,
      }),
      /Dedicated voice runtime is not ready/,
    );
  }
});
