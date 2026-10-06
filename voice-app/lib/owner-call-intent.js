'use strict';

// Read corrections and explicit caller imperatives are bound to caller text.
// Never infer permission to send from a session's output.
function wantsReplyWatch(text) {
  return typeof text === 'string' && !/\b(?:don't|do not|never|no need to) (?:read|tell|report)\b/i.test(text) && /\b(?:read|reader|tell|report|back)\b[\s\S]{0,100}\b(?:when|once|after)\b[\s\S]{0,40}\b(?:done|finished|finishes|complete|completed|comes back|responds|replies)\b/i.test(text);
}

function spokenLabelPattern(label) {
  return label.replace(/\s/g, '').split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
}

function ownerCorrectionRoute(text, focusedSession, operationId, labels = []) {
  if (typeof text !== 'string' || text.length > 400) return null;
  const clean = text.trim().replace(/[?.!]+$/, '');
  const correction = /^(?:no[, ]+)+(?:i mean|i meant|the session is) (?:the )?([A-Za-z0-9][A-Za-z0-9 ._-]{0,79}?)(?: session)?$/i.exec(clean);
  if (correction) return { action: 'inspect_owner_session', args: { session_label: correction[1], history: true } };
  const reading = /\b(?:read|latest|reply|response|output)\b/i.test(clean);
  if (reading && !/\b(?:ask|tell|send|write|follow up)\b/i.test(clean)) {
    const named = labels.filter(label => typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(label) &&
      new RegExp('(?:^|[^A-Za-z0-9])' + spokenLabelPattern(label) + '(?:$|[^A-Za-z0-9])', 'i').test(clean));
    if (named.length === 1 && !/\b(?:for|from|of)\b.*\band\b/i.test(clean)) {
      return { action: 'inspect_owner_session', args: { session_label: named[0], history: true } };
    }
    if (named.length > 1 || /\b(?:for|from|of)\b.*\band\b/i.test(clean)) {
      return { action: 'respond', args: {}, response_instruction: 'Ask which single named session the caller wants to read first. Do not read or send anything yet.' };
    }
  }
  // A reminder about an earlier instruction is never a new send.
  const reminder = /\b(?:i|we) (?:asked|told|said|wanted)\b/i.test(clean);
  if (reminder && focusedSession) {
    if (/^job_[a-f0-9]{64}$/.test(operationId || '') && wantsReplyWatch(clean)) {
      return { action: 'get_owner_reply', args: { operation_id: operationId, notify_when_complete: true } };
    }
    return { action: 'inspect_owner_session', args: { session_label: focusedSession, history: true } };
  }
  return null;
}

function preserveOwnerMessage(transcript, args) {
  if (typeof transcript !== 'string' || !transcript.trim()) return null;
  // Questions about prior delivery are read-only even if they contain "write".
  if (/\b(?:i|we) (?:asked|told|said|wanted)\b/i.test(transcript) ||
      !/\b(?:ask|tell|write|send|follow up|message)\b/i.test(transcript)) return null;
  let message = args.message;
  const label = typeof args.session_label === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(args.session_label)
    ? args.session_label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s*') : '(?!)';
  const question = new RegExp('\\bask (?:it|them|that session|' + label + ')\\s+([\\s\\S]+)$', 'i').exec(transcript);
  const what = /\b(?:write|send)\s+(what (?:is|are)\b[\s\S]+?)(?:\s+in that same syntax)?[?.!]*$/i.exec(transcript);
  if (question || what) message = (question || what)[1].trim();
  if (typeof message === 'string' && wantsReplyWatch(transcript)) message = message.replace(/\s+and (?:then )?(?:immediately )?(?:read|tell|report)\b[\s\S]*\b(?:done|finished|finishes|complete|completed|comes back|responds|replies)\b[\s\S]*$/i, '').trim();
  const normalize = value => String(value || '').toLowerCase().replace(/\bcomma\b/g, ',')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // A model may extract the message, but cannot answer, rewrite or expand it.
  const exact = normalize(message);
  if (!exact || typeof message !== 'string' || message.length > 1200 || !normalize(transcript).includes(exact)) return null;
  return { session_label: args.session_label, message,
    notify_when_complete: wantsReplyWatch(transcript) };
}

function callerCommand(text) {
  return text.trim().replace(/^(?:(?:okay|ok|all right|now|please)[,.! ]+)+/i, '')
    .replace(/^let['’]s start by doing (?:the )?(?:first|next) step[.!]\s*/i, '')
    .replace(/^(?:could|can|would) you (?:please )?/i, '').replace(/^please /i, '');
}

function ownerInventoryRoute(transcript) {
  if (typeof transcript !== 'string' || transcript.length > 400) return null;
  const text = callerCommand(transcript);
  return /^(?:list|read|show|name|tell me)(?: me)? (?:all (?:of )?(?:the )?|the |my )?(?:(?:enrolled|personal|available|named|agent) )*sessions(?: and their names)?[?.!]*$/i.test(text)
    ? { action: 'list_owner_sessions', args: {} } : null;
}

function ownerSendRoute(transcript, focusedSession, labels = []) {
  if (typeof transcript !== 'string' || transcript.length > 1400) return null;
  const text = callerCommand(transcript);
  // Only a fresh imperative can send. Match a spoken spacing alias against
  // known labels; collisions ask for clarification, never choose a target.
  const match = /^(ask|tell|write|send(?: (?:a |the )?message to)?|message)\s+([\s\S]+)$/i.exec(text);
  if (!match) return null;
  let label = null; let message = null;
  const rest = match[2];
  const named = [...new Set([...labels, focusedSession].filter(Boolean))].flatMap(value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(value)) return [];
    const pattern = spokenLabelPattern(value);
    const found = new RegExp('^' + pattern + '(?:\\s*[:,]\\s*|\\s+)([\\s\\S]+)$', 'i').exec(rest);
    return found ? [{ label: value, message: found[1] }] : [];
  });
  if (named.length > 1) return { action: 'respond', args: {},
    response_instruction: 'Ask for the exact single session name. Nothing has been sent because the spoken name matches multiple enrolled sessions.' };
  if (named.length === 1) { label = named[0].label; message = named[0].message.trim(); }
  else if (/^(?:it|them|that session) /i.test(rest) && focusedSession) {
    label = focusedSession; message = rest.replace(/^(?:it|them|that session) /i, '');
  } else if (match[1].toLowerCase() === 'write' && /^what (?:is|are) /i.test(rest) && focusedSession) {
    label = focusedSession; message = rest.replace(/\s+in that same syntax[?.!]*$/i, '');
  }
  if (!label || !message) return null;
  if (/^(?:send|message)/i.test(match[1])) message = message.replace(/^(?:that|saying)\s+/i, '');
  message = message.replace(/\s+and (?:then )?(?:immediately )?(?:read|tell|report)\b[\s\S]*\b(?:done|finished|finishes|complete|completed|comes back|responds|replies)\b[\s\S]*$/i, '').trim();
  const args = preserveOwnerMessage(transcript, { session_label: label, message });
  return args ? { action: 'request_owner_instruction', args } : null;
}

// Selection is caller-owned; a model cannot silently turn an ordinal into latest.
function ownerHistorySelection(text, previous = null) {
  if (typeof text !== 'string' || /\b(?:send|tell|write|ask|message to)\b/i.test(text)) return null;
  const role = /\b(?:reply|replies|answer|answers|response)\b/i.test(text) ? 'assistant'
    : /\b(?:user|my) message\b/i.test(text) ? 'user' : 'any';
  if (/\b(?:very first|first|oldest)\b/i.test(text)) return { anchor: 'start', index: 1, role };
  if (/\bsecond[ -]to[ -]last\b/i.test(text)) return { anchor: 'end', index: 2, role };
  if (/\b(?:one before that|previous|earlier|before that)\b/i.test(text)) {
    if (previous?.anchor === 'start') return { ...previous, index: previous.index - 1 };
    return { anchor: 'end', index: (previous?.index || 1) + 1, role: previous?.role || role };
  }
  return null;
}

module.exports = { ownerInventoryRoute, ownerHistorySelection, ownerCorrectionRoute, ownerSendRoute, preserveOwnerMessage, wantsReplyWatch };
