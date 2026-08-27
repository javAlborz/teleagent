const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSipUri, initiateOutboundCall } = require('../lib/outbound-handler');
const { createOutboundRoutingConfig } = require('../lib/outbound-routing-config');

const CALLBACK_AUTH = Object.freeze({
  username: 'teleagent-voice',
  password: 'callback-0123456789abcdef0123456789abcdef',
});

const ROUTING_CONFIG = createOutboundRoutingConfig({
  host: '127.0.0.1',
  port: 5060,
  transport: 'udp',
  callbackAuth: CALLBACK_AUTH,
});

test('buildSipUri uses the exact validated loopback PBX route', () => {
  const sipUri = buildSipUri({
    to: '1001',
    routingConfig: ROUTING_CONFIG,
  });

  assert.equal(sipUri, 'sip:1001@127.0.0.1:5060;transport=udp');
});

test('buildSipUri honors explicit transport configuration', () => {
  const sipUri = buildSipUri({
    to: '1001',
    routingConfig: createOutboundRoutingConfig({
      host: 'pbx.internal',
      port: 5070,
      transport: 'tcp',
      callbackAuth: CALLBACK_AUTH,
    }),
  });

  assert.equal(sipUri, 'sip:1001@pbx.internal:5070;transport=tcp');
});

test('buildSipUri rejects an absent or unvalidated route', () => {
  assert.throws(
    () => buildSipUri({ to: '1001' }),
    /validated outbound SIP routing configuration/
  );
});

test('initiateOutboundCall destroys the media endpoint when SIP setup fails', async () => {
  let endpointDestroyCount = 0;
  const endpoint = {
    local: { sdp: 'local-sdp' },
    async destroy() { endpointDestroyCount += 1; },
  };
  const srf = {
    async createUAC() {
      const error = new Error('busy response');
      error.status = 486;
      throw error;
    },
  };

  await assert.rejects(
    initiateOutboundCall(srf, { async createEndpoint() { return endpoint; } }, {
      to: '1001',
      message: 'Hello',
      callId: 'cleanup-on-sip-error',
      routingConfig: ROUTING_CONFIG,
    }),
    /busy/
  );
  assert.equal(endpointDestroyCount, 1);
});

test('initiateOutboundCall destroys both dialog and endpoint when media setup fails', async () => {
  let endpointDestroyCount = 0;
  let dialogDestroyCount = 0;
  const endpoint = {
    local: { sdp: 'local-sdp' },
    async modify() { throw new Error('media_modify_failed'); },
    async destroy() { endpointDestroyCount += 1; },
  };
  const dialog = {
    remote: { sdp: 'remote-sdp' },
    destroyed: false,
    async destroy() {
      dialogDestroyCount += 1;
      this.destroyed = true;
    },
  };

  await assert.rejects(
    initiateOutboundCall(
      { async createUAC() { return dialog; } },
      { async createEndpoint() { return endpoint; } },
      {
        to: '1001',
        message: 'Hello',
        callId: 'cleanup-on-media-error',
        routingConfig: ROUTING_CONFIG,
      }
    ),
    /media_modify_failed/
  );
  assert.equal(dialogDestroyCount, 1);
  assert.equal(endpointDestroyCount, 1);
});

test('abort while SIP submission is ambiguous never claims teardown quiescence', async () => {
  const controller = new AbortController();
  let rejectInvite;
  let signalInviteStarted;
  const inviteStarted = new Promise((resolve) => { signalInviteStarted = resolve; });
  let endpointDestroyCount = 0;
  const pending = initiateOutboundCall(
    {
      createUAC() {
        signalInviteStarted();
        return new Promise((_resolve, reject) => { rejectInvite = reject; });
      },
    },
    {
      async createEndpoint() {
        return {
          local: { sdp: 'local-sdp' },
          async destroy() { endpointDestroyCount += 1; },
        };
      },
    },
    {
      to: '1001',
      message: 'Hello',
      callId: 'ambiguous-abort',
      signal: controller.signal,
      routingConfig: ROUTING_CONFIG,
    }
  );
  await inviteStarted;
  controller.abort('panic_stop');
  rejectInvite(new Error('transport closed before dialog truth'));

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'OUTBOUND_CALL_CANCELED');
    assert.equal(error.cleanupSucceeded, false);
    return true;
  });
  assert.equal(endpointDestroyCount, 1);
});

test('dedicated callback credentials are attached only to the exact configured PBX route', async () => {
  let observedUri = null;
  let observedOptions = null;
  const endpoint = {
    local: { sdp: 'local-sdp' },
    async modify() {},
    async destroy() {},
  };
  const dialog = {
    remote: { sdp: 'remote-sdp' },
    destroyed: false,
    async destroy() { this.destroyed = true; },
  };

  const result = await initiateOutboundCall({
    async createUAC(uri, options) {
      observedUri = uri;
      observedOptions = options;
      return dialog;
    },
  }, {
    async createEndpoint() { return endpoint; },
  }, {
    to: '1001',
    callId: 'exact-route-auth',
    routingConfig: ROUTING_CONFIG,
    deviceConfig: {
      extension: '1001',
      name: 'Test Device',
      authId: 'attacker-controlled-device-auth-id',
      password: 'attacker-controlled-device-password',
    },
  });

  assert.equal(observedUri, 'sip:1001@127.0.0.1:5060;transport=udp');
  assert.deepEqual(observedOptions.auth, {
    username: CALLBACK_AUTH.username,
    password: CALLBACK_AUTH.password,
  });
  assert.equal(
    observedOptions.headers.From,
    '"Test Device" <sip:1001@127.0.0.1:5060>'
  );
  await result.dialog.destroy();
  await result.endpoint.destroy();
});
