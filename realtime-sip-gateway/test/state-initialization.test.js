import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  initializeStateFiles,
  verifyInitializedStateFiles,
} from '../deploy/verify-realtime-sip-gateway';

function stateFixture(t) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'teleagent-sip-state-init-'));
  const stateRoot = path.join(parent, 'state');
  const configRoot = path.join(parent, 'config');
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(configRoot, { mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  chmodSync(configRoot, 0o700);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const markerPath = path.join(configRoot, 'STATE_INITIALIZED');
  const databasePath = path.join(stateRoot, 'gateway-state.sqlite3');
  const singletonPath = `${databasePath}.lifetime-lock.sqlite3`;
  const uid = process.getuid();
  const gid = process.getgid();
  const options = {
    stateRoot,
    configRoot,
    markerPath,
    databasePath,
    singletonPath,
    stateUid: uid,
    stateGid: gid,
    markerUid: uid,
    markerGid: gid,
  };
  return { ...options, options };
}

test('fresh initialization creates and fsyncs exact zero-length no-replace state files', (t) => {
  const context = stateFixture(t);
  const initialized = initializeStateFiles(context.options);
  assert.equal(initialized.created, true);
  for (const filename of [context.databasePath, context.singletonPath]) {
    const metadata = statSync(filename);
    assert.equal(metadata.size, 0);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal(metadata.nlink, 1);
  }
  const marker = statSync(context.markerPath);
  assert.equal(marker.mode & 0o777, 0o444);
  assert.equal(marker.nlink, 1);
  assert.match(readFileSync(context.markerPath, 'utf8'), /^version=1$/mu);
  assert.equal(verifyInitializedStateFiles(context.options).database.size, 0n);
});

test('reinstall preserves an initialized nonempty ledger and exact inode attestation', (t) => {
  const context = stateFixture(t);
  initializeStateFiles(context.options);
  const before = statSync(context.databasePath);
  writeFileSync(context.databasePath, 'durable admitted truth', { flag: 'a' });
  const preserved = initializeStateFiles(context.options);
  assert.equal(preserved.created, false);
  assert.equal(readFileSync(context.databasePath, 'utf8'), 'durable admitted truth');
  assert.equal(statSync(context.databasePath).ino, before.ino);
});

test('reinstall safely completes a crash-published two-link marker', (t) => {
  const context = stateFixture(t);
  initializeStateFiles(context.options);
  const companion = path.join(context.configRoot, '.STATE_INITIALIZED.tmp.123.456');
  linkSync(context.markerPath, companion);
  assert.equal(statSync(context.markerPath).nlink, 2);
  const recovered = initializeStateFiles(context.options);
  assert.equal(recovered.created, false);
  assert.equal(existsSync(companion), false);
  assert.equal(statSync(context.markerPath).nlink, 1);
});

test('missing or replaced initialized files refuse instead of recreating lost truth', (t) => {
  const missing = stateFixture(t);
  initializeStateFiles(missing.options);
  unlinkSync(missing.databasePath);
  assert.throws(() => initializeStateFiles(missing.options));
  assert.equal(existsSync(missing.databasePath), false);

  const replaced = stateFixture(t);
  initializeStateFiles(replaced.options);
  unlinkSync(replaced.singletonPath);
  writeFileSync(replaced.singletonPath, '', { mode: 0o600 });
  chmodSync(replaced.singletonPath, 0o600);
  assert.throws(
    () => initializeStateFiles(replaced.options),
    /do not match their initialization marker/u,
  );
});

test('nonempty unmarked mounts and tampered markers fail closed', (t) => {
  const unmarked = stateFixture(t);
  writeFileSync(path.join(unmarked.stateRoot, 'unmarked.sqlite3'), 'unknown', { mode: 0o600 });
  assert.throws(
    () => initializeStateFiles(unmarked.options),
    /unmarked durable-state mount is not empty/u,
  );
  assert.equal(existsSync(unmarked.markerPath), false);

  const tampered = stateFixture(t);
  initializeStateFiles(tampered.options);
  chmodSync(tampered.markerPath, 0o644);
  assert.throws(() => initializeStateFiles(tampered.options), /unsafe metadata/u);
});
