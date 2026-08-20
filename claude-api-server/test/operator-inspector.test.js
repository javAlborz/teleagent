'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  OperatorInspector,
  enrichTmuxPanes,
  isSensitivePath,
  redactSensitiveText,
} = require('../operator-inspector');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-inspector-'));
  const root = path.join(base, 'allowed');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'README.md'), 'token=secret-value\nplain text\n');
  fs.writeFileSync(path.join(root, '.env'), 'DO_NOT_READ=true\n');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside\n');
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(root, 'escape.txt'));
  const inspector = new OperatorInspector({ allowedRoots: [root], home: base });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { inspector, root };
}

test('bounded file inspection lists safe files, clips output, and redacts labeled secrets', async (t) => {
  const { inspector, root } = fixture(t);
  const listing = await inspector.listDirectory({ path: root });
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['escape.txt', 'README.md']);

  const read = await inspector.readTextFile({ path: path.join(root, 'README.md'), max_bytes: 256 });
  assert.match(read.content, /token=\[REDACTED\]/);
  assert.match(read.content, /plain text/);
});

test('sensitive files and symlink escapes are denied after realpath resolution', async (t) => {
  const { inspector, root } = fixture(t);
  await assert.rejects(
    inspector.readTextFile({ path: path.join(root, '.env') }),
    (error) => error.code === 'SENSITIVE_PATH'
  );
  await assert.rejects(
    inspector.readTextFile({ path: path.join(root, 'escape.txt') }),
    (error) => error.code === 'PATH_OUTSIDE_ROOTS'
  );
});

test('credential redaction covers common key, flag, token, and private-key forms', () => {
  const input = [
    'api_key=topsecret',
    '--password hunter2',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'github_pat_abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN TEST PRIVATE KEY-----\nmaterial\n-----END TEST PRIVATE KEY-----',
  ].join('\n');
  const redacted = redactSensitiveText(input);
  assert.doesNotMatch(redacted, /topsecret|hunter2|abcdefghijklmnopqrstuvwxyz|material/);
  assert.equal(isSensitivePath('/tmp/example/.ssh/config'), true);
  assert.equal(isSensitivePath('/tmp/example/src/index.js'), false);
});

test('tmux panes include window names and map node-wrapped Codex descendants to their pane', () => {
  const tmux = [
    'main\t5\t1\t%12\t2129946\tnode\t/home/alborz/phone\t1\tphone',
    'main\t6\t1\t%13\t2117137\tpi\t/home/alborz/dev2\t0\tpi',
  ].join('\n');
  const processes = [
    '2129946 47746 Ss -bash',
    '2152926 2129946 Sl node /opt/node/bin/codex',
    '2152998 2152926 Sl /opt/codex-linux/bin/codex',
    '2117137 47746 Ss -bash',
    '2120682 2117137 Sl pi',
  ].join('\n');

  const panes = enrichTmuxPanes(tmux, processes);
  assert.equal(panes[0].target, 'main:5.1');
  assert.equal(panes[0].stable_target, '%12');
  assert.equal(panes[0].named_target, 'main:phone.1');
  assert.equal(panes[0].window_name, 'phone');
  assert.equal(panes[0].agent, 'codex');
  assert.equal(panes[0].agent_process_count, 2);
  assert.ok(panes[0].agent_processes.every((process) => process.provider === 'codex'));
  assert.equal(panes[1].window_name, 'pi');
  assert.equal(panes[1].agent, null);
});

test('agent attribution ignores shell commands that merely mention bridge filenames', () => {
  const tmux = 'main\t5\t1\t%12\t100\tnode\t/home/alborz/phone\t1\tphone\n';
  const processes = [
    '100 1 Ss -bash',
    '101 100 S /bin/bash -lc docker exec voice-app node -e require(claude-bridge)',
    '102 100 Sl node /opt/bin/codex',
  ].join('\n');
  const [pane] = enrichTmuxPanes(tmux, processes);
  assert.equal(pane.agent, 'codex');
  assert.equal(pane.agent_process_count, 1);
});

test('tmux session filtering is bounded and returns mapped process metadata', async () => {
  const calls = [];
  const fakeExec = async (command, args) => {
    calls.push({ command, args });
    if (command === 'tmux') {
      return {
        stdout: 'main\t5\t1\t%12\t2129946\tnode\t/home/alborz/phone\t1\tphone\n',
      };
    }
    if (command === 'ps') {
      return { stdout: '2129946 47746 Ss -bash\n2152926 2129946 Sl node /opt/bin/codex\n' };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  const inspector = new OperatorInspector({
    allowedRoots: [],
    home: '/tmp',
    execFileImpl: fakeExec,
  });
  const result = await inspector.listTmuxSessions({ session: 'main' });
  assert.equal(result.session_count, 1);
  assert.equal(result.sessions[0].name, 'main');
  assert.equal(result.sessions[0].windows[0].name, 'phone');
  assert.equal(result.sessions[0].windows[0].agent, 'codex');
  assert.equal(result.sessions[0].windows[0].panes[0].target, 'main:5.1');
  assert.equal(result.sessions[0].windows[0].panes[0].stable_target, '%12');
  assert.equal(result.sessions[0].windows[0].panes[0].named_target, 'main:phone.1');
  assert.equal(result.sessions[0].windows[0].panes[0].conversation_name, 'phone');
  assert.equal(JSON.stringify(result).includes('agent_processes'), false);
  assert.deepEqual(calls[0].args.slice(0, 4), ['list-panes', '-s', '-t', 'main']);
  await assert.rejects(
    inspector.listTmuxSessions({ session: 'main;shutdown' }),
    (error) => error.code === 'INVALID_TMUX_TARGET'
  );
});

test('pane inspection returns canonical, named, and stable target identities', async () => {
  const fakeExec = async (command, args) => {
    if (command === 'tmux' && args[0] === 'capture-pane') return { stdout: 'Codex is ready.\n' };
    if (command === 'tmux' && args[0] === 'display-message') {
      return { stdout: 'main\t5\t1\t%12\t100\tnode\t/workspace\t1\tphone\tphone\t1\t8player-tooling\n' };
    }
    if (command === 'ps') {
      return { stdout: '100 1 Ss -bash\n101 100 Sl node /opt/bin/codex\n' };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  const inspector = new OperatorInspector({ allowedRoots: [], home: '/tmp', execFileImpl: fakeExec });

  const result = await inspector.inspectTmuxPane({ target: 'main:phone', lines: 40 });
  assert.equal(result.requested_target, 'main:phone');
  assert.equal(result.target, 'main:5.1');
  assert.equal(result.stable_target, '%12');
  assert.equal(result.named_target, 'main:phone.1');
  assert.equal(result.conversation_name, '8player-tooling');
});

test('Codex provider history resolves the pane-owned rollout and paginates redacted messages', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-codex-history-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sessionDirectory = path.join(base, '.codex', 'sessions', '2026', '08', '14');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(
    sessionDirectory,
    'rollout-2026-08-14T00-00-00-11111111-1111-4111-8111-111111111111.jsonl'
  );
  const records = [
    { type: 'session_meta', payload: { id: 'hidden-provider-id' } },
    {
      type: 'response_item', timestamp: '2026-08-14T00:00:00Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignore me</environment_context>' }] },
    },
    {
      type: 'response_item', timestamp: '2026-08-14T00:00:01Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect token=secret-value now.' }] },
    },
    {
      type: 'response_item', timestamp: '2026-08-14T00:00:02Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Inspection complete.' }] },
    },
  ];
  fs.writeFileSync(rollout, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const fakeExec = async (command) => {
    if (command === 'tmux') {
      return { stdout: 'main\t5\t1\t%12\t100\tnode\t/workspace\t1\tphone\tphone\t1\tphone\n' };
    }
    if (command === 'ps') {
      return { stdout: '100 1 Ss -bash\n101 100 Sl node /opt/bin/codex\n102 101 Sl /opt/codex-linux/codex\n' };
    }
    if (command === 'lsof') return { stdout: `p102\nn${rollout}\n` };
    throw new Error(`Unexpected command: ${command}`);
  };
  const inspector = new OperatorInspector({ allowedRoots: [], home: base, execFileImpl: fakeExec });
  const first = await inspector.inspectAgentSessionHistory({ target: 'main:phone', limit: 1 });
  assert.equal(first.provider, 'codex');
  assert.equal(first.target, 'main:5.1');
  assert.equal(first.stable_target, '%12');
  assert.equal(first.named_target, 'main:phone.1');
  assert.equal(first.messages[0].number, 1);
  assert.equal(first.messages[0].role, 'user');
  assert.match(first.messages[0].text, /token=\[REDACTED\]/);
  assert.equal(first.chunk.has_more, true);
  assert.equal(first.chunk.next_cursor, 1);
  assert.equal(first.chunk.total_messages, 2);
  assert.doesNotMatch(JSON.stringify(first), /hidden-provider-id|rollout-2026/);

  const second = await inspector.inspectAgentSessionHistory({
    target: 'main:phone', cursor: first.chunk.next_cursor, limit: 1,
  });
  assert.equal(second.messages[0].number, 2);
  assert.equal(second.messages[0].text, 'Inspection complete.');
  assert.equal(second.chunk.has_more, false);
  assert.equal(second.chunk.total_messages, 2);
});

test('Claude provider history resolves an explicit resume ID and excludes meta and tool rows', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-claude-history-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const projectDirectory = path.join(base, '.claude', 'projects', '-workspace');
  fs.mkdirSync(projectDirectory, { recursive: true });
  const transcript = path.join(projectDirectory, `${sessionId}.jsonl`);
  const records = [
    { type: 'user', isMeta: true, message: { role: 'user', content: 'hidden metadata' } },
    { type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] } },
    {
      type: 'user', timestamp: '2026-08-14T00:00:00Z',
      message: {
        role: 'user',
        content: '<command-message>home</command-message><command-name>/home</command-name><command-args>Check Flux.</command-args>',
      },
    },
    { type: 'assistant', timestamp: '2026-08-14T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Flux is healthy.' }, { type: 'tool_use', name: 'Bash' }] } },
  ];
  fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const fakeExec = async (command) => {
    if (command === 'tmux') {
      return { stdout: 'infra\t2\t1\t%20\t200\tclaude\t/workspace\t1\tflux\tflux\t0\t\n' };
    }
    if (command === 'ps') {
      return { stdout: `200 1 Ss -bash\n201 200 Sl claude -r ${sessionId}\n` };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  const inspector = new OperatorInspector({ allowedRoots: [], home: base, execFileImpl: fakeExec });
  const history = await inspector.inspectAgentSessionHistory({ target: 'infra:flux', limit: 6 });
  assert.equal(history.provider, 'claude');
  assert.deepEqual(history.messages.map((message) => message.text), ['Check Flux.', 'Flux is healthy.']);
  assert.equal(history.chunk.total_messages, 2);
  assert.equal(history.exact_provider_history, true);
});

test('provider history reads the actual tail, filters roles, and walks backward without relabeling messages', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-history-tail-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sessionDirectory = path.join(base, '.codex', 'sessions', '2026', '08', '15');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(
    sessionDirectory,
    'rollout-2026-08-15T00-00-00-33333333-3333-4333-8333-333333333333.jsonl'
  );
  const records = [];
  for (let number = 1; number <= 8; number += 1) {
    records.push({
      type: 'response_item',
      timestamp: `2026-08-15T00:00:0${number}Z`,
      payload: {
        type: 'message',
        role: number % 2 === 0 ? 'assistant' : 'user',
        content: [{
          type: number % 2 === 0 ? 'output_text' : 'input_text',
          text: `${number % 2 === 0 ? 'Answer' : 'Question'} ${number}`,
        }],
      },
    });
  }
  fs.writeFileSync(rollout, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const fakeExec = async (command) => {
    if (command === 'tmux') {
      return { stdout: 'main\t5\t1\t%12\t100\tnode\t/workspace\t1\tphone\tphone\t1\tphone\n' };
    }
    if (command === 'ps') {
      return { stdout: '100 1 Ss -bash\n101 100 Sl node /opt/bin/codex\n' };
    }
    if (command === 'lsof') return { stdout: `p101\nn${rollout}\n` };
    throw new Error(`Unexpected command: ${command}`);
  };
  const inspector = new OperatorInspector({ allowedRoots: [], home: base, execFileImpl: fakeExec });

  const latestUser = await inspector.inspectAgentSessionHistory({
    target: 'main:phone', position: 'latest', role: 'user', limit: 1,
  });
  assert.deepEqual(latestUser.messages.map((message) => [message.number, message.role, message.text]), [
    [7, 'user', 'Question 7'],
  ]);
  assert.equal(latestUser.chunk.total_messages, 8);
  assert.equal(latestUser.chunk.total_matching_messages, 4);
  assert.equal(latestUser.chunk.direction, 'backward');
  assert.equal(latestUser.chunk.has_older, true);
  assert.equal(latestUser.chunk.previous_cursor, 7);

  const olderUsers = await inspector.inspectAgentSessionHistory({
    target: 'main:phone', position: 'before', cursor: latestUser.chunk.previous_cursor,
    role: 'user', limit: 2,
  });
  assert.deepEqual(olderUsers.messages.map((message) => message.number), [3, 5]);
  assert.equal(olderUsers.chunk.has_older, true);
  assert.equal(olderUsers.chunk.has_newer, true);
  assert.equal(olderUsers.chunk.previous_cursor, 3);

  const latestAny = await inspector.inspectAgentSessionHistory({
    target: 'main:phone', position: 'tail', role: 'any', limit: 2,
  });
  assert.deepEqual(latestAny.messages.map((message) => message.number), [7, 8]);
  assert.equal(latestAny.chunk.position, 'latest');

  await assert.rejects(
    inspector.inspectAgentSessionHistory({ target: 'main:phone', position: 'before', cursor: 0 }),
    (error) => error.code === 'HISTORY_CURSOR_REQUIRED'
  );
  await assert.rejects(
    inspector.inspectAgentSessionHistory({ target: 'main:phone', position: 'latest', role: 'tool' }),
    (error) => error.code === 'INVALID_HISTORY_ROLE'
  );
});
