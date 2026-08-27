'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  TmuxAgentController,
  readProviderActivityState,
  updateProviderActivityState,
} = require('../tmux-agent-controller');

test('Codex task markers provide timestamped provider activity transitions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-agent-activity-'));
  const filename = path.join(directory, 'session.jsonl');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const startedAt = '2026-08-20T10:00:00.000Z';
  const completedAt = '2026-08-20T10:00:02.000Z';
  const records = [
    { type: 'event_msg', timestamp: startedAt, payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: completedAt, payload: { type: 'task_complete' } },
  ];
  fs.writeFileSync(filename, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const state = await readProviderActivityState(filename, 'codex');
  assert.equal(state.busy, false);
  assert.equal(state.observed, true);
  assert.equal(state.lastRecordAt, completedAt);
  assert.equal(state.lastTransitionAt, completedAt);
  assert.ok(Number.isFinite(state.millisecondsSinceLogUpdate));

  const running = updateProviderActivityState({}, records[0], 'codex');
  assert.equal(running.busy, true);
  assert.equal(running.lastTransitionAt, startedAt);
});

function harness(t, provider = 'codex') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-agent-controller-'));
  const filename = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filename, `${JSON.stringify({ type: 'session_meta' })}\n`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const calls = [];
  const resolvedTargets = [];
  let submittedHook = null;
  let submittedRecords = null;
  let enterFailure = null;
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
      if (enterFailure) throw enterFailure;
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
    setEnterFailure(value) { enterFailure = value; },
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

test('paste termination and hidden second-command controls are rejected before tmux mutation', async (t) => {
  const { calls, controller } = harness(t, 'claude');
  await assert.rejects(controller.send({
    target: 'main:phone',
    message: 'Visible approval\u001b[201~\n/hidden-command',
    sessionFingerprint: 'not-reached',
    operationId: 'job_ControlInjection1',
  }), (error) => error.code === 'INVALID_TARGET_MESSAGE');
  assert.equal(calls.length, 0);
});

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

test('durable target delivery persists its attempt before pasting a deterministic marker', async (t) => {
  const fixture = harness(t, 'codex');
  const operationId = 'job_TargetMarker1';
  const markedMessage = `Run the exact check.\n\n[teleagent-operation:${operationId}]`;
  fixture.setSubmittedRecords([
    {
      type: 'response_item', timestamp: '2026-08-15T10:00:00Z',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: markedMessage }],
      },
    },
    {
      type: 'response_item', timestamp: '2026-08-15T10:00:01Z',
      payload: {
        type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'The marked operation passed.' }],
      },
    },
  ]);
  const prepared = await fixture.controller.prepare({ target: 'main:phone' });
  let attemptPersisted = false;
  const result = await fixture.controller.send({
    target: prepared.stable_target,
    message: 'Run the exact check.',
    operationId,
    sessionFingerprint: prepared.session_fingerprint,
    onBeforeSubmit(binding) {
      assert.equal(fixture.calls.some((call) => call.args?.[0] === 'load-buffer'), false);
      assert.equal(binding.stableTarget, '%12');
      assert.equal(binding.operationMarker, `[teleagent-operation:${operationId}]`);
      attemptPersisted = true;
    },
  });

  assert.equal(attemptPersisted, true);
  assert.equal(result.response, 'The marked operation passed.');
  const load = fixture.calls.find((call) => call.args?.[0] === 'load-buffer');
  assert.equal(load.input, markedMessage);
  assert.equal(fixture.calls.some((call) => JSON.stringify(call.args).includes(operationId)), false);
});

test('restart reconciliation recognizes only the exact marked operation and final response', async (t) => {
  const fixture = harness(t, 'codex');
  const operationId = 'job_ReconcileMarker1';
  fixture.append({
    type: 'response_item', timestamp: '2026-08-15T10:00:00Z',
    payload: {
      type: 'message', role: 'user',
      content: [{
        type: 'input_text',
        text: `Run the exact check.\n\n[teleagent-operation:${operationId}]`,
      }],
    },
  });
  fixture.append({
    type: 'response_item', timestamp: '2026-08-15T10:00:01Z',
    payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Recovered exact result.' }],
    },
  });

  const completed = await fixture.controller.reconcileOperation({
    target: '%12',
    message: 'Run the exact check.',
    operationId,
    sessionFingerprint: 'approved-fingerprint',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.response, 'Recovered exact result.');
  assert.equal(completed.result.reconciled_after_restart, true);
  assert.equal(fixture.calls.length, 0);

  const unknown = await fixture.controller.reconcileOperation({
    target: '%12',
    message: 'Run the exact check.',
    operationId: 'job_DifferentMarker1',
    sessionFingerprint: 'approved-fingerprint',
  });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'operation_marker_not_observed');
  assert.equal(fixture.calls.length, 0);
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
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'TARGET_DELIVERY_OUTCOME_UNKNOWN');
    assert.equal(error.originalCode, 'TARGET_MESSAGE_CANCELED');
    assert.equal(error.deliveryAttempted, true);
    return true;
  });
  assert.ok(calls.some((call) => call.args?.[0] === 'send-keys' && call.args.at(-1) === 'C-c'));
});

test('a submit exception after the durable delivery hook is outcome unknown', async (t) => {
  const fixture = harness(t);
  fixture.setEnterFailure(new Error('tmux send-keys response was lost'));
  const prepared = await fixture.controller.prepare({ target: 'main:phone' });
  let staged = false;

  await assert.rejects(
    fixture.controller.send({
      target: prepared.target,
      message: 'Run the exact check.',
      sessionFingerprint: prepared.session_fingerprint,
      operationId: 'job_SubmitException1',
      onBeforeSubmit: () => { staged = true; },
    }),
    (error) => {
      assert.equal(error.code, 'TARGET_DELIVERY_OUTCOME_UNKNOWN');
      assert.equal(error.originalCode, 'TARGET_MESSAGE_SUBMIT_FAILED');
      assert.equal(error.deliveryAttempted, true);
      return true;
    }
  );
  assert.equal(staged, true);
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
