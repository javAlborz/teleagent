'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerCorrectionRoute, ownerSendRoute, preserveOwnerMessage } = require('../lib/owner-call-intent');
const { OwnerReplyWatch } = require('../lib/owner-reply-watch');
const operation = 'job_' + 'a'.repeat(64);

test('explicit name corrections beat old focus; readback reminders cannot send', () => {
  assert.deepEqual(ownerCorrectionRoute('No, no, I mean the drizzy session.', 'tmuxp', null),
    { action: 'inspect_owner_session', args: { session_label: 'drizzy', history: true } });
  assert.deepEqual(ownerCorrectionRoute('But I asked it to, back once it was done, right?', 'drizzy', operation),
    { action: 'get_owner_reply', args: { operation_id: operation, notify_when_complete: true } });
  assert.equal(preserveOwnerMessage('But I asked it to, back once it was done, right?',
    { session_label: 'drizzy', message: 'Please answer: What is 10 times 10?' }), null);
});

test('forwarded questions stay questions; invented or expanded messages are refused', () => {
  assert.equal(preserveOwnerMessage('All right, could you write what is two plus two in that same syntax?',
    { session_label: 'drizzy', message: '2+2 is 4.' }).message, 'what is two plus two');
  assert.equal(preserveOwnerMessage('Ask Drizzy what is ten times ten and immediately read it back when done.',
    { session_label: 'drizzy', message: 'What is 10 times 10?' }).message, 'what is ten times ten');
  const input = preserveOwnerMessage('Okay, now ask it what is 36 times 36?', { session_label: 'drizzy', message: '1296' });
  assert.equal(input.message, 'what is 36 times 36?');
  assert.equal(preserveOwnerMessage('Ask it what is ten times ten and immediately read it back when done.',
    { session_label: 'drizzy', message: '100' }).notify_when_complete, true);
  assert.equal(preserveOwnerMessage('Send thanks to Drizzy', { message: 'Delete the project', session_label: 'drizzy' }), null);
  assert.equal(preserveOwnerMessage('What is the latest message there now?', { message: 'Repeat', session_label: 'drizzy' }), null);
});

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

test('unknown replies expire the watcher without canceling or sending native work', async () => {
  let timedOut = 0;
  const f = watcher({ read: async () => ({ success: true, result: { history: { latestTurn: { status: 'unknown', reply: null } } } }), timeout: () => timedOut++ });
  f.watch.start(operation);
  for (let i = 0; i < 60; i++) await f.watch.tick(f.watch.current);
  assert.equal(timedOut, 1); assert.equal(f.spoken.length, 0); assert.equal(f.watch.current, null);
});

test('explicit enrolled names override context and compound targets require clarification', () => {
  assert.equal(ownerCorrectionRoute('Read the latest reply from drizzy', 'tmuxp', null, ['tmuxp', 'drizzy']).args.session_label, 'drizzy');
  assert.equal(ownerCorrectionRoute('Okay, can you read the latest for Cy and Drizzy?', 'tmuxp', null, ['tmuxp', 'drizzy']).action, 'respond');
});

test('reading words inside a new message do not turn a send into a read', () => {
  assert.equal(ownerCorrectionRoute('Tell Drizzy to read the README', 'phoneA', operation, ['drizzy', 'phoneA']), null);
});


test('explicit ask/send commands use verified focus without being routed to managed work', () => {
  for (const text of ['Okay, now ask it what is 36 times 36?', 'Could you write what is two plus two in that same syntax?']) {
    const route = ownerSendRoute(text, 'drizzy', ['drizzy']);
    assert.equal(route.action, 'request_owner_instruction');assert.equal(route.args.session_label, 'drizzy');
    assert.match(route.args.message, /^what is /);
  }
  assert.equal(ownerSendRoute('Ask Drizzy what is ten times ten and read it back when done.', null, ['drizzy']).args.notify_when_complete, true);
  for (const text of ['But I asked it to read back when done', 'Did you tell it what is 36 times 36?', 'Read the message: ask it to deploy', 'What does ask it mean?']) {
    assert.equal(ownerSendRoute(text, 'drizzy', ['drizzy']), null);
  }
  assert.equal(ownerSendRoute('Ask it what is 36 times 36?', null, []), null);
});


test('ordinary multi-part agent instructions are preserved and negated readback stays off', () => {
  const route = ownerSendRoute('Ask Drizzy to deploy and read the documentation', null, ['drizzy']);
  assert.equal(route.args.message, 'to deploy and read the documentation');
  assert.equal(preserveOwnerMessage("Ask it what is ten times ten, do not read it back when done", {session_label: 'drizzy'}).notify_when_complete, false);
});
