import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  buildAgentServerEnvironment,
  checkAgentProvider,
  createDefaultAgentConfig,
  getAgentProfileChoices,
  normalizeAgentConfig
} from '../lib/agents.js';

function createSpawnStub(results) {
  let index = 0;
  return (command, args) => {
    const result = results[index++];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.command = command;
    child.args = args;

    Promise.resolve().then(() => {
      if (result.output) child.stdout.write(result.output);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', result.code);
    });
    return child;
  };
}

test('legacy configurations migrate to Claude-only provider selection', () => {
  const agents = normalizeAgentConfig(undefined, { defaultProviders: ['claude'] });
  assert.deepEqual(agents.providers, ['claude']);
});

test('new configurations expose all six selectable phone profiles', () => {
  const config = { agents: createDefaultAgentConfig() };
  assert.deepEqual(
    getAgentProfileChoices(config).map(choice => choice.value),
    [
      'phone-haiku',
      'phone-sonnet',
      'phone-opus',
      'phone-codex-luna',
      'phone-codex-terra',
      'phone-codex-sol'
    ]
  );
});

test('Codex-only configuration does not include Claude profiles or requirements', () => {
  const config = {
    agents: createDefaultAgentConfig({ providers: ['codex'], homeDirectory: '/srv/phone' })
  };
  const environment = buildAgentServerEnvironment(config, {});

  assert.deepEqual(getAgentProfileChoices(config).map(choice => choice.value), [
    'phone-codex-luna',
    'phone-codex-terra',
    'phone-codex-sol'
  ]);
  assert.equal(environment.AGENT_PROVIDERS, 'codex');
  assert.equal(environment.PHONE_CODEX_TERRA_SANDBOX, 'workspace-write');
  assert.equal(environment.PHONE_CODEX_SOL_SANDBOX, 'danger-full-access');
});

test('Codex readiness checks version and authenticated login status', async () => {
  const config = {
    agents: createDefaultAgentConfig({ providers: ['codex'] })
  };
  const spawnImpl = createSpawnStub([
    { code: 0, output: 'codex-cli 1.2.3\n' },
    { code: 0, output: 'Logged in using ChatGPT\n' }
  ]);

  const result = await checkAgentProvider('codex', config, { spawnImpl });
  assert.equal(result.installed, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.version, '1.2.3');
});

test('Claude readiness checks version and authenticated status', async () => {
  const config = {
    agents: createDefaultAgentConfig({ providers: ['claude'] })
  };
  const spawnImpl = createSpawnStub([
    { code: 0, output: '2.1.227 (Claude Code)\n' },
    { code: 0, output: '{"loggedIn":true}\n' }
  ]);

  const result = await checkAgentProvider('claude', config, { spawnImpl });
  assert.equal(result.installed, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.version, '2.1.227');
});

test('Codex readiness returns an actionable headless authentication error', async () => {
  const config = {
    agents: createDefaultAgentConfig({ providers: ['codex'] })
  };
  const spawnImpl = createSpawnStub([
    { code: 0, output: 'codex-cli 1.2.3\n' },
    { code: 1, output: 'Not logged in\n' }
  ]);

  const result = await checkAgentProvider('codex', config, { spawnImpl });
  assert.equal(result.installed, true);
  assert.equal(result.authenticated, false);
  assert.match(result.error, /codex login --device-auth/);
});
