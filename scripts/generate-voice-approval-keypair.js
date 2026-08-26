#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function absoluteFile(value, label) {
  const filename = String(value || '').trim();
  if (!filename || !path.isAbsolute(filename) || filename.includes('\0')) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.normalize(filename);
}

function writeNewSecret(filename, data, mode) {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
    mode
  );
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, mode);
  } finally {
    fs.closeSync(descriptor);
  }
}

function generateKeyPairFiles({ privateKeyFile, publicKeyFile }) {
  const privateFilename = absoluteFile(privateKeyFile, 'Private key file');
  const publicFilename = absoluteFile(publicKeyFile, 'Public key file');
  if (privateFilename === publicFilename) {
    throw new Error('Private and public key files must be different.');
  }
  for (const filename of [privateFilename, publicFilename]) {
    const parent = path.dirname(filename);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error(`Key directory is not a trusted directory: ${parent}`);
    }
    if (fs.existsSync(filename)) {
      throw new Error(`Refusing to replace an existing key file: ${filename}`);
    }
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  let privateCreated = false;
  try {
    writeNewSecret(privateFilename, privateKey, 0o600);
    privateCreated = true;
    writeNewSecret(publicFilename, publicKey, 0o600);
  } catch (error) {
    if (privateCreated && !fs.existsSync(publicFilename)) {
      try {
        fs.unlinkSync(privateFilename);
      } catch {
        // Preserve the original failure. A partial private file is still mode 0600.
      }
    }
    throw error;
  }

  return Object.freeze({ privateKeyFile: privateFilename, publicKeyFile: publicFilename });
}

if (require.main === module) {
  try {
    const [privateKeyFile, publicKeyFile] = process.argv.slice(2);
    if (!privateKeyFile || !publicKeyFile) {
      throw new Error('Usage: generate-voice-approval-keypair.js PRIVATE_KEY_FILE PUBLIC_KEY_FILE');
    }
    const result = generateKeyPairFiles({ privateKeyFile, publicKeyFile });
    console.log(`Created private approval signing key: ${result.privateKeyFile}`);
    console.log(`Created public approval verification key: ${result.publicKeyFile}`);
  } catch (error) {
    console.error(`Approval key generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { generateKeyPairFiles };
