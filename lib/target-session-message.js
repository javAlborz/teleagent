'use strict';

const MAX_TARGET_SESSION_MESSAGE_CHARS = 4000;
// C0/C1 controls include ESC and every line/keystroke delimiter. Unicode
// format controls cover bidi overrides, zero-width characters, and BOM. A
// target message is one visible logical line; Teleagent itself appends the one
// trusted operation marker and submits exactly one final Enter.
const UNSAFE_TARGET_MESSAGE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function canonicalizeTargetSessionMessage(value, {
  maximum = MAX_TARGET_SESSION_MESSAGE_CHARS,
} = {}) {
  const message = String(value ?? '').trim();
  if (!message || message.length > maximum || UNSAFE_TARGET_MESSAGE.test(message)) {
    const error = new Error(
      `Target-session message must be one visible plain-text line no longer than ${maximum} characters.`
    );
    error.code = 'INVALID_TARGET_MESSAGE';
    throw error;
  }
  return message;
}

module.exports = {
  MAX_TARGET_SESSION_MESSAGE_CHARS,
  canonicalizeTargetSessionMessage,
};
