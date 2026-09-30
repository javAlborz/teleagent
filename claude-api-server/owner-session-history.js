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

module.exports = { boundedMessages };
