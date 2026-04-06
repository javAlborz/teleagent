const assert = require('node:assert/strict');
const test = require('node:test');

const {
  detectCallbackRequest,
  queueRuntimeCallback,
} = require('../lib/conversation-loop');

test('detectCallbackRequest recognizes announce callbacks', () => {
  const result = detectCallbackRequest('Would you check my current homelab status and call me when done?');

  assert.ok(result);
  assert.equal(result.mode, 'announce');
  assert.equal(result.normalizedTranscript, 'would you check my current homelab status and call me when done');
});

test('detectCallbackRequest recognizes callback phrasing with afterwards', () => {
  const result = detectCallbackRequest('Could you check on the current HOMELAB status and call me back afterwards?');

  assert.ok(result);
  assert.equal(result.mode, 'announce');
  assert.equal(result.normalizedTranscript, 'could you check on the current homelab status and call me back afterwards');
});

test('detectCallbackRequest recognizes conversation callbacks', () => {
  const result = detectCallbackRequest("Call me when you're done and let's discuss the deployment");

  assert.ok(result);
  assert.equal(result.mode, 'conversation');
});

test('detectCallbackRequest ignores non-callback phrasing', () => {
  const result = detectCallbackRequest('Check my current homelab status');

  assert.equal(result, null);
});

test('queueRuntimeCallback posts to the local outbound API with auth when configured', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.OUTBOUND_API_TOKEN;
  const calls = [];

  process.env.OUTBOUND_API_TOKEN = 'test-token';
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        callId: 'test-call-id',
      }),
    };
  };

  try {
    const result = await queueRuntimeCallback({
      target: '1001',
      message: 'Your homelab is healthy and all nodes are ready.',
      mode: 'announce',
      deviceName: 'Opus',
      dialUri: 'sip:1001@100.101.120.26:52596',
      callUuid: 'test-call-uuid',
      transcript: 'call me when done',
      reason: 'unit_test',
    });

    assert.equal(result.queued, true);
    assert.equal(result.callId, 'test-call-id');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/outbound-call$/);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');

    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.to, '1001');
    assert.equal(payload.mode, 'announce');
    assert.equal(payload.device, 'Opus');
    assert.equal(payload.dialUri, 'sip:1001@100.101.120.26:52596');
    assert.equal(payload.message, 'Your homelab is healthy and all nodes are ready.');
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.OUTBOUND_API_TOKEN;
    } else {
      process.env.OUTBOUND_API_TOKEN = originalToken;
    }
  }
});
