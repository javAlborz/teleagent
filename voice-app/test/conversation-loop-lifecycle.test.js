'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const test = require('node:test');
const { installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();
const { runConversationLoop } = require('../lib/conversation-loop');
const { buildDurableIdempotencyKey } = require('../lib/claude-bridge');
const logger = require('../lib/logger');

function fixture(t, {
  turns = 1, hangupAt = null, cancelResult = null, cancelAt = null,
  delayedCancel = null,
} = {}) {
  for (const level of ['info', 'warn', 'error', 'debug']) t.mock.method(logger, level, () => {});
  t.mock.method(console, 'log', () => {});
  const dialog = new EventEmitter();
  const endpoint = new EventEmitter();
  const queries = [];
  const cancellations = [];
  const spoken = [];
  const audioBreaks = [];
  const resultsByKey = new Map();
  let cleanupCount = 0;
  let settleCancellation;
  endpoint.uuid = 'fixture-media-call';
  endpoint.play = async (url) => {
    if (hangupAt === 'thinking-playback' && String(url).startsWith('tts:')) {
      dialog.emit('destroy');
    }
    if (cancelAt === 'thinking-playback' && String(url).startsWith('tts:')) {
      endpoint.emit('dtmf', { digit: '*' });
    }
  };
  endpoint.api = async (command) => {
    if (command === 'uuid_break') audioBreaks.push(spoken.at(-1));
  };
  endpoint.forkAudioStart = async () => {};
  endpoint.forkAudioStop = async () => {};
  const session = {
    setCaptureEnabled() {},
    forceFinalize() {},
    async waitForUtterance({ timeoutMs }) {
      if (timeoutMs === 1000) {
        // The spoken-cancel watcher never consumes the next ordinary turn.
        await nextTurn();
        return null;
      }
      return { audio: Buffer.from('synthetic utterance'), reason: 'fixture' };
    },
  };
  const bridge = {
    async queryDetailed(prompt, options) {
      queries.push({ prompt, options });
      if (cancelResult) {
        endpoint.emit('dtmf', { digit: '*' });
        await nextTurn();
        return cancelResult;
      }
      const key = buildDurableIdempotencyKey(prompt, options);
      if (!resultsByKey.has(key)) {
        resultsByKey.set(key, {
          success: true,
          response: `Status observation ${resultsByKey.size + 1}.`,
          provider: 'codex',
        });
      }
      return resultsByKey.get(key);
    },
    async cancelSession(callId, options) {
      cancellations.push({ callId, options });
      if (delayedCancel) {
        await new Promise((resolve, reject) => {
          settleCancellation = () => delayedCancel === 'failure'
            ? reject(new Error('fixture cancellation response lost')) : resolve();
        });
      }
      // Acceptance alone is deliberately not quiescence evidence.
      return { success: true, canceledCount: 1, executorTasks: { quiesced: false } };
    },
    async endSession() { cleanupCount += 1; return { success: true }; },
  };
  const options = {
    audioForkServer: {
      expectSession: () => ({ connectionUrl: 'ws://fixture.invalid', session: Promise.resolve(session) }),
      cancelExpectation() {},
    },
    whisperClient: {
      async transcribe() {
        if (hangupAt === 'transcription') dialog.emit('destroy');
        return 'Inspect the fixture status.';
      },
    },
    claudeBridge: bridge,
    ttsService: {
      async generateSpeech(text) {
        spoken.push(text);
        if (hangupAt === 'thinking-tts') dialog.emit('destroy');
        if (cancelAt === 'thinking-tts') endpoint.emit('dtmf', { digit: '*' });
        if (settleCancellation && text.includes('completed before cancellation')) {
          settleCancellation();
          await nextTurn();
        }
        return `tts:${text}`;
      },
    },
    skipGreeting: true,
    maxTurns: turns,
    sessionKey: 'fixture-voice-thread',
    deviceConfig: { sessionType: 'phone-codex-terra', holdMusicEnabled: false },
  };
  return {
    queries, cancellations, spoken, resultsByKey, audioBreaks,
    async run() {
      await runConversationLoop(endpoint, dialog, 'fixture-call-123', options);
      assert.equal(cleanupCount, 1);
      assert.equal(dialog.listenerCount('destroy'), 0);
      assert.equal(endpoint.listenerCount('dtmf'), 0);
    },
  };
}

test('identical questions in different legacy turns execute separately, while each turn keeps one retry key', async (t) => {
  const call = fixture(t, { turns: 2 });
  await call.run();
  assert.equal(call.queries.length, 2);
  assert.equal(call.queries[0].prompt, call.queries[1].prompt);
  assert.equal(call.resultsByKey.size, 2, 'a later observation must not reuse an earlier result');
  const keys = call.queries.map(({ prompt, options }) => buildDurableIdempotencyKey(prompt, options));
  assert.notEqual(keys[0], keys[1]);
  assert.match(keys[0], /^voice_turn_[a-f0-9]{64}$/);
  const first = call.queries[0];
  assert.equal(buildDurableIdempotencyKey(first.prompt, first.options), keys[0]);
  assert.ok(call.spoken.includes('Status observation 2'));
});

for (const hangupAt of ['transcription', 'thinking-tts', 'thinking-playback']) {
  test(`hangup during ${hangupAt} cannot start a legacy agent task`, async (t) => {
    const call = fixture(t, { hangupAt });
    await call.run();
    assert.equal(call.queries.length, 0);
  });
}

test('legacy star reserves the exact current turn key and speaks only confirmed cancellation', async (t) => {
  const call = fixture(t, { cancelResult: { success: false, agentCode: 'AGENT_CANCELED' } });
  await call.run();
  assert.equal(call.cancellations.length, 1);
  assert.equal(call.cancellations[0].options.idempotencyKey, call.queries[0].options.idempotencyKey);
  assert.equal(call.cancellations[0].options.scope, 'task');
  assert.match(call.cancellations[0].options.idempotencyKey, /^voice_turn_[a-f0-9]{64}$/);
  assert.ok(call.spoken.includes('Stopped.'));
});

for (const code of ['AGENT_TIMEOUT', 'AGENT_API_UNAVAILABLE', 'EXECUTOR_WAIT_ABORTED']) {
  test(`legacy cancellation does not claim stopped after ${code}`, async (t) => {
    const call = fixture(t, { cancelResult: { success: false, agentCode: code } });
    await call.run();
    assert.ok(!call.spoken.includes('Stopped.'));
    assert.ok(call.spoken.some((text) => /could not confirm/i.test(text)));
  });
}

test('legacy cancellation preserves an unknown execution outcome', async (t) => {
  const call = fixture(t, { cancelResult: {
    success: false, agentCode: 'EXECUTION_OUTCOME_UNKNOWN', execution_outcome_unknown: true,
  } });
  await call.run();
  assert.ok(!call.spoken.includes('Stopped.'));
  assert.ok(call.spoken.some((text) => /may have completed/i.test(text)));
});

test('a verified result winning legacy cancellation is spoken as a result, not discarded as stopped', async (t) => {
  const call = fixture(t, { cancelResult: {
    success: true, response: 'The fixture task completed before cancellation.', provider: 'codex',
  } });
  await call.run();
  assert.ok(!call.spoken.includes('Stopped.'));
  assert.ok(call.spoken.includes('The fixture task completed before cancellation'));
});

for (const delayedCancel of ['success', 'failure']) {
  test(`delayed cancellation ${delayedCancel} cannot break result audio`, async (t) => {
    const call = fixture(t, { delayedCancel, cancelResult: {
      success: true, response: 'The fixture task completed before cancellation.', provider: 'codex',
    } });
    await call.run();
    assert.equal(call.audioBreaks.length, 1);
    assert.ok(!call.audioBreaks[0].includes('completed before cancellation'));
    assert.ok(call.spoken.includes('The fixture task completed before cancellation'));
  });
}

for (const cancelAt of ['thinking-tts', 'thinking-playback']) {
  test(`star during ${cancelAt} prevents task submission`, async (t) => {
    const call = fixture(t, { cancelAt });
    await call.run();
    assert.equal(call.queries.length, 0);
    assert.equal(call.cancellations.length, 0, 'no remote task exists to cancel');
    assert.ok(call.spoken.includes('Stopped.'));
  });
}
