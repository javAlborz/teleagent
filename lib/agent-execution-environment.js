'use strict';

// Agent CLIs are intentionally treated as untrusted workers. They receive the
// ordinary process environment required to start, but never inherit controller,
// SIP, cloud, bridge, or upstream-provider credentials. Provider workers use a
// short-lived launch capability against a provider-specific egress broker; the
// real bearer remains in a separate credential-holding service identity.
const SENSITIVE_ENVIRONMENT_KEYS = new Set([
  'AGENT_API_TOKEN',
  'ANTHROPIC_API_KEY',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AZURE_CONFIG_DIR',
  'CLAUDE_API_TOKEN',
  'CLOUDSDK_CONFIG',
  'DBUS_SESSION_BUS_ADDRESS',
  'DOCKER_CERT_PATH',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DRACHTIO_SECRET',
  'FREESWITCH_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'KUBECONFIG',
  'OPENAI_API_KEY',
  'OPENAI_REALTIME_API_KEY',
  'OPENAI_SAFETY_IDENTIFIER_SALT',
  'OUTBOUND_API_TOKEN',
  'SIP_AUTH_PASSWORD',
  'SSH_AGENT_PID',
  'SSH_AUTH_SOCK',
  'STT_API_KEY',
  'TTS_API_KEY',
  'VOICE_APPROVAL_PRIVATE_KEY',
  'VOICE_APPROVAL_PRIVATE_KEY_FILE',
  'XDG_RUNTIME_DIR',
]);

const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|SESSION_?TOKEN|TOKEN)(?:_|$)/i;

function isSensitiveEnvironmentKey(key) {
  const normalized = String(key || '').trim();
  return SENSITIVE_ENVIRONMENT_KEYS.has(normalized) || SENSITIVE_ENVIRONMENT_NAME.test(normalized);
}

function buildAgentExecutionEnvironment(baseEnvironment = {}, {
  preserveKeys = [],
  removeKeys = [],
} = {}) {
  const environment = { ...baseEnvironment };
  const preserved = new Set([].concat(preserveKeys).map(String));
  const removed = new Set([].concat(removeKeys).map(String));

  for (const key of Object.keys(environment)) {
    if (removed.has(key) || (!preserved.has(key) && isSensitiveEnvironmentKey(key))) {
      delete environment[key];
    }
  }

  return environment;
}

module.exports = {
  SENSITIVE_ENVIRONMENT_KEYS,
  buildAgentExecutionEnvironment,
  isSensitiveEnvironmentKey,
};
