#!/usr/bin/env node
//
// End-to-end smoke test against the real API (not mudslide directly — see
// test-mudslide-proxy.js for that, which bypasses the HTTP API entirely to
// test the raw relay -> mudslide-CLI path). Three phases, each gating the
// next:
//   1. GET /api/whatsapp/ip — does the residential-IP-lookup path (relay's
//      plain-HTTP proxy leg, curl -> ip-api.com) work at all. Stops here on
//      failure, since that means the relay/proxy chain itself is broken.
//   2. GET /api/whatsapp — is the account actually connected (the real,
//      network-verified check, not just the cheap local file check). Stops
//      here if not — sending would just fail.
//   3. Fires N sends plus one groups fetch concurrently, all back-to-back —
//      not awaited one at a time — so they land in the same withSession
//      batch (userQueueDepth > 1), exercising: relay acquired once and
//      reused across the batch, retry-with-clean-slate on a transient
//      failure, usage-log entries (including retryReason if a retry
//      happened).
//
// This script only fires the requests and prints their responses — deeper
// verification (was the relay really only acquired once? did a retry
// happen?) comes from watching the server's own logs / that user's usage
// log while this runs, not from this script's output.
//
// sendMedia isn't covered here yet (needs a sample file to send).
//
// Usage:
//   API_KEY=xxx npm run test-mudslide
//   API_KEY=xxx node scripts/test-mudslide.js --count=3 --to=me --base=https://localhost
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

function request(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  const start = Date.now();
  return new Promise(resolve => {
    const req = https.request(`${baseUrl}${path}`, {
      method,
      agent,
      headers: {
        'X-API-Key': apiKey,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - start, body: data.trim() }));
    });
    req.on('error', err => resolve({ status: null, ms: Date.now() - start, body: '', error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function logResult(label, r) {
  if (r.error) console.error(`${label} -> request error (${r.ms}ms): ${r.error}`);
  else console.log(`${label} -> ${r.status} (${r.ms}ms): ${r.body}`);
}

function sendMessage(i) {
  return request('POST', '/api/message', { to, message: `test-mudslide #${i} @ ${new Date().toISOString()}` })
    .then(r => logResult(`send #${i}`, r));
}

function fetchGroups() {
  return request('GET', '/api/whatsapp/groups').then(r => logResult('groups', r));
}

(async () => {
  console.log(`1. Checking residential IP lookup at ${baseUrl}/api/whatsapp/ip...`);
  const ipCheck = await request('GET', '/api/whatsapp/ip');
  if (ipCheck.error || ipCheck.status !== 200) {
    console.error(`IP lookup failed (${ipCheck.status ?? 'no response'}, ${ipCheck.ms}ms): ${ipCheck.error || ipCheck.body}`);
    console.error('Stopping — the relay/proxy path itself is not working.');
    process.exit(1);
  }
  console.log(`   OK (${ipCheck.ms}ms): ${ipCheck.body}\n`);

  console.log(`2. Checking WhatsApp is actually connected at ${baseUrl}/api/whatsapp...`);
  const status = await request('GET', '/api/whatsapp');
  if (status.error || status.status !== 200) {
    console.error(`Connection check failed (${status.status ?? 'no response'}, ${status.ms}ms): ${status.error || status.body}`);
    process.exit(1);
  }
  let connected = false;
  try { connected = JSON.parse(status.body).connected; } catch {}
  if (!connected) {
    console.log(`   Not connected (${status.ms}ms): ${status.body}`);
    console.log('Stopping — connect the account first (e.g. via the dashboard QR flow) before running the send test.');
    return;
  }
  console.log(`   OK, connected (${status.ms}ms).\n`);

  console.log(`3. Firing ${count} messages to "${to}" plus one groups fetch at ${baseUrl}, back-to-back (not awaited sequentially)...\n`);
  const jobs = Array.from({ length: count }, (_, idx) => sendMessage(idx + 1));
  jobs.push(fetchGroups());
  await Promise.all(jobs);
  console.log('\nDone. Check the server logs and this user\'s usage log to confirm the relay was acquired once for the whole batch (not once per message) and to see retryReason on any entry where a retry happened.');
})();
