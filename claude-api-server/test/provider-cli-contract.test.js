'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertNoPrivateStages: assertInstallerHasNoPrivateStages,
  installArtifactsInPrivateStage,
} = require('../../deploy/worker-session/teleagent-provider-cli-install');
const {
  assertNoPrivateStages: assertCheckerHasNoPrivateStages,
  checkArtifact,
} = require('../../deploy/worker-session/teleagent-provider-cli-check');
const {
  requirePinnedProviderCli,
} = require('../../deploy/worker-session/teleagent-provider-boundary');

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

test('root provider CLI install and check never execute pinned artifacts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-metadata-only-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const targetRoot = path.join(directory, 'targets');
  fs.mkdirSync(targetRoot, { mode: 0o755 });
  const marker = path.join(directory, 'provider-executed');
  const ids = ['claude', 'codex-wrapper', 'codex-vendor'];
  const sources = {};
  const artifacts = {};
  for (const id of ids) {
    const contents = `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 93\n`;
    const source = path.join(directory, `${id}-source`);
    fs.writeFileSync(source, contents, { mode: 0o755 });
    fs.chmodSync(source, 0o755);
    sources[id] = source;
    artifacts[id] = {
      id,
      path: path.join(targetRoot, id === 'codex-wrapper' ? 'codex' : id),
      size: Buffer.byteLength(contents),
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      versionArgs: ['--version'],
      versionStdout: id === 'claude' ? '2.1.246 (Claude Code)' : 'codex-cli 0.149.1',
    };
  }
  const manifest = { artifacts: ids.map((id) => artifacts[id]) };
  const expectedUid = process.getuid();
  const expectedGid = process.getgid();
  installArtifactsInPrivateStage(manifest, artifacts, sources, {
    targetRoot,
    expectedUid,
    expectedGid,
  });
  assert.equal(fs.existsSync(marker), false);
  for (const artifact of manifest.artifacts) {
    await checkArtifact(artifact, { expectedUid, expectedGid });
    assert.equal(fs.existsSync(marker), false);
  }

  const installer = fs.readFileSync(
    path.join(DEPLOY, 'teleagent-provider-cli-install'), 'utf8'
  );
  const checker = fs.readFileSync(
    path.join(DEPLOY, 'teleagent-provider-cli-check'), 'utf8'
  );
  assert.doesNotMatch(installer, /verifyVersion|versionCheck|artifact\.versionArgs/);
  assert.doesNotMatch(checker, /node:child_process|spawn(?:Sync)?\s*\(/);
  assert.doesNotMatch(installer, /function fail\(message\) \{[\s\S]*process\.exit\(/);
  assert.match(installer, /process\.exitCode = 77/);
  assert.doesNotMatch(checker, /function fail\(message\) \{[\s\S]*process\.exit\(/);
  assert.match(checker, /process\.exitCode = 77/);

  const checkerCalls = [];
  assert.doesNotThrow(() => requirePinnedProviderCli('claude', {
    spawnCheck: (filename, args, options) => {
      checkerCalls.push({ filename, args, options });
      return {
        error: null,
        status: 0,
        signal: null,
        stdout: 'PROVIDER_CLI_OK claude\n',
      };
    },
  }));
  assert.equal(checkerCalls.length, 1);
  assert.equal(checkerCalls[0].filename, '/usr/local/libexec/teleagent-provider-cli-check');
  assert.deepEqual(checkerCalls[0].args, ['--provider', 'claude']);
  assert.doesNotMatch(checkerCalls[0].filename, /agent-tools\/(?:claude|codex)/);
});

test('provider CLI installation removes private stages on every pre-commit failure', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-cleanup-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const expectedUid = process.getuid();
  const expectedGid = process.getgid();
  const artifactIds = ['claude', 'codex-wrapper', 'codex-vendor'];

  for (const scenario of ['second-source-validation', 'copy-enospc']) {
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
    assert.throws(
      () => installArtifactsInPrivateStage(manifest, artifacts, sources, {
        targetRoot,
        expectedUid,
        expectedGid,
        copySource,
      }),
      new RegExp(scenario),
    );
    assert.deepEqual(
      fs.readdirSync(targetRoot).filter((name) => name.startsWith('.provider-cli-stage-')),
      [],
    );
  }
});

test('one interrupted provider CLI stage blocks install and check without creating another', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-orphan-stage-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const orphan = path.join(directory, '.provider-cli-stage-interrupted');
  fs.mkdirSync(orphan, { mode: 0o700 });
  fs.writeFileSync(path.join(orphan, 'partial-vendor'), 'partial fixture\n', { mode: 0o600 });

  assert.throws(
    () => assertInstallerHasNoPrivateStages(directory),
    /interrupted provider CLI stage requires operator review/,
  );
  assert.throws(
    () => assertCheckerHasNoPrivateStages(directory),
    /interrupted provider CLI stage requires operator review/,
  );

  let copyCalls = 0;
  assert.throws(
    () => installArtifactsInPrivateStage({ artifacts: [] }, {}, {}, {
      targetRoot: directory,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      copySource: () => { copyCalls += 1; },
    }),
    /interrupted provider CLI stage requires operator review/,
  );
  assert.equal(copyCalls, 0);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.startsWith('.provider-cli-stage-')),
    ['.provider-cli-stage-interrupted'],
  );
  assert.equal(fs.existsSync(path.join(directory, '.provider-cli-stage-active')), false);
});

test('provider CLI orphan detection rejects stage-shaped files and links', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-stage-types-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unrelated = path.join(directory, 'unrelated');
  fs.writeFileSync(unrelated, 'fixture\n', { mode: 0o600 });

  for (const [name, create] of [
    ['.provider-cli-stage-file', (filename) => fs.writeFileSync(filename, 'fixture\n')],
    ['.provider-cli-stage-link', (filename) => fs.symlinkSync(unrelated, filename)],
  ]) {
    const candidate = path.join(directory, name);
    create(candidate);
    assert.throws(
      () => assertInstallerHasNoPrivateStages(directory),
      /interrupted provider CLI stage requires operator review/,
    );
    assert.throws(
      () => assertCheckerHasNoPrivateStages(directory),
      /interrupted provider CLI stage requires operator review/,
    );
    fs.unlinkSync(candidate);
  }
  assert.doesNotThrow(() => assertInstallerHasNoPrivateStages(directory));
  assert.doesNotThrow(() => assertCheckerHasNoPrivateStages(directory));
});
