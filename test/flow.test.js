#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const crypto = require('crypto');

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const MAILDEV_SMTP_PORT = 1025;
const MAILDEV_WEB_PORT = 1080;
const MAILDEV_URL = `http://localhost:${MAILDEV_WEB_PORT}`;
const TEST_EMAIL = `test-${crypto.randomBytes(4).toString('hex')}@example.com`;
const USERS_DIR = path.join(__dirname, '..', 'users');
const { getUserDir } = require('../services/userService');
const usageService = require('../services/usageService');
const dailyReport = require('../scripts/daily-report');
const MailDev = require('maildev');

let serverProcess = null;
let maildevServer = null;
let token = null;
let apiKey = null;
let scheduleId = null;

// --- helpers ---

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json() };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function put(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function del(url, headers = {}) {
  const res = await fetch(url, { method: 'DELETE', headers });
  return { status: res.status, body: await res.json() };
}

function authHeader(t) {
  return { Authorization: `Bearer ${t}` };
}

async function waitForServer(url, retries = 20, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Server did not start in time');
}

async function extractTokenFromMaildev() {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`${MAILDEV_URL}/email`);
      const emails = await res.json();
      const email = emails.find(e => e.to?.[0]?.address === TEST_EMAIL);
      if (email) {
        const match = (email.html || email.text || '').match(/token=([a-f0-9]{64})/);
        if (match) {
          // Delete the email so the next call finds a fresh one
          await fetch(`${MAILDEV_URL}/email/${email.id}`, { method: 'DELETE' });
          return match[1];
        }
      }
    } catch { /* maildev not ready yet */ }
  }
  throw new Error('Token not found in MailDev after 10 seconds');
}

async function killPort(port) {
  return new Promise((resolve, reject) => {
    const lsof = spawn('lsof', ['-ti', `tcp:${port}`]);
    let pids = '';
    lsof.stdout.on('data', d => { pids += d.toString(); });
    lsof.on('close', () => {
      const list = pids.trim().split('\n').filter(Boolean);
      if (!list.length) return resolve(); // nothing on that port
      const kill = spawn('kill', ['-9', ...list]);
      kill.on('close', code => {
        if (code === 0) return resolve();
        reject(new Error(`Port ${port} is occupied and could not be freed. Kill whatever is running on it and run tests again.`));
      });
    });
  });
}

// --- setup / teardown ---

before(async () => {
  // Clear ports — kill anything occupying TEST_PORT or MailDev ports
  await killPort(TEST_PORT);
  await killPort(MAILDEV_SMTP_PORT);
  await killPort(MAILDEV_WEB_PORT);

  // Start fresh MailDev
  maildevServer = new MailDev({ smtp: MAILDEV_SMTP_PORT, web: MAILDEV_WEB_PORT, silent: true });
  await new Promise((resolve, reject) => maildevServer.listen(err => err ? reject(err) : resolve()));

  // Start app server on TEST_PORT
  serverProcess = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      // Explicit, not inherited from .env — this test talks to the server
      // over plain HTTP (see BASE_URL/get()/post() above), so the server
      // must not switch on HTTPS (via mkcert or otherwise) regardless of
      // what BASE_URL happens to be set to outside this test process.
      BASE_URL: `http://localhost:${TEST_PORT}`,
      SMTP_HOST: 'localhost',
      SMTP_PORT: String(MAILDEV_SMTP_PORT),
      SMTP_SECURE: 'false',
      SMTP_USER: '',
      SMTP_PASS: ''
    },
    stdio: 'pipe'
  });
  serverProcess.stderr.on('data', d => process.stderr.write(d));
  await waitForServer(BASE_URL);
});

after(async () => {
  // Clean up test user dir
  try {
    await fs.rm(path.join(USERS_DIR, getUserDir(TEST_EMAIL)), { recursive: true, force: true });
  } catch { /* ignore */ }

  if (serverProcess) serverProcess.kill();
  if (maildevServer) await new Promise(resolve => maildevServer.close(resolve));
});

// --- tests ---

test('health check', async () => {
  const { status, body } = await get(`${BASE_URL}/api/health`);
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('register user', async () => {
  const { status, body } = await post(`${BASE_URL}/api/register`, { email: TEST_EMAIL });
  assert.equal(status, 200);
  assert.equal(body.success, true);
});

test('extract token from MailDev', async () => {
  token = await extractTokenFromMaildev();
  assert.match(token, /^[a-f0-9]{64}$/);
});

test('verify token', async () => {
  const { status, body } = await get(`${BASE_URL}/api/verify/${token}`);
  assert.equal(status, 200);
  assert.equal(body.success, true);
});

test('GET /api/countries returns the static country list', async () => {
  const { status, body } = await get(`${BASE_URL}/api/countries`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 100);
  const india = body.find(c => c.code === 'in');
  assert.deepEqual(india, { code: 'in', name: 'India' });
});

test('POST /api/user/location requires both country and city', async () => {
  const { status, body } = await post(`${BASE_URL}/api/user/location`, {}, authHeader(token));
  assert.equal(status, 400);
  assert.equal(body.valid, false);
  assert.equal(body.reason, 'missing_fields');
});

test('POST /api/user/location rejects an invalid country code', async () => {
  const { status, body } = await post(
    `${BASE_URL}/api/user/location`,
    { country: 'zz', city: 'Nowhereville' },
    authHeader(token)
  );
  assert.equal(status, 400);
  assert.equal(body.valid, false);
  assert.equal(body.reason, 'invalid_country');
});

// City validation (Nominatim) now happens client-side in verify.html —
// this route trusts whatever city string it's given as long as the
// country code is valid, since it never makes an external call itself.
test('POST /api/user/location accepts and persists any city for a valid country', async () => {
  const { status, body } = await post(
    `${BASE_URL}/api/user/location`,
    { country: 'in', city: 'Zzzznotarealcityxyz123' },
    authHeader(token)
  );
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.city, 'Zzzznotarealcityxyz123');
});

test('POST /api/user/location accepts and persists a valid manual override', async () => {
  const { status, body } = await post(
    `${BASE_URL}/api/user/location`,
    { country: 'in', city: 'Bengaluru' },
    authHeader(token)
  );
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.country, 'in');
  assert.equal(body.countryName, 'India');
  assert.equal(body.city, 'Bengaluru');

  const userDir = getUserDir(TEST_EMAIL);
  const raw = await fs.readFile(path.join(USERS_DIR, userDir, 'proxy.json'), 'utf8');
  assert.match(raw, /^[a-f0-9]+:[a-f0-9]+$/); // encrypted on disk
});

test('POST /api/user/notify-email rejects an invalid email', async () => {
  const { status, body } = await post(
    `${BASE_URL}/api/user/notify-email`,
    { email: 'not-an-email' },
    authHeader(token)
  );
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('POST /api/user/notify-email saves, encrypts on disk, and GET returns it back', async () => {
  const { status, body } = await post(
    `${BASE_URL}/api/user/notify-email`,
    { email: 'alerts@example.com' },
    authHeader(token)
  );
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.email, 'alerts@example.com');

  const userDir = getUserDir(TEST_EMAIL);
  const raw = await fs.readFile(path.join(USERS_DIR, userDir, 'notify_email.enc'), 'utf8');
  assert.match(raw, /^[a-f0-9]+:[a-f0-9]+$/); // encrypted on disk
  assert.ok(!raw.includes('alerts@example.com'));

  const getRes = await get(`${BASE_URL}/api/user/notify-email`, authHeader(token));
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.email, 'alerts@example.com');
});

test('user directory and token_hash created', async () => {
  const userDir = getUserDir(TEST_EMAIL);
  const stat = await fs.stat(path.join(USERS_DIR, userDir));
  assert.ok(stat.isDirectory());

  // token_hash file must exist (used for auth verification)
  const hashContent = await fs.readFile(path.join(USERS_DIR, userDir, 'token_hash'), 'utf8');
  assert.match(hashContent.trim(), /^[a-f0-9]{64}$/);

  // token embeds userDir as first 10 chars
  assert.equal(token.slice(0, 10), userDir);

  // tokens.json must NOT exist
  await assert.rejects(fs.access(path.join(__dirname, '..', 'tokens.json')));
});

test('generate API key', async () => {
  const { status, body } = await post(`${BASE_URL}/api/apikey/generate`, {}, authHeader(token));
  assert.equal(status, 200);
  assert.match(body.apiKey, /^[a-f0-9]{64}$/);
  apiKey = body.apiKey;
});

test('api_key_hash and api_key_token files exist', async () => {
  const userDir = getUserDir(TEST_EMAIL);

  // api_key_hash: sha256(apiKey) — 64 hex chars
  const hashContent = await fs.readFile(path.join(USERS_DIR, userDir, 'api_key_hash'), 'utf8');
  assert.match(hashContent.trim(), /^[a-f0-9]{64}$/);

  // token_enc_with_api_key: session token encrypted with apiKey — iv:ciphertext format
  const tokenContent = await fs.readFile(path.join(USERS_DIR, userDir, 'token_enc_with_api_key'), 'utf8');
  assert.match(tokenContent.trim(), /^[a-f0-9]+:[a-f0-9]+$/);

  // apiKey embeds same userDir as first 10 chars
  assert.equal(apiKey.slice(0, 10), userDir);
});

test('authenticate with API key', async () => {
  const { status, body } = await get(`${BASE_URL}/api/schedules`, { 'x-api-key': apiKey });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.schedules));
});

test('create schedule', async () => {
  const { status, body } = await post(`${BASE_URL}/api/schedules`, {
    name: 'Test Schedule',
    recipients: ['+1234567890'],
    message: 'Hello from test',
    timezone: 'Asia/Kolkata',
    localTime: '10:00',
    localDate: null,
    frequency: 'Daily'
  }, authHeader(token));
  assert.equal(status, 200);
  assert.ok(body.schedule.id);
  assert.equal(body.schedule.timezone, 'Asia/Kolkata');
  assert.equal(body.schedule.localTime, '10:00');
  assert.equal(body.schedule.frequency, 'Daily');
  // 10:00 IST (UTC+5:30) = 04:30 UTC → cron: "30 4 * * *"
  assert.equal(body.schedule.cronExpression, '30 4 * * *');
  scheduleId = body.schedule.id;
});

test('schedules.json is encrypted on disk', async () => {
  const userDir = getUserDir(TEST_EMAIL);
  const content = await fs.readFile(
    path.join(USERS_DIR, userDir, 'schedules.json'),
    'utf8'
  );
  assert.match(content, /^[a-f0-9]+:[a-f0-9]+$/);
  assert.ok(!content.includes('Test Schedule'));
});

test('get schedule', async () => {
  const { status, body } = await get(`${BASE_URL}/api/schedules/${scheduleId}`, authHeader(token));
  assert.equal(status, 200);
  assert.equal(body.schedule.name, 'Test Schedule');
});

test('list schedules', async () => {
  const { status, body } = await get(`${BASE_URL}/api/schedules`, authHeader(token));
  assert.equal(status, 200);
  assert.equal(body.schedules.length, 1);
});

test('update schedule', async () => {
  const { status, body } = await put(
    `${BASE_URL}/api/schedules/${scheduleId}`,
    { name: 'Updated Schedule', enabled: false },
    authHeader(token)
  );
  assert.equal(status, 200);
  assert.equal(body.schedule.name, 'Updated Schedule');
  assert.equal(body.schedule.enabled, false);
});

test('delete schedule', async () => {
  const { status, body } = await del(`${BASE_URL}/api/schedules/${scheduleId}`, authHeader(token));
  assert.equal(status, 200);
  assert.equal(body.success, true);
});

test('schedule removed from storage', async () => {
  const { status, body } = await get(`${BASE_URL}/api/schedules`, authHeader(token));
  assert.equal(status, 200);
  assert.equal(body.schedules.length, 0);
});

// --- usage stats (all file-based; no mudslide/WhatsApp calls involved) ---

test('getMessageStats aggregates today/yesterday and surfaces reconciliation drift', async () => {
  const userDir = getUserDir(TEST_EMAIL);
  const statsPath = path.join(USERS_DIR, userDir, 'usage-stats.json');
  const todayKey = new Date().toISOString().slice(0, 10);

  await fs.writeFile(statsPath, JSON.stringify({
    [todayKey]: { total: 5, success: 4, failed: 1 }
  }));

  let stats = await usageService.getMessageStats(userDir, 'UTC');
  assert.deepEqual(stats.day.current, { total: 5, success: 4, failed: 1, reconciledTotal: 5 });
  assert.equal(stats.day.previous.total, 0);
  assert.equal(stats.total.total, 5);
  assert.equal(stats.total.reconciledTotal, 5);

  // Simulate a nightly reconciliation correction (live counter under-counted)
  await fs.writeFile(statsPath, JSON.stringify({
    [todayKey]: { total: 5, success: 4, failed: 1, totalReconciled: 8 }
  }));
  stats = await usageService.getMessageStats(userDir, 'UTC');
  assert.equal(stats.day.current.total, 5); // live count unchanged
  assert.equal(stats.day.current.reconciledTotal, 8); // corrected value surfaces separately
  assert.equal(stats.total.reconciledTotal, 8);

  await fs.rm(statsPath, { force: true });
});

test('daily-report processUser reconciles drift and skips zero-activity days entirely', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watobot-daily-report-'));
  const dayKey = '2026-08-06';

  // No usage.log at all — must skip entirely, no usage-stats.json created
  const skipped = await dailyReport.processUser(tmpDir, dayKey);
  assert.equal(skipped, null);
  await assert.rejects(fs.access(path.join(tmpDir, 'usage-stats.json')));

  // Live cache under-counted (2) vs actual log (3) — should self-heal via totalReconciled
  await fs.writeFile(path.join(tmpDir, 'usage.log'), [
    { ts: `${dayKey}T09:00:00.000Z`, action: 'sendMessage' },
    { ts: `${dayKey}T10:00:00.000Z`, action: 'getGroups' },
    { ts: `${dayKey}T11:00:00.000Z`, action: 'logout' }
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  await fs.writeFile(path.join(tmpDir, 'usage-stats.json'), JSON.stringify({
    [dayKey]: { total: 2, success: 2, failed: 0 }
  }));

  const result = await dailyReport.processUser(tmpDir, dayKey);
  assert.deepEqual(result, { userDir: path.basename(tmpDir), total: 3 });

  let stats = JSON.parse(await fs.readFile(path.join(tmpDir, 'usage-stats.json'), 'utf8'));
  assert.equal(stats[dayKey].totalReconciled, 3);

  // Running again once the live count matches must be a no-op — no stale totalReconciled written
  await fs.writeFile(path.join(tmpDir, 'usage-stats.json'), JSON.stringify({
    [dayKey]: { total: 3, success: 2, failed: 1 }
  }));
  await dailyReport.processUser(tmpDir, dayKey);
  stats = JSON.parse(await fs.readFile(path.join(tmpDir, 'usage-stats.json'), 'utf8'));
  assert.equal(stats[dayKey].totalReconciled, undefined);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('re-registration invalidates old token and issues new one for same userDir', async () => {
  const { status } = await post(`${BASE_URL}/api/register`, { email: TEST_EMAIL });
  assert.equal(status, 200);

  const newToken = await extractTokenFromMaildev();
  assert.notEqual(newToken, token);

  // New token maps to same userDir (first 10 chars of sha256(email))
  assert.equal(newToken.slice(0, 10), getUserDir(TEST_EMAIL));

  // Old token must now be invalid (token_hash was overwritten)
  const { status: oldStatus } = await get(`${BASE_URL}/api/verify/${token}`);
  assert.equal(oldStatus, 401);

  // New token is valid
  const { status: newStatus, body } = await get(`${BASE_URL}/api/verify/${newToken}`);
  assert.equal(newStatus, 200);
  assert.equal(body.success, true);
});
