const assert = require('node:assert/strict');
const { installTestRuntimeSecrets } = require('./runtime-secrets-fixture');
installTestRuntimeSecrets();
const test = require('node:test');

const { extractCallerId, extractDialedExtension, handleInvite } = require('../lib/sip-handler');

function sipRequest(headers = {}) {
  const requested = [];
  return {
    body: 'v=0\r\nm=audio 123 RTP/AVP 0\r\n',
    requested,
    get(name) {
      requested.push(name);
      return headers[name] || '';
    },
  };
}

function authenticatedAdmission() {
  const admission = Object.freeze({ testAdmission: true });
  let consumed = false;
  return {
    inboundAdmission: admission,
    inboundTrunkAuthenticator: {
      consumeAdmission(value) {
        if (consumed || value !== admission) return false;
        consumed = true;
        return true;
      },
    },
  };
}

test('SIP identity parsing uses From/To and never reads an untrusted Contact route', () => {
  const req = sipRequest({
    From: '<sip:+15551234567@pbx.invalid>',
    To: '<sip:1001@pbx.invalid>',
    Contact: '<sip:1001@attacker.example:65000;transport=tcp>',
  });

  assert.equal(extractCallerId(req), '+15551234567');
  assert.equal(extractDialedExtension(req), '1001');
  assert.deepEqual(req.requested, ['From', 'To']);
});

test('an abort before admission reaches media rejects the INVITE without side effects', async () => {
  const controller = new AbortController();
  controller.abort('shutdown');
  const req = sipRequest({ From: '<sip:1001@pbx>', To: '<sip:7@pbx>' });
  const statuses = [];
  let mediaCalls = 0;

  const result = await handleInvite(req, { send(value) { statuses.push(value); } }, {
    ...authenticatedAdmission(),
    signal: controller.signal,
    mediaServer: { async connectCaller() { mediaCalls += 1; } },
  });

  assert.equal(result.aborted, true);
  assert.deepEqual(statuses, [503]);
  assert.equal(mediaCalls, 0);
});

test('shutdown during SIP setup cleans late dialog and endpoint before conversation starts', async () => {
  const controller = new AbortController();
  let finishConnect;
  const connectPending = new Promise((resolve) => { finishConnect = resolve; });
  let dialogDestroyed = 0;
  let endpointDestroyed = 0;
  let resourcesPublished = 0;
  const endpoint = {
    uuid: 'late-inbound-endpoint',
    async destroy() { endpointDestroyed += 1; },
  };
  const dialog = {
    destroyed: false,
    async destroy() { dialogDestroyed += 1; this.destroyed = true; },
  };
  const req = sipRequest({
    From: '<sip:1001@pbx>',
    To: '<sip:7@pbx>',
    Contact: '<sip:1001@203.0.113.10:65000;transport=tcp>',
  });
  const pending = handleInvite(req, { send() {} }, {
    ...authenticatedAdmission(),
    signal: controller.signal,
    mediaServer: { async connectCaller() { return connectPending; } },
    onResources(resources) {
      resourcesPublished += 1;
      assert.equal(resources.dialog, dialog);
      assert.equal(resources.endpoint, endpoint);
    },
  });

  controller.abort('shutdown');
  finishConnect({ dialog, endpoint });
  const result = await pending;

  assert.equal(result.aborted, true);
  assert.equal(resourcesPublished, 1);
  assert.equal(dialogDestroyed, 1);
  assert.equal(endpointDestroyed, 1);
  assert.equal(req.requested.includes('Contact'), false);
});

test('a forged loopback INVITE is rejected before caller, device, media, or durable state is touched', async () => {
  const req = sipRequest({
    From: '<sip:1001@127.0.0.1>',
    To: '<sip:7@127.0.0.1>',
  });
  const statuses = [];
  let deviceReads = 0;
  let mediaCalls = 0;
  let stateCalls = 0;

  const result = await handleInvite(req, { send(value) { statuses.push(value); } }, {
    mediaServer: { async connectCaller() { mediaCalls += 1; } },
    deviceRegistry: {
      get() { deviceReads += 1; return null; },
      getDefault() { deviceReads += 1; return null; },
    },
    voiceStateStore: new Proxy({}, { get() { stateCalls += 1; return undefined; } }),
  });

  assert.equal(result.unauthorized, true);
  assert.deepEqual(statuses, [403]);
  assert.deepEqual(req.requested, []);
  assert.equal(deviceReads, 0);
  assert.equal(mediaCalls, 0);
  assert.equal(stateCalls, 0);
});
