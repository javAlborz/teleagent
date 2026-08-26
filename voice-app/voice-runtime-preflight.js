'use strict';

const { validateVoiceRuntimePreflight } = require('./lib/voice-runtime-preflight');

try {
  validateVoiceRuntimePreflight();
  process.stdout.write('Dedicated voice runtime is ready.\n');
} catch (error) {
  process.stderr.write(`Dedicated voice runtime rejected: ${error.message}\n`);
  process.exitCode = 1;
}
