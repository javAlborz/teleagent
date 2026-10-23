'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spokenReply, missingSessionSpeech} = require('../lib/owner-readback');
const {OwnerTaskMemory, validatePlan, renderPlan, resultSnapshot} = require('../lib/owner-task-plan');
const {OpenAIRealtimeClient, buildRealtimeRouterTool} = require('../lib/openai-realtime-client');
const {capabilitiesFromHealth} = require('../lib/controller-capabilities');
const {nativeOwnerHealth, executorHealth} = require('./controller-capabilities-fixture');
const capabilities = capabilitiesFromHealth(nativeOwnerHealth(), executorHealth());

const reply = 'Create a **running agent session**, give it a unique name, and leave it running.\n' +
  'Open your project and run:\n```bash\ncodex\n```\n' +
  'Read the [documentation](https://example.test/very/long/link). ' +
  'Keep the session open. '.repeat(35) + 'The final detail is violet.';

test('default preview is bounded and labeled; full read includes the final detail without changing stored text', () => {
  const snapshot = resultSnapshot({success: true, result: {history: {latestTurn: {status: 'completed', reply: {text: reply}}}}});
  const task = {action: 'get_owner_reply', session_label: 'phoneA', state: 'read', result: snapshot};
  const brief = renderPlan([task]);
  assert.match(brief, /brief excerpt.*read the full reply/);
  assert.ok(brief.split(/\s+/).length < 85);
  assert.doesNotMatch(brief, /```|\*\*|https:\/\/|final detail/);
  const full = renderPlan([{...task, reply_detail: 'full'}]);
  assert.match(full, /final detail is violet/);
  assert.doesNotMatch(full, /brief excerpt/);
  assert.equal(snapshot.reply, reply, 'presentation never rewrites the retained source');
  assert.match(spokenReply('partial', {detail: 'full', clipped: true}), /saved reply is clipped/);
});

test('preview never cuts a quoted command into a misleading shorter command', () => {
  const command = 'echo one && echo two && echo three';
  const text = 'Run `' + command + '` after checking the directory.';
  const brief = spokenReply(text, {words: 4});
  assert.doesNotMatch(brief, /echo/);
  assert.match(spokenReply(text, {detail: 'full'}), /echo one && echo two && echo three/);
  assert.equal(spokenReply('**Done.**'), 'Done.');
});

test('missing new-session read and send explain discovery without pretending enrollment or delivery', () => {
  for (const action of ['inspect_owner_session', 'request_owner_instruction']) {
    const text = renderPlan([{action, session_label: 'Aurora', state: 'failed',
      result: {success: false, code: 'OWNER_SESSION_NOT_ENROLLED'}}]);
    assert.match(text, /Aurora: session not found/);
    assert.match(text, /discovered between calls/);
    assert.doesNotMatch(text, /instruction accepted|will send|has been enrolled/);
    assert.equal(text, missingSessionSpeech('Aurora', action === 'request_owner_instruction'));
  }
});

test('a new session read cannot reuse the creating session receipt through a conflicting task hint', () => {
  const memory = new OwnerTaskMemory();
  const [task] = memory.reserve([{action: 'request_owner_instruction', session_label: 'alpha',
    message: 'Create Aurora.'}], 'create');
  memory.update(task, {state: 'accepted', operation_id: 'job_' + 'a'.repeat(64)});
  for (const action of ['get_owner_reply', 'get_owner_instruction']) {
    assert.throws(() => validatePlan({actions: [{action, session_label: 'Aurora', task_id: task.id}]},
      {transcript: 'Read Aurora.', labels: ['alpha'], memory}), {code: 'OWNER_PLAN_REFERENCE_INVALID'});
  }
  const checked = validatePlan({actions: [{action: 'inspect_owner_session', session_label: 'Aurora', history: true}]},
    {transcript: 'What was the new Codex reply?', labels: ['alpha'], memory});
  assert.equal(checked.actions[0].action, 'inspect_owner_session');
  assert.equal(checked.actions[0].session_label, 'Aurora');
  assert.equal(checked.actions[0].operation_id, undefined);
});

test('brief then full plan and direct reads use the same source and never forward presentation flags or send', async t => {
  const calls = [], spoken = [];
  const client = new OpenAIRealtimeClient({apiKey: 'fixture', capabilities, instructions: 'Offline owner-session fixture.', ownerSessionLabels: ['Aurora'],
    ownerSpeech: async ({text}) => {spoken.push(text); return {state: 'played'};},
    toolHandler: async (name, args) => {
      calls.push({name, args});
      assert.equal(name, 'inspect_owner_session');
      assert.equal(args.reply_detail, undefined);
      return {success: true, result: {label: 'Aurora', history: {latestTurn: {status: 'completed', reply: {text: reply}}}}};
    }});
  t.after(() => client.close());
  client.connected = true; client.ws = {readyState: 1, send() {}, close() {}};
  for (const [index, plan] of [true, false].entries()) {
    client.prepareCallerTurn('Read the full reply from Aurora.');
    const fields = {action: 'inspect_owner_session', session_label: 'Aurora', history: true, reply_detail: 'full'};
    await client._handleResponseDone({output: [{type: 'function_call', name: 'route_turn', call_id: `full-${index}`,
      arguments: JSON.stringify({proposed_message: null, ...(plan ? {action: 'execute_owner_plan', actions: [fields]} : fields)})}]});
    await client.ownerSpeechCompletion;
    assert.match(spoken.at(-1), /final detail is violet/);
    assert.doesNotMatch(spoken.at(-1), /brief excerpt/);
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.args.session_label === 'Aurora'));
  assert.equal(client.ownerReadContext.text, reply);
  const schema = buildRealtimeRouterTool(['codex-sol'], capabilities).parameters.properties;
  assert.deepEqual(schema.reply_detail.enum, ['brief', 'full']);
  assert.deepEqual(schema.actions.items.properties.reply_detail.enum, ['brief', 'full']);
});
