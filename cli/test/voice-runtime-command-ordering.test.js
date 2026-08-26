import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

function source(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function functionBody(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return text.slice(start, end);
}

function assertOrdered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must follow the previous preflight step`);
    cursor = next;
  }
}

test('setup gates prerequisite repair and config migration on all voice identities', () => {
  const text = source('../lib/commands/setup.js');
  const body = functionBody(
    text,
    'export async function setupCommand',
    'async function setupInstallationType'
  );

  assertOrdered(body, [
    'await peekConfig()',
    'resolveVoiceRuntimeIdentitiesForInstallation(installationType)',
    "runPrereqChecks({ type: 'minimal' })",
    'await loadConfig({ snapshot: configSnapshot })',
  ]);
  assert.match(body, /setupInstallationType\([\s\S]*voiceRuntimeIdentities/);
});

test('start gates migration and prerequisite repair and reuses the identity bundle', () => {
  const text = source('../lib/commands/start.js');
  const body = functionBody(text, 'export async function startCommand', 'async function startApiServer');

  assertOrdered(body, [
    'await peekConfig()',
    'await loadConfigWithVoiceRuntimeIdentityPreflight({ snapshot: configSnapshot })',
    'await runPrereqChecks({ type: installationType })',
  ]);
  assert.match(text, /writeDockerConfig\(config, voiceRuntimeIdentities\)/);
  assert.doesNotMatch(text, /writeDockerConfig\(config, \{ voiceIdentity \}\)/);
});

for (const [name, relativePath, startMarker] of [
  ['device add', '../lib/commands/device/add.js', 'export async function deviceAddCommand'],
  ['device remove', '../lib/commands/device/remove.js', 'export async function deviceRemoveCommand'],
]) {
  test(`${name} gates migration/save and Docker writes and preserves API-only exemption`, () => {
    const text = source(relativePath);
    const body = text.slice(text.indexOf(startMarker));

    assertOrdered(body, [
      'await peekConfig()',
      'await loadConfigWithVoiceRuntimeIdentityPreflight({ snapshot: configSnapshot })',
      'await saveConfig(config)',
      'if (voiceRuntimeIdentities)',
      'await writeDockerConfig(config, voiceRuntimeIdentities)',
    ]);
  });
}

test('persistent loader resolves the installation identity before loadConfig', () => {
  const text = source('../lib/config.js');
  const body = functionBody(
    text,
    'export async function loadConfigWithVoiceRuntimeIdentityPreflight',
    '/**\n * Get the installation type from config'
  );
  assertOrdered(body, [
    'await peekConfig()',
    'getInstallationType(exactSnapshot)',
    'identityResolver(installationType)',
    'await loadConfig({ snapshot: exactSnapshot })',
  ]);
});

for (const [name, relativePath] of [
  ['config show', '../lib/commands/config/show.js'],
  ['device list', '../lib/commands/device/list.js'],
  ['doctor', '../lib/commands/doctor.js'],
  ['logs', '../lib/commands/logs.js'],
  ['status', '../lib/commands/status.js'],
  ['stop', '../lib/commands/stop.js'],
]) {
  test(`${name} uses only the non-persisting configuration view`, () => {
    const text = source(relativePath);
    assert.match(text, /await loadConfigReadOnly\(\)/u);
    assert.doesNotMatch(text, /\bloadConfig\s*\(/u);
    assert.doesNotMatch(text, /loadConfigWithVoiceRuntimeIdentityPreflight/u);
  });
}

test('API-server and update preflight before any downstream operation', () => {
  const apiServer = source('../lib/commands/api-server.js');
  assertOrdered(apiServer, [
    'loadConfigWithVoiceRuntimeIdentityPreflight({ identityResolver })',
    'await checkProviders(config)',
    "spawnProcess('node'",
    "persistPid('claude-api-server'",
  ]);

  const update = source('../lib/commands/update.js');
  assertOrdered(update, [
    'loadConfigWithVoiceRuntimeIdentityPreflight({ identityResolver })',
    'await persistConfig(config)',
    'resolveProjectRoot()',
    'isGitRepo(projectRoot)',
  ]);
});

function commandFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return commandFiles(filename);
    return entry.isFile() && entry.name.endsWith('.js') ? [filename] : [];
  });
}

test('setup is the only deliberate direct command-side loadConfig caller', () => {
  const commandRoot = fileURLToPath(new URL('../lib/commands/', import.meta.url));
  const directCallers = commandFiles(commandRoot)
    .filter((filename) => /\bloadConfig\s*\(/u.test(fs.readFileSync(filename, 'utf8')))
    .map((filename) => path.relative(commandRoot, filename))
    .sort();
  assert.deepEqual(directCallers, ['setup.js']);
});
