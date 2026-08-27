'use strict';

const fs = require('node:fs');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TRIAL_EPOCH_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u;

function readOwnedExactFile(filePath, { size, pattern }) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1 ||
        (metadata.mode & 0o777) !== 0o600 || metadata.size !== size) {
      throw new Error('unsafe runtime file');
    }
    const value = fs.readFileSync(descriptor, 'utf8');
    if (!pattern.test(value)) throw new Error('invalid runtime file');
    return value;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readLaunchToken(filePath) {
  return readOwnedExactFile(filePath, { size: 43, pattern: TOKEN_PATTERN });
}

function readTrialEpoch(filePath) {
  const value = readOwnedExactFile(filePath, { size: 24, pattern: TRIAL_EPOCH_PATTERN });
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('invalid trial epoch');
  }
  return value;
}

module.exports = {
  TOKEN_PATTERN,
  TRIAL_EPOCH_PATTERN,
  readLaunchToken,
  readOwnedExactFile,
  readTrialEpoch,
};
