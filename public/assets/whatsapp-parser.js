// Parses a WhatsApp chat-export .txt file into { from, name, timestamp, text }
// messages, entirely client-side (so we never upload large exports to the
// server). Keep in sync with the server-side twin this was ported from:
// functions/src/zipParser.js's parseWhatsAppChat — same logic, no Node deps
// on either side, so it's a straight port.

// WhatsApp export lines look like either:
//   "12/07/2026, 9:41 PM - Jane Doe: message text"
//   "[12/07/2026, 21:41:03] Jane Doe: message text"
const WA_LINE_WITH_SENDER = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),\s?(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]?\s*-?\s*([^:\n]{1,60}):\s(.*)$/;
const WA_LINE_DATE_ONLY = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),\s?(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]?\s*-?\s*(.*)$/;

function parseWhatsAppChat(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const withSender = line.match(WA_LINE_WITH_SENDER);
    if (withSender) {
      const [, date, time, name, msg] = withSender;
      messages.push({ from: name.trim(), name: name.trim(), timestamp: `${date} ${time}`, text: msg.trim() });
      continue;
    }

    const dateOnly = line.match(WA_LINE_DATE_ONLY);
    if (dateOnly) {
      const [, date, time, msg] = dateOnly;
      messages.push({ from: 'System', name: 'System', timestamp: `${date} ${time}`, text: msg.trim() });
      continue;
    }

    // Continuation of a multi-line message
    if (messages.length) {
      messages[messages.length - 1].text += '\n' + line;
    }
  }

  // "System" bucket = a timestamped line with no "Name: text" pattern, which in
  // practice is always a WhatsApp-generated notice (joined/left/added/removed,
  // changed group settings/description, disappearing-messages toggle, the
  // end-to-end-encryption banner, etc.) — never substantive conversation, so
  // drop it entirely rather than let it eat into the message budget.
  return messages.filter(m => m.text && m.name !== 'System' && !/<Media omitted>/i.test(m.text));
}

// A flat message-count cap (e.g. "last 1500 messages") badly under-serves
// long-running, bursty groups: a few weeks of heavy back-and-forth can fill
// the whole budget and crowd out a year of other topics entirely. Capping by
// serialized size instead adapts to the actual content — chatty recent
// periods use more of the budget, quiet ones use less — while still
// guaranteeing we stay under Firestore's 1MiB document limit (the array is
// stored in the job doc before generation). Keeps the most recent messages
// that fit, walking backward from the end.
function capMessagesBySize(messages, maxChars) {
  let total = 0;
  let startIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const size = JSON.stringify(messages[i]).length;
    if (total + size > maxChars) break;
    total += size;
    startIndex = i;
  }

  return messages.slice(startIndex);
}
