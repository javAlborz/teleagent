'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MemoryCapabilityReplayStore,
  createApprovalCapabilityVerifier,
  generateApprovalCapabilityKeyPair,
  hashApprovalPlan,
} = require('../../lib/voice-approval-capability');
const {
  loadApprovalCapabilityConfig,
} = require('../lib/approval-capability-config');

function withKeyFile(t, { mode = 0o600, contents = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-approval-config-'));
  const keyFile = path.join(directory, 'controller-private.pem');
  const keys = generateApprovalCapabilityKeyPair();
  fs.writeFileSync(keyFile, contents || keys.privateKey, { mode });
  fs.chmodSync(keyFile, mode);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, keyFile, keys };
}

function enabledEnv(keyFile, overrides = {}) {
  return {
    VOICE_APPROVAL_CAPABILITY_ENABLED: 'true',
    VOICE_APPROVAL_SIGNING_KEY_FILE: keyFile,
    VOICE_APPROVAL_SIGNING_KEY_ID: 'controller-test-1',
    VOICE_APPROVAL_CAPABILITY_TTL_SECONDS: '90',
    ...overrides,
  };
}

function secureKeyFs(contents, metadataOverrides = {}) {
  const value = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  return {
    constants: fs.constants,
    openSync() { return 42; },
    fstatSync() {
      return {
        isFile: () => true,
        mode: 0o100440,
        uid: 0,
        gid: typeof process.getegid === 'function' ? process.getegid() : 0,
        nlink: 1,
        size: value.length,
        ...metadataOverrides,
      };
    },
    readFileSync() { return value; },
    closeSync() {},
  };
}

test('production voice runtime cannot load an issuer or privileged bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /require\(["']\.\/lib\/approval-capability-config["']\)/u);
  assert.doesNotMatch(source, /require\(["']\.\/lib\/privileged-action-(?:bridge|config)["']\)/u);
  assert.doesNotMatch(source, /loadApprovalCapabilityConfig\s*\(/u);
  assert.doesNotMatch(source, /loadPrivilegedActionConfig\s*\(/u);
  assert.match(source, /approvalCapabilityIssuer:\s*null/u);
  assert.match(source, /privilegedActionBridge:\s*null/u);
});

test('disabled capability configuration does not read a key and leaves mutations fail closed', () => {
  let opened = false;
  const config = loadApprovalCapabilityConfig({
    env: { VOICE_APPROVAL_CAPABILITY_ENABLED: 'false' },
    fsModule: {
      openSync() { opened = true; },
    },
  });
  assert.deepEqual(config, {
    enabled: false,
    issuer: null,
    keyId: null,
    ttlSeconds: null,
  });
  assert.equal(opened, false);
});

test('enabled configuration securely loads a root:voice 0440 Ed25519 issuer', async () => {
  const keys = generateApprovalCapabilityKeyPair();
  const config = loadApprovalCapabilityConfig({
    env: enabledEnv('/run/secrets/controller-private.pem'),
    fsModule: secureKeyFs(keys.privateKey),
  });
  assert.equal(config.enabled, true);
  assert.equal(config.keyId, 'controller-test-1');
  assert.equal(config.ttlSeconds, 90);
  assert.equal(Object.hasOwn(config, 'privateKey'), false);

  const requestHash = crypto.createHash('sha256').update('Restart preview.').digest('hex');
  const planHash = hashApprovalPlan({ command: ['systemctl', 'restart', 'preview'] });
  const bindings = {
    jobId: 'job_config_test',
    requestHash,
    planHash,
    target: 'hermes',
    provider: 'codex',
    profile: 'codex-sol',
  };
  const token = config.issuer.issue(bindings);
  const verifier = createApprovalCapabilityVerifier({
    publicKeys: { 'controller-test-1': keys.publicKey },
    replayStore: new MemoryCapabilityReplayStore(),
  });
  const consumed = await verifier.consume(token, bindings);
  assert.equal(consumed.exp - consumed.iat, 90);
});

test('private PEM bytes are cleared after construction and never returned from configuration', () => {
  const keys = generateApprovalCapabilityKeyPair();
  const privateKeyBuffer = Buffer.from(keys.privateKey, 'utf8');
  const fsModule = {
    constants: fs.constants,
    openSync() { return 42; },
    fstatSync() {
      return {
        isFile: () => true,
        mode: 0o100440,
        uid: 0,
        gid: typeof process.getegid === 'function' ? process.getegid() : 0,
        nlink: 1,
        size: privateKeyBuffer.length,
      };
    },
    readFileSync() { return privateKeyBuffer; },
    closeSync() {},
  };
  const config = loadApprovalCapabilityConfig({
    env: enabledEnv('/run/secrets/test-private.pem'),
    fsModule,
  });

  assert.equal(config.enabled, true);
  assert.equal([...privateKeyBuffer].every(byte => byte === 0), true);
  assert.equal(Object.hasOwn(config, 'privateKey'), false);
});

test('enabled configuration fails closed for missing or malformed settings', t => {
  const { keyFile } = withKeyFile(t);
  const cases = [
    [{ VOICE_APPROVAL_CAPABILITY_ENABLED: 'sometimes' }, 'APPROVAL_CAPABILITY_INVALID_ENABLED'],
    [{ VOICE_APPROVAL_CAPABILITY_ENABLED: 'true' }, 'APPROVAL_CAPABILITY_CONFIG_MISSING'],
    [enabledEnv(keyFile, { VOICE_APPROVAL_SIGNING_KEY_ID: '' }), 'APPROVAL_CAPABILITY_CONFIG_MISSING'],
    [enabledEnv(keyFile, { VOICE_APPROVAL_SIGNING_KEY_ID: 'invalid key id' }), 'APPROVAL_CAPABILITY_KEY_ID_INVALID'],
    [enabledEnv('relative/private.pem'), 'APPROVAL_CAPABILITY_KEY_PATH_INVALID'],
    [enabledEnv(keyFile, { VOICE_APPROVAL_CAPABILITY_TTL_SECONDS: '0' }), 'APPROVAL_CAPABILITY_INVALID_TTL'],
    [enabledEnv(keyFile, { VOICE_APPROVAL_CAPABILITY_TTL_SECONDS: '301' }), 'APPROVAL_CAPABILITY_INVALID_TTL'],
  ];
  for (const [env, code] of cases) {
    assert.throws(
      () => loadApprovalCapabilityConfig({ env }),
      error => error.code === code
    );
  }
});

test('key loading rejects broad permissions, symlinks, non-files, and non-Ed25519 keys', t => {
  const broad = withKeyFile(t, { mode: 0o644 });
  assert.throws(
    () => loadApprovalCapabilityConfig({ env: enabledEnv(broad.keyFile) }),
    error => error.code === 'APPROVAL_CAPABILITY_KEY_PERMISSIONS'
  );

  const linked = withKeyFile(t);
  const symlink = path.join(linked.directory, 'linked-private.pem');
  fs.symlinkSync(linked.keyFile, symlink);
  assert.throws(
    () => loadApprovalCapabilityConfig({ env: enabledEnv(symlink) }),
    error => error.code === 'APPROVAL_CAPABILITY_KEY_UNREADABLE'
  );

  assert.throws(
    () => loadApprovalCapabilityConfig({ env: enabledEnv(linked.directory) }),
    error => ['APPROVAL_CAPABILITY_KEY_INVALID', 'APPROVAL_CAPABILITY_KEY_UNREADABLE'].includes(error.code)
  );

  const rsa = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  assert.throws(
    () => loadApprovalCapabilityConfig({
      env: enabledEnv('/run/secrets/wrong-algorithm.pem'),
      fsModule: secureKeyFs(rsa.privateKey),
    }),
    error => error.code === 'APPROVAL_CAPABILITY_KEY_INVALID'
  );

  const valid = generateApprovalCapabilityKeyPair();
  for (const metadata of [
    { uid: 1000 },
    { gid: (typeof process.getegid === 'function' ? process.getegid() : 0) + 1 },
    { nlink: 2 },
  ]) {
    assert.throws(
      () => loadApprovalCapabilityConfig({
        env: enabledEnv('/run/secrets/unsafe-owner.pem'),
        fsModule: secureKeyFs(valid.privateKey, metadata),
      }),
      error => error.code === 'APPROVAL_CAPABILITY_KEY_OWNER'
    );
  }
});

test('key errors never contain configured key contents', () => {
  const marker = 'DO-NOT-LOG-PRIVATE-KEY-MARKER';
  const keyFile = '/run/secrets/invalid-private.pem';
  assert.throws(
    () => loadApprovalCapabilityConfig({
      env: enabledEnv(keyFile),
      fsModule: secureKeyFs(`${marker}\n${'x'.repeat(80)}\n`, { size: 128 }),
    }),
    error => {
      assert.equal(JSON.stringify(error).includes(marker), false);
      assert.equal(error.message.includes(keyFile), false);
      return error.code === 'APPROVAL_CAPABILITY_KEY_INVALID';
    }
  );
});
