#!/usr/bin/env node
'use strict';

const { readLoopbackHealth } = require('./health');

async function main() {
  try {
    const health = await readLoopbackHealth();
    process.stdout.write(`${JSON.stringify(health)}\n`);
  } catch {
    process.stderr.write('Hermes health collection failed closed.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
