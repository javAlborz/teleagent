'use strict';

const { validateVoiceRuntimePreflight } = require('./lib/voice-runtime-preflight');
const tls = require('node:tls');
const { canonical, digest } = require('../lib/media-receiver-runtime');

function successEvidence(certificates = tls.rootCertificates) {
  if (!Array.isArray(certificates) || certificates.length === 0 ||
      !certificates.every((value) => typeof value === 'string' && value.startsWith('-----BEGIN CERTIFICATE-----'))) {
    throw new Error('the image TLS roots are unavailable');
  }
  return canonical({ schema: 'teleagent.voice-preflight-ca-evidence.v1',
    caDigest: digest(canonical(certificates)) });
}

if (require.main === module) {
  try {
    validateVoiceRuntimePreflight();
    process.stdout.write(`${successEvidence()}\n`);
  } catch (error) {
    process.stderr.write(`Dedicated voice runtime rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { successEvidence };
