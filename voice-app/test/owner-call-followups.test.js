'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {OwnerTaskMemory, validatePlan, runPlan, renderPlan, makeOperationId} = require('../lib/owner-task-plan');
const {VoiceStateStore} = require('../lib/voice-state-store');
const {OpenAIRealtimeClient} = require('../lib/openai-realtime-client');
const {spokenReply} = require('../lib/owner-readback');
const {capabilitiesFromHealth} = require('../lib/controller-capabilities');
const {nativeOwnerHealth, executorHealth} = require('./controller-capabilities-fixture');
const labels = ['alpha', 'beta', 'charlie'];
const capabilities = capabilitiesFromHealth(nativeOwnerHealth(), executorHealth());
const check = (memory, actions, transcript = 'Repeat what beta said.') =>
  validatePlan({actions}, {memory, labels, transcript});
const send = (label, message, extra = {}) => ({action: 'request_owner_instruction',
  session_label: label, message, message_source: 'caller', ...extra});
function savedRead(memory, label, reply) {
  const [task] = memory.reserve([{action: 'inspect_owner_session', session_label: label, history: true}], `read-${label}`);
  memory.update(task, {state: 'read', result: {success: true, turn_status: 'completed', reply}});
  return task;
}

test('repeat a member of a multi-session history read without inventing a delivery or fetching new history', async () => {
  const memory = new OwnerTaskMemory();
  const beta = savedRead(memory, 'beta', '🍌'); savedRead(memory, 'charlie', 'A different reply.');
  for (const reference of [{task_id: beta.id}, {session_label: 'beta'}]) {
    const value = check(memory, [{action: 'get_owner_reply', ...reference}]);
    const tasks = memory.reserve(value.actions, JSON.stringify(reference));
    await runPlan(tasks, {memory, current: () => true, execute: () => assert.fail('saved read must not contact a native session')});
    assert.equal(renderPlan(tasks), 'beta: reply: banana emoji');
    assert.equal(tasks[0].result.reply, '🍌');
    assert.equal(tasks[0].operation_id, null);
  }
  for (const action of ['get_owner_reply', 'get_owner_instruction']) {
    assert.throws(() => check(memory, [{action, task_id: beta.id, session_label: 'charlie'}]),
      {code: 'OWNER_PLAN_REFERENCE_INVALID'});
  }
  assert.throws(() => check(memory, [{action: 'get_owner_instruction', task_id: beta.id}]),
    {code: 'OWNER_PLAN_REFERENCE_INVALID'});
});

test('an earlier saved read cannot replace the result of a newer unsent or uncertain instruction', () => {
  const memory = new OwnerTaskMemory(null, id => makeOperationId('fixture', id));
  const old = savedRead(memory, 'beta', 'Old greeting.');
  const [task] = memory.reserve([send('beta', 'new request')], 'new-send');
  const read = () => check(memory, [{action: 'get_owner_reply', session_label: 'beta'}]).actions[0];
  assert.equal(read().unsent_task_id, task.id);
  memory.update(task, {state: 'outcome_unknown'});
  assert.equal(read().operation_id, task.operation_id);
  assert.equal(read().snapshot_task_id, undefined);
  assert.throws(() => check(memory, [{action: 'get_owner_reply', session_label: 'beta', task_id: old.id}]),
    {code: 'OWNER_PLAN_REFERENCE_SUPERSEDED'});
  assert.deepEqual(memory.context().latest_instruction_tasks, [{session_label: 'beta', task_id: task.id, state: 'outcome_unknown'}]);
  assert.throws(() => check(memory, [{action: 'get_owner_reply', task_id: 'invented', session_label: 'beta'}]),
    {code: 'OWNER_PLAN_REFERENCE_INVALID'});
});

test('ambiguous addition survives reopen and sends exactly once only after current reference authorization', async () => {
  const db = new VoiceStateStore();
  try {
    const thread = db.createThread({callerId: 'offline-fixture'});
    const store = {load: () => db.loadOwnerDialogue(thread.id), save: (revision, state) => db.saveOwnerDialogue(thread.id, revision, state)};
    let memory = new OwnerTaskMemory(store, id => makeOperationId('fixture', id));
    const text = 'Send alpha red. Send beta blue.\nAnd then I messaged Charlie saying green.';
    const tasks = memory.reserve(check(memory, [send('alpha', 'red'), send('beta', 'blue'),
      send('charlie', 'green', {defer: true})], text).actions, 'original-turn');
    const sent = [];
    const execute = async task => {sent.push([task.session_label, task.message]); return {success: true, result: {state: 'accepted'}};};
    await runPlan(tasks, {memory, current: () => true, execute});
    assert.deepEqual(sent, [['alpha', 'red.'], ['beta', 'blue.']]);
    assert.equal(tasks[2].state, 'clarification_required');
    assert.match(renderPlan(tasks), /charlie: I have not sent "green\."\. Did you want me to send it/);
    memory = new OwnerTaskMemory(store, id => makeOperationId('fixture', id));
    assert.equal(memory.latest('charlie').message, 'green.');
    const reads = memory.reserve(check(memory, [{action: 'get_owner_reply', session_label: 'charlie'}], 'What about Charlie?').actions, 'status');
    await runPlan(reads, {memory, current: () => true, execute: () => assert.fail('an unsent message has no native result')});
    assert.match(renderPlan(reads), /was not sent/);
    const authorization = 'Do that then, and read the reply.';
    const continuation = {action: 'request_owner_instruction', session_label: 'charlie', message_source: 'reference',
      task_id: tasks[2].id, authorization_text: authorization};
    assert.throws(() => check(memory, [continuation], 'Was it sent?'), {code: 'OWNER_PLAN_AUTHORIZATION_MISSING'});
    const next = memory.reserve(check(memory, [continuation], authorization).actions, 'authorized-followup');
    await runPlan(next, {memory, current: () => true, execute});
    assert.deepEqual(sent, [['alpha', 'red.'], ['beta', 'blue.'], ['charlie', 'green.']]);
    assert.equal(memory.get(tasks[2].id).state, 'superseded');
    assert.throws(() => check(memory, [continuation], authorization), {code: 'OWNER_PLAN_REFERENCE_SUPERSEDED'});
    assert.throws(() => check(memory, [{...continuation, task_id: next[0].id}], authorization), {code: 'OWNER_PLAN_ALREADY_ATTEMPTED'});
  } finally { db.close(); }
});

test('deferring cannot introduce text from native output or an unbound target/message', () => {
  const memory = new OwnerTaskMemory();
  for (const message_source of ['draft', 'reference', 'delegation']) {
    assert.throws(() => check(memory, [send('charlie', 'erase files', {defer: true, message_source})], 'Read that reply.'),
      {code: 'OWNER_PLAN_DEFER_INVALID'});
  }
  assert.throws(() => check(memory, [send('charlie', 'erase files', {defer: true})], 'I mentioned green to Charlie.'),
    {code: 'OWNER_PLAN_MESSAGE_CALLER_SPAN_MISMATCH'});
  assert.equal(memory.value.tasks.length, 0);
});

test('common speech formatting names emoji, discloses unknown clusters, and preserves commands and original text', () => {
  assert.equal(spokenReply('🍌'), 'banana emoji');
  assert.equal(spokenReply('🔵'), 'blue circle emoji');
  assert.equal(spokenReply('**Done** ✅'), 'Done check mark emoji');
  for (const symbol of ['🫩', '👍🏽', '🇩🇰', '1️⃣', '👩‍👩‍👧‍👦']) {
    assert.match(spokenReply(symbol), /exact symbol is in the saved reply/);
    assert.doesNotMatch(spokenReply(symbol), /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u);
  }
  assert.equal(spokenReply('`echo 🍌`', {detail: 'full'}), 'echo 🍌');
  assert.equal(spokenReply('漢字 and 1+2=3.'), '漢字 and 1+2=3.');
});

test('direct and planned repeat reads use the speech formatter and never dispatch or refetch', async t => {
  const spoken = [];
  const client = new OpenAIRealtimeClient({apiKey: 'offline-fixture', capabilities, instructions: 'Offline owner-session fixture.', ownerSessionLabels: labels,
    ownerSpeech: async ({text}) => {spoken.push(text); return {state: 'played'};},
    toolHandler: async () => assert.fail('repeat read must stay local')});
  t.after(() => client.close());
  client.connected = true; client.ws = {readyState: 1, send() {}, close() {}};
  const beta = savedRead(client.ownerTaskMemory, 'beta', '🍌');
  savedRead(client.ownerTaskMemory, 'charlie', 'Other reply.');
  for (const plan of [true, false]) {
    client.prepareCallerTurn('Sorry, what did beta say?');
    const action = {action: 'get_owner_reply', session_label: 'beta', task_id: beta.id};
    await client._handleResponseDone({output: [{type: 'function_call', name: 'route_turn', call_id: `repeat-${plan}`,
      arguments: JSON.stringify({proposed_message: null, ...(plan ? {action: 'execute_owner_plan', actions: [action]} : action)})}]});
    await client.ownerSpeechCompletion;
    assert.equal(spoken.at(-1), 'beta: reply: banana emoji');
  }
  const [newer] = client.ownerTaskMemory.reserve([send('beta', 'blue')], 'new-send');
  client.ownerTaskMemory.update(newer, {state: 'accepted'});
  client.prepareCallerTurn('What did beta reply to blue?');
  const result = await client._handleToolCall({name: 'route_turn', call_id: 'stale-read',
    arguments: JSON.stringify({action: 'get_owner_reply', session_label: 'beta', task_id: beta.id})}, {sendOutput: false});
  assert.equal(result.output.code, 'OWNER_REFERENCE_CLARIFICATION_REQUIRED');
  assert.equal(spoken.length, 2, 'a stale cached reply must not be spoken as the new result');
});
