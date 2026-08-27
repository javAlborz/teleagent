'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SECRET_SPECS,
  RuntimeSecretError,
  clearRuntimeSecretsForTest,
  configureRuntimeSecrets,
  getRuntimeSecret,
  loadRuntimeSecrets,
} = require('../lib/runtime-secrets');

const VALUES = Object.freeze({
  drachtioSecret: 'drachtio_0123456789abcdef_ABCDEFGH',
  freeswitchSecret: 'freeswitch_9876543210fedcba_HGFEDCBA',
  executorApiToken: 'executor_0123456789abcdef_ABCDEFGH',
  voiceControlToken: 'voice_control_0123456789abcdef_ABCDEFGH',
  openaiRealtimeApiKey: 'sk-project-0123456789abcdef-ABCDEFGH',
  openaiSafetyIdentifierSalt: 'safety_0123456789abcdef_ABCDEFGH',
  outboundApiToken: 'outbound_0123456789abcdef_ABCDEFGH',
});

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-runtime-secrets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, spec] of Object.entries(SECRET_SPECS)) {
    const value = Object.hasOwn(overrides, name) ? overrides[name] : VALUES[name];
    if (value === null) continue;
    const filename = path.join(directory, spec.filename);
    fs.writeFileSync(filename, `${value}\n`, { mode: 0o440 });
    fs.chmodSync(filename, 0o440);
  }
  return directory;
}

function load(directory, options = {}) {
  return loadRuntimeSecrets({
    directory,
    expectedUid: process.geteuid(),
    expectedGid: process.getegid(),
    verifyAncestors: false,
    ...options,
  });
}

test('loads one immutable, pairwise-distinct runtime secret snapshot', (t) => {
  const directory = fixture(t);
  const secrets = load(directory);
  assert.deepEqual(secrets, VALUES);
  assert.ok(Object.isFrozen(secrets));
  configureRuntimeSecrets(secrets);
  assert.equal(getRuntimeSecret('executorApiToken'), VALUES.executorApiToken);
  clearRuntimeSecretsForTest();
  assert.throws(() => getRuntimeSecret('executorApiToken'), RuntimeSecretError);
});

test('required credentials fail closed when absent', (t) => {
  const missingCore = fixture(t, { executorApiToken: null });
  assert.throws(() => load(missingCore), { code: 'VOICE_RUNTIME_SECRET_UNREADABLE' });
});

test('voice runtime has no privileged-action credential slot', () => {
  assert.equal(Object.hasOwn(SECRET_SPECS, 'privilegedActionApiToken'), false);
  assert.throws(() => getRuntimeSecret('privilegedActionApiToken'), {
    code: 'VOICE_RUNTIME_SECRET_UNKNOWN',
  });
});

test('rejects symlinks, hard links, unsafe modes, placeholders, and reuse', (t) => {
  const cases = [
    {
      name: 'symlink',
      mutate(directory) {
        const target = path.join(directory, SECRET_SPECS.executorApiToken.filename);
        const replacement = `${target}.real`;
        fs.renameSync(target, replacement);
        fs.symlinkSync(replacement, target);
      },
      code: 'VOICE_RUNTIME_SECRET_UNREADABLE',
    },
    {
      name: 'hard link',
      mutate(directory) {
        const target = path.join(directory, SECRET_SPECS.executorApiToken.filename);
        fs.linkSync(target, `${target}.second-link`);
      },
      code: 'VOICE_RUNTIME_SECRET_METADATA',
    },
    {
      name: 'mode',
      mutate(directory) {
        fs.chmodSync(path.join(directory, SECRET_SPECS.executorApiToken.filename), 0o640);
      },
      code: 'VOICE_RUNTIME_SECRET_METADATA',
    },
    {
      name: 'placeholder',
      mutate(directory) {
        const target = path.join(directory, SECRET_SPECS.executorApiToken.filename);
        fs.chmodSync(target, 0o600);
        fs.writeFileSync(target, 'replace-with-example-executor-token-123456\n', { mode: 0o440 });
        fs.chmodSync(target, 0o440);
      },
      code: 'VOICE_RUNTIME_SECRET_INVALID',
    },
    {
      name: 'reuse',
      mutate(directory) {
        const target = path.join(directory, SECRET_SPECS.voiceControlToken.filename);
        fs.chmodSync(target, 0o600);
        fs.writeFileSync(target, `${VALUES.executorApiToken}\n`, { mode: 0o440 });
        fs.chmodSync(target, 0o440);
      },
      code: 'VOICE_RUNTIME_SECRET_REUSED',
    },
  ];

  for (const entry of cases) {
    const directory = fixture(t);
    entry.mutate(directory);
    assert.throws(() => load(directory), { code: entry.code }, entry.name);
  }
});

test('error text never includes credential contents', (t) => {
  const sentinel = 'replace-with-secret-sentinel-0123456789';
  const directory = fixture(t, { executorApiToken: sentinel });
  assert.throws(
    () => load(directory),
    (error) => error.code === 'VOICE_RUNTIME_SECRET_INVALID' && !error.message.includes(sentinel),
  );
});
