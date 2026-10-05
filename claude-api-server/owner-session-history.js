'use strict';

const { redactSensitiveText } = require('./operator-inspector');

function boundedMessages(messages) {
  return messages.filter((message) => ['user', 'assistant'].includes(message.role) &&
    typeof message.text === 'string' && message.text.trim())
    .slice(-6).map(({ role, text }) => {
      const redacted = redactSensitiveText(text);
      return { role, text: redacted.slice(0, 2000), clipped: redacted.length > 2000 };
    });
}

function validateSelection(selection) {
  if (selection === undefined || selection === null) return null;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
      Object.keys(selection).sort().join(',') !== 'anchor,index,role' ||
      !['start', 'end'].includes(selection.anchor) || !['any', 'user', 'assistant'].includes(selection.role) ||
      !Number.isInteger(selection.index) || selection.index < 1 || selection.index > 6) {
    throw require('./owner-session-endpoint').sessionError('OWNER_HISTORY_SELECTION_INVALID');
  }
  return selection;
}

function selectMessage(messages, selection, { startAvailable = true, limited = false } = {}) {
  validateSelection(selection);
  const eligible = messages.filter(m => ['user', 'assistant'].includes(m.role) &&
    typeof m.text === 'string' && m.text.trim() && (selection.role === 'any' || m.role === selection.role));
  const message = selection.anchor === 'start' && !startAvailable ? null
    : eligible[selection.anchor === 'start' ? selection.index - 1 : eligible.length - selection.index];
  return { selection, selectedMessage: message ? boundedMessages([message])[0] : null,
    selectionUnavailable: !message, limited };
}

module.exports = { boundedMessages, validateSelection, selectMessage };
