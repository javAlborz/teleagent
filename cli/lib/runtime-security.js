import crypto from 'crypto';

const RUNTIME_SECRET_FIELDS = Object.freeze([
  ['agentApi', 'AGENT_API_TOKEN'],
  ['executorApi', 'EXECUTOR_API_TOKEN'],
  ['voiceControl', 'VOICE_CONTROL_TOKEN'],
  ['privilegedActionApi', 'PRIVILEGED_ACTION_API_TOKEN'],
  ['outboundApi', 'OUTBOUND_API_TOKEN']
]);

const PLACEHOLDER_SECRET = /^(?:replace|change|your)[-_ ]?with|placeholder|example|changeme/i;

function validRuntimeSecret(value) {
  const secret = String(value || '');
  const byteLength = Buffer.byteLength(secret, 'utf8');
  return secret === secret.trim() &&
    byteLength >= 32 && byteLength <= 4096 &&
    !/[\u0000-\u001F\u007F]/.test(secret) &&
    !PLACEHOLDER_SECRET.test(secret);
}

function freshRuntimeSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Ensure every generated deployment has distinct, non-placeholder credentials.
 * The caller is responsible for persisting the mutated config with mode 0600.
 */
export function ensureRuntimeSecrets(config, environment = process.env) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('A configuration object is required.');
  }
  if (!config.secrets || typeof config.secrets !== 'object') {
    config.secrets = {};
  }

  let changed = false;
  const used = new Set();
  for (const [field, environmentName] of RUNTIME_SECRET_FIELDS) {
    let value = config.secrets[field];
    if (!validRuntimeSecret(value) || used.has(value)) {
      const provisioned = environment?.[environmentName];
      if (validRuntimeSecret(provisioned) && !used.has(provisioned)) {
        value = provisioned;
      }
    }
    if (!validRuntimeSecret(value) || used.has(value)) {
      do {
        value = freshRuntimeSecret();
      } while (used.has(value));
    }
    if (config.secrets[field] !== value) changed = true;
    config.secrets[field] = value;
    used.add(value);
  }

  return { config, changed };
}

export function getRuntimeSecretEnvironment(config) {
  ensureRuntimeSecrets(config);
  return Object.fromEntries(RUNTIME_SECRET_FIELDS.map(([field, environmentName]) => [
    environmentName,
    config.secrets[field]
  ]));
}

export { RUNTIME_SECRET_FIELDS, validRuntimeSecret };
