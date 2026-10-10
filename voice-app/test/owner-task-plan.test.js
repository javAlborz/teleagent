'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {OwnerTaskMemory, validatePlan, runPlan, renderPlan, makeOperationId} = require('../lib/owner-task-plan');
const {VoiceStateStore} = require('../lib/voice-state-store');
const {OpenAIRealtimeClient} = require('../lib/openai-realtime-client');
const {capabilitiesFromHealth} = require('../lib/controller-capabilities');
const {nativeOwnerHealth, executorHealth} = require('./controller-capabilities-fixture');
const labels = ['alpha', 'beta', 'charlie'];
const op = n => 'job_' + String(n).repeat(64);
const send = (label, message) => ({action: 'request_owner_instruction', session_label: label, message, message_source: 'caller'});
const transcript = 'What is one plus one to alpha? What is two plus two to beta? And what is three plus three to Charlie?';
const plan = {selected_sessions: labels, actions: labels.map((label, i) => send(label,
  ['What is one plus one', 'What is two plus two', 'what is three plus three'][i]))};
function checked(memory, value = plan, text = transcript) {
  return validatePlan(value, {transcript: text, labels, memory});
}

test('three-target caller request keeps every mapping and dispatches serially with separate receipts', async () => {
  const memory = new OwnerTaskMemory();
  const validated = checked(memory); memory.select(validated.selected, 'math');
  const tasks = memory.reserve(validated.actions, 'caller-1');
  const calls = []; let active = 0;
  await runPlan(tasks, {memory, current: () => true, delay: async () => {}, execute: async action => {
    assert.equal(active++, 0); calls.push(action);
    await Promise.resolve(); active--;
    if (action.action === 'get_owner_instruction') return {success: true, result: {state: 'accepted'}};
    return {success: true, operation_id: op(labels.indexOf(action.session_label) + 1), result: {state: 'dispatching'}};
  }});
  assert.deepEqual(calls.filter(x => x.action === 'request_owner_instruction').map(x => [x.session_label, x.message]),
    [['alpha', 'What is one plus one'], ['beta', 'What is two plus two'], ['charlie', 'what is three plus three']]);
  assert.deepEqual(tasks.map(t => t.state), ['accepted', 'accepted', 'accepted']);
  assert.deepEqual(new Set(tasks.map(t => t.operation_id)).size, 3);
  const reads = checked(memory, {actions: labels.map(label => ({action: 'inspect_owner_session', session_label: label}))}, 'Read all three replies.');
  assert.deepEqual(reads.actions.map(a => a.operation_id), [op(1), op(2), op(3)]);
  assert.deepEqual(memory.context().groups, [{name: 'math', sessions: labels}]);
  for (const label of labels) assert.match(renderPlan(tasks), new RegExp(`${label}: instruction accepted`));
});

test('failed target and not-yet-sent target cannot become an unrelated old greeting', async () => {
  const memory = new OwnerTaskMemory(); const tasks = memory.reserve(checked(memory).actions, 'caller-1');
  let n = 0;
  await runPlan(tasks, {memory, current: () => n < 2, execute: async action => {
    n++; return action.session_label === 'alpha' ? {success: true, operation_id: op(1), result: {state: 'accepted'}}
      : {success: false, code: 'OWNER_SESSION_NOT_ENROLLED'};
  }});
  assert.deepEqual(tasks.map(t => t.state), ['accepted', 'failed', 'pending']);
  const reads = checked(memory, {actions: labels.map(label => ({action: 'inspect_owner_session', session_label: label}))});
  assert.equal(reads.actions[0].operation_id, op(1));
  assert.equal(reads.actions[1].unsent_task_id, tasks[1].id);
  assert.equal(reads.actions[2].unsent_task_id, tasks[2].id);
  assert.match(renderPlan(tasks), /beta: session not found; instruction not sent/);
  assert.match(renderPlan(tasks), /charlie: not sent or checked yet/);
});

test('uncertain delivery is not retried and prevents later dispatch until reconciled', async () => {
  const memory = new OwnerTaskMemory(); const tasks = memory.reserve(checked(memory).actions, 'caller-1');
  let count = 0;
  await runPlan(tasks, {memory, current: () => true, execute: async () => {
    count++; return {success: false, operation_id: op(1), delivery_attempted: true};
  }});
  assert.equal(count, 1); assert.equal(tasks[0].state, 'outcome_unknown');
  assert.equal(tasks[1].state, 'pending'); assert.equal(tasks[0].operation_id, op(1));
});

test('durable plan survives reopen without sending, and stale writers cannot reserve work', () => {
  const db = new VoiceStateStore();
  try {
    const thread = db.createThread({callerId: 'fixture'});
    const store = {load: () => db.loadOwnerDialogue(thread.id), save: (r, state) => db.saveOwnerDialogue(thread.id, r, state)};
    const memory = new OwnerTaskMemory(store); const stale = new OwnerTaskMemory(store);
    memory.select(labels, 'math'); const tasks = memory.reserve(checked(memory).actions, 'caller-1');
    memory.update(tasks[0], {state: 'dispatching', operation_id: op(1)});
    const reopened = new OwnerTaskMemory(store);
    assert.deepEqual(reopened.value, memory.value);
    assert.equal(reopened.latest('alpha').state, 'dispatching');
    assert.throws(() => stale.reserve(checked(stale).actions, 'caller-2'), {code: 'OWNER_DIALOGUE_STATE_CONFLICT'});
    assert.equal(db.loadOwnerDialogue(thread.id).state.tasks.length, 3);
  } finally { db.close(); }
});

test('reference and composed delegation bind current caller authorization; exact dictation stays exact', () => {
  const memory = new OwnerTaskMemory(); const [prior] = memory.reserve(checked(memory).actions, 'caller-1');
  memory.update(prior, {state: 'accepted', operation_id: op(1)});
  const reference = {action: 'request_owner_instruction', session_label: 'beta', message_source: 'reference',
    task_id: prior.id, authorization_text: 'Ask beta the same question.'};
  const value = checked(memory, {actions: [reference]}, reference.authorization_text);
  assert.equal(value.actions[0].message, 'What is one plus one');
  assert.throws(() => checked(memory, {actions: [{...reference, session_label: 'alpha'}]}, reference.authorization_text),
    {code: 'OWNER_PLAN_ALREADY_ATTEMPTED'});
  assert.throws(() => checked(memory, {actions: [{...reference, task_id: 'invented'}]}, reference.authorization_text),
    {code: 'OWNER_PLAN_REFERENCE_INVALID'});
  assert.throws(() => checked(memory, {actions: [reference]}, 'Read the reply.'), {code: 'OWNER_PLAN_AUTHORIZATION_MISSING'});
  const delegated = {action: 'request_owner_instruction', session_label: 'charlie', message_source: 'delegation',
    authorization_text: 'Ask Charlie to investigate why that deployment failed.',
    message: 'Investigate why the deployment failed and report the cause.'};
  assert.equal(checked(memory, {actions: [delegated]}, delegated.authorization_text).actions[0].message, delegated.message);
  assert.throws(() => checked(memory, {actions: [send('alpha', '3+2')]}, 'Send 3-2 to alpha.'), /OWNER_PLAN_MESSAGE/);
});

test('duplicate entries and an invalid later action reject the entire plan before dispatch', () => {
  const memory = new OwnerTaskMemory();
  assert.throws(() => checked(memory, {actions: [plan.actions[0], plan.actions[0]]}), {code: 'OWNER_PLAN_DUPLICATE_INSTRUCTION'});
  assert.throws(() => checked(memory, {actions: [plan.actions[0], {action: 'shell', message: 'ignored'}]}), {code: 'OWNER_PLAN_ACTION_INVALID'});
  assert.equal(memory.value.tasks.length, 0);
});

test('production-capability client executes one plan through real dispatch and cannot repeat it under a new tool ID', async () => {
  const calls = [];
  const client = new OpenAIRealtimeClient({apiKey: 'offline-fixture', instructions: 'fixture', ownerDecisionRouter: null,
    ownerSessionLabels: labels, ownerCallId: 'fixture-call', capabilities: capabilitiesFromHealth(nativeOwnerHealth(), executorHealth()),
    toolHandler: async (name, args, context) => { calls.push({name, args}); return {success: true,
      operation_id: makeOperationId('fixture-call', context.callId), result: {state: 'accepted'}}; }});
  client.prepareCallerTurn(transcript);
  const routed = id => ({name: 'route_turn', call_id: id,
    arguments: JSON.stringify({action: 'execute_owner_plan', ...plan})});
  const result = await client._handleToolCall(routed('first'), {sendOutput: false});
  assert.equal(result.output.code, 'OWNER_PLAN_RESULT'); assert.equal(result.output.action_count, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.args.session_label), labels);
  await client._handleToolCall(routed('other-model-id'), {sendOutput: false});
  assert.equal(calls.length, 3);
  client.close();
});


test('receipt is durable before IO and a lost response survives restart without retry', async () => {
  let saved = null;
  const store = {load: () => saved, save: (revision, state) => {
    saved = {revision: revision + 1, state: structuredClone(state)}; return saved.revision;
  }};
  const memory = new OwnerTaskMemory(store, id => makeOperationId('call', id));
  const tasks = memory.reserve(checked(memory).actions, 'turn');
  await runPlan(tasks, {memory, current: () => true, execute: async action => {
    assert.equal(saved.state.tasks[0].state, 'dispatching');
    assert.equal(saved.state.tasks[0].operation_id, makeOperationId('call', action.id));
    throw new Error('lost response');
  }});
  const reopened = new OwnerTaskMemory(store);
  assert.deepEqual(reopened.value.tasks.map(t => t.state), ['outcome_unknown', 'pending', 'pending']);
  const reads = checked(reopened, {actions: reopened.value.tasks.map(t => ({action:'get_owner_reply', task_id:t.id}))});
  assert.equal(reads.actions[0].operation_id, tasks[0].operation_id);
  assert.equal(reads.actions[1].unsent_task_id, tasks[1].id);
});

test('interruption preserves unstarted tasks; continue references only those tasks', async () => {
  const memory = new OwnerTaskMemory(null, id => makeOperationId('call', id));
  const tasks = memory.reserve(checked(memory).actions, 'turn');
  let current = true; const sent = [];
  const execute = async task => {
    sent.push(task.session_label); current = false;
    return {success:true, operation_id:task.operation_id, result:{state:'accepted'}};
  };
  await runPlan(tasks, {memory, current: () => current, execute});
  assert.deepEqual(sent, ['alpha']);
  const text = 'Continue with the remaining two.';
  const continuation = checked(memory, {actions: tasks.slice(1).map(task => ({
    action:'request_owner_instruction', session_label:task.session_label, task_id:task.id,
    message_source:'reference', authorization_text:text,
  }))}, text);
  const pending = memory.reserve(continuation.actions, 'next-turn');
  await runPlan(pending, {memory, current: () => true, execute});
  assert.deepEqual(sent, labels);
  assert.deepEqual(tasks.map(t => t.state), ['accepted', 'superseded', 'superseded']);
});

test('capability denial rejects a nested plan before any handler call', async () => {
  let calls=0;
  const client=new OpenAIRealtimeClient({apiKey:'offline', instructions:'fixture', ownerDecisionRouter:null,
    ownerSessionLabels:labels, capabilities:capabilitiesFromHealth(nativeOwnerHealth(), executorHealth()),
    toolHandler:async()=>{calls++;}});
  client.prepareCallerTurn(transcript);
  client.capabilities = {...client.capabilities, ownerSessionsAvailable:false};
  const result=await client._handleOwnerPlan(plan, 'denied', transcript);
  assert.equal(calls,0);assert.equal(result.output.success,false);
  client.close();
});

test('production path preserves an uncertain send and fences remaining targets', async () => {
  let calls=0;
  const client=new OpenAIRealtimeClient({apiKey:'offline', instructions:'fixture', ownerDecisionRouter:null,
    ownerSessionLabels:labels, ownerCallId:'call', capabilities:capabilitiesFromHealth(nativeOwnerHealth(), executorHealth()),
    toolHandler:async()=>{calls++;throw new Error('response lost');}});
  client.prepareCallerTurn(transcript);
  await client._handleOwnerPlan(plan, 'lost', transcript);
  assert.equal(calls,1);
  assert.deepEqual(client.ownerTaskMemory.value.tasks.map(t=>t.state), ['outcome_unknown','pending','pending']);
  client.close();
});


test('latest named reads resolve app receipts and individual followups preserve the selected group', async () => {
  const memory=new OwnerTaskMemory(null,id=>makeOperationId('call',id));memory.select(labels,'math');
  const tasks=memory.reserve(checked(memory).actions,'turn');
  for(const task of tasks)memory.update(task,{state:'accepted'});
  const next=checked(memory,{actions:[{action:'get_owner_reply',session_label:'beta'}],selected_sessions:['beta']});
  assert.equal(next.actions[0].operation_id,tasks[1].operation_id);assert.deepEqual(next.selected,labels);
  assert.deepEqual(checked(memory,{actions:[{action:'get_owner_reply',session_label:'beta'}],selected_sessions:['beta'],replace_group:true}).selected,['beta']);
  assert.equal(memory.context().tasks[0].id,'task_1');
});


test('read-after-send actions bind this plan and never read older replies after a failed send', async () => {
  const memory=new OwnerTaskMemory(null,id=>makeOperationId('call',id));
  const input={actions:[...plan.actions,...labels.map(session_label=>({action:'get_owner_reply',session_label}))]};
  const tasks=memory.reserve(checked(memory,input).actions,'turn');const calls=[];
  await runPlan(tasks,{memory,current:()=>true,execute:async task=>{
    calls.push(task);
    if(task.action==='request_owner_instruction')return task.session_label==='beta'
      ?{success:false,code:'OWNER_SESSION_NOT_ENROLLED'}
      :{success:true,operation_id:task.operation_id,result:{state:'accepted'}};
    return {success:true,result:{history:{latestTurn:{status:'completed',reply:{text:'result'}}}}};
  }});
  assert.equal(calls.length,5);assert.equal(tasks[4].state,'not_sent');
  assert.equal(calls[3].operation_id,tasks[0].operation_id);
  assert.equal(calls[4].operation_id,tasks[2].operation_id);
});
