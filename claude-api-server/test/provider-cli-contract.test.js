'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'worker-session');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DEPLOY, name), 'utf8'));
}

test('provider CLI artifacts and capture versions are exact and mutually consistent', () => {
  const manifest = readJson('provider-cli.manifest.json');
  const capture = readJson('provider-cli-wire-capture.json');
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.artifacts.map((entry) => entry.id), [
    'claude', 'codex-wrapper', 'codex-vendor',
  ]);
  const artifacts = Object.fromEntries(manifest.artifacts.map((entry) => [entry.id, entry]));
  assert.equal(artifacts.claude.versionStdout, capture.clients.claude.version);
  assert.equal(artifacts.claude.sha256, capture.clients.claude.sha256);
  assert.equal(artifacts['codex-wrapper'].versionStdout, capture.clients.codex.version);
  assert.equal(artifacts['codex-vendor'].versionStdout, capture.clients.codex.version);
  assert.equal(artifacts['codex-vendor'].sha256, capture.clients.codex.vendorSha256);

  const wrapper = fs.readFileSync(path.join(DEPLOY, 'teleagent-codex-cli-wrapper'));
  assert.equal(
    crypto.createHash('sha256').update(wrapper).digest('hex'),
    artifacts['codex-wrapper'].sha256,
  );
  assert.equal(artifacts['codex-wrapper'].source,
    '/usr/local/libexec/teleagent-provider-codex-cli-wrapper');
  assert.match(wrapper.toString('utf8'),
    /exec \/opt\/teleagent\/agent-tools\/codex-vendor "\$@"/);
});

test('checked-in wire capture keeps unobserved routes fail closed', () => {
  const capture = readJson('provider-cli-wire-capture.json');
  assert.equal(capture.captureMode, 'clean-home-loopback-fake-upstream-initial-request');
  assert.equal(capture.credentials, 'synthetic-local-sentinel-only');
  assert.equal(capture.clients.codex.responsesCompactObserved, false);
  assert.ok(capture.promotionLimitations.some((entry) => entry.includes('/v1/responses/compact')));

  const codexModels = capture.clients.codex.requests.map((entry) => [
    entry.model, entry.reasoningEffort,
  ]);
  assert.deepEqual(codexModels, [
    ['gpt-5.6-luna', 'low'],
    ['gpt-5.6-terra', 'medium'],
    ['gpt-5.6-sol', 'high'],
  ]);
  assert.deepEqual(capture.clients.codex.commonContract.query, []);
  assert.equal(capture.clients.codex.commonContract.path, '/v1/responses');
  assert.equal(capture.clients.codex.commonContract.reasoningContext, 'all_turns');
  assert.equal(capture.clients.codex.commonContract.parallelToolCalls, false);
  assert.equal(capture.clients.codex.commonContract.textVerbosity, 'low');
  assert.deepEqual(capture.clients.codex.commonContract.clientMetadataKeys, [
    'thread_id', 'root_turn_id', 'turn_id', 'session_id',
    'x-codex-turn-metadata', 'x-codex-window-id', 'x-codex-installation-id',
  ]);
  assert.deepEqual(capture.clients.claude.requests.map((entry) => entry.model), [
    'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5',
  ]);
});
