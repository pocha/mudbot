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

// --- setup / teardown ---

before(async () => {
  // Always start a fresh server with MailDev SMTP so registration emails are captured
  serverProcess = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
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
  assert.equal(body.success, true);
  assert.equal(typeof body.user.whatsappConnected, 'boolean');
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

  // api_key_token: session token encrypted with apiKey — iv:ciphertext format
  const tokenContent = await fs.readFile(path.join(USERS_DIR, userDir, 'api_key_token'), 'utf8');
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
