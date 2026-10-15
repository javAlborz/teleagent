'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {capabilitiesFromHealth, readControllerCapabilities} = require('../lib/controller-capabilities');
const {OpenAIRealtimeClient, buildRealtimeRouterTool} = require('../lib/openai-realtime-client');
const {OwnerDecisionRouter} = require('../lib/owner-decision-router');
const {buildConductorInstructions} = require('../lib/realtime-conversation');
const {nativeOwnerHealth, operatorHealth, executorHealth} = require('./controller-capabilities-fixture');

async function clientFromHealth(operator = nativeOwnerHealth(), executor = executorHealth(), overrides = {}) {
  const capabilities = await readControllerCapabilities({
    getRuntimeCapabilities: async () => capabilitiesFromHealth(operator, executor),
  });
  return new OpenAIRealtimeClient({apiKey: 'offline-fixture', capabilities,
    ownerSessionLabels: ['phoneA', 'drizzy'],
    instructions: buildConductorInstructions({thread: {id: 'fixture'}, capabilities}), ...overrides});
}

test('authenticated native health selects Luna and the personal prompt/schema even with a healthy executor', async () => {
  const client = await clientFromHealth();
  assert.equal(client.capabilities.managedExecutionAvailable, true);
  assert.equal(client.capabilities.workerInspectionAvailable, true);
  assert.ok(client.ownerDecisionRouter instanceof OwnerDecisionRouter);
  assert.deepEqual(client.getConversationConfiguration(), {mode: 'owner_sessions',
    decision_transport: 'responses', decision_model: 'gpt-6-luna',
    managed_execution_available: true, owner_sessions_available: true});
  assert.doesNotMatch(client.instructions, /every managed phone job is forced read-only/);
  assert.match(client.instructions, /including edits and deployment/);
  const properties = buildRealtimeRouterTool(['codex-sol'], client.capabilities).parameters.properties;
  assert.equal(properties.arguments_json, undefined);
  assert.deepEqual(properties.action.enum, ['respond', 'list_owner_sessions', 'inspect_owner_session',
    'request_owner_instruction', 'get_owner_reply', 'get_owner_instruction', 'end_call',
    'clarify_owner_request', 'propose_owner_message', 'execute_owner_plan']);
});

test('executor outages do not change personal conversation selection; emergency locks still remove actions', async () => {
  for (const executor of [null, {...executorHealth(), ready: false}, executorHealth()]) {
    const health = nativeOwnerHealth();
    for (const locked of [false, true]) {
      health.voiceExecution.locked = locked;
      const client = await clientFromHealth(health, executor);
      assert.ok(client.ownerDecisionRouter instanceof OwnerDecisionRouter);
      assert.equal(client.getConversationConfiguration().mode, 'owner_sessions');
      const actions = buildRealtimeRouterTool([], client.capabilities).parameters.properties.action.enum;
      assert.equal(actions.includes('request_owner_instruction'), !locked);
      assert.equal(actions.includes('send_agent_message'), false);
    }
  }
});

test('the managed-only deployment retains its existing router and no mode can add owner authority', async () => {
  const client = await clientFromHealth(operatorHealth());
  assert.equal(client.ownerDecisionRouter, null);
  const capabilities = {...client.capabilities, conversationMode: 'owner_sessions'};
  const actions = buildRealtimeRouterTool([], capabilities).parameters.properties.action.enum;
  assert.equal(actions.includes('request_owner_instruction'), false);
  assert.equal(actions.includes('send_agent_message'), false);
});

test('single-word caller payloads reach the handler once under actual production capabilities', async () => {
  for (const transcript of ['All right, now write done in the phone A session.',
    'Just write done.', 'The message is done.', 'The message you should send is the single word done.']) {
    const sent = [];
    const client = await clientFromHealth(undefined, undefined, {
      toolHandler: async (name, args) => {
        sent.push({name, args});
        return {success: true, operation_id: 'job_' + 'a'.repeat(64), result: {state: 'accepted'}};
      },
    });
    client.prepareCallerTurn(transcript);
    const call = id => ({type: 'function_call', name: 'route_turn', call_id: id,
      arguments: JSON.stringify({action: 'request_owner_instruction', session_label: 'phoneA',
        message: 'done', message_source: 'caller'})});
    const first = await client._handleToolCall(call('first'), {sendOutput: false});
    assert.equal(first.output.success, true, transcript);
    await client._handleToolCall(call('duplicate'), {sendOutput: false});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, 'request_owner_instruction');
    assert.match(sent[0].args.message, /^done\.?$/);
    assert.equal(sent[0].args.session_label, 'phoneA');
  }
});

test('October 15 split dictation reaches the native message validator and either read route binds its receipt', async () => {
  const {canonicalizeTargetSessionMessage} = require('../../lib/target-session-message');
  const calls = []; let operation;
  const client = await clientFromHealth(undefined, undefined, {ownerSessionLabels: ['alpha', 'beta'],
    toolHandler: async (name, args) => {
      calls.push({name, args});
      if (name === 'request_owner_instruction') {
        assert.equal(canonicalizeTargetSessionMessage(args.message), 'What is five plus five? Please reply.');
        return {success: true, operation_id: operation, result: {state: 'accepted'}};
      }
      return {success: true, result: {label: 'beta', history: {latestTurn: {status: 'completed', reply: {text: '10'}}}}};
    }});
  operation = require('../lib/owner-task-plan').makeOperationId(client.ownerCallId, 'task_1');
  client.prepareCallerTurn('Send beta the following message. What is five plus five?');
  client.prepareCallerTurn('Please reply.');
  client.pendingCallerTranscript = client.unsentCallerTranscript;
  const route = (id, args) => client._handleToolCall({name: 'route_turn', call_id: id,
    arguments: JSON.stringify(args)}, {sendOutput: false});
  const sent = await route('split', {action: 'execute_owner_plan', actions: [
    {action: 'request_owner_instruction', session_label: 'beta', message_source: 'caller',
      message: 'What is five plus five? Please reply.'},
  ]});
  assert.match(sent.output.text, /beta: instruction accepted/);
  for (const selectors of [{}, {session_label: 'beta'}, {task_id: 'task_1'}]) {
    client.prepareCallerTurn('Did it respond yet?');
    const result = await route('read-' + calls.length, {action: 'get_owner_reply', ...selectors});
    assert.equal(result.output.result.history.latestTurn.reply.text, '10');
    assert.equal(calls.at(-1).args.operation_id, operation);
  }
  const before = calls.length;
  for (const selectors of [{session_label: 'alpha'}, {task_id: 'invented'},
    {operation_id: 'job_' + 'b'.repeat(64)}, {task_id: 'task_1', session_label: 'alpha'},
    {task_id: 'invented', operation_id: operation}]) {
    const result = await route('bad-' + JSON.stringify(selectors), {action: 'get_owner_reply', ...selectors});
    assert.equal(result.output.code, 'OWNER_REFERENCE_CLARIFICATION_REQUIRED');
  }
  assert.equal(calls.length, before);
  assert.equal(calls.filter(c => c.name === 'request_owner_instruction').length, 1);
});
