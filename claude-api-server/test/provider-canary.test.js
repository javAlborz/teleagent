'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  CANARY_RESPONSE,
  MAX_COMBINED_OUTPUT_BYTES,
  acknowledgePersistedLaunch,
  executeProviderCanary,
  parseProviderCanaryOutput,
} = require('../../deploy/worker-session/teleagent-provider-canary');

const WORKSPACE = '/srv/teleagent-agent-workspaces/phone';

function codexJsonl({
  message = CANARY_RESPONSE,
  extraMessage = null,
  terminal = true,
  lifecycle = false,
} = {}) {
  const events = [
    { type: 'thread.started', thread_id: 'canary-thread' },
    { type: 'turn.started' },
  ];
  if (lifecycle) {
    events.push(
      { type: 'item.started', item: { id: 'item_reasoning', type: 'reasoning', text: '' } },
      { type: 'item.updated', item: {
        id: 'item_reasoning', type: 'reasoning', text: 'bounded reasoning',
      } },
    );
  }
  events.push({
    type: 'item.completed',
    item: { id: 'item_reasoning', type: 'reasoning', text: 'bounded reasoning' },
  });
  if (lifecycle) {
    events.push(
      { type: 'item.started', item: { id: 'item_answer', type: 'agent_message', text: '' } },
      { type: 'item.updated', item: {
        id: 'item_answer', type: 'agent_message', text: 'PROVIDER_',
      } },
    );
  }
  events.push({
    type: 'item.completed',
    item: { id: 'item_answer', type: 'agent_message', text: message },
  });
  if (extraMessage !== null) {
    events.push({
      type: 'item.completed',
      item: { id: 'item_extra', type: 'agent_message', text: extraMessage },
    });
  }
  if (terminal) events.push({ type: 'turn.completed', usage: { input_tokens: 1 } });
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function fakeSpawn({
  stdout = '', stderr = '', code = 0, signal = null, never = false,
  killCloses = true, closeNaturally = true, acceptedStatus = false,
} = {}) {
  const state = { killed: null, input: '', invocation: null, acknowledgement: '' };
  const spawnImpl = (command, args, options) => {
    state.invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
    child.stdio[4].on('data', (chunk) => { state.acknowledgement += chunk.toString('utf8'); });
    child.stdin.on('data', (chunk) => { state.input += chunk.toString('utf8'); });
    let closed = false;
    const close = (closeCode, closeSignal) => {
      if (closed) return;
      closed = true;
      child.emit('close', closeCode, closeSignal);
    };
    child.kill = (killSignal) => {
      state.killed = killSignal;
      if (killCloses) queueMicrotask(() => close(null, killSignal));
      return true;
    };
    if (!never) {
      setImmediate(() => {
        if (acceptedStatus) child.stdio[3].write(`${JSON.stringify({
          version: 1, accepted: true, launchId: `launch_${'a'.repeat(32)}`,
        })}\n`);
        child.stdout.end(stdout);
        child.stderr.end(stderr);
        if (closeNaturally) setImmediate(() => close(code, signal));
      });
    }
    return child;
  };
  return { spawnImpl, state };
}

test('provider canary parsers accept only exact provider-specific final evidence', () => {
  for (const output of [CANARY_RESPONSE, `${CANARY_RESPONSE}\n`, `${CANARY_RESPONSE}\r\n`]) {
    assert.equal(parseProviderCanaryOutput('claude', Buffer.from(output)), true);
  }
  for (const output of [
    'Reply exactly PROVIDER_CANARY_OK.',
    `prefix ${CANARY_RESPONSE}`,
    `${CANARY_RESPONSE} extra`,
    `${CANARY_RESPONSE}\nextra`,
    `${CANARY_RESPONSE}\n\n`,
    'WRONG_ANSWER',
  ]) {
    assert.throws(
      () => parseProviderCanaryOutput('claude', Buffer.from(output)),
      /final response was not exact/
    );
  }
  assert.throws(
    () => parseProviderCanaryOutput('claude', Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CANARY_RESPONSE),
    ])),
    /final response was not exact/
  );
  assert.throws(
    () => parseProviderCanaryOutput('claude', Buffer.from([0xc3, 0x28])),
    /not valid UTF-8/
  );

  assert.equal(parseProviderCanaryOutput('codex', Buffer.from(codexJsonl())), true);
  assert.equal(parseProviderCanaryOutput('codex', Buffer.from(codexJsonl({
    lifecycle: true,
  }))), true);
  for (const output of [
    codexJsonl({ message: 'Reply exactly PROVIDER_CANARY_OK.' }),
    codexJsonl({ message: `prefix ${CANARY_RESPONSE}` }),
    codexJsonl({ message: `${CANARY_RESPONSE} extra` }),
    codexJsonl({ message: 'WRONG_ANSWER' }),
    codexJsonl({ extraMessage: 'extra answer' }),
    codexJsonl({ terminal: false }),
    `${JSON.stringify({ type: 'thread.started', thread_id: 'canary-thread' })}\n` +
      `${JSON.stringify({ type: 'turn.started' })}\n` +
      `${JSON.stringify({ type: 'item.completed', item: {
        id: 'item_tool', type: 'command_execution', command: CANARY_RESPONSE,
      } })}\n`,
    `${JSON.stringify({ type: 'thread.started', thread_id: 'canary-thread' })}\n` +
      `${JSON.stringify({ type: 'turn.started' })}\n` +
      `${JSON.stringify({ type: 'item.started', item: {
        id: 'item_tool', type: 'command_execution', command: CANARY_RESPONSE,
      } })}\n`,
    `${JSON.stringify({ type: 'thread.started', thread_id: 'canary-thread' })}\n` +
      `${JSON.stringify({ type: 'turn.started' })}\n` +
      `${JSON.stringify({ type: 'item.updated', item: {
        id: 'item_answer', type: 'agent_message', text: CANARY_RESPONSE,
      } })}\n`,
    '{"type":"thread.started"}\nnot-json\n',
    `${JSON.stringify({ type: 'turn.failed', error: { message: CANARY_RESPONSE } })}\n`,
  ]) {
    assert.throws(() => parseProviderCanaryOutput('codex', Buffer.from(output)));
  }
});

test('provider canary captures output and emits only fixed attestation after exact success', async () => {
  const receiptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-canary-test-'));
  for (const [provider, stdout] of [
    ['claude', `${CANARY_RESPONSE}\n`],
    ['codex', codexJsonl()],
  ]) {
    const fake = fakeSpawn({ stdout, stderr: 'provider diagnostic that must stay captured\n', acceptedStatus: true });
    assert.equal(await executeProviderCanary(provider, WORKSPACE, {
      spawnImpl: fake.spawnImpl,
      receiptDirectory,
    }), `PROVIDER_CANARY_ATTESTED ${provider}`);
    assert.equal(fake.state.input, 'Reply exactly PROVIDER_CANARY_OK.\n');
    assert.deepEqual(fake.state.invocation.options.stdio, ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']);
    assert.match(fake.state.acknowledgement, /"statusPersisted":true/);
    assert.equal(fs.existsSync(path.join(receiptDirectory,
      `${provider}-launch_${'a'.repeat(32)}.json`)), true);
    assert.equal(fake.state.killed, null);
  }
  fs.rmSync(receiptDirectory, { recursive: true });
});

test('provider canary withholds launch acknowledgement if its receipt cannot persist', () => {
  const fake = fakeSpawn({ never: true });
  const child = fake.spawnImpl('client', [], {});
  acknowledgePersistedLaunch(child, 'codex', {
    receiptDirectory: '/nonexistent/teleagent-canary-receipts',
  });
  child.stdio[3].write(`${JSON.stringify({
    version: 1, accepted: true, launchId: `launch_${'b'.repeat(32)}`,
  })}\n`);
  assert.equal(fake.state.acknowledgement, '');
});

test('provider canary refuses exit zero without exact final evidence and never echoes it', async () => {
  for (const stdout of ['', 'secret-provider-output', `${CANARY_RESPONSE} extra\n`]) {
    const fake = fakeSpawn({ stdout, code: 0 });
    await assert.rejects(executeProviderCanary('claude', WORKSPACE, {
      spawnImpl: fake.spawnImpl,
    }), (error) => (
      /final response was not exact/.test(error.message) &&
      !error.message.includes('secret-provider-output')
    ));
  }
  const failed = fakeSpawn({ stdout: `${CANARY_RESPONSE}\n`, code: 1 });
  await assert.rejects(executeProviderCanary('claude', WORKSPACE, {
    spawnImpl: failed.spawnImpl,
  }), /did not exit successfully/);
});

test('provider canary kills oversized output and deadline overruns without exposing output', async () => {
  const oversized = fakeSpawn({
    stdout: `${CANARY_RESPONSE}\n`,
    stderr: `sensitive-provider-output-${'x'.repeat(MAX_COMBINED_OUTPUT_BYTES)}`,
  });
  await assert.rejects(executeProviderCanary('claude', WORKSPACE, {
    spawnImpl: oversized.spawnImpl,
  }), (error) => (
    /output exceeded its bound/.test(error.message) &&
    !error.message.includes('sensitive-provider-output')
  ));
  assert.equal(oversized.state.killed, 'SIGKILL');

  const hung = fakeSpawn({ never: true });
  await assert.rejects(executeProviderCanary('codex', WORKSPACE, {
    spawnImpl: hung.spawnImpl,
    deadlineMs: 5,
  }), /exceeded its deadline/);
  assert.equal(hung.state.killed, 'SIGKILL');

  const unclosed = fakeSpawn({ never: true, killCloses: false });
  await assert.rejects(executeProviderCanary('codex', WORKSPACE, {
    spawnImpl: unclosed.spawnImpl,
    deadlineMs: 5,
    postKillCloseMs: 5,
  }), /did not close after termination/);
  assert.equal(unclosed.state.killed, 'SIGKILL');

  const unclosedOutput = fakeSpawn({
    stderr: 'x'.repeat(MAX_COMBINED_OUTPUT_BYTES + 1),
    killCloses: false,
    closeNaturally: false,
  });
  await assert.rejects(executeProviderCanary('claude', WORKSPACE, {
    spawnImpl: unclosedOutput.spawnImpl,
    postKillCloseMs: 5,
  }), /did not close after termination/);
  assert.equal(unclosedOutput.state.killed, 'SIGKILL');
});
