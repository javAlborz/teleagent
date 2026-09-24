'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const buildConfig = fs.mkdtempSync('/tmp/teleagent-image-build.');
const parents = {
  baseline: 'sha256:8776872867802e71c789f836440dbb598df10ae95eb88f35de8e9206c5b90ab8',
  candidate: 'sha256:2b50e0224a08c71836e4edc0b73186c19d0c093e3f4fcb99a1adf1f71ca16392',
};
function insist(ok, message) { if (!ok) throw new Error(message); }
function docker(...args) {
  const r = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', DOCKER_CONFIG: buildConfig },
  });
  insist(!r.error && r.status === 0, 'Fixed local image build/inspection failed');
  return r.stdout;
}
function inspect(id) { return JSON.parse(docker('image', 'inspect', id))[0]; }
function hasPrefix(values, prefix) { return prefix.every((value, index) => values[index] === value); }
try {
  insist(process.argv.length === 2, 'No image override arguments are supported');
  const bootstrap = fs.readFileSync(`${__dirname}/hermes-bootstrap.cjs`);
  const bootstrapSha = crypto.createHash('sha256').update(bootstrap).digest('hex');
  const originals = Object.fromEntries(Object.entries(parents).map(([role, id]) => [role, inspect(id)]));
  insist(originals.baseline.Id === parents.baseline && originals.candidate.Id === parents.candidate &&
    hasPrefix(originals.candidate.RootFS.Layers, originals.baseline.RootFS.Layers), 'Reviewed local parent ancestry differs');
  const receipt = { version: 1, bootstrap_sha256: bootstrapSha, images: {} };
  for (const [role, parent] of Object.entries(originals)) {
    // A locally resolved tag avoids BuildKit attempting to fetch a bare image
    // ID as a registry digest. Prove the tag before and after using it.
    const inputTag = `teleagent-hermes-legacy-input:${role}-20260907`;
    const existing = docker('image', 'ls', '--no-trunc', '--filter', `reference=${inputTag}`, '--format', '{{.ID}}').trim();
    insist(!existing || inspect(inputTag).Id === parent.Id, 'Build input tag is occupied by an unrelated image');
    docker('image', 'tag', parent.Id, inputTag);
    insist(inspect(inputTag).Id === parent.Id, 'Build input tag resolution differs');
    docker('build', '--network=none', '--pull=false', '--build-arg', `LEGACY_IMAGE=${inputTag}`,
      '--build-arg', `BOOTSTRAP_SHA=${bootstrapSha}`, '--tag', `teleagent-hermes-voice:${role}-20260907`, __dirname);
    const image = inspect(`teleagent-hermes-voice:${role}-20260907`);
    insist(inspect(inputTag).Id === parent.Id && image.RootFS.Layers.length === parent.RootFS.Layers.length + 2 &&
      hasPrefix(image.RootFS.Layers, parent.RootFS.Layers) && image.Config.Labels?.['org.teleagent.hermes-bootstrap-sha'] === bootstrapSha &&
      image.Config.Labels?.['org.teleagent.hermes-lifecycle'] === '1', 'Derived image provenance differs');
    receipt.images[role] = { parent: parent.Id, image: image.Id, rootfs_layers: image.RootFS.Layers };
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
finally { fs.rmSync(buildConfig, { recursive: true }); }
