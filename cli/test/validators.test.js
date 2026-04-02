import { test } from 'node:test';
import assert from 'node:assert';
import {
  validateTtsEndpoint,
  validateSttEndpoint
} from '../lib/validators.js';

test('validators module', async (t) => {
  await t.test('validateTtsEndpoint rejects empty URL', async () => {
    const result = await validateTtsEndpoint('');
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /Endpoint URL cannot be empty/);
  });

  await t.test('validateTtsEndpoint rejects unreachable endpoint', async () => {
    const result = await validateTtsEndpoint('http://127.0.0.1:1/v1');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
  });

  await t.test('validateSttEndpoint rejects empty URL', async () => {
    const result = await validateSttEndpoint('');
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /Endpoint URL cannot be empty/);
  });

  await t.test('validateSttEndpoint rejects unreachable endpoint', async () => {
    const result = await validateSttEndpoint('http://127.0.0.1:1/v1');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
  });
});
