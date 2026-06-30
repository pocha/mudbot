#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const USERS_DIR = path.join(__dirname, '..', 'users');
const PORT = process.env.PORT || 3000;

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

async function main() {
  const tokenHash = (await fs.readFile(path.join(USERS_DIR, userDir, 'token_hash'), 'utf8')).trim();
  const { token, recipients, message, media } = decryptPayload(encryptedPayload, tokenHash);

  for (const recipient of recipients) {
    try {
      const body = { to: recipient, message };
      if (media) body.media = media;
      const res = await fetch(`http://localhost:${PORT}/api/message`, {
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
