'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(
  ROOT,
  'deploy',
  'worker-session',
  'provider-libexec.manifest'
);

test('provider libexec manifest pins the complete reviewed install closure', () => {
  const lines = fs.readFileSync(MANIFEST, 'utf8').trim().split('\n');
  const targets = new Set();
  let hasModelProfile = false;
  const providerCli = JSON.parse(fs.readFileSync(path.join(
    ROOT, 'deploy', 'worker-session', 'provider-cli.manifest.json'), 'utf8'));
  const codexWrapper = providerCli.artifacts.find((artifact) => artifact.id === 'codex-wrapper');
  assert.equal(codexWrapper?.mode, '0755');
  const requiredTargets = new Set([
    'teleagent-provider-cli-check',
    'teleagent-provider-canary',
    'teleagent-provider-cli-install',
    'teleagent-provider-cli.manifest.json',
    'teleagent-provider-codex-cli-wrapper',
    'teleagent-provider-egress-credential-check',
    'teleagent-resource-admission',
    'teleagent-resource-topology-watch',
  ]);

  for (const line of lines) {
    const fields = line.split(' ');
    assert.equal(fields.length, 4, `invalid manifest entry: ${line}`);
    const [expectedDigest, source, target, mode] = fields;
    assert.match(expectedDigest, /^[a-f0-9]{64}$/);
    assert.match(source, /^(?:deploy\/worker-session|claude-api-server)\//);
    assert.match(target, /^(?:teleagent-provider-[A-Za-z0-9.-]+|teleagent-resource-(?:admission|topology-watch))$/);
    assert.match(mode, /^(?:0755|0555|0444)$/);
    assert.equal(targets.has(target), false, `duplicate target: ${target}`);
    targets.add(target);
    requiredTargets.delete(target);

    const contents = fs.readFileSync(path.join(ROOT, source));
    const actualDigest = crypto.createHash('sha256').update(contents).digest('hex');
    assert.equal(actualDigest, expectedDigest, `unreviewed source: ${source}`);

    if (target === 'teleagent-provider-model.apparmor') {
      hasModelProfile = true;
      assert.equal(source, 'deploy/worker-session/teleagent-provider-model.apparmor');
      assert.equal(mode, '0444');
    }
    if (target === 'teleagent-provider-codex-cli-wrapper') {
      assert.equal(source, 'deploy/worker-session/teleagent-codex-cli-wrapper');
      assert.equal(mode, codexWrapper.mode);
    }
    if (target === 'teleagent-resource-admission') {
      assert.equal(source, 'deploy/worker-session/teleagent-resource-admission');
      assert.equal(mode, '0444');
    }
    if (target === 'teleagent-resource-topology-watch') {
      assert.equal(source, 'deploy/worker-session/teleagent-resource-topology-watch');
      assert.equal(mode, '0555');
    }
  }

  assert.equal(hasModelProfile, true, 'the enforced model profile must be digest-pinned');
  assert.deepEqual([...requiredTargets], [], 'the pinned provider CLI gate must be in the closure');
});
