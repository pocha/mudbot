#!/usr/bin/env node
// Interactive, human-in-the-loop end-to-end walkthrough against a REAL
// watobot server and a REAL WhatsApp account/phone. This is deliberately NOT
// part of `npm test` (see package.json) — it needs a human to scan a QR code
// and check a real phone for messages, so it can't run unattended in CI.
// Automated coverage for failure/edge cases lives in
// test/mudslideService.classification.test.js, test/mudslideService.queueHang.test.js,
// and test/dataimpulseRelay.test.js instead (mocked, no real device needed).
//
// If BASE_URL/MAILDEV_URL point at localhost and aren't already reachable,
// this starts them itself (a real `node server.js`, and MailDev via the
// `maildev` package already used by test/flow.test.js) and stops only
// whichever of the two it actually started, on exit. A non-localhost target
// is assumed to be someone else's responsibility and is never auto-started.
//
// Usage: node test/e2e-manual.js [baseUrl]
//   E2E_BASE_URL / first CLI arg — server to test against (default http://localhost:3000)
//   MAILDEV_URL   — where to check for the "WhatsApp Connected" owner email (default http://localhost:1080)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const readline = require('readline/promises');
const path = require('path');
const { spawn } = require('child_process');

const BASE_URL = process.argv[2] || process.env.E2E_BASE_URL || 'http://localhost:3000';
const MAILDEV_URL = process.env.MAILDEV_URL || 'http://localhost:1080';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => rl.question(q);

// Only auto-started when the target is localhost — a remote BASE_URL/MAILDEV_URL
// means someone else is responsible for it, and spawning a local process for
// it would be nonsensical. Tracked here (not just local to their own
// functions) so cleanupSpawned() at the end only stops what THIS run actually
// started, never something that was already running before it got here.
let spawnedServerProcess = null;
let spawnedMaildevServer = null;

function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

async function waitForServer(url, retries = 30, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Server did not become reachable at ${url} in time`);
}

// Starts MailDev first (if needed) so its port is known before possibly
// starting the app server, which needs to be told where to send mail.
async function ensureMaildevRunning() {
  try {
    const res = await fetch(`${MAILDEV_URL}/email`);
    if (res.ok) { pass('MailDev already running'); return; }
  } catch { /* not reachable, fall through to start/skip below */ }

  if (!isLocalUrl(MAILDEV_URL)) {
    console.log(`  MailDev not reachable at ${MAILDEV_URL} and it's not localhost — can't start it here; email checks will be skipped.`);
    return;
  }

  const webPort = Number(new URL(MAILDEV_URL).port) || 1080;
  console.log(`  MailDev not reachable — starting it (web ${webPort}, smtp 1025)...`);
  const MailDev = require('maildev');
  spawnedMaildevServer = new MailDev({ smtp: 1025, web: webPort, silent: true });
  await new Promise((resolve, reject) => spawnedMaildevServer.listen(err => err ? reject(err) : resolve()));
  pass('MailDev started');
}

async function ensureServerRunning() {
  const { status } = await get(`${BASE_URL}/api/health`).catch(() => ({ status: 0 }));
  if (status === 200) { pass('server already running'); return; }

  if (!isLocalUrl(BASE_URL)) {
    throw new Error(`Server not reachable at ${BASE_URL} and it's not localhost — can't start a remote server from here.`);
  }

  const port = new URL(BASE_URL).port || '3000';
  console.log(`  server not reachable at ${BASE_URL} — starting node server.js on port ${port}...`);
  spawnedServerProcess = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: port,
      // Explicit, not inherited from .env — this script talks to the server
      // over plain HTTP (see BASE_URL above), so a locally-spawned instance
      // must not switch on HTTPS regardless of what BASE_URL happens to be
      // set to outside this process (see test/flow.test.js's own comment on
      // this exact same pattern).
      BASE_URL: `http://localhost:${port}`,
      // Only redirect mail if we're the ones who just started MailDev — if
      // it was already running, whatever SMTP config the (already-running)
      // server was configured with stands, we don't touch it.
      ...(spawnedMaildevServer ? {
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_SECURE: 'false',
        SMTP_USER: '',
        SMTP_PASS: ''
      } : {})
    },
    stdio: 'pipe'
  });
  spawnedServerProcess.stderr.on('data', d => process.stderr.write(d));
  await waitForServer(BASE_URL);
  pass('server started');
}

async function cleanupSpawned() {
  if (spawnedServerProcess) {
    console.log('\nStopping the server this run started...');
    spawnedServerProcess.kill();
  }
  if (spawnedMaildevServer) {
    console.log('Stopping MailDev this run started...');
    await new Promise(resolve => spawnedMaildevServer.close(resolve));
  }
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function log(msg) { console.log(`\n${msg}`); }
function pass(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

// --- steps ---

async function detectLocation() {
  try {
    const res = await fetch('https://ipwho.is/');
    const data = await res.json();
    if (!data.success || !data.country_code || !data.city) throw new Error('incomplete result');
    return { country: data.country_code.toLowerCase(), city: data.city, countryName: data.country };
  } catch {
    return null;
  }
}

async function pollMaildevForSubject(substring, sinceMs) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`${MAILDEV_URL}/email`);
      const emails = await res.json();
      const match = emails.find(e =>
        (e.subject || '').includes(substring) && new Date(e.date || e.time).getTime() >= sinceMs
      );
      if (match) return match;
    } catch { /* maildev not reachable yet */ }
  }
  return null;
}

async function main() {
  console.log(`watobot e2e-manual — BASE_URL=${BASE_URL}`);
  await ensureMaildevRunning();
  await ensureServerRunning();

  const token = (await ask('\nPaste the account token to test with: ')).trim();
  if (!token) throw new Error('Token is required');

  // --- 1. reconnect (optional) ---
  // Logging out + a fresh QR scan makes mudslide create a brand-new session
  // under whichever Baileys version is currently running — the right thing
  // to test "does a new login work". It's the WRONG thing to test "does an
  // EXISTING session, created under an older Baileys version, keep working
  // after upgrading mudslide" — that needs the account left exactly as it
  // was, so it's optional here.
  log('Step 1: reconnect (optional)');
  const { body: statusBody } = await get(`${BASE_URL}/api/whatsapp/status`, authHeader(token));
  let doReconnect;
  if (statusBody.loggedIn) {
    const answer = (await ask('  Existing local session found. Log out and scan a fresh QR code, or test THIS existing session as-is? (fresh/existing) [existing]: ')).trim().toLowerCase();
    doReconnect = answer === 'fresh' || answer === 'f';
  } else {
    console.log('  No existing local session found — a fresh QR scan is required.');
    doReconnect = true;
  }

  if (doReconnect) {
    if (statusBody.loggedIn) {
      pass('logging out the existing session');
      const { status, body } = await post(`${BASE_URL}/api/whatsapp/logout`, {}, authHeader(token));
      if (status !== 200 || !body.success) throw new Error('logout call failed: ' + JSON.stringify(body));
      pass('local session purged via /api/whatsapp/logout');
      await ask('Please also remove this device from WhatsApp\'s own Linked Devices list on your phone now, then press Enter to continue...');
    }

    console.log('\n  setting proxy location...');
    const detected = await detectLocation();
    let country, city;
    if (detected) {
      console.log(`  Detected: ${detected.city}, ${detected.countryName}`);
      const useIt = (await ask('  Use this? (Y/n, or type "override" to enter manually): ')).trim().toLowerCase();
      if (useIt === 'n' || useIt === 'override') {
        country = (await ask('  Country code (e.g. in): ')).trim().toLowerCase();
        city = (await ask('  City: ')).trim();
      } else {
        country = detected.country;
        city = detected.city;
      }
    } else {
      console.log('  Could not auto-detect location.');
      country = (await ask('  Country code (e.g. in): ')).trim().toLowerCase();
      city = (await ask('  City: ')).trim();
    }
    {
      const { status, body } = await post(`${BASE_URL}/api/user/location`, { country, city }, authHeader(token));
      if (status !== 200 || !body.valid) throw new Error('location save failed: ' + JSON.stringify(body));
      pass(`location set: ${body.city}, ${body.countryName}`);
    }

    console.log('\n  QR login...');
    let scanned = false;
    while (!scanned) {
      const { status, body } = await get(`${BASE_URL}/api/whatsapp/qr`, authHeader(token));
      if (status !== 200 || !body.qr) throw new Error('failed to get QR: ' + JSON.stringify(body));
      console.log('\n' + body.qr + '\n');
      const answer = (await ask('Scan the QR above with WhatsApp. Connected? (y = yes / n = get a new QR / q = quit): ')).trim().toLowerCase();
      if (answer === 'q') { console.log('Aborted.'); rl.close(); return; }
      if (answer === 'y') scanned = true;
    }

    console.log('\n  confirming connection with the server...');
    const notifiedAt = Date.now();
    {
      const { status, body } = await post(`${BASE_URL}/api/whatsapp/notify-user-connected`, {}, authHeader(token));
      if (status === 200 && body.success) pass('POST /api/whatsapp/notify-user-connected succeeded');
      else fail(`notify-user-connected returned ${status}: ${JSON.stringify(body)}`);
    }
    const notifyEmailConfigured = !!(process.env.NOTIFY_EMAIL || process.env.REPLY_TO);
    if (!notifyEmailConfigured) {
      console.log('  (NOTIFY_EMAIL/REPLY_TO not set in .env — server would not have sent an owner email; skipping MailDev check)');
    } else {
      const email = await pollMaildevForSubject('WhatsApp Connected', notifiedAt);
      if (email) pass(`owner notification email found in MailDev: "${email.subject}"`);
      else fail('no "WhatsApp Connected" email appeared in MailDev within 10s');
    }
  } else {
    pass('skipping logout/QR — testing the existing connected session as-is');
  }

  // --- 2. real connected check (confirmWhatsappIsActuallyConnected) ---
  log('Step 2: verifying via GET /api/whatsapp...');
  let reallyConnected = false;
  {
    const { status, body } = await get(`${BASE_URL}/api/whatsapp`, authHeader(token));
    if (status === 200 && body.connected) { pass(`connected — phoneNumber=${body.phoneNumber}`); reallyConnected = true; }
    else fail(`GET /api/whatsapp: ${status} ${JSON.stringify(body)}`);
  }

  if (!reallyConnected) {
    const cont = (await ask('\nNot confirmed connected — sends would likely fail. Continue anyway? (y/N): ')).trim().toLowerCase();
    if (cont !== 'y') { console.log('Stopping.'); rl.close(); return; }
  }

  // --- 3. concurrent sends + groups ---
  log('Step 3: sending 3 concurrent test messages + fetching groups');
  const recipient = (await ask('Recipient phone number to send test messages to (digits only, country code, no +): ')).trim();
  const message = (await ask('Message text [default: "Test message from e2e-manual.js"]: ')).trim() || 'Test message from e2e-manual.js';

  const results = await Promise.allSettled([
    post(`${BASE_URL}/api/message`, { to: recipient, message: `${message} #1` }, authHeader(token)),
    post(`${BASE_URL}/api/message`, { to: recipient, message: `${message} #2` }, authHeader(token)),
    post(`${BASE_URL}/api/message`, { to: recipient, message: `${message} #3` }, authHeader(token)),
    get(`${BASE_URL}/api/whatsapp/groups`, authHeader(token))
  ]);
  const [send1, send2, send3, groups] = results;
  [send1, send2, send3].forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.status === 200 && r.value.body.success) pass(`send #${i + 1} succeeded`);
    else fail(`send #${i + 1}: ${r.status === 'fulfilled' ? JSON.stringify(r.value.body) : r.reason}`);
  });
  if (groups.status === 'fulfilled' && groups.value.status === 200) pass(`groups fetched (${(groups.value.body.groups || []).length} groups)`);
  else fail(`groups: ${groups.status === 'fulfilled' ? JSON.stringify(groups.value.body) : groups.reason}`);

  await ask(`\nCheck ${recipient}'s phone. Press Enter once you've confirmed all 3 test messages arrived...`);
  pass('confirmed by operator');

  log('Done.');
  rl.close();
}

main()
  .catch(err => {
    console.error('\nFATAL:', err.message);
    rl.close();
    process.exitCode = 1;
  })
  .finally(cleanupSpawned);
