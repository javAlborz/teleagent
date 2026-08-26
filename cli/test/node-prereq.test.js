import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkNode,
  REQUIRED_NODE_VERSION
} from '../lib/prereqs/checks/node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const deployedPackages = [
  '.',
  'claude-api-server',
  'voice-app',
  'privileged-action-broker',
  'realtime-sip-gateway'
];

test('deployed services require the supported Node 24 LTS line', async () => {
  const result = await checkNode({}, {
    execNodeVersion: () => 'v24.0.0\n'
  });

  assert.equal(REQUIRED_NODE_VERSION, '24.0.0');
  assert.equal(result.passed, true);
  assert.equal(result.required, '>=24.0.0');
});

test('the retired Node 20 and 22 service runtimes fail readiness', async () => {
  for (const version of ['v20.20.2\n', 'v22.22.0\n', 'v23.11.1\n']) {
    const result = await checkNode({}, {
      execNodeVersion: () => version
    });
    assert.equal(result.passed, false, version.trim());
    assert.equal(result.canAutoFix, true, version.trim());
  }
});

test('every deployed package lock and the voice image share the Node 24 contract', () => {
  for (const directory of deployedPackages) {
    const packageDirectory = path.join(repoRoot, directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package-lock.json'), 'utf8'));
    assert.equal(manifest.engines.node, '>=24.0.0', directory);
    assert.equal(lock.packages[''].engines.node, '>=24.0.0', `${directory} lock`);
  }

  const dockerfile = fs.readFileSync(path.join(repoRoot, 'voice-app/Dockerfile'), 'utf8');
  const expectedBase = 'node:24-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
  assert.equal(dockerfile.match(/^FROM /gm)?.length, 2);
  assert.equal(dockerfile.match(new RegExp(expectedBase, 'g'))?.length, 2);
  assert.doesNotMatch(dockerfile, /FROM\s+node:(?:18|20|22|23)(?:\D|$)/);
});
