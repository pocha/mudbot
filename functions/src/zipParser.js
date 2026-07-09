const AdmZip = require('adm-zip');

const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // guard against zip bombs

// WhatsApp export lines look like either:
//   "12/07/2026, 9:41 PM - Jane Doe: message text"
//   "[12/07/2026, 21:41:03] Jane Doe: message text"
const LINE_WITH_SENDER = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),\s?(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]?\s*-?\s*([^:\n]{1,60}):\s(.*)$/;
const LINE_DATE_ONLY = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),\s?(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]?\s*-?\s*(.*)$/;

function extractChatText(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  const totalUncompressed = entries.reduce((sum, e) => sum + (e.header ? e.header.size : 0), 0);
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
    throw new Error('Archive contents are too large to process');
  }

  const chatEntry = entries.find(e => !e.isDirectory && /\.txt$/i.test(e.entryName));
  if (!chatEntry) {
    throw new Error('No chat export (.txt) file found in the zip');
  }

  return chatEntry.getData().toString('utf8');
}

function parseWhatsAppChat(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const withSender = line.match(LINE_WITH_SENDER);
    if (withSender) {
      const [, date, time, name, msg] = withSender;
      messages.push({ from: name.trim(), name: name.trim(), timestamp: `${date} ${time}`, text: msg.trim() });
      continue;
    }

    const dateOnly = line.match(LINE_DATE_ONLY);
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

module.exports = { extractChatText, parseWhatsAppChat };
