'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAgentProfileConfig,
  getDeploymentAuthorization,
  normalizeSessionType,
  resolveAgentProfile,
  resolveEffectiveSessionType,
} = require('../agent-profiles');

test('normalizes Claude and Codex phone profile aliases', () => {
  assert.equal(normalizeSessionType('phone'), 'phone-haiku');
  assert.equal(normalizeSessionType('phone-codex'), 'phone-codex-luna');
  assert.equal(normalizeSessionType('phone-codex-terra'), 'phone-codex-terra');
  assert.equal(normalizeSessionType('unknown'), 'default');
});

test('builds all six model profiles with independent Codex workspaces', () => {
  const config = createAgentProfileConfig({
    HOME: '/home/tester',
    PHONE_CODEX_LUNA_WORKING_DIR: '/srv/read',
    PHONE_CODEX_TERRA_WORKING_DIR: '/srv/workspace',
    PHONE_CODEX_SOL_WORKING_DIR: '/srv/admin',
  });

  assert.equal(config.profiles['phone-haiku'].provider, 'claude');
  assert.equal(config.profiles['phone-sonnet'].model, 'sonnet');
  assert.equal(config.profiles['phone-opus'].model, 'opus');
  assert.deepEqual(
    [
      config.profiles['phone-codex-luna'].model,
      config.profiles['phone-codex-terra'].model,
      config.profiles['phone-codex-sol'].model,
    ],
    ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']
  );
  assert.equal(config.profiles['phone-codex-luna'].workingDirectory, '/srv/read');
  assert.equal(config.profiles['phone-codex-terra'].workingDirectory, '/srv/workspace');
  assert.equal(config.profiles['phone-codex-sol'].workingDirectory, '/srv/admin');
});

test('Codex Luna and Terra deploy requests never escalate to Sol', () => {
  const deployPrompt = 'Deploy the app-platform preview now';

  assert.equal(
    resolveEffectiveSessionType('phone-codex-luna', deployPrompt),
    'phone-codex-luna'
  );
  assert.equal(
    resolveEffectiveSessionType('phone-codex-terra', deployPrompt),
    'phone-codex-terra'
  );
  assert.equal(getDeploymentAuthorization('phone-codex-luna', deployPrompt).allowed, false);
  assert.equal(getDeploymentAuthorization('phone-codex-terra', deployPrompt).allowed, false);
});

test('Codex Sol deploy requests stay on Codex and use the deploy profile', () => {
  const deployPrompt = 'Ship and deploy the app-platform preview';
  const config = createAgentProfileConfig({ HOME: '/home/tester' });
  const profile = resolveAgentProfile(config, 'phone-codex-sol', deployPrompt);

  assert.equal(resolveEffectiveSessionType('phone-codex-sol', deployPrompt), 'phone-codex-deploy');
  assert.equal(getDeploymentAuthorization('phone-codex-sol', deployPrompt).allowed, true);
  assert.equal(profile.provider, 'codex');
  assert.equal(profile.sessionType, 'phone-codex-deploy');
  assert.equal(profile.sandbox, 'danger-full-access');
});

test('Codex-only configuration defaults untyped requests to Luna', () => {
  const config = createAgentProfileConfig({
    HOME: '/home/tester',
    AGENT_PROVIDERS: 'codex',
  });

  assert.deepEqual(config.enabledProviders, ['codex']);
  assert.equal(resolveAgentProfile(config, null).sessionType, 'phone-codex-luna');
});

test('Claude deploy routing retains the existing deployment profile behavior', () => {
  assert.equal(
    resolveEffectiveSessionType('phone-sonnet', 'Please publish the app-platform preview'),
    'phone-deploy'
  );
});
