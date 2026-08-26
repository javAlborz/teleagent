import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CallRegistry } from '../src/call-registry.js';
import { GatewayStateStore } from '../src/gateway-state-store.js';

export const testPbxSecret = 'Q7m2N9x4R6k1W8z3C5b0D2f7H4j9K6p3T8y1U5i0O2s7V4a9';

export function makeConfig(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    mode: 'accept',
    apiKey: 'sk-test-not-a-real-key',
    webhookSecret: 'whsec_test_not_a_real_secret',
    pbxAuthSecret: testPbxSecret,
    pbxPrincipal: 'hermes-test-pbx',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    instructions: 'Canary only.',
    allowedFrom: ['sip:canary@asterisk.test'],
    allowedTo: [],
    allowAllCallers: false,
    rejectStatus: 486,
    maxActiveCalls: 1,
    maxHttpConnections: 32,
    greetingEnabled: true,
    sidebandConnectTimeoutMs: 1_000,
    maxWebhookBytes: 1_048_576,
    maxRealtimeEventBytes: 1_048_576,
    stateDatabasePath: '/tmp/unused-gateway-state.sqlite3',
    apiBaseUrl: 'https://api.openai.com/v1',
    realtimeWsUrl: 'wss://api.openai.com/v1/realtime',
    ...overrides,
  };
}

export async function makeRegistry(context, { filePath, clock } = {}) {
  const directory = filePath ? null : await mkdtemp(path.join(os.tmpdir(), 'sip-state-'));
  const stateStore = new GatewayStateStore({
    filePath: filePath ?? path.join(directory, 'gateway-state.sqlite3'),
    clock,
  });
  await stateStore.init();
  if (context) context.after(() => stateStore.close());
  return { stateStore, registry: new CallRegistry({ stateStore }) };
}

export function recordIncomingWebhook(stateStore, event, webhookId = 'wh_test_1') {
  stateStore.recordVerifiedWebhook(webhookId, {
    eventId: event.id,
    eventType: event.type,
    callId: event.data.call_id,
  });
  return webhookId;
}

export const silentLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

export class FakeSocket extends EventEmitter {
  sent = [];
  closes = [];

  send(value) {
    this.sent.push(value);
  }

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

export function incomingEvent(overrides = {}) {
  return {
    object: 'event',
    id: 'evt_test_1',
    type: 'realtime.call.incoming',
    created_at: 1,
    data: {
      call_id: 'rtc_test_1',
      sip_headers: [
        { name: 'From', value: 'sip:canary@asterisk.test' },
        { name: 'To', value: 'sip:extension-70@asterisk.test' },
        { name: 'X-Teleagent-PBX-Auth', value: testPbxSecret },
      ],
    },
    ...overrides,
  };
}
