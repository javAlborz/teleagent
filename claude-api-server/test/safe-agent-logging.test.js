'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSensitiveAgentLoggingDisabled,
  summarizeSensitiveText,
} = require('../../lib/safe-agent-logging');

test('raw agent logging flags fail closed', () => {
  for (const key of ['AGENT_LOG_SENSITIVE', 'CLAUDE_LOG_SENSITIVE']) {
    assert.throws(
      () => assertSensitiveAgentLoggingDisabled({ [key]: 'true' }),
      (error) => error.code === 'SENSITIVE_AGENT_LOGGING_FORBIDDEN' &&
        error.message.includes(key)
    );
  }
  assert.doesNotThrow(() => assertSensitiveAgentLoggingDisabled({
    AGENT_LOG_SENSITIVE: 'false',
    CLAUDE_LOG_SENSITIVE: '0',
  }));
});

test('sensitive text summaries never contain source text', () => {
  const secret = 'prompt-secret-value';
  const summary = summarizeSensitiveText(secret);
  assert.equal(summary, `chars=${secret.length}`);
  assert.doesNotMatch(summary, /prompt-secret-value/);
});
