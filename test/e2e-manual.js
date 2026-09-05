#!/usr/bin/env node
// Interactive, human-in-the-loop end-to-end walkthrough against a REAL,
// already-running watobot server and a REAL WhatsApp account/phone. This is
// deliberately NOT part of `npm test` (see package.json) — it needs a human
// to scan a QR code and check a real phone for messages, so it can't run
// unattended in CI. Automated coverage for failure/edge cases lives in
// test/mudslideService.classification.test.js, test/mudslideService.queueHang.test.js,
// and test/dataimpulseRelay.test.js instead (mocked, no real device needed).
//
// Usage: node test/e2e-manual.js [baseUrl]
//   E2E_BASE_URL / first CLI arg — server to test against (default http://localhost:3000)
//   MAILDEV_URL   — where to check for the "WhatsApp Connected" owner email (default http://localhost:1080)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const readline = require('readline/promises');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { getUserDir } = require('../services/userService');

const BASE_URL = process.argv[2] || process.env.E2E_BASE_URL || 'http://localhost:3000';
const MAILDEV_URL = process.env.MAILDEV_URL || 'http://localhost:1080';
const USERS_DIR = path.join(__dirname, '..', 'users');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => rl.question(q);

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

// Same AES-256-CBC(sha256(token)) scheme mudslideService.js uses for
// .mudslide.enc — mirrored here only by the chaos steps at the end, to
// decrypt/re-encrypt in place for a real (not mocked) reproduction.
function decrypt(buf, token) {
  const key = crypto.createHash('sha256').update(token).digest();
  const iv = buf.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(buf.slice(16)), decipher.final()]);
}
function encrypt(buf, token) {
  const key = crypto.createHash('sha256').update(token).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(buf), cipher.final()]);
}

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
  const { status: health } = await get(`${BASE_URL}/api/health`);
  if (health !== 200) throw new Error(`Server not reachable at ${BASE_URL} (health check returned ${health})`);
  pass('server reachable');

  const token = (await ask('\nPaste the account token to test with: ')).trim();
  if (!token) throw new Error('Token is required');
  const userDir = getUserDir ? token.slice(0, 10) : null; // token embeds userDir as its first 10 chars (see test/flow.test.js)

  // --- 1. logout if already connected ---
  log('Step 1: checking existing connection...');
  const { body: statusBody } = await get(`${BASE_URL}/api/whatsapp/status`, authHeader(token));
  if (statusBody.loggedIn) {
    pass('account has a local session — logging it out');
    const { status, body } = await post(`${BASE_URL}/api/whatsapp/logout`, {}, authHeader(token));
    if (status !== 200 || !body.success) throw new Error('logout call failed: ' + JSON.stringify(body));
    pass('local session purged via /api/whatsapp/logout');
    await ask('Please also remove this device from WhatsApp\'s own Linked Devices list on your phone now, then press Enter to continue...');
  } else {
    pass('no existing local session — nothing to remove');
  }

  // --- 2. location ---
  log('Step 2: setting proxy location...');
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

  // --- 3. QR login loop ---
  log('Step 3: QR login');
  let connected = false;
  while (!connected) {
    const { status, body } = await get(`${BASE_URL}/api/whatsapp/qr`, authHeader(token));
    if (status !== 200 || !body.qr) throw new Error('failed to get QR: ' + JSON.stringify(body));
    console.log('\n' + body.qr + '\n');
    const answer = (await ask('Scan the QR above with WhatsApp. Connected? (y = yes / n = get a new QR / q = quit): ')).trim().toLowerCase();
    if (answer === 'q') { console.log('Aborted.'); rl.close(); return; }
    if (answer === 'y') connected = true;
  }

  // --- 4. notify-user-connected + email check ---
  log('Step 4: confirming connection with the server...');
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

  // --- 5. real connected check ---
  log('Step 5: verifying via GET /api/whatsapp...');
  {
    const { status, body } = await get(`${BASE_URL}/api/whatsapp`, authHeader(token));
    if (status === 200 && body.connected) pass(`connected — phoneNumber=${body.phoneNumber}`);
    else fail(`GET /api/whatsapp: ${status} ${JSON.stringify(body)}`);
  }

  // --- 6. concurrent sends + groups ---
  log('Step 6: sending 3 concurrent test messages + fetching groups');
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

  // --- 7. optional chaos checks ---
  log('Step 7 (optional): chaos checks');
  const runChaos = (await ask('Run proxy-unreachable and device-unlinked-marker chaos checks now? (y/N): ')).trim().toLowerCase() === 'y';
  if (runChaos) {
    await chaosProxyUnreachable(token, userDir);
    await chaosNotRegisteredMarker(token, userDir);
  } else {
    console.log('  skipped');
  }

  log('Done.');
  rl.close();
}

// Temporarily points proxy.json at an unused port so the next real call must
// fail via a genuine connectivity error, then restores it — real
// reproduction of "residential proxy not reachable", not a mock.
async function chaosProxyUnreachable(token, userDir) {
  console.log('\n[chaos] proxy-unreachable...');
  const proxyPath = path.join(USERS_DIR, userDir, 'proxy.json');
  const original = await fs.readFile(proxyPath, 'utf8');
  try {
    // proxy.json uses userService's own encryptData scheme (key = Buffer.from(token, 'hex'), iv:hex ciphertext) — distinct from the .mudslide.enc AES scheme (key = sha256(token)) the decrypt()/encrypt() helpers above are for.
    const [ivHex, encHex] = original.split(':');
    const key = Buffer.from(token, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    const plain = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8'));
    const corrupted = { ...plain, port: 65535 };
    const iv2 = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv2);
    const encPlain = Buffer.concat([cipher.update(JSON.stringify(corrupted), 'utf8'), cipher.final()]);
    await fs.writeFile(proxyPath, `${iv2.toString('hex')}:${encPlain.toString('hex')}`);

    const { body } = await get(`${BASE_URL}/api/whatsapp`, authHeader(token));
    if (body.reason === 'proxy_unreachable') pass('reason: proxy_unreachable correctly returned');
    else fail(`expected reason 'proxy_unreachable', got: ${JSON.stringify(body)}`);
  } finally {
    await fs.writeFile(proxyPath, original);
  }
}

// Blanks creds.json's registration identity inside .mudslide.enc so the next
// real mudslide/Baileys connection genuinely hits the "not logged in,
// attempting registration" path, then restores the original file — real
// reproduction of the NOT_REGISTERED_MARKER fix, not a mock.
async function chaosNotRegisteredMarker(token, userDir) {
  console.log('\n[chaos] not-registered marker...');
  const { execFileSync } = require('child_process');
  const encPath = path.join(USERS_DIR, userDir, '.mudslide.enc');
  const original = await fs.readFile(encPath);
  const tmp = await fs.mkdtemp(path.join(require('os').tmpdir(), 'e2e-chaos-'));
  try {
    const tarBuffer = decrypt(original, token);
    await fs.writeFile(path.join(tmp, 'bundle.tar.gz'), tarBuffer);
    execFileSync('tar', ['-xzf', 'bundle.tar.gz'], { cwd: tmp });
    const credsPath = path.join(tmp, '.mudslide', 'creds.json');
    const creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
    delete creds.me;
    creds.registered = false;
    await fs.writeFile(credsPath, JSON.stringify(creds));
    execFileSync('tar', ['-czf', 'bundle2.tar.gz', '.mudslide'], { cwd: tmp });
    const newTar = await fs.readFile(path.join(tmp, 'bundle2.tar.gz'));
    await fs.writeFile(encPath, encrypt(newTar, token));

    const { body } = await get(`${BASE_URL}/api/whatsapp`, authHeader(token));
    if (body.reason === 'device_unlinked') pass('reason: device_unlinked correctly returned (via NOT_REGISTERED_MARKER)');
    else fail(`expected reason 'device_unlinked', got: ${JSON.stringify(body)}`);
    console.log('  (.mudslide.enc has now been purged by the server\'s own purgeMudslideCache — re-scan a QR to reconnect for real)');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    // Best-effort restore — if the server already purged .mudslide.enc as part
    // of correctly handling the corrupted marker, there's nothing to restore.
    await fs.writeFile(encPath, original).catch(() => {});
  }
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  rl.close();
  process.exit(1);
});