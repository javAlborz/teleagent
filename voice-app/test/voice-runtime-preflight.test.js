'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  VOICE_RUNTIME_PATHS,
  VoiceStateCapacityGuard,
  projectStateCapacityHealth,
  validateVoiceRuntimePreflight,
} = require('../lib/voice-runtime-preflight');
const { SECRET_PATHS } = require('../lib/runtime-secrets');
const { canonical, digest } = require('../../lib/media-receiver-runtime');
const { successEvidence } = require('../voice-runtime-preflight');

test('successful image preflight emits only the canonical TLS root digest', () => {
  const roots = ['-----BEGIN CERTIFICATE-----\nunit-test\n-----END CERTIFICATE-----'];
  assert.equal(successEvidence(roots), canonical({
    schema: 'teleagent.voice-preflight-ca-evidence.v1',
    caDigest: digest(canonical(roots)),
  }));
  assert.throws(() => successEvidence([]));
  assert.throws(() => successEvidence(['not a certificate']));
});

const UID = 989;
const GID = 989;
const INGRESS = 'ingress_0123456789abcdef_ABCDEFGH';
const CALLBACK = 'callback_9876543210fedcba_HGFEDCBA';
const RUNTIME_SECRETS = Object.freeze({
  [SECRET_PATHS.drachtioSecret]: 'drachtio_0123456789abcdef_ABCDEFGH',
  [SECRET_PATHS.freeswitchSecret]: 'freeswitch_9876543210fedcba_HGFEDCBA',
  [SECRET_PATHS.executorApiToken]: 'executor_0123456789abcdef_ABCDEFGH',
  [SECRET_PATHS.voiceControlToken]: 'voice_control_0123456789abcdef_ABCDEFGH',
  [SECRET_PATHS.openaiRealtimeApiKey]: 'sk-project-0123456789abcdef-ABCDEFGH',
  [SECRET_PATHS.openaiSafetyIdentifierSalt]: 'safety_0123456789abcdef_ABCDEFGH',
  [SECRET_PATHS.outboundApiToken]: 'outbound_0123456789abcdef_ABCDEFGH',
});

function metadata({
  type = 'file', uid = 0, gid = GID, mode = 0o440, nlink = 1, size = 64, dev = 100,
} = {}) {
  return {
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink',
    uid,
    gid,
    mode,
    nlink,
    size,
    dev,
  };
}

function buildFilesystem(overrides = {}) {
  const values = new Map([
    [VOICE_RUNTIME_PATHS.configDirectory, {
      stat: metadata({ type: 'directory', uid: 0, gid: GID, mode: 0o750, size: 0 }),
    }],
    [VOICE_RUNTIME_PATHS.stateDirectory, {
      stat: metadata({
        type: 'directory', uid: UID, gid: GID, mode: 0o700, size: 0, dev: 200,
      }),
      statfs: { bsize: 4096n, blocks: 1048576n, bavail: 524288n },
    }],
    [VOICE_RUNTIME_PATHS.deviceConfigFile, {
      value: Buffer.from('{"1001":{"extension":"1001"}}'),
    }],
    [VOICE_RUNTIME_PATHS.sipIngressCredential, { value: Buffer.from(INGRESS) }],
    [VOICE_RUNTIME_PATHS.sipCallbackCredential, { value: Buffer.from(CALLBACK) }],
    ...Object.entries(RUNTIME_SECRETS).map(([filename, value]) => [
      filename,
      { value: Buffer.from(value) },
    ]),
  ]);
  for (const [filename, change] of Object.entries(overrides)) {
    values.set(filename, { ...(values.get(filename) || {}), ...change });
  }
  for (const entry of values.values()) {
    if (!entry.stat && entry.value) entry.stat = metadata({ size: entry.value.length });
  }

  let nextDescriptor = 20;
  const descriptors = new Map();
  return {
    constants: fs.constants,
    lstatSync(filename) {
      const entry = values.get(filename);
      if (!entry) throw new Error('missing');
      return entry.stat;
    },
    statfsSync(filename) {
      const entry = values.get(filename);
      if (!entry?.statfs) throw new Error('missing');
      return entry.statfs;
    },
    openSync(filename) {
      const entry = values.get(filename);
      if (!entry) throw new Error('missing');
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, entry);
      return descriptor;
    },
    fstatSync(descriptor) { return descriptors.get(descriptor).stat; },
    readFileSync(descriptor) { return Buffer.from(descriptors.get(descriptor).value); },
    closeSync(descriptor) { descriptors.delete(descriptor); },
  };
}

test('preflight accepts only dedicated runtime paths and root:voice 0440 secrets', () => {
  assert.deepEqual(validateVoiceRuntimePreflight({
    fsModule: buildFilesystem(),
    effectiveUid: UID,
    effectiveGid: GID,
  }), { ok: true, uid: UID, gid: GID });
});

test('preflight requires a separate bounded state filesystem with a free-space reserve', () => {
  const statePath = VOICE_RUNTIME_PATHS.stateDirectory;
  const validState = metadata({
    type: 'directory', uid: UID, gid: GID, mode: 0o700, size: 0, dev: 200,
  });
  const invalid = [
    {
      stat: metadata({
        type: 'directory', uid: UID, gid: GID, mode: 0o700, size: 0, dev: 100,
      }),
      statfs: { bsize: 4096n, blocks: 1048576n, bavail: 524288n },
      message: /not on a dedicated bounded filesystem/,
    },
    {
      stat: validState,
      statfs: { bsize: 4096n, blocks: 2621440n, bavail: 2097152n },
      message: /4-8 GiB hard capacity/,
    },
    {
      stat: validState,
      statfs: { bsize: 4096n, blocks: 1048576n, bavail: 65536n },
      message: /free-space reserve is exhausted/,
    },
  ];
  for (const fixture of invalid) {
    assert.throws(() => validateVoiceRuntimePreflight({
      fsModule: buildFilesystem({ [statePath]: fixture }),
      effectiveUid: UID,
      effectiveGid: GID,
    }), fixture.message);
  }
});

test('runtime capacity guard reports bounded JSON-safe health and fails closed after exhaustion', () => {
  const healthy = new VoiceStateCapacityGuard({
    fsModule: buildFilesystem(),
    effectiveUid: UID,
    effectiveGid: GID,
  }).check();
  assert.deepEqual(healthy, {
    ok: true,
    code: null,
    capacityBytes: 4 * 1024 * 1024 * 1024,
    availableBytes: 2 * 1024 * 1024 * 1024,
    requiredFreeBytes: Math.ceil((4 * 1024 * 1024 * 1024) / 5),
  });
  assert.doesNotThrow(() => JSON.stringify(healthy));

  const exhausted = new VoiceStateCapacityGuard({
    fsModule: buildFilesystem({
      [VOICE_RUNTIME_PATHS.stateDirectory]: {
        statfs: { bsize: 4096n, blocks: 1048576n, bavail: 65536n },
      },
    }),
    effectiveUid: UID,
    effectiveGid: GID,
  }).check();
  assert.deepEqual(exhausted, {
    ok: false,
    code: 'VOICE_STATE_CAPACITY_EXHAUSTED',
  });
});

test('public capacity health projection exposes one exact fail-closed boolean', () => {
  assert.deepEqual(projectStateCapacityHealth({
    ok: true,
    code: null,
    capacityBytes: 4 * 1024 * 1024 * 1024,
    availableBytes: 2 * 1024 * 1024 * 1024,
    path: 'SENSITIVE_CAPACITY_PATH',
  }), { ok: true });
  assert.deepEqual(projectStateCapacityHealth({
    ok: false,
    code: 'VOICE_STATE_CAPACITY_EXHAUSTED',
    reason: 'SENSITIVE_CAPACITY_DIAGNOSTIC',
  }), { ok: false });
  assert.deepEqual(projectStateCapacityHealth({ ok: 'true' }), { ok: false });
  assert.deepEqual(projectStateCapacityHealth(null), { ok: false });
});

test('preflight rejects root, owner UID/GID 1000, and unsafe runtime paths', () => {
  for (const [effectiveUid, effectiveGid] of [[0, GID], [UID, 0], [1000, GID], [UID, 1000]]) {
    assert.throws(
      () => validateVoiceRuntimePreflight({
        fsModule: buildFilesystem(),
        effectiveUid,
        effectiveGid,
      }),
      /not the dedicated non-root teleagent-voice identity/,
    );
  }

  for (const [filename, stat] of [
    [VOICE_RUNTIME_PATHS.configDirectory, metadata({ type: 'directory', uid: UID, mode: 0o750 })],
    [VOICE_RUNTIME_PATHS.stateDirectory, metadata({ type: 'directory', uid: UID, mode: 0o750 })],
    [VOICE_RUNTIME_PATHS.deviceConfigFile, metadata({ uid: 0, gid: GID + 1, mode: 0o440 })],
  ]) {
    assert.throws(
      () => validateVoiceRuntimePreflight({
        fsModule: buildFilesystem({ [filename]: { stat } }),
        effectiveUid: UID,
        effectiveGid: GID,
      }),
      /metadata is unsafe/,
    );
  }
});

test('preflight rejects every SIP secret that is not root:exact-voice-gid 0440 single-link', () => {
  const secretFiles = [
    VOICE_RUNTIME_PATHS.sipIngressCredential,
    VOICE_RUNTIME_PATHS.sipCallbackCredential,
  ];
  for (const filename of secretFiles) {
    for (const change of [
      { uid: UID },
      { gid: GID + 1 },
      { mode: 0o400 },
      { mode: 0o640 },
      { nlink: 2 },
    ]) {
      assert.throws(
        () => validateVoiceRuntimePreflight({
          fsModule: buildFilesystem({
            [filename]: { stat: metadata({ ...change, size: 128 }) },
          }),
          effectiveUid: UID,
          effectiveGid: GID,
        }),
        /metadata is unsafe/,
      );
    }
  }
});

test('preflight rejects retired authority files, duplicate SIP credentials, and never logs material', () => {
  assert.throws(
    () => validateVoiceRuntimePreflight({
      fsModule: buildFilesystem({
        [VOICE_RUNTIME_PATHS.approvalPrivateKey]: {
          value: Buffer.from('retired-approval-authority-must-remain-absent'),
          stat: metadata({ size: 46 }),
        },
      }),
      effectiveUid: UID,
      effectiveGid: GID,
    }),
    /approval signing key must not be projected/,
  );
  assert.throws(
    () => validateVoiceRuntimePreflight({
      fsModule: buildFilesystem({
        [VOICE_RUNTIME_PATHS.privilegedActionBearer]: {
          value: Buffer.from('retired-privileged-bearer-must-remain-absent'),
          stat: metadata({ size: 44 }),
        },
      }),
      effectiveUid: UID,
      effectiveGid: GID,
    }),
    /privileged-action bearer must not be projected/,
  );
  assert.throws(
    () => validateVoiceRuntimePreflight({
      fsModule: buildFilesystem({
        [VOICE_RUNTIME_PATHS.sipCallbackCredential]: {
          value: Buffer.from(INGRESS),
          stat: metadata({ size: Buffer.byteLength(INGRESS) }),
        },
      }),
      effectiveUid: UID,
      effectiveGid: GID,
    }),
    /SIP trunk credentials are not distinct/,
  );

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'voice-runtime-preflight.js'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dedicated voice runtime rejected/);
  assert.doesNotMatch(result.stderr, new RegExp(`${INGRESS}|${CALLBACK}`));
});

test('privileged authority is rejected when its feature flag is enabled', () => {
  let observedRequired = null;
  const loader = ({ required }) => {
    observedRequired = required;
    return {};
  };

  assert.deepEqual(validateVoiceRuntimePreflight({
    fsModule: buildFilesystem(),
    effectiveUid: UID,
    effectiveGid: GID,
    privilegedActionsEnabled: 'false',
    runtimeSecretLoader: loader,
  }), { ok: true, uid: UID, gid: GID });
  assert.deepEqual(observedRequired, []);

  assert.throws(() => validateVoiceRuntimePreflight({
    fsModule: buildFilesystem(),
    effectiveUid: UID,
    effectiveGid: GID,
    privilegedActionsEnabled: 'true',
    runtimeSecretLoader: loader,
  }), /independent approval attester/);
  assert.deepEqual(observedRequired, []);
});

test('SIP credentials cannot reuse runtime secrets and device authentication is always rejected', () => {
  const runtimeSecrets = { executorApiToken: INGRESS };
  assert.throws(() => validateVoiceRuntimePreflight({
    fsModule: buildFilesystem(),
    effectiveUid: UID,
    effectiveGid: GID,
    runtimeSecretLoader: () => runtimeSecrets,
  }), (error) => (
    /SIP ingress credential must be distinct/.test(error.message) &&
    !error.message.includes(INGRESS)
  ));

  const deviceSentinel = 'device_0123456789abcdef_ABCDEFGH';
  assert.throws(() => validateVoiceRuntimePreflight({
    fsModule: buildFilesystem({
      [VOICE_RUNTIME_PATHS.deviceConfigFile]: {
        value: Buffer.from(JSON.stringify({ 1001: { password: deviceSentinel } })),
        stat: metadata({ size: 72 }),
      },
    }),
    effectiveUid: UID,
    effectiveGid: GID,
    runtimeSecretLoader: () => ({ outboundApiToken: deviceSentinel }),
  }), (error) => /device configuration is invalid/.test(error.message) &&
    !error.message.includes(deviceSentinel));
});

test('preflight rejects every legacy device authentication field before startup', () => {
  for (const document of [
    { 1001: { password: INGRESS } },
    { 1001: { authId: '1001' } },
    { 1001: { authPassword: 'shared_device_0123456789abcdef_ABCDEFGH' } },
  ]) {
    const serialized = Buffer.from(JSON.stringify(document));
    assert.throws(() => validateVoiceRuntimePreflight({
      fsModule: buildFilesystem({
        [VOICE_RUNTIME_PATHS.deviceConfigFile]: {
          value: serialized,
          stat: metadata({ size: serialized.length }),
        },
      }),
      effectiveUid: UID,
      effectiveGid: GID,
      runtimeSecretLoader: () => ({}),
    }), (error) => /device configuration is invalid/.test(error.message) &&
      !error.message.includes(INGRESS) &&
      !error.message.includes('shared_device_'));
  }
});
