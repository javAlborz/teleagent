'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  UNAVAILABLE, capabilitiesFromHealth, isToolAvailable, readControllerCapabilities,
  toolCapability,
} = require('../lib/controller-capabilities');
const { buildRealtimeTools, buildRealtimeRouterTool } = require('../lib/openai-realtime-client');
const { READY_CAPABILITIES, operatorHealth, executorHealth } = require('./controller-capabilities-fixture');

test('every advertised production tool has an explicit classification and unavailable defaults are local-only', () => {
  for (const tool of buildRealtimeTools(['codex-terra'])) {
    assert.notEqual(toolCapability(tool.name), 'disabled', tool.name);
    assert.equal(isToolAvailable(tool.name), ['local', 'composite'].includes(toolCapability(tool.name)), tool.name);
  }
  for (const name of ['unknown', '__proto__', 'constructor', 'send_agent_session_message', 'start_privileged_action']) {
    assert.equal(isToolAvailable(name, READY_CAPABILITIES), false, name);
  }
  const local = buildRealtimeRouterTool([]).parameters.properties.action.enum;
  assert.ok(local.includes('list_runtime_sessions'));
  assert.ok(local.includes('get_voice_history'));
  assert.ok(!local.includes('send_agent_message'));
  assert.ok(!local.includes('list_tmux_sessions'));
  const ready = buildRealtimeRouterTool([], READY_CAPABILITIES).parameters.properties.action.enum;
  assert.ok(ready.includes('send_agent_message'));
  assert.ok(ready.includes('list_tmux_sessions'));
  for (const unsupported of ['get_homelab_status', 'inspect_agent_session_history', 'get_latest_agent_session_message', 'continue_agent_session_history']) {
    assert.ok(!ready.includes(unsupported), unsupported);
    assert.equal(isToolAvailable(unsupported, READY_CAPABILITIES), false);
  }
  const localContract = buildRealtimeRouterTool([]).description;
  assert.match(localContract, /"action":"get_voice_history"/);
  assert.doesNotMatch(localContract, /"action":"send_agent_message"/);
  const readyContract = buildRealtimeRouterTool(['codex-terra'], READY_CAPABILITIES).description;
  assert.match(readyContract, /"action":"send_agent_message"/);
  assert.match(readyContract, /"profile":\{"type":"string","enum":\["auto","codex-terra"\]/);
  assert.doesNotMatch(readyContract, /"action":"get_latest_agent_session_message"/);
});

test('strict scoped health admits read-only worker inspection and separately proven managed execution', () => {
  assert.deepEqual(capabilitiesFromHealth(operatorHealth(), executorHealth()), READY_CAPABILITIES);
  const inspectionOnly = capabilitiesFromHealth(operatorHealth(), null);
  assert.equal(inspectionOnly.workerInspectionAvailable, true);
  assert.equal(inspectionOnly.managedExecutionAvailable, false);
  assert.equal(isToolAvailable('adopt_tmux_context', inspectionOnly), false);
  for (const bad of [null, {}, { ready: true }, { ...executorHealth(), scope: 'agent' }, { ...executorHealth(), ready: 'true' }]) {
    assert.equal(capabilitiesFromHealth(operatorHealth(), bad).managedExecutionAvailable, false);
  }
});

test('legacy/public, partial, unsafe-authority and missing-boundary health never enable tools', () => {
  for (const health of [null, {}, { ready: true, status: 'ok', service: 'claude-api-server' }]) {
    assert.deepEqual(capabilitiesFromHealth(health, executorHealth()), UNAVAILABLE);
  }
  for (const [section, key, bad] of [
    ['phoneAuthority', 'mode', 'legacy_authority_present'],
    ['phoneAuthority', 'status', 'unsafe_for_voice_activation'],
    ['approvalCapabilities', 'verifierConfigured', true],
    ['privilegedActions', 'enabled', true],
    ['privilegedActions', 'proxyConfigured', true],
    ['privilegedActions', 'authConfigured', true],
    ['authentication', 'allActiveScopesConfiguredAndDistinct', false],
    ['agentWorker', 'hardened', false],
    ['agentWorker', 'legacySameUidEnabled', true],
    ['workerSessionBroker', 'enabled', false],
    ['stateStorage', 'enforced', false],
    ['stateStorage', 'admitted', false],
  ]) {
    const health = operatorHealth();
    health[section][key] = bad;
    assert.deepEqual(capabilitiesFromHealth(health, executorHealth()), UNAVAILABLE, section + '.' + key);
    delete health[section][key];
    assert.deepEqual(capabilitiesFromHealth(health, executorHealth()), UNAVAILABLE, 'missing ' + section + '.' + key);
  }
});

test('panic, stale/not-ready worker and malformed readiness never enable execution', () => {
  for (const mutate of [
    (h) => { h.voiceExecution.locked = true; },
    (h) => { h.executor.panic.locked = true; },
    (h) => { h.workerSessionBroker.ready = false; },
    (h) => { h.ready = false; },
    (h) => { h.ready = 'true'; },
    (h) => { delete h.voiceExecution.locked; },
    (h) => { delete h.executor.panic.locked; },
  ]) {
    const health = operatorHealth();
    mutate(health);
    const result = capabilitiesFromHealth(health, executorHealth());
    assert.equal(result.managedExecutionAvailable, false);
    assert.equal(result.workerInspectionAvailable, false);
  }
});

test('missing or throwing bridges fail closed and successful snapshots cannot be changed by aliases', async () => {
  assert.equal(await readControllerCapabilities({}), UNAVAILABLE);
  assert.equal(await readControllerCapabilities({ getRuntimeCapabilities() { throw new Error('private diagnostic'); } }), UNAVAILABLE);
  const source = { ...READY_CAPABILITIES };
  const result = await readControllerCapabilities({ getRuntimeCapabilities: async () => source });
  source.managedExecutionAvailable = false;
  assert.equal(result.managedExecutionAvailable, true);
  assert.equal(Object.isFrozen(result), true);
});
