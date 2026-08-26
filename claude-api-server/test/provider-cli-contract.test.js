'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copySourceToStage,
  installArtifactsInPrivateStage,
  verifyVersion,
} = require('../../deploy/worker-session/teleagent-provider-cli-install');

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
  assert.equal(
    capture.captureMode,
    'clean-home-loopback-fake-upstream-initial-and-tool-roundtrip'
  );
  assert.equal(capture.credentials, 'synthetic-local-sentinel-only');
  assert.equal(capture.clients.codex.responsesCompactObserved, false);
  assert.equal(capture.clients.claude.countTokensObserved, false);
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
  assert.deepEqual(capture.clients.claude.toolRoundTrip.continuationMessageTypes, [
    ['text', 'text'], ['tool_use:Read'], ['tool_result'],
  ]);
  assert.equal(capture.clients.claude.toolRoundTrip.correlationVerified, true);
  assert.deepEqual(capture.clients.codex.toolRoundTrip.continuationInputSuffix, [
    'custom_tool_call', 'custom_tool_call_output',
  ]);
  assert.equal(capture.clients.codex.toolRoundTrip.correlationVerified, true);
  assert.deepEqual(capture.clients.codex.compactionProbe.continuationInputSuffix, [
    'custom_tool_call', 'custom_tool_call_output', 'compaction_trigger',
  ]);
  assert.equal(capture.clients.codex.compactionProbe.correlationVerified, true);
  assert.equal(capture.clients.codex.compactionProbe.responsesCompactPathObserved, false);
});

test('provider CLI installation executes only its descriptor-copied private stage', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-private-stage-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'caller-selected-cli');
  const staged = path.join(directory, 'root-private-staged-cli');
  const marker = path.join(directory, 'original-path-executed');
  const reviewed = '#!/bin/sh\nprintf \'reviewed-cli 1.0\\n\'\n';
  fs.writeFileSync(source, reviewed, { mode: 0o755 });
  fs.chmodSync(source, 0o755);
  const artifact = {
    size: Buffer.byteLength(reviewed),
    sha256: crypto.createHash('sha256').update(reviewed).digest('hex'),
    versionArgs: ['--version'],
    versionStdout: 'reviewed-cli 1.0',
  };
  copySourceToStage(source, staged, artifact, {
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  });

  fs.writeFileSync(source, `#!/bin/sh\n/usr/bin/touch '${marker}'\nprintf 'reviewed-cli 1.0\\n'\n`);
  fs.chmodSync(source, 0o755);
  verifyVersion(staged, artifact);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(staged, 'utf8'), reviewed);
  const metadata = fs.lstatSync(staged);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o755);

  const installer = fs.readFileSync(
    path.join(DEPLOY, 'teleagent-provider-cli-install'), 'utf8'
  );
  assert.match(installer,
    /copySource\(sources\[artifact\.id\], staged, artifact,[\s\S]*versionCheck\(staged, artifact\)/);
  assert.doesNotMatch(installer, /verifyVersion\(sources\[artifact\.id\]/);
  assert.doesNotMatch(installer, /function fail\(message\) \{[\s\S]*process\.exit\(/);
  assert.match(installer, /process\.exitCode = 77/);
});

test('provider CLI installation removes private stages on every pre-commit failure', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-cleanup-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const expectedUid = process.getuid();
  const expectedGid = process.getgid();
  const artifactIds = ['claude', 'codex-wrapper', 'codex-vendor'];

  for (const scenario of ['second-source-validation', 'copy-enospc', 'version-probe']) {
    const targetRoot = path.join(directory, scenario);
    fs.mkdirSync(targetRoot, { mode: 0o755 });
    const artifacts = Object.fromEntries(artifactIds.map((id) => [id, {
      id,
      path: path.join(targetRoot, id),
    }]));
    const manifest = { artifacts: artifactIds.map((id) => artifacts[id]) };
    const sources = Object.fromEntries(artifactIds.map((id) => [id, `${id}-source`]));
    let copyCount = 0;
    const copySource = (_source, staged) => {
      copyCount += 1;
      if (scenario === 'second-source-validation' && copyCount === 2) {
        throw new Error('second-source-validation');
      }
      fs.writeFileSync(staged, 'reviewed fixture\n', { mode: 0o755 });
      if (scenario === 'copy-enospc') {
        const error = new Error('copy-enospc');
        error.code = 'ENOSPC';
        throw error;
      }
    };
    const versionCheck = () => {
      if (scenario === 'version-probe') throw new Error('version-probe');
    };

    assert.throws(
      () => installArtifactsInPrivateStage(manifest, artifacts, sources, {
        targetRoot,
        expectedUid,
        expectedGid,
        copySource,
        versionCheck,
      }),
      new RegExp(scenario),
    );
    assert.deepEqual(
      fs.readdirSync(targetRoot).filter((name) => name.startsWith('.provider-cli-stage-')),
      [],
    );
  }
});
