import { createHash, timingSafeEqual } from 'node:crypto';

const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DTMF_DIGITS = new Set('0123456789*#ABCD'.split(''));
export const PBX_AUTH_HEADER = 'x-teleagent-pbx-auth';

export function assertCallId(value) {
  if (typeof value !== 'string' || !CALL_ID_PATTERN.test(value)) {
    throw new TypeError('Webhook data.call_id is invalid');
  }
  return value;
}

export function sipHeadersToMap(headers) {
  if (!Array.isArray(headers)) return new Map();
  const result = new Map();
  for (const header of headers) {
    if (!header || typeof header.name !== 'string' || typeof header.value !== 'string') continue;
    const name = header.name.trim().toLowerCase();
    const value = header.value.trim();
    if (!name || name.length > 128 || value.length > 2_048) continue;
    const existing = result.get(name) ?? [];
    existing.push(value);
    result.set(name, existing);
  }
  return result;
}

function secretDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function authenticatePrivatePbx(config, headers) {
  const supplied = headers.get(PBX_AUTH_HEADER) ?? [];
  const candidate = supplied.length === 1 ? supplied[0] : '';
  const expected = typeof config.pbxAuthSecret === 'string' ? config.pbxAuthSecret : '';
  const matches = timingSafeEqual(secretDigest(candidate), secretDigest(expected));
  if (!matches || supplied.length !== 1 || !expected) return null;
  return config.pbxPrincipal;
}

export function decideIncomingCall(config, event) {
  const callId = assertCallId(event?.data?.call_id);
  const headers = sipHeadersToMap(event?.data?.sip_headers);

  if (config.mode === 'reject') {
    return { action: 'reject', callId, statusCode: config.rejectStatus, reason: 'gateway_reject_mode' };
  }

  const from = headers.get('from') ?? [];
  const to = headers.get('to') ?? [];
  const authenticatedPrincipal = authenticatePrivatePbx(config, headers);
  if (!authenticatedPrincipal) {
    return { action: 'reject', callId, statusCode: 403, reason: 'pbx_auth_failed' };
  }
  if (!config.allowAllCallers && !from.some((value) => config.allowedFrom.includes(value))) {
    return {
      action: 'reject',
      callId,
      statusCode: 403,
      reason: 'caller_not_allowed',
      authenticatedPrincipal,
    };
  }
  if (config.allowedTo.length > 0 && !to.some((value) => config.allowedTo.includes(value))) {
    return {
      action: 'reject',
      callId,
      statusCode: 404,
      reason: 'destination_not_allowed',
      authenticatedPrincipal,
    };
  }

  return {
    action: 'accept',
    callId,
    reason: 'canary_allowed',
    authenticatedPrincipal,
  };
}

export function extractDtmfDigit(event) {
  if (event?.type !== 'input_audio_buffer.dtmf_event_received') return null;
  const candidates = [
    event.event,
    event.digit,
    event.key,
    event.dtmf?.digit,
    event.event_data?.digit,
    event.event_data?.key,
  ];
  const digit = candidates.find((value) => typeof value === 'string');
  if (!digit) return null;
  const normalized = digit.toUpperCase();
  return DTMF_DIGITS.has(normalized) ? normalized : null;
}
