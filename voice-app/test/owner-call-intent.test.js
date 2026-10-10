'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOwnerInstruction, checkOwnerInstruction, verbatimMessageSpan } = require('../lib/owner-call-intent');
const { OwnerReplyWatch } = require('../lib/owner-reply-watch');
const operation = 'job_' + 'a'.repeat(64);

function watcher(overrides = {}) {
  const tasks = []; const read = []; const spoken = [];
  const watch = new OwnerReplyWatch({ schedule: fn => { tasks.push(fn); return 1; }, cancel() {},
    read: async id => { read.push(id); return { success: true, result: { history: { latestTurn: { status: 'completed', reply: { text: '100' } } } } }; },
    available: () => true, speak: result => { spoken.push(result); return true; }, timeout() {}, ...overrides });
  return { watch, tasks, read, spoken };
}

test('watch reads only the recorded operation, speaks once, and deduplicates reminders', async () => {
  const f = watcher(); f.watch.start(operation); f.watch.start(operation);
  assert.equal(f.tasks.length, 1);
  await f.watch.tick(f.watch.current);
  assert.deepEqual(f.read, [operation]); assert.equal(f.spoken.length, 1);
  assert.equal(f.watch.current, null);
});

test('ending the call fences a pending read; user speech defers checks', async () => {
  let resolve; const f = watcher({ read: () => new Promise(r => { resolve = r; }) });
  f.watch.start(operation); const pending = f.watch.tick(f.watch.current); f.watch.stop();
  resolve({ success: true, result: { history: { latestTurn: { status: 'completed', reply: { text: 'late' } } } } });
  await pending; assert.equal(f.spoken.length, 0); assert.equal(f.watch.current, null);
  const g = watcher({ available: () => false });g.watch.start(operation);await g.watch.tick(g.watch.current);
  assert.equal(g.read.length, 0);assert.equal(g.spoken.length, 0);
});

test('a long-running instruction keeps its single watch until call end without resending', async () => {
  let checks = 0;
  const f = watcher({ read: async () => { checks++; return { success: true, result: { history: { latestTurn: { status: 'inProgress', reply: null } } } }; } });
  f.watch.start(operation);const original = f.watch.current;
  for (let i = 0; i < 100; i++) await f.watch.tick(original);
  assert.equal(checks, 100);assert.equal(f.watch.current, original);assert.equal(f.spoken.length, 0);
  f.watch.stop();assert.equal(f.watch.current, null);
});


test('only verbatim current caller content or a presented exact draft can supply message bytes', () => {
  const state = {labels:['phoneA','drizzy'], draft:null};
  const args = {session_label:'phone A', message:'what is two plus two?'};
  const caller = 'Would you ask phone A what is two plus two?';
  assert.deepEqual(validateOwnerInstruction(caller,args,{kind:'caller',text:args.message},state),
    {...args, session_label:'phoneA', notify_when_complete:false});
  for (const source of [null, {kind:'caller',text:'4'}, {kind:'draft',draft_id:'invented'}]) {
    assert.equal(validateOwnerInstruction(caller,args,source,state), null);
  }
  assert.equal(validateOwnerInstruction('Send that then.',args,{kind:'caller',text:args.message},state),null);
  assert.equal(validateOwnerInstruction(caller,{...args,message:'4'},{kind:'caller',text:args.message},state),null);
  const draft={id:'draft-1',session_label:'phoneA',message:args.message,presented:true};
  assert.ok(validateOwnerInstruction('Send it.',args,{kind:'draft',draft_id:draft.id},{...state,draft}));
  for (const changed of [{...draft,presented:false},{...draft,id:'other'},{...draft,session_label:'drizzy'},{...draft,message:'deploy'}]) {
    assert.equal(validateOwnerInstruction('Send it.',args,{kind:'draft',draft_id:draft.id},{...state,draft:changed}),null);
  }
});

test('ambiguous enrollment aliases and malformed message envelopes cannot dispatch', () => {
  const args={session_label:'phone A',message:'hello'};
  const source={kind:'caller',text:'hello'};
  assert.equal(validateOwnerInstruction('Send hello',args,source,{labels:['phoneA','phone A']}),null);
  for(const message of ['', ' '.repeat(10), 'x'.repeat(1201), null, {}]) {
    assert.equal(validateOwnerInstruction('Send hello',{...args,message},source,{labels:['phoneA']}),null);
  }
});

test('capitalization may differ but original bytes and internal operators are preserved',()=>{
  const args={session_label:'drizzy',message:'What is ten times ten?'};
  const source={kind:'caller',text:args.message};
  assert.equal(validateOwnerInstruction('Ask it what is ten times ten and read it back',args,source,{labels:['drizzy']}).message,'what is ten times ten');
  assert.equal(validateOwnerInstruction('Send 3-2 to drizzy',{...args,message:'3+2'},{kind:'caller',text:'3+2'},{labels:['drizzy']}),null);
});

test('an unframed conversational followup is not an entire new message unless content was requested',()=>{
  const args={session_label:'drizzy',message:'Okay reply.'},source={kind:'caller',text:'Okay reply.'};
  assert.equal(validateOwnerInstruction('Okay reply.',args,source,{labels:['drizzy']}),null);
  assert.ok(validateOwnerInstruction('Okay reply.',args,source,{labels:['drizzy'],awaitingMessage:true}));
});

test('paused dictation tolerates boundary punctuation but returns exact caller bytes', () => {
  const transcript = 'Would you now go to the phone A session and reply to that. The reply should be, I just did some texting\nInvestigate logs.\nAnd read the reply to me afterwards when it is done.';
  const args = {session_label: 'phone A', message: 'I just did some texting. Investigate logs.', notify_when_complete: true};
  const result = checkOwnerInstruction(transcript, args, {kind: 'caller', text: args.message}, {labels: ['phoneA']});
  assert.deepEqual(result, {reason: null, instruction: {session_label: 'phoneA',
    message: 'I just did some texting\nInvestigate logs.', notify_when_complete: true}});
  assert.equal(verbatimMessageSpan('Send first.\nSecond!', 'first Second'), 'first.\nSecond!');
  assert.equal(verbatimMessageSpan('Send first second', 'first. second'), null);
  assert.equal(verbatimMessageSpan('Send 3-2\nthen report', '3+2. then report'), null);
  assert.equal(verbatimMessageSpan('Send first\nsecond or first\nsecond', 'first. second'), null);
  assert.equal(verbatimMessageSpan('Send change\nthen report', 'change then deploy'), null);
  assert.equal(checkOwnerInstruction('Read the reply', args, {kind: 'caller', text: args.message},
    {labels: ['phoneA']}).reason, 'caller_span_mismatch');
});


test('watches rotate waiting tasks and do not overlap a canceled in-flight read', async () => {
  const a=operation,b='job_'+'b'.repeat(64);let release,active=0,maxActive=0;
  const f=watcher({read:async id=>{
    active++;maxActive=Math.max(maxActive,active);
    if(id===a)await new Promise(resolve=>{release=resolve;});
    active--;
    return {success:true,result:{history:{latestTurn:{status:'completed',reply:{text:id}}}}};
  }});
  f.watch.start(a);f.watch.start(b);
  const pending=f.watch.tick(f.watch.current);
  f.watch.stop(a);await f.watch.tick(f.watch.current);
  assert.equal(active,1);assert.equal(f.spoken.length,0);
  release();await pending;
  await f.watch.tick(f.watch.current);
  assert.equal(maxActive,1);assert.equal(f.spoken.length,1);assert.equal(f.watch.current,null);
  const g=watcher({read:async id=>({success:true,result:{history:{latestTurn:
    id===a?{status:'inProgress'}:{status:'failed',reply:null}}}})});
  g.watch.start(a);g.watch.start(b);
  await g.watch.tick(g.watch.current);assert.equal(g.watch.current.operationId,b);
  await g.watch.tick(g.watch.current);assert.equal(g.spoken.length,1);
  assert.equal(g.watch.current.operationId,a);g.watch.stop();
});
