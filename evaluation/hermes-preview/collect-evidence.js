#!/usr/bin/env node
'use strict';

const { readAggregateEvidence } = require('./aggregate-store');
const { readTrialEpoch } = require('./runtime-files');

const TRIAL_EPOCH_FILE = '/run/teleagent-evaluation-epoch';

function main() {
  try {
    const trialEpoch = readTrialEpoch(TRIAL_EPOCH_FILE);
    const now = new Date();
    const evidence = readAggregateEvidence({ now, trialEpoch });
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch {
    process.stderr.write('Hermes evidence collection failed closed.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { TRIAL_EPOCH_FILE };
