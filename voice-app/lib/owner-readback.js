'use strict';

// Presentation names only. Unknown emoji are disclosed, never guessed or
// silently omitted. Native reply bytes and quoted commands remain untouched.
const symbolNames = new Map(Object.entries({
  '🍌': 'banana emoji', '👍': 'thumbs-up emoji', '👎': 'thumbs-down emoji',
  '🔴': 'red circle emoji', '🟠': 'orange circle emoji', '🟡': 'yellow circle emoji',
  '🟢': 'green circle emoji', '🔵': 'blue circle emoji', '🟣': 'purple circle emoji',
  '⚫': 'black circle emoji', '⚪': 'white circle emoji', '✅': 'check mark emoji',
  '❌': 'cross mark emoji', '❤️': 'red heart emoji', '❤': 'heart symbol',
  '🙂': 'slightly smiling face emoji', '😀': 'grinning face emoji', '😂': 'face with tears of joy emoji',
  '🎉': 'party popper emoji', '🚀': 'rocket emoji', '🔥': 'fire emoji',
  '✓': 'check mark symbol', '✔': 'check mark symbol',
}));
const graphemes = new Intl.Segmenter('en', {granularity: 'grapheme'});
function spokenSymbols(text) {
  return [...graphemes.segment(text)].map(({segment}) => {
    const name = symbolNames.get(segment);
    if (name) return ` ${name} `;
    if (/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(segment) || /[0-9#*]\uFE0F?\u20E3/u.test(segment)) {
      return ' an emoji whose exact symbol is in the saved reply ';
    }
    return segment;
  }).join('').replace(/\s+/g, ' ').trim();
}

// Presentation only: keep the original reply in application state. Commands are
// indivisible preview units, so a shortened read never speaks half a command.
function replyUnits(text) {
  return String(text || '').split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g).flatMap((part, index) => {
    if (index % 2) return [part.startsWith('```')
      ? part.replace(/^```[^\n]*\n/, '').replace(/```$/, '').trim() : part.slice(1, -1)];
    return spokenSymbols(part.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim()).split(/\s+/).filter(Boolean);
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
