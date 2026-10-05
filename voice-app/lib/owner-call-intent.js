'use strict';

// These overrides only choose reads or preserve text inside an independently
// selected send. Never infer permission to send from a session's output.
function wantsReplyWatch(text) {
  return typeof text === 'string' && /\b(?:read|reader|tell|report|back)\b[\s\S]{0,100}\b(?:done|finished|comes back|responds|replies)\b/i.test(text);
}

function ownerCorrectionRoute(text, focusedSession, operationId, labels = []) {
  if (typeof text !== 'string' || text.length > 400) return null;
  const clean = text.trim().replace(/[?.!]+$/, '');
  const correction = /^(?:no[, ]+)+(?:i mean|i meant|the session is) (?:the )?([A-Za-z0-9][A-Za-z0-9 ._-]{0,79}?)(?: session)?$/i.exec(clean);
  if (correction) return { action: 'inspect_owner_session', args: { session_label: correction[1], history: true } };
  const reading = /\b(?:read|latest|reply|response|output)\b/i.test(clean);
  if (reading && !/\b(?:ask|tell|send|write|follow up)\b/i.test(clean)) {
    const named = labels.filter(label => typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(label) &&
      new RegExp('(?:^|[^A-Za-z0-9])' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^A-Za-z0-9])', 'i').test(clean));
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
  const question = new RegExp('\\bask (?:it|them|that session|' + label + ')\\s+([\\s\\S]+?)(?:\\s+and (?:then )?(?:immediately )?(?:read|tell|report)\\b[\\s\\S]*)?$', 'i').exec(transcript);
  const what = /\b(?:write|send)\s+(what (?:is|are)\b[\s\S]+?)(?:\s+in that same syntax)?[?.!]*$/i.exec(transcript);
  if (question || what) message = (question || what)[1].trim();
  const normalize = value => String(value || '').toLowerCase().replace(/\bcomma\b/g, ',')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // A model may extract the message, but cannot answer, rewrite or expand it.
  const exact = normalize(message);
  if (!exact || !normalize(transcript).includes(exact)) return null;
  return { session_label: args.session_label, message,
    notify_when_complete: wantsReplyWatch(transcript) };
}

module.exports = { ownerCorrectionRoute, preserveOwnerMessage, wantsReplyWatch };
