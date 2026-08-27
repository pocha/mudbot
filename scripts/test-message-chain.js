#!/usr/bin/env node
//
// Fires N send-message requests at the local /api/message endpoint back-to-
// back — not awaited one at a time — so they land in the same withSession
// batch for the user (userQueueDepth > 1) instead of each being its own
// batch of one. That's what actually exercises the real send path: relay
// acquired once and reused across the batch, retry-with-clean-slate on a
// transient failure, usage-log entries (including retryReason if a retry
// happened). test-mudslide-proxy.js calls mudslide directly and bypasses
// withSession entirely, so it can't validate any of that.
//
// This script only fires the requests and prints their responses — the
// actual verification (was the relay really only acquired once? did a retry
// happen?) comes from watching the server's own logs / that user's usage
// log while this runs, not from this script's output.
//
// Usage:
//   API_KEY=xxx npm run test-message-chain
//   API_KEY=xxx node scripts/test-message-chain.js --count=3 --to=me --base=https://localhost
//
const https = require('https');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    })
);

const apiKey = args['api-key'] || process.env.API_KEY;
if (!apiKey) {
  console.error('Missing API key. Pass --api-key=xxx or set API_KEY env var.');
  process.exit(1);
}

const baseUrl = (args.base || process.env.BASE_URL || 'https://localhost').replace(/\/$/, '');
const count = Number(args.count || 3);
const to = args.to || 'me';

// Local dev serves HTTPS with a mkcert-signed cert (see services/buildServer.js) —
// trusted by the OS/browsers via mkcert's own root CA, but Node's own CA store
// doesn't know about it, so plain https.request would fail cert verification.
// Fine to relax for this local-only test script.
const agent = new https.Agent({ rejectUnauthorized: false });

function sendMessage(i) {
  const body = JSON.stringify({ to, message: `test-message-chain #${i} @ ${new Date().toISOString()}` });
  const start = Date.now();
  return new Promise(resolve => {
    const req = https.request(`${baseUrl}/api/message`, {
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key': apiKey
      }
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        console.log(`#${i} -> ${res.statusCode} (${Date.now() - start}ms): ${data.trim()}`);
        resolve();
      });
    });
    req.on('error', err => {
      console.error(`#${i} -> request error (${Date.now() - start}ms):`, err.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log(`Firing ${count} messages to "${to}" at ${baseUrl}/api/message, back-to-back (not awaited sequentially)...\n`);
  await Promise.all(Array.from({ length: count }, (_, idx) => sendMessage(idx + 1)));
  console.log('\nDone. Check the server logs and this user\'s usage log to confirm the relay was acquired once for the whole batch (not once per message) and to see retryReason on any entry where a retry happened.');
})();