'use strict';

const { loadRuntimeSecrets } = require('./lib/runtime-secrets');

try {
  loadRuntimeSecrets();
  process.stdout.write('Media control configuration is valid.\n');
} catch (error) {
  process.stderr.write(`Media control configuration rejected: ${error.message}\n`);
  process.exitCode = 1;
}
