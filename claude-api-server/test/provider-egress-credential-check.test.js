'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const credentialCheck = require(
  '../../deploy/worker-session/teleagent-provider-egress-credential-check'
);

function preflightFixture() {
  const releaseRoot = `/opt/teleagent/releases/sha256-${'c'.repeat(64)}`;
  const environment = {
    TELEAGENT_RELEASE_ROOT: releaseRoot,
    TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD: '23',
    TELEAGENT_PREFLIGHT_PROVIDER_CREDENTIAL_FD: '24',
  };
  const lock = {
    dev: 9,
    ino: 17,
    uid: 0,
    gid: 0,
    mode: 0o40755,
    isDirectory: () => true,
  };
  const credential = {
    dev: 10,
    ino: 18,
    uid: 1001,
    gid: 1001,
    mode: 0o100400,
    nlink: 1,
    size: 36,
    mtimeMs: 17,
    ctimeMs: 18,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  return {
    environment,
    filesystem: {
      realpathSync: (filename) => filename,
      fstatSync: (descriptor) => ({ ...(descriptor === 23 ? lock : credential) }),
      lstatSync: () => ({ ...lock }),
    },
    executable: `${releaseRoot}/runtime/node/bin/node`,
    invokedScript: `${releaseRoot}/deploy/worker-session/` +
      'teleagent-provider-egress-credential-check',
    execArguments: [],
    uid: 0,
  };
}

test('provider credential preflight requires bundled Node and the retained exact lock', () => {
  const valid = preflightFixture();
  assert.deepEqual(credentialCheck.requireImmutablePreflight(valid), {
    lockDescriptor: 23,
    credentialDescriptor: 24,
  });
  assert.equal(valid.environment.TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD, undefined);
  assert.equal(valid.environment.TELEAGENT_PREFLIGHT_PROVIDER_CREDENTIAL_FD, undefined);

  for (const mutate of [
    (input) => { input.executable = '/usr/local/libexec/teleagent-node'; },
    (input) => {
      input.invokedScript = '/usr/local/libexec/teleagent-provider-egress-credential-check';
    },
    (input) => { input.environment.TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD = '0'; },
    (input) => { input.environment.TELEAGENT_PREFLIGHT_PROVIDER_CREDENTIAL_FD = '23'; },
    (input) => { input.uid = 1000; },
    (input) => {
      input.filesystem = {
        ...input.filesystem,
        fstatSync: () => ({
          dev: 9, ino: 18, uid: 0, gid: 0, mode: 0o40755, isDirectory: () => true,
        }),
      };
    },
  ]) {
    const input = preflightFixture();
    mutate(input);
    assert.throws(
      () => credentialCheck.requireImmutablePreflight(input),
      /immutable release|retained lock|escaped|lock (?:descriptor|identity)|projected provider credential/u,
    );
  }
});

test('projected provider credential read is descriptor-stable and bounded', () => {
  const credential = 'claude-valid-token-7fN2wQ9xJ4mK8pR6';
  const metadata = {
    dev: 10,
    ino: 18,
    uid: 1001,
    gid: 1001,
    mode: 0o100400,
    nlink: 1,
    size: Buffer.byteLength(credential),
    mtimeMs: 17,
    ctimeMs: 18,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  let fstatCalls = 0;
  const filesystem = {
    fstatSync: (descriptor) => {
      assert.equal(descriptor, 24);
      fstatCalls += 1;
      return { ...metadata };
    },
    readFileSync: (descriptor) => {
      assert.equal(descriptor, 24);
      return Buffer.from(credential);
    },
  };
  assert.equal(
    credentialCheck.readStableProjectedCredential(24, filesystem),
    credential,
  );
  assert.equal(fstatCalls, 2);

  let changingCalls = 0;
  const changingFilesystem = {
    ...filesystem,
    fstatSync: () => ({
      ...metadata,
      ctimeMs: changingCalls++ === 0 ? metadata.ctimeMs : metadata.ctimeMs + 1,
    }),
  };
  assert.throws(
    () => credentialCheck.readStableProjectedCredential(24, changingFilesystem),
    /changed or has unsafe metadata/u,
  );
});

test('live provider credential read is no-follow and descriptor-stable', () => {
  const credential = 'claude-valid-token-7fN2wQ9xJ4mK8pR6';
  const metadata = {
    dev: 11,
    ino: 19,
    uid: 0,
    gid: 0,
    mode: 0o100600,
    nlink: 1,
    size: Buffer.byteLength(credential),
    mtimeMs: 21,
    ctimeMs: 22,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  let openFlags;
  let closed = false;
  const filesystem = {
    constants: fs.constants,
    openSync: (filename, flags) => {
      assert.equal(filename, '/fixed/claude.api-key');
      openFlags = flags;
      return 25;
    },
    fstatSync: (descriptor) => {
      assert.equal(descriptor, 25);
      return { ...metadata };
    },
    readFileSync: (descriptor) => {
      assert.equal(descriptor, 25);
      return Buffer.from(credential);
    },
    closeSync: (descriptor) => {
      assert.equal(descriptor, 25);
      closed = true;
    },
  };
  assert.equal(
    credentialCheck.readStableLiveCredential('/fixed/claude.api-key', filesystem),
    credential,
  );
  assert.notEqual(openFlags & fs.constants.O_NOFOLLOW, 0);
  assert.equal(closed, true);

  let changingCalls = 0;
  assert.throws(
    () => credentialCheck.readStableLiveCredential('/fixed/claude.api-key', {
      ...filesystem,
      fstatSync: () => ({
        ...metadata,
        ino: changingCalls++ === 0 ? metadata.ino : metadata.ino + 1,
      }),
    }),
    /identity is unsafe/u,
  );
  assert.throws(
    () => credentialCheck.readStableLiveCredential('/fixed/claude.api-key', {
      ...filesystem,
      fstatSync: () => ({ ...metadata, mode: 0o100640 }),
    }),
    /mode, size, or identity is unsafe/u,
  );
});

test('main binds the exact provider and compares projected and live descriptor bytes', () => {
  const claude = 'claude-valid-token-7fN2wQ9xJ4mK8pR6';
  const codex = 'codex-valid-token-3vT8zP5sL1nD9qW7';
  const credentialMetadata = (descriptor) => ({
    dev: descriptor === 24 ? 10 : 11,
    ino: descriptor,
    uid: descriptor === 24 ? 1001 : 0,
    gid: descriptor === 24 ? 1001 : 0,
    mode: descriptor === 24 ? 0o100400 : 0o100600,
    nlink: 1,
    size: Buffer.byteLength(descriptor === 32 ? codex : claude),
    mtimeMs: 23,
    ctimeMs: 24,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const opened = [];
  const closed = [];
  const environment = { FIXTURE: 'main-success' };
  const filesystem = {
    constants: fs.constants,
    lstatSync: (filename) => {
      assert.equal(filename, '/etc/teleagent/provider-egress-secrets');
      return {
        uid: 0,
        gid: 0,
        mode: 0o40700,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    realpathSync: (filename) => filename,
    openSync: (filename, flags) => {
      assert.notEqual(flags & fs.constants.O_NOFOLLOW, 0);
      opened.push(filename);
      return filename.endsWith('/claude.api-key') ? 31 : 32;
    },
    fstatSync: (descriptor) => credentialMetadata(descriptor),
    readFileSync: (descriptor) => Buffer.from(descriptor === 32 ? codex : claude),
    closeSync: (descriptor) => closed.push(descriptor),
  };
  let preflightCalls = 0;
  assert.doesNotThrow(() => credentialCheck.main({
    filesystem,
    environment,
    uid: 0,
    argv: ['node', 'teleagent-provider-egress-credential-check', 'claude'],
    requirePreflight: (input) => {
      preflightCalls += 1;
      assert.equal(input.environment, environment);
      assert.equal(input.filesystem, filesystem);
      return { lockDescriptor: 23, credentialDescriptor: 24 };
    },
  }));
  assert.equal(preflightCalls, 1);
  assert.deepEqual(opened, [
    '/etc/teleagent/provider-egress-secrets/claude.api-key',
    '/etc/teleagent/provider-egress-secrets/codex.api-key',
  ]);
  assert.deepEqual(closed, [31, 32]);
});

test('provider credential validation rejects placeholders and equal provider secrets', () => {
  const claude = 'claude-valid-token-7fN2wQ9xJ4mK8pR6';
  const codex = 'codex-valid-token-3vT8zP5sL1nD9qW7';
  assert.equal(credentialCheck.validateProviderCredential(claude), claude);
  assert.equal(credentialCheck.providerCredentialsEqual(claude, codex), false);
  assert.equal(credentialCheck.providerCredentialsEqual(claude, claude), true);
  assert.doesNotThrow(() => credentialCheck.validateCredentialSnapshot(
    'claude',
    claude,
    { claude, codex },
  ));
  assert.throws(
    () => credentialCheck.validateCredentialSnapshot(
      'claude',
      codex,
      { claude, codex },
    ),
    /differs from the live selected credential/u,
  );
  assert.throws(
    () => credentialCheck.validateCredentialSnapshot(
      'claude',
      claude,
      { claude, codex: claude },
    ),
    /must be distinct/u,
  );
  assert.throws(
    () => credentialCheck.validateProviderCredential('replace-with-your-api-key'),
    /invalid/u,
  );
});
