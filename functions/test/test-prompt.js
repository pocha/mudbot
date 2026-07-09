// Standalone local test harness: parses a real WhatsApp chat export and calls
// Gemini directly, without deploying functions or going through Firestore/
// Cloud Functions at all. Lets us iterate on prompt.js/gemini.js in seconds
// instead of a deploy+upload+poll cycle.
//
// Usage:
//   npm test -- path/to/_chat.txt [maxChars]
// Reads GEMINI_API_KEY from the environment, or from functions/.env.local
// (gitignored). Deliberately .env.local, not .env — Firebase Functions v2
// auto-loads functions/.env as a plain deployed env var, which collides with
// the GEMINI_API_KEY *secret* binding on processFaqJob (same name, two
// mechanisms). .env.local is excluded from deploys by Firebase's own
// convention, so it's local/test-only by construction.

const fs = require('fs');
const path = require('path');

// Minimal .env loader (functions/ has no dotenv dependency, and adding one
// just for a test script isn't worth it) — only fills in vars not already set.
function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
}
loadDotEnv(path.join(__dirname, '..', '.env.local'));

const { parseWhatsAppChat, capMessagesBySize } = require('../../public/assets/whatsapp-parser.js');
const { buildFaqPrompt } = require('../src/prompt');
const { callGeminiForFaq } = require('../src/gemini');

async function main() {
  const [, , chatFilePath, maxCharsArg] = process.argv;
  if (!chatFilePath) {
    console.error('Usage: npm test -- path/to/_chat.txt [maxChars]');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set (env var or functions/.env)');
    process.exit(1);
  }

  const maxChars = maxCharsArg ? Number(maxCharsArg) : 900000; // matches MAX_MESSAGES_CHARS in index.js
  const text = fs.readFileSync(chatFilePath, 'utf8');

  const allMessages = parseWhatsAppChat(text);
  const messages = capMessagesBySize(allMessages, maxChars);
  console.log(`Parsed ${allMessages.length} messages, using ${messages.length} after size cap (${maxChars} chars).`);

  const prompt = buildFaqPrompt(path.basename(chatFilePath), messages);
  console.log(`Prompt length: ${prompt.length} chars.`);
  console.log('Calling Gemini...');

  const start = Date.now();
  const faq = await callGeminiForFaq(prompt, process.env.GEMINI_API_KEY);
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s. ${faq.length} FAQ entries:\n`);

  for (const [i, entry] of faq.entries()) {
    console.log(`${i + 1}. ${entry.question}  (count ~${entry.count}, last ${entry.mostRecentDate})`);
    for (const a of entry.answers || []) {
      console.log(`   - [${a.date}] ${a.text}`);
    }
  }

  const outPath = path.join(__dirname, '..', 'test-output.json');
  fs.writeFileSync(outPath, JSON.stringify(faq, null, 2));
  console.log(`\nFull output written to ${outPath}`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
