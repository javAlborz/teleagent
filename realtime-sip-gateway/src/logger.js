const REDACTED_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'webhooksecret',
  'webhook_secret',
  'webhook-signature',
  'pbxauthsecret',
  'pbx_auth_secret',
  'sip_pbx_auth_secret',
  'x-teleagent-pbx-auth',
]);

function sanitize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitize(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : sanitize(entry, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 1_024) return `${value.slice(0, 1_024)}…`;
  return value;
}

export function createLogger({ sink = console, clock = () => new Date() } = {}) {
  function write(level, message, fields = {}) {
    const entry = JSON.stringify({
      timestamp: clock().toISOString(),
      level,
      message,
      ...sanitize(fields),
    });
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    sink[method](entry);
  }

  return Object.freeze({
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  });
}
