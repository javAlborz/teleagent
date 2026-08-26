'use strict';

const SENSITIVE_LOGGING_ENV_KEYS = Object.freeze([
  'AGENT_LOG_SENSITIVE',
  'CLAUDE_LOG_SENSITIVE',
]);

function isTruthy(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function assertSensitiveAgentLoggingDisabled(environment = process.env) {
  const requested = SENSITIVE_LOGGING_ENV_KEYS.filter((key) => isTruthy(environment[key]));
  if (requested.length === 0) return;

  const error = new Error(
    `Raw agent prompt and output logging is forbidden; unset or disable ${requested.join(', ')}`
  );
  error.code = 'SENSITIVE_AGENT_LOGGING_FORBIDDEN';
  throw error;
}

function summarizeSensitiveText(text) {
  return `chars=${String(text || '').length}`;
}

module.exports = {
  SENSITIVE_LOGGING_ENV_KEYS,
  assertSensitiveAgentLoggingDisabled,
  summarizeSensitiveText,
};
