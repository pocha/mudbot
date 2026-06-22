#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const MAILDEV_URL = 'http://localhost:1080';
const TEST_EMAIL = `test-${crypto.randomBytes(4).toString('hex')}@example.com`;
const USERS_DIR = path.join(__dirname, '..', 'users');
const { getUserDir } = require('../services/userService');

let serverProcess = null;
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
        if (match) return match[1];
      }
    } catch { /* maildev not ready yet */ }
  }
  throw new Error('Token not found in MailDev after 10 seconds');
}

// --- setup / teardown ---

before(async () => {
  // Check if server is already running
  try {
    await fetch(`${BASE_URL}/api/health`);
  } catch {
    // Start it
    serverProcess = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env },
      stdio: 'pipe'
    });
    serverProcess.stderr.on('data', d => process.stderr.write(d));
    await waitForServer(BASE_URL);
  }
});

after(async () => {
  // Clean up test user dir
  try {
    await fs.rm(path.join(USERS_DIR, getUserDir(TEST_EMAIL)), { recursive: true, force: true });
  } catch { /* ignore */ }

  if (serverProcess) {
    serverProcess.kill();
  }
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
  assert.equal(body.user.email, TEST_EMAIL);
});

test('user directory created', async () => {
  const userDir = getUserDir(TEST_EMAIL);
  const stat = await fs.stat(path.join(USERS_DIR, userDir));
  assert.ok(stat.isDirectory());
});

test('generate API key', async () => {
  const { status, body } = await post(`${BASE_URL}/api/apikey/generate`, {}, authHeader(token));
  assert.equal(status, 200);
  assert.match(body.apiKey, /^[a-f0-9]{64}$/);
  apiKey = body.apiKey;
});

test('api_key file exists and is encrypted', async () => {
  const userDir = getUserDir(TEST_EMAIL);
  const content = await fs.readFile(path.join(USERS_DIR, userDir, 'api_key'), 'utf8');
  // Should be iv:ciphertext format, not plaintext
  assert.match(content, /^[a-f0-9]+:[a-f0-9]+$/);
  assert.ok(!content.includes(apiKey));
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
    cronExpression: '0 10 * * *'
  }, authHeader(token));
  assert.equal(status, 200);
  assert.ok(body.schedule.id);
  scheduleId = body.schedule.id;
});

test('schedule.json is encrypted on disk', async () => {
  const userDir = getUserDir(TEST_EMAIL);
  const content = await fs.readFile(
    path.join(USERS_DIR, userDir, 'schedules', scheduleId, 'schedule.json'),
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

test('re-registration returns new token, same user dir', async () => {
  const { status, body: b1 } = await post(`${BASE_URL}/api/register`, { email: TEST_EMAIL });
  assert.equal(status, 200);
  // Extract new token from MailDev
  const newToken = await extractTokenFromMaildev();
  assert.notEqual(newToken, token);

  // Both tokens should resolve to same email and userDir
  const { body: v1 } = await get(`${BASE_URL}/api/verify/${token}`);
  const { body: v2 } = await get(`${BASE_URL}/api/verify/${newToken}`);
  assert.equal(v1.user.email, v2.user.email);
  assert.equal(getUserDir(v1.user.email), getUserDir(v2.user.email));
});
