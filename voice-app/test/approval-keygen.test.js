'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateKeyPairFiles } = require('../../scripts/generate-voice-approval-keypair');

test('approval key generator creates a matching pair without replacing files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-keygen-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const privateKeyFile = path.join(directory, 'private.pem');
  const publicKeyFile = path.join(directory, 'public.pem');

  generateKeyPairFiles({ privateKeyFile, publicKeyFile });

  assert.equal(fs.statSync(privateKeyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(publicKeyFile).mode & 0o777, 0o600);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyFile));
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyFile));
  const message = Buffer.from('approval-key-self-test');
  assert.equal(crypto.verify(null, message, publicKey, crypto.sign(null, message, privateKey)), true);
  assert.throws(
    () => generateKeyPairFiles({ privateKeyFile, publicKeyFile }),
    /Refusing to replace/
  );
});

test('approval key generator rejects relative paths and symlink directories', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-keygen-links-'));
  const realDirectory = path.join(directory, 'real');
  const linkedDirectory = path.join(directory, 'linked');
  fs.mkdirSync(realDirectory, { mode: 0o700 });
  fs.symlinkSync(realDirectory, linkedDirectory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.throws(
    () => generateKeyPairFiles({ privateKeyFile: 'private.pem', publicKeyFile: 'public.pem' }),
    /absolute path/
  );
  assert.throws(
    () => generateKeyPairFiles({
      privateKeyFile: path.join(linkedDirectory, 'private.pem'),
      publicKeyFile: path.join(linkedDirectory, 'public.pem'),
    }),
    /trusted directory/
  );
});
