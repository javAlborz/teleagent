'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TmuxAgentController } = require('../tmux-agent-controller');

function harness(t, provider = 'codex') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-agent-controller-'));
  const filename = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filename, `${JSON.stringify({ type: 'session_meta' })}\n`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const calls = [];
  const resolvedTargets = [];
  let submittedHook = null;
  let submittedRecords = null;
  let fingerprint = 'approved-fingerprint';
  const inspector = {
    async resolveAgentSessionTarget(target) {
      resolvedTargets.push(target);
      return {
        inspected: {
          pane: {
            target: 'main:5.1',
            stable_target: '%12',
            named_target: 'main:phone.1',
            pane_id: '%12',
            agent: provider,
            window_name: 'phone',
            ai_session_name: 'phone',
          },
        },
        resolved: { filename, resolution: 'test_fixture' },
        sessionFingerprint: fingerprint,
      };
    },
  };
  const inputCommandImpl = async (command, args, input) => {
    calls.push({ command, args, input });
    return { code: 0, stdout: '', stderr: '' };
  };
  const execFileImpl = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') {
      const records = submittedRecords || (provider === 'codex'
        ? [
          {
            type: 'response_item', timestamp: '2026-08-15T10:00:00Z',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the exact check.' }] },
          },
          {
            type: 'response_item', timestamp: '2026-08-15T10:00:01Z',
            payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'The exact check passed.' }] },
          },
        ]
        : [
          {
            type: 'user', timestamp: '2026-08-15T10:00:00Z',
            message: { role: 'user', content: 'Run the exact check.' },
          },
          {
            type: 'assistant', timestamp: '2026-08-15T10:00:01Z',
            message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The exact check passed.' }] },
          },
        ]);
      fs.appendFileSync(filename, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
      submittedHook?.();
    }
    return { stdout: '', stderr: '' };
  };
  const controller = new TmuxAgentController({
    inspector,
    execFileImpl,
    inputCommandImpl,
    pollIntervalMs: 25,
  });
  return {
    append(record) {
      fs.appendFileSync(filename, `${JSON.stringify(record)}\n`);
    },
    calls,
    controller,
    resolvedTargets,
    setSubmittedHook(value) { submittedHook = value; },
    setSubmittedRecords(value) { submittedRecords = value; },
    setFingerprint(value) { fingerprint = value; },
  };
}

for (const provider of ['codex', 'claude']) {
  test(`approved ${provider} tmux delivery verifies the exact user input and final provider response`, async (t) => {
    const { calls, controller } = harness(t, provider);
    const prepared = await controller.prepare({ target: 'main:phone' });
    const result = await controller.send({
      target: prepared.target,
      message: 'Run the exact check.',
      sessionFingerprint: prepared.session_fingerprint,
    });

    assert.equal(result.target, 'main:5.1');
    assert.equal(result.stable_target, '%12');
    assert.equal(result.named_target, 'main:phone.1');
    assert.equal(result.provider, provider);
    assert.equal(result.delivered, true);
    assert.equal(result.response_verified, true);
    assert.equal(result.response, 'The exact check passed.');
    const load = calls.find((call) => call.args?.[0] === 'load-buffer');
    assert.equal(load.input, 'Run the exact check.');
    assert.equal(calls.some((call) => JSON.stringify(call.args).includes('Run the exact check.')), false);
    assert.ok(calls.some((call) => call.args?.[0] === 'delete-buffer'));
    assert.ok(calls.some((call) => call.args?.[0] === 'paste-buffer' && call.args.at(-1) === '%12'));
    assert.ok(calls.some((call) => call.args?.[0] === 'send-keys' && call.args.at(-2) === '%12'));
  });
}

test('a cancel arriving after the provider final answer preserves verified completion', async (t) => {
  const fixture = harness(t);
  const abortController = new globalThis.AbortController();
  fixture.setSubmittedHook(() => abortController.abort());
  const prepared = await fixture.controller.prepare({ target: 'main:phone' });

  const result = await fixture.controller.send({
    target: prepared.target,
    message: 'Run the exact check.',
    sessionFingerprint: prepared.session_fingerprint,
    signal: abortController.signal,
  });

  assert.equal(result.response_verified, true);
  assert.equal(result.cancellation_arrived_after_completion, true);
  assert.equal(fixture.calls.some((call) => call.args?.at(-1) === 'C-c'), false);
  assert.ok(fixture.resolvedTargets.includes('%12'));
});

test('a cancel after exact delivery reports the partial side effect truthfully', async (t) => {
  const fixture = harness(t);
  const abortController = new globalThis.AbortController();
  fixture.setSubmittedRecords([{
    type: 'response_item',
    timestamp: '2026-08-15T10:00:00Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Run the exact check.' }],
    },
  }]);
  fixture.setSubmittedHook(() => abortController.abort());
  const prepared = await fixture.controller.prepare({ target: 'main:phone' });

  const result = await fixture.controller.send({
    target: prepared.target,
    message: 'Run the exact check.',
    sessionFingerprint: prepared.session_fingerprint,
    signal: abortController.signal,
  });

  assert.equal(result.delivered, true);
  assert.equal(result.response_verified, false);
  assert.equal(result.canceled_after_delivery, true);
  assert.ok(fixture.calls.some((call) => call.args?.at(-1) === 'C-c'));
});

test('tmux delivery fails closed before mutation when the approved session fingerprint changes', async (t) => {
  const { calls, controller, setFingerprint } = harness(t);
  const prepared = await controller.prepare({ target: 'main:phone' });
  setFingerprint('replacement-session');
  await assert.rejects(
    controller.send({
      target: prepared.target,
      message: 'Run the exact check.',
      sessionFingerprint: prepared.session_fingerprint,
    }),
    (error) => error.code === 'TARGET_SESSION_CHANGED'
  );
  assert.equal(calls.length, 0);
});

test('canceling a submitted tmux delivery interrupts the target pane', async (t) => {
  const { calls, controller } = harness(t);
  const prepared = await controller.prepare({ target: 'main:phone' });
  const abortController = new globalThis.AbortController();
  const pending = controller.send({
    target: prepared.target,
    message: 'A message that will not match provider history.',
    sessionFingerprint: prepared.session_fingerprint,
    signal: abortController.signal,
  });
  setTimeout(() => abortController.abort(), 50);
  await assert.rejects(pending, (error) => error.code === 'TARGET_MESSAGE_CANCELED');
  assert.ok(calls.some((call) => call.args?.[0] === 'send-keys' && call.args.at(-1) === 'C-c'));
});

test('tmux delivery waits for an existing provider task to finish before pasting', async (t) => {
  const { append, calls, controller } = harness(t);
  append({ type: 'event_msg', payload: { type: 'task_started' } });
  const prepared = await controller.prepare({ target: 'main:phone' });
  assert.equal(prepared.agent_busy, true);
  assert.equal(prepared.ready_for_message, false);

  const pending = controller.send({
    target: prepared.target,
    message: 'Run the exact check.',
    sessionFingerprint: prepared.session_fingerprint,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.some((call) => call.args?.[0] === 'load-buffer'), false);
  append({ type: 'event_msg', payload: { type: 'task_complete' } });
  const result = await pending;
  assert.equal(result.response_verified, true);
  assert.ok(calls.some((call) => call.args?.[0] === 'load-buffer'));
});

test('canceling while a target is busy leaves its pre-existing task untouched', async (t) => {
  const { append, calls, controller } = harness(t);
  append({ type: 'event_msg', payload: { type: 'task_started' } });
  const prepared = await controller.prepare({ target: 'main:phone' });
  const abortController = new globalThis.AbortController();
  const pending = controller.send({
    target: prepared.target,
    message: 'Run the exact check.',
    sessionFingerprint: prepared.session_fingerprint,
    signal: abortController.signal,
  });
  setTimeout(() => abortController.abort(), 50);
  await assert.rejects(pending, (error) => error.code === 'TARGET_MESSAGE_CANCELED');
  assert.equal(calls.some((call) => call.args?.[0] === 'load-buffer'), false);
  assert.equal(calls.some((call) => call.args?.at(-1) === 'C-c'), false);
});
