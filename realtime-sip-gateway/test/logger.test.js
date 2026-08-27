import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from '../src/logger.js';

test('structured logger redacts credential fields case-insensitively', () => {
  const entries = [];
  const sink = {
    log: (entry) => entries.push(entry),
    warn: (entry) => entries.push(entry),
    error: (entry) => entries.push(entry),
  };
  const logger = createLogger({ sink, clock: () => new Date('2026-08-25T00:00:00Z') });
  logger.info('test', {
    Authorization: 'Bearer secret',
    apiKey: 'sk-secret',
    webhook_secret: 'whsec-secret',
    SIP_PBX_AUTH_SECRET: 'pbx-secret',
    'X-Teleagent-PBX-Auth': 'header-secret',
    safe: 'visible',
  });
  const parsed = JSON.parse(entries[0]);
  assert.equal(parsed.Authorization, '[redacted]');
  assert.equal(parsed.apiKey, '[redacted]');
  assert.equal(parsed.webhook_secret, '[redacted]');
  assert.equal(parsed.SIP_PBX_AUTH_SECRET, '[redacted]');
  assert.equal(parsed['X-Teleagent-PBX-Auth'], '[redacted]');
  assert.equal(parsed.safe, 'visible');
});
