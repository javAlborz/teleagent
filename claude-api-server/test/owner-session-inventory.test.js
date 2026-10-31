'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {collectInventory} = require('../owner-session-inventory');
const {parsePanes, groupSnapshot, resumeId, eligiblePane, codexExecutable, tmuxIdentity} = require('../owner-tmux-groups');
const ID = '01000000-0000-7000-8000-000000000001';
const entries = [
  {id: 'os_one', label: 'one', provider: 'codex', sessionId: ID, endpoint: {pid: 99}},
  {id: 'os_two', label: 'two', provider: 'claude', endpoint: {pid: 12}, identity: {process: {start: '102'}}},
];
const panes = parsePanes('$1|main|%1|10|/home/alborz\n$2|infra|%2|20|/home/alborz/dev\n');

test('tmux socket permits its normal mode only behind a private owner directory and rejects symlinks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-tmux-'));
  const socket = path.join(root, 'default'); const server = net.createServer();
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true});});
  fs.chmodSync(socket, 0o770);
  assert.ok(tmuxIdentity(socket, process.getuid()).ino);
  fs.chmodSync(root, 0o750);
  assert.throws(() => tmuxIdentity(socket, process.getuid()), {code: 'OWNER_GROUP_SOCKET_UNSAFE'});
  fs.chmodSync(root, 0o700); fs.chmodSync(socket, 0o777);
  assert.throws(() => tmuxIdentity(socket, process.getuid()), {code: 'OWNER_GROUP_SOCKET_UNSAFE'});
  fs.chmodSync(socket, 0o770);
  const linked = path.join(root, 'link'); fs.symlinkSync(socket, linked);
  assert.throws(() => tmuxIdentity(linked, process.getuid()), {code: 'OWNER_GROUP_SOCKET_UNSAFE'});
});

test('tmux metadata refuses ambiguous/control fields and bounded output; excludes org and protected roots', () => {
  assert.equal(panes.length, 2);
  for (const raw of ['$1|main|extra|%1|10|/home/alborz', '$1|bad\tname|%1|10|/home/alborz',
    '$1|main|%1|0|/home/alborz', 'x'.repeat(65537), Array(130).fill('$1|main|%1|10|/home/alborz').join('\n')]) {
    assert.throws(() => parsePanes(raw));
  }
  for (const cwd of ['/home/alborz/ufst/private', '/home/alborz/.ssh', '/home/alborz/private']) {
    assert.equal(eligiblePane({...panes[0], cwd}, ['/home/alborz/private'], '/home/alborz'), false);
  }
  assert.equal(eligiblePane({...panes[0], name: 'ufst'}, [], '/home/alborz'), false);
});

test('groups use exact native identities and process ancestry, never labels, cwd or shared daemon ancestry', () => {
  const processes = new Map([[10, {parent: 1, start: '100'}], [11, {parent: 10, start: '101', codexSessionId: ID}],
    [12, {parent: 10, start: '102'}], [20, {parent: 1, start: '200'}], [99, {parent: 20, start: '999'}]]);
  const result = groupSnapshot(panes, processes, entries);
  assert.deepEqual(result.groups, [{id: '$2', name: 'infra'}, {id: '$1', name: 'main'}]);
  assert.deepEqual(result.memberships.os_one, {groups: ['$1'], basis: 'resume_launch'});
  assert.deepEqual(result.memberships.os_two, {groups: ['$1'], basis: 'native_process'});
  processes.get(12).start = 'reused';
  processes.get(11).codexSessionId = 'other';
  const changed = groupSnapshot(panes, processes, entries);
  assert.deepEqual(changed.memberships.os_one.groups, []);
  assert.deepEqual(changed.memberships.os_two.groups, []);
  assert.equal(resumeId(['codex', 'resume', ID]), ID);
  assert.equal(resumeId(['codex', 'resume', '--last']), null);
  assert.equal(resumeId(['codex', 'new', ID]), null);
  assert.equal(codexExecutable('/usr/bin/codex (deleted)'), true);
  assert.equal(codexExecutable('/usr/bin/codex-code-mode-host'), false);
});

test('linked panes retain multiple groups; fresh snapshots follow moves and renames', () => {
  const linked = [...panes, {...panes[0], id: '$3', name: 'linked'}];
  const processes = new Map([[10, {parent: 1, start: '100'}], [12, {parent: 10, start: '102'}]]);
  assert.deepEqual(groupSnapshot(linked, processes, entries).memberships.os_two.groups, ['$1', '$3']);
  const moved = [{...panes[0], id: '$4', name: 'renamed'}];
  assert.deepEqual(groupSnapshot(moved, processes, entries).memberships.os_two.groups, ['$4']);
});

test('activity sample distinguishes active, idle, unknown and unavailable without exporting native fields', async () => {
  const sample = [...entries, {...entries[0], id: 'os_three'}, {...entries[0], id: 'os_four'}];
  const result = await collectInventory(sample, {
    topology: async () => ({available: true, groups: [{id: '$1', name: 'main'}], memberships: {
      os_one: {groups: ['$1'], basis: 'resume_launch'},
    }}),
    inspect: async id => { if (id === 'os_four') throw Error('private path/secret');
      return {os_one: 'active', os_two: 'idle', os_three: 'unknown'}[id]; },
  });
  assert.deepEqual(result.sessions.map(s => s.activity), ['active', 'idle', 'unknown', 'unknown']);
  assert.equal(result.sessions[3].availability, 'unavailable');
  assert.equal(result.activityComplete, false);
  assert.equal(result.tmuxPaneBinding, false);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|endpoint|sessionId/);
});

test('slow reads leave the unvisited tail unknown and topology failure does not erase native status', async () => {
  let clock = 0; const calls = [];
  const result = await collectInventory(entries, {
    now: () => clock, budgetMs: 500,
    topology: async () => { throw Error('no tmux'); },
    inspect: async (id, timeout) => { calls.push([id, timeout]); clock = 500; return 'busy'; },
  });
  assert.deepEqual(calls, [['os_one', 500]]);
  assert.equal(result.groupingAvailable, false);
  assert.deepEqual(result.sessions.map(s => s.activity), ['active', 'unknown']);
  assert.equal(result.sessions[1].availability, 'unchecked');
});
