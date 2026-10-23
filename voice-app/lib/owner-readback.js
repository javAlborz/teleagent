'use strict';

// Presentation only: keep the original reply in application state. Commands are
// indivisible preview units, so a shortened read never speaks half a command.
function replyUnits(text) {
  return String(text || '').split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g).flatMap((part, index) => {
    if (index % 2) return [part.startsWith('```')
      ? part.replace(/^```[^\n]*\n/, '').replace(/```$/, '').trim() : part.slice(1, -1)];
    return part.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim().split(/\s+/).filter(Boolean);
  }).filter(Boolean);
}

function spokenReply(text, {detail = 'brief', words = 60, clipped = false} = {}) {
  const units = replyUnits(text);
  if (detail === 'full') return units.join(' ') + (clipped ? ' The saved reply is clipped here.' : '');
  const selected = []; let count = 0, characters = 0;
  for (const unit of units) {
    const size = unit.split(/\s+/).length;
    if (count + size > words || characters + unit.length > 550) break;
    selected.push(unit); count += size; characters += unit.length + 1;
  }
  const shortened = selected.length < units.length || clipped;
  return (selected.join(' ') || 'The reply is too long for a short preview.') +
    (shortened ? ' That is a brief excerpt. Say read the full reply for more.' : '');
}

function missingSessionSpeech(label, sending = false) {
  return `${label}: session not found${sending ? '; instruction not sent' : ''}. ` +
    'New sessions are discovered between calls. If you just created it, hang up and allow about two minutes before calling again. ' +
    (sending ? 'Which session should receive that message?' : 'Which session do you want to read?');
}

module.exports = {spokenReply, missingSessionSpeech};
