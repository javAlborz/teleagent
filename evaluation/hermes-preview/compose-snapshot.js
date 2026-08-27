#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const { composeSnapshot } = require('./snapshot-schema');

const EVIDENCE_FILE = '/input/evidence.json';
const HEALTH_FILE = '/input/health.json';
const MAX_INPUT_BYTES = 64 * 1024;

function readJson(filePath) {
  const body = fs.readFileSync(filePath, 'utf8');
  if (!body || Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error('invalid input');
  return JSON.parse(body);
}

function main() {
  try {
    const snapshot = composeSnapshot({
      evidence: readJson(EVIDENCE_FILE),
      health: readJson(HEALTH_FILE),
    });
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  } catch {
    process.stderr.write('Hermes snapshot composition failed closed.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { EVIDENCE_FILE, HEALTH_FILE, MAX_INPUT_BYTES };
