'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {queryInventory, inventorySpeech} = require('../lib/owner-inventory');
function sample() {
  const observedAt = new Date().toISOString();
  return {groupingAvailable: true, observedAt,
    groups: [{id: '$1', name: 'main'}, {id: '$2', name: 'infra'}, {id: '$3', name: 'empty'}],
    sessions: ['active', 'idle', 'unknown'].map((activity, i) => ({id: `os_${i}`, label: `agent${i}`,
      provider: 'codex', activity, availability: i === 2 ? 'unchecked' : 'available',
      observedAt: i === 2 ? null : observedAt, groupIds: i === 2 ? [] : ['$1'], membershipBasis: i === 2 ? 'unknown' : 'resume_launch'}))};
}
test('group names, group members and active-only inventory have separate scopes', () => {
  const raw = sample();
  const groups = queryInventory(raw, {view: 'groups'});
  const speech = inventorySpeech(groups).text;
  assert.match(speech, /main: 2 enrolled sessions, 1 active/);
  assert.match(speech, /empty: 0 enrolled sessions/);
  assert.match(speech, /1 enrolled session has no known group/);
  const members = queryInventory(raw, {tmux_group: 'main', view: 'sessions'});
  assert.equal(members.sessions.length, 2);
  assert.match(inventorySpeech(members).text, /agent0, codex, active, launched in main/);
  assert.equal(queryInventory(raw, {view: 'groups', active_only: true}).groups.length, 1);
  assert.match(inventorySpeech(queryInventory(raw, {view: 'groups', active_only: true})).text, /main: 2 enrolled sessions, 1 active/);
  const active = queryInventory(raw, {active_only: true});
  assert.equal(active.sessions.length, 1);
  assert.match(inventorySpeech(active).text, /Activity is unknown for 1 other sessions/);
});
test('unknown is never idle and missing grouping never means no groups exist', () => {
  const raw = sample(); raw.groupingAvailable = false; raw.groups = [];
  raw.sessions.forEach(s => {s.groupIds = [];});
  assert.match(inventorySpeech(queryInventory(raw, {view: 'groups'})).text, /groups are unavailable/);
  assert.throws(() => queryInventory(raw, {tmux_group: 'main'}), {code: 'OWNER_GROUPS_UNAVAILABLE'});
  assert.match(inventorySpeech(queryInventory(raw, {})).text, /agent2, codex, activity unknown/);
});
test('inventory refuses malformed identities, false active claims and ambiguous or absent group names', () => {
  for (const change of [r => {r.sessions[0].availability = 'unchecked';},
    r => {r.sessions[0].groupIds = ['$999'];}, r => {r.groups[0].name = 'bad\nlabel';},
    r => {r.sessions.push(r.sessions[0]);}, r => {r.sessions[0].activity = 'generating';}]) {
    const raw = sample(); change(raw); assert.throws(() => queryInventory(raw, {}));
  }
  assert.throws(() => queryInventory(sample(), {tmux_group: 'missing'}), {code: 'OWNER_GROUP_NOT_FOUND'});
  const raw = sample(); raw.groups.push({id: '$4', name: 'MAIN'});
  assert.throws(() => queryInventory(raw, {tmux_group: 'main'}), {code: 'OWNER_GROUP_AMBIGUOUS'});
});
test('voice pagination stays scoped and restarts after state or group changes', () => {
  const raw = sample(); raw.groups = Array.from({length: 12}, (_, i) => ({id: `$${i + 1}`, name: `group${i}`}));
  const result = queryInventory(raw, {view: 'groups'});
  const first = inventorySpeech(result); assert.match(first.text, /7 more entries/);
  const second = inventorySpeech(result, first.cursor, true); assert.match(second.text, /group5/); assert.doesNotMatch(second.text, /group0:/);
  assert.equal(inventorySpeech(queryInventory(raw, {}), second.cursor, true).cursor.offset, 3);
  raw.groups[0].name = 'renamed';
  assert.match(inventorySpeech(queryInventory(raw, {view: 'groups'}), first.cursor, true).text, /renamed/);
});
