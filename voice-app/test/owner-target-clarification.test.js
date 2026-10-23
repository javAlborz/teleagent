'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {OpenAIRealtimeClient} = require('../lib/openai-realtime-client');
const {capabilitiesFromHealth} = require('../lib/controller-capabilities');
const {nativeOwnerHealth, executorHealth} = require('./controller-capabilities-fixture');
const {OwnerTaskMemory, validatePlan, renderPlan} = require('../lib/owner-task-plan');
const {VoiceStateStore} = require('../lib/voice-state-store');
const {buildConductorInstructions} = require('../lib/realtime-conversation');

const route = (id, fields) => ({type: 'function_call', name: 'route_turn', call_id: id,
  arguments: JSON.stringify({proposed_message: null, ...fields})});

test('missing named target preserves dictation, correction sends once, and old intent cannot replay', async t => {
  const db = new VoiceStateStore(); t.after(() => db.close());
  const thread = db.createThread({callerId: 'offline'});
  const store = {load: () => db.loadOwnerDialogue(thread.id), save: (r, s) => db.saveOwnerDialogue(thread.id, r, s)};
  const attempts = [], spoken = [];
  const capabilities = capabilitiesFromHealth(nativeOwnerHealth(), executorHealth());
  const client = new OpenAIRealtimeClient({apiKey: 'offline', ownerCallId: 'offline-call', ownerTaskStore: store,
    capabilities, ownerSessionLabels: ['phoneA'],
    instructions: buildConductorInstructions({thread: {id: thread.id}, capabilities,
      ownerSessionContext: {available: true, labels: ['phoneA']}}),
    toolHandler: async (name, args) => {
      attempts.push({name, args});
      if (args.session_label === 'Charlie') return {success: false, code: 'OWNER_SESSION_NOT_ENROLLED'};
      return {success: true, operation_id: 'job_' + 'a'.repeat(64), result: {state: 'accepted'}};
    }});
  t.after(() => client.close());
  client.requestResponse = (_r, options) => {spoken.push(options.verifiedSpeech?.text); return true;};
  async function turn(text, id, fields) {
    client.prepareCallerTurn(text);
    await client._handleResponseDone({output: [route(id, fields)]});
    client.ownerReplyWatch.stop();
  }
  await turn('Will you send a message to the Charlie session? Just say the word muffin.', 'missing', {
    action: 'execute_owner_plan', actions: [{action: 'request_owner_instruction',
      session_label: 'Charlie', message: 'muffin', message_source: 'caller'}]});
  assert.match(spoken.at(-1), /Charlie: session not found; instruction not sent/);
  assert.match(spoken.at(-1), /Which session should receive/);
  const original = client.ownerTaskMemory.value.tasks[0];
  assert.equal(original.message, 'muffin.');
  assert.equal(original.state, 'failed');
  assert.equal(new OwnerTaskMemory(store).get(original.id).message, original.message);

  await turn('What happened to that message?', 'status', {action: 'execute_owner_plan', actions: [
    {action: 'get_owner_reply', session_label: 'Charlie'}]});
  assert.equal(attempts.length, 1, 'an unsent-message status does not send or inspect unrelated history');
  assert.match(spoken.at(-1), /instruction was not sent/);

  const correction = 'Okay, could you send a message to phone A?';
  const fields = {action: 'execute_owner_plan', actions: [{action: 'request_owner_instruction',
    session_label: 'phone A', message_source: 'reference', task_id: original.id, authorization_text: correction}]};
  await turn(correction, 'correction', fields);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].args.session_label, 'phoneA');
  assert.equal(attempts[1].args.message, original.message);
  assert.equal(original.state, 'superseded');
  assert.ok(original.replacement);
  assert.equal(client.ownerTaskMemory.context().tasks[0].replacement, original.replacement);
  await client._handleResponseDone({output: [route('duplicate', fields)]});
  assert.equal(attempts.length, 2, 'a second decision in the same turn cannot repeat delivery');
  const reloaded = new OwnerTaskMemory(store);
  assert.throws(() => validatePlan(fields, {transcript: correction, labels: ['phoneA'], memory: reloaded}),
    {code: 'OWNER_PLAN_REFERENCE_SUPERSEDED'});
});

test('unavailable identities explain a refusal without converting uncertain delivery into not-sent', () => {
  const task = {action: 'request_owner_instruction', session_label: 'phoneA', state: 'failed',
    result: {success: false, code: 'OWNER_SESSION_PROCESS_CHANGED'}};
  assert.match(renderPlan([task]), /phoneA: session access is unavailable; instruction not sent/);
  task.state = 'outcome_unknown'; task.result.delivery_state = 'outcome_unknown';
  assert.match(renderPlan([task]), /delivery is uncertain/);
  assert.doesNotMatch(renderPlan([task]), /not sent/);
});

for (const action of ['get_owner_reply', 'get_owner_instruction']) {
  for (const byTask of [false, true]) {
    test(`${action} explains a known unsent task by ${byTask ? 'task ID' : 'session name'} without native IO`, async t => {
      const attempts = [], spoken = [];
      const capabilities = capabilitiesFromHealth(nativeOwnerHealth(), executorHealth());
      const client = new OpenAIRealtimeClient({apiKey: 'offline', ownerCallId: 'offline-unsent',
        capabilities, ownerSessionLabels: ['beta'],
        instructions: buildConductorInstructions({thread: {id: 'offline'}, capabilities,
          ownerSessionContext: {available: true, labels: ['beta']}}), toolHandler: async (name, args) => {
          attempts.push({name, args});
          return {success: false, code: 'OWNER_SESSION_PROCESS_CHANGED'};
        }});
      t.after(() => client.close());
      client.requestResponse = (_r, options) => {spoken.push(options.verifiedSpeech?.text); return true;};
      async function turn(text, id, fields) {
        client.prepareCallerTurn(text);
        await client._handleResponseDone({output: [route(id, fields)]});
        client.ownerReplyWatch.stop();
      }
      await turn('Send beta the word orange.', 'send', {action: 'execute_owner_plan', actions: [
        {action: 'request_owner_instruction', session_label: 'beta', message: 'orange', message_source: 'caller'}]});
      const task = client.ownerTaskMemory.latest('beta');
      assert.equal(task.state, 'failed');
      await turn('Has beta replied?', 'read', {action, session_label: 'beta', ...(byTask ? {task_id: task.id} : {})});
      assert.equal(attempts.length, 1, 'status neither retries delivery nor reads unrelated history');
      assert.match(spoken.at(-1), /beta: that instruction was not sent, so there is no result/);
      assert.equal(task.state, 'failed');
      // Explicit task IDs cannot override mismatching target/operation hints.
      await turn('Has alpha replied?', 'mismatch', {action, session_label: 'alpha', task_id: task.id});
      assert.match(spoken.at(-1), /Which earlier instruction/);
      await turn('Has beta replied?', 'operation-mismatch', {action, session_label: 'beta', task_id: task.id,
        operation_id: 'job_' + 'f'.repeat(64)});
      assert.match(spoken.at(-1), /Which earlier instruction/);
      for (const state of ['dispatching', 'accepted', 'submitted_unconfirmed', 'outcome_unknown']) {
        client.ownerTaskMemory.update(task, {state});
        await turn('Has beta replied?', 'uncertain-' + state, {action, session_label: 'beta', task_id: task.id});
        assert.doesNotMatch(spoken.at(-1), /not sent/);
      }
      assert.equal(attempts.length, 1);
    });
  }
}
