import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiServerCommand } from '../lib/commands/api-server.js';
import { updateCommand } from '../lib/commands/update.js';

function voiceConfigFixture(t) {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-cli-identity-refusal-'));
  const configDirectory = path.join(home, '.claude-phone');
  const configPath = path.join(configDirectory, 'config.json');
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify({
    installationType: 'both',
    sip: { username: 'legacy', password: 'must-not-be-deleted' },
    secrets: { drachtio: 'legacy-media-secret' },
  }, null, 2)}\n`;
  fs.writeFileSync(configPath, bytes, { mode: 0o600 });
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { bytes, configDirectory, configPath };
}

function refusingIdentityResolver(counter) {
  return (installationType) => {
    counter.identity += 1;
    assert.equal(installationType, 'both');
    throw new Error('fixture three-account identity refusal');
  };
}

function assertConfigUntouched(fixture) {
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), fixture.bytes);
  assert.deepEqual(fs.readdirSync(fixture.configDirectory), ['config.json']);
}

test('API-server identity refusal precedes migration, provider checks, spawn, and PID writes', async (t) => {
  const fixture = voiceConfigFixture(t);
  const calls = { identity: 0, providers: 0, spawn: 0, pid: 0 };

  await assert.rejects(
    apiServerCommand({ port: 3333 }, {
      identityResolver: refusingIdentityResolver(calls),
      checkProviders() {
        calls.providers += 1;
        return [];
      },
      spawnProcess() {
        calls.spawn += 1;
        throw new Error('spawn must not be reached');
      },
      persistPid() {
        calls.pid += 1;
        throw new Error('PID persistence must not be reached');
      },
    }),
    /fixture three-account identity refusal/,
  );

  assert.deepEqual(calls, { identity: 1, providers: 0, spawn: 0, pid: 0 });
  assertConfigUntouched(fixture);
});

test('update identity refusal precedes migration, backup, and repository inspection', async (t) => {
  const fixture = voiceConfigFixture(t);
  const calls = { identity: 0, persist: 0, project: 0 };

  await assert.rejects(
    updateCommand({
      identityResolver: refusingIdentityResolver(calls),
      persistConfig() {
        calls.persist += 1;
        throw new Error('config persistence must not be reached');
      },
      resolveProjectRoot() {
        calls.project += 1;
        throw new Error('repository inspection must not be reached');
      },
    }),
    /fixture three-account identity refusal/,
  );

  assert.deepEqual(calls, { identity: 1, persist: 0, project: 0 });
  assertConfigUntouched(fixture);
});
