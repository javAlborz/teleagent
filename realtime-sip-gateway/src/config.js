import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

const OFFICIAL_API_BASE = 'https://api.openai.com/v1';
const OFFICIAL_REALTIME_WS = 'wss://api.openai.com/v1/realtime';
const MAX_SECRET_BYTES = 8_192;
const PLACEHOLDER_SECRET_PATTERNS = Object.freeze([
  /(?:^|[-_.])change[-_.]?me(?:$|[-_.])/iu,
  /(?:^|[-_.])replace[-_.]?with(?:$|[-_.])/iu,
  /(?:^|[-_.])placeholder(?:$|[-_.])/iu,
  /(?:^|[-_.])example(?:$|[-_.])/iu,
  /(?:^|[-_.])dummy(?:$|[-_.])/iu,
  /(?:^|[-_.])not[-_.]?a[-_.]?real(?:$|[-_.])/iu,
  /(?:^|[-_.])test(?:$|[-_.])/iu,
  /(?:^|[-_.])your[-_.]?(?:api[-_.]?key|webhook[-_.]?secret|secret)(?:$|[-_.])/iu,
]);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function stringValue(env, name, defaultValue) {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (typeof raw !== 'string' || /[\r\n\0]/u.test(raw)) {
    throw new ConfigError(`${name} contains invalid control characters`);
  }
  return raw.trim();
}

function validateSecret(value, name) {
  if (!value || value.length < 16 || /\s/u.test(value)) {
    throw new ConfigError(`${name} must be a non-whitespace secret of at least 16 characters`);
  }
  if (
    PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(value))
    || value.toUpperCase() === name
  ) {
    throw new ConfigError(`${name} contains an obvious placeholder and cannot be used`);
  }
  return value;
}

function validateHighEntropySecret(value, name) {
  validateSecret(value, name);
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new ConfigError(`${name} must contain at least 32 bytes of secret material`);
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(value) || new Set(value).size < 10) {
    throw new ConfigError(
      `${name} must be 43-128 base64url/hex characters with sufficient character diversity`,
    );
  }
  return value;
}

function readSecretFile(filePath, name) {
  if (!path.isAbsolute(filePath)) {
    throw new ConfigError(`${name}_FILE must be an absolute path`);
  }

  let fileDescriptor;
  try {
    fileDescriptor = openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = fstatSync(fileDescriptor);
    if (!metadata.isFile() || metadata.size > MAX_SECRET_BYTES) {
      throw new ConfigError(
        `${name} credential must be a regular file no larger than ${MAX_SECRET_BYTES} bytes`,
      );
    }
    if (metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      throw new ConfigError(
        `${name} credential file must have one link and no group or other permissions`,
      );
    }
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : metadata.uid;
    if (metadata.uid !== 0 && metadata.uid !== effectiveUid) {
      throw new ConfigError(`${name} credential file must be owned by root or the service user`);
    }
    return validateSecret(readFileSync(fileDescriptor, 'utf8').trim(), name);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${name} credential file could not be read`);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function requiredHighEntropySecret(env, name) {
  return validateHighEntropySecret(requiredSecret(env, name), name);
}

function requiredSecret(env, name) {
  const directValue = stringValue(env, name, '');
  const explicitFile = stringValue(env, `${name}_FILE`, '');
  if (directValue && explicitFile) {
    throw new ConfigError(`${name} and ${name}_FILE cannot both be set`);
  }
  if (directValue) return validateSecret(directValue, name);

  const credentialsDirectory = stringValue(env, 'CREDENTIALS_DIRECTORY', '');
  const credentialFile = explicitFile
    || (credentialsDirectory ? path.join(credentialsDirectory, name) : '');
  if (!credentialFile) {
    throw new ConfigError(
      `${name} must be set directly, through ${name}_FILE, or as a systemd credential`,
    );
  }
  return readSecretFile(credentialFile, name);
}

function integerValue(env, name, defaultValue, { min, max }) {
  const raw = stringValue(env, name, String(defaultValue));
  if (!/^\d+$/u.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function booleanValue(env, name, defaultValue) {
  const raw = stringValue(env, name, String(defaultValue)).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} must be true or false`);
}

function enumValue(env, name, defaultValue, allowed) {
  const value = stringValue(env, name, defaultValue).toLowerCase();
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function listValue(env, name) {
  const raw = stringValue(env, name, '');
  if (!raw) return [];
  const values = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (values.some((entry) => entry.length > 512)) {
    throw new ConfigError(`${name} contains an entry longer than 512 characters`);
  }
  return [...new Set(values)];
}

function identifierValue(env, name, defaultValue) {
  const value = stringValue(env, name, defaultValue);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new ConfigError(`${name} has an invalid identifier`);
  }
  return value;
}

function validateUrl(raw, name, protocol) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid URL`);
  }
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${name} must use ${protocol} without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/$/u, '');
}

export function loadConfig(env = process.env) {
  const mode = enumValue(env, 'SIP_GATEWAY_MODE', 'reject', ['reject', 'accept']);
  const apiKey = requiredSecret(env, 'OPENAI_API_KEY');
  const webhookSecret = requiredSecret(env, 'OPENAI_WEBHOOK_SECRET');
  const pbxAuthSecret = mode === 'accept'
    ? requiredHighEntropySecret(env, 'SIP_PBX_AUTH_SECRET')
    : null;
  const pbxPrincipal = identifierValue(env, 'SIP_PBX_PRINCIPAL', 'hermes-private-pbx');
  const allowAllCallers = booleanValue(env, 'SIP_ALLOW_ALL_CALLERS', false);
  const allowedFrom = listValue(env, 'SIP_ALLOWED_FROM');
  const allowedTo = listValue(env, 'SIP_ALLOWED_TO');

  if (mode === 'accept' && !allowAllCallers && allowedFrom.length === 0) {
    throw new ConfigError(
      'SIP_GATEWAY_MODE=accept requires SIP_ALLOWED_FROM or explicit SIP_ALLOW_ALL_CALLERS=true',
    );
  }

  const apiBaseUrl = validateUrl(
    stringValue(env, 'OPENAI_BASE_URL', OFFICIAL_API_BASE),
    'OPENAI_BASE_URL',
    'https:',
  );
  const realtimeWsUrl = validateUrl(
    stringValue(env, 'OPENAI_REALTIME_WS_URL', OFFICIAL_REALTIME_WS),
    'OPENAI_REALTIME_WS_URL',
    'wss:',
  );
  const allowCustomEndpoints = booleanValue(env, 'SIP_ALLOW_CUSTOM_OPENAI_ENDPOINTS', false);
  if (!allowCustomEndpoints && (apiBaseUrl !== OFFICIAL_API_BASE || realtimeWsUrl !== OFFICIAL_REALTIME_WS)) {
    throw new ConfigError(
      'Custom OpenAI endpoints require SIP_ALLOW_CUSTOM_OPENAI_ENDPOINTS=true',
    );
  }

  const stateDatabasePath = path.resolve(
    stringValue(
      env,
      'SIP_STATE_DATABASE',
      '/var/lib/teleagent-sip-gateway/gateway-state.sqlite3',
    ),
  );
  const host = stringValue(env, 'SIP_GATEWAY_HOST', '127.0.0.1');
  const allowNonLoopbackBind = booleanValue(env, 'SIP_ALLOW_NON_LOOPBACK_BIND', false);
  if (!allowNonLoopbackBind && !['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase())) {
    throw new ConfigError('Non-loopback SIP_GATEWAY_HOST requires SIP_ALLOW_NON_LOOPBACK_BIND=true');
  }

  return Object.freeze({
    host,
    port: integerValue(env, 'SIP_GATEWAY_PORT', 3107, { min: 1, max: 65535 }),
    mode,
    apiKey,
    webhookSecret,
    pbxAuthSecret,
    pbxPrincipal,
    model: identifierValue(env, 'OPENAI_REALTIME_MODEL', 'gpt-realtime-2.1-mini'),
    voice: identifierValue(env, 'OPENAI_REALTIME_VOICE', 'marin'),
    instructions: stringValue(
      env,
      'OPENAI_REALTIME_INSTRUCTIONS',
      'You are the Teleagent native SIP canary. Be concise and report only confirmed state.',
    ),
    allowedFrom: Object.freeze(allowedFrom),
    allowedTo: Object.freeze(allowedTo),
    allowAllCallers,
    rejectStatus: integerValue(env, 'SIP_REJECT_STATUS', 486, { min: 400, max: 699 }),
    maxActiveCalls: integerValue(env, 'SIP_MAX_ACTIVE_CALLS', 1, { min: 1, max: 100 }),
    maxHttpConnections: integerValue(env, 'SIP_MAX_HTTP_CONNECTIONS', 32, {
      min: 1,
      max: 1_000,
    }),
    greetingEnabled: booleanValue(env, 'SIP_GREETING_ENABLED', true),
    sidebandConnectTimeoutMs: integerValue(
      env,
      'SIP_SIDEBAND_CONNECT_TIMEOUT_MS',
      10_000,
      { min: 1_000, max: 60_000 },
    ),
    maxWebhookBytes: integerValue(env, 'SIP_MAX_WEBHOOK_BYTES', 1_048_576, {
      min: 1_024,
      max: 4_194_304,
    }),
    maxRealtimeEventBytes: integerValue(env, 'SIP_MAX_REALTIME_EVENT_BYTES', 1_048_576, {
      min: 1_024,
      max: 4_194_304,
    }),
    stateDatabasePath,
    apiBaseUrl,
    realtimeWsUrl,
  });
}

export const officialEndpoints = Object.freeze({
  apiBaseUrl: OFFICIAL_API_BASE,
  realtimeWsUrl: OFFICIAL_REALTIME_WS,
});
