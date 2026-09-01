#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const USERS_DIR = path.join(__dirname, '..', 'users');

const [userDir, scheduleId, encryptedPayload] = process.argv.slice(2);

if (!userDir || !scheduleId || !encryptedPayload) {
  console.error('Usage: run-schedule.js <userDir> <scheduleId> <encryptedPayload>');
  process.exit(1);
}

function decryptPayload(payload, tokenHashHex) {
  const data = Buffer.from(payload, 'base64url');
  const iv = data.slice(0, 16);
  const encrypted = data.slice(16);
  const key = Buffer.from(tokenHashHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// Reads/writes a plain (unencrypted) per-user timestamp file — this is just
// alert-frequency bookkeeping, not sensitive, so it doesn't need to go
// through the token-keyed encryption helpers the way real user data does.
const ALERT_BACKOFF_MS = 24 * 60 * 60 * 1000;
async function shouldAlert(userDir) {
  const markerPath = path.join(USERS_DIR, userDir, 'device_check_last_alert');
  try {
    const last = new Date((await fs.readFile(markerPath, 'utf8')).trim());
    if (Date.now() - last.getTime() < ALERT_BACKOFF_MS) return false;
  } catch {}
  await fs.writeFile(markerPath, new Date().toISOString());
  return true;
}

async function checkConnection(token) {
  let connected = false;
  let checkError = null;
  try {
    const res = await fetch(`${process.env.BASE_URL || 'http://localhost'}:${process.env.PORT || 80}/api/whatsapp`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) checkError = body.error || `HTTP ${res.status}`;
    else {
      connected = !!body.connected;
      if (!connected) checkError = 'WhatsApp device is not connected';
    }
  } catch (err) {
    checkError = err.message;
  }

  if (connected) return;
  if (!(await shouldAlert(userDir))) return;

  const userService = require('../services/userService');
  const emailService = require('../services/emailService');
  const userEmail = await userService.getNotifyEmail(userDir, token).catch(() => null);
  await emailService.notifyDeviceDisconnected(userDir, checkError, userEmail).catch(() => {});
}

async function main() {
  const tokenHash = (await fs.readFile(path.join(USERS_DIR, userDir, 'token_hash'), 'utf8')).trim();
  const { type = 'send', token, recipients, message, media } = decryptPayload(encryptedPayload, tokenHash);

  if (type === 'check-connection') {
    await checkConnection(token);
    return;
  }

  for (const recipient of recipients) {
    try {
      const body = { to: recipient, message };
      if (media) body.media = media;
      const res = await fetch(`${process.env.BASE_URL || 'http://localhost'}:${process.env.PORT || 80}/api/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(`Failed to send to ${recipient}: ${err.error || res.status}`);
      }
    } catch (err) {
      console.error(`Error sending to ${recipient}: ${err.message}`);
    }
  }

  // Update lastRun in schedules.json
  try {
    const { updateLastRun } = require('../services/scheduleService');
    await updateLastRun(userDir, token, scheduleId);
  } catch {}
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
