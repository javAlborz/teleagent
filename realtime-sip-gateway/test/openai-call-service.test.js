import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { buildAcceptConfig, OpenAICallService } from '../src/openai-call-service.js';
import { makeConfig } from './helpers.js';

test('accept config uses a SIP-compatible semantic VAD configuration', () => {
  const config = buildAcceptConfig(makeConfig());
  assert.equal(config.type, 'realtime');
  assert.equal(config.model, 'gpt-realtime-2.1-mini');
  assert.equal(config.audio.output.voice, 'marin');
  assert.deepEqual(config.audio.input.turn_detection, {
    type: 'semantic_vad',
    create_response: true,
    interrupt_response: true,
  });
  assert.equal('threshold' in config.audio.input.turn_detection, false);
});

test('call service delegates verification and lifecycle calls to the OpenAI SDK', async () => {
  const calls = [];
  const client = {
    webhooks: {
      async unwrap(body, headers) {
        calls.push(['unwrap', body, headers]);
        return { type: 'test' };
      },
    },
    realtime: {
      calls: {
        async accept(...args) { calls.push(['accept', ...args]); },
        async reject(...args) { calls.push(['reject', ...args]); },
        async hangup(...args) { calls.push(['hangup', ...args]); },
      },
    },
  };
  const service = new OpenAICallService({ config: makeConfig(), client });
  await service.verifyWebhook('{"test":true}', { test: 'header' });
  await service.accept('rtc_test');
  await service.reject('rtc_test', 486);
  await service.hangup('rtc_test');
  assert.deepEqual(calls.map((call) => call[0]), ['unwrap', 'accept', 'reject', 'hangup']);
  assert.equal(calls[1][2].type, 'realtime');
  assert.deepEqual(calls[2], ['reject', 'rtc_test', { status_code: 486 }]);
});

test('official SDK verifies a standard signed webhook offline and rejects body changes', async () => {
  const webhookSecret = 'offline-test-webhook-secret';
  const config = makeConfig({ webhookSecret });
  const service = new OpenAICallService({ config });
  const body = JSON.stringify({ id: 'evt_signed', type: 'response.completed', data: { id: 'x' } });
  const webhookId = 'wh_signed';
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac('sha256', webhookSecret)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest('base64');
  const headers = {
    'webhook-id': webhookId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  };
  assert.equal((await service.verifyWebhook(body, headers)).id, 'evt_signed');
  await assert.rejects(service.verifyWebhook(`${body} `, headers));
});
