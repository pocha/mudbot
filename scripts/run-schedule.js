#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { encryptData, decryptData, getUserDir } = require('../services/userService');

const USERS_DIR = path.join(__dirname, '..', 'users');
const TOKENS_FILE = path.join(__dirname, '..', 'tokens.json');
const SERVER_SECRET = process.env.SERVER_SECRET;

const [userDir, scheduleId] = process.argv.slice(2);

if (!userDir || !scheduleId) {
  console.error('Usage: run-schedule.js <userDir> <scheduleId>');
  process.exit(1);
}

const crypto = require('crypto');

function decryptWithSecret(ciphertext) {
  const [ivHex, encHex] = ciphertext.split(':');
  const key = crypto.scryptSync(SERVER_SECRET, 'tokensalt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

async function findEmailForDir(userDir) {
  const raw = await fs.readFile(TOKENS_FILE, 'utf8');
  const tokens = JSON.parse(decryptWithSecret(raw.trim()));
  for (const encryptedEmail of Object.values(tokens)) {
    try {
      const email = decryptWithSecret(encryptedEmail);
      if (getUserDir(email) === userDir) return email;
    } catch { /* skip */ }
  }
  return null;
}

function runMudslide(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('mudslide', args);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 30000);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(out.trim() || `exit code ${code}`));
    });
  });
}

async function appendLog(scheduleDir, line) {
  await fs.appendFile(
    path.join(scheduleDir, 'logs.txt'),
    `[${new Date().toISOString()}] ${line}\n`
  );
}

async function main() {
  const scheduleDir = path.join(USERS_DIR, userDir, 'schedules', scheduleId);
  const scheduleFile = path.join(scheduleDir, 'schedule.json');
  const credentialsPath = path.join(USERS_DIR, userDir, '.mudslide');

  const email = await findEmailForDir(userDir);
  if (!email) {
    console.error(`No user found for dir: ${userDir}`);
    process.exit(1);
  }

  const raw = await fs.readFile(scheduleFile, 'utf8');
  const schedule = JSON.parse(decryptData(raw, email));

  if (!schedule.enabled) {
    await appendLog(scheduleDir, 'INFO: Schedule disabled, skipping');
    return;
  }

  await appendLog(scheduleDir, `INFO: Starting execution for schedule ${scheduleId}`);

  let success = 0;
  let failure = 0;

  for (const recipient of schedule.recipients) {
    await appendLog(scheduleDir, `INFO: Sending to ${recipient}`);
    try {
      let args;
      if (schedule.media) {
        const ext = schedule.media.split('.').pop().toLowerCase();
        const cmd = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? 'send-image' : 'send-file';
        args = ['-c', credentialsPath, cmd, recipient, schedule.media];
        if (schedule.message) args.push('--caption', schedule.message);
      } else {
        args = ['-c', credentialsPath, 'send', recipient, schedule.message];
      }
      await runMudslide(args);
      await appendLog(scheduleDir, `SUCCESS: Sent to ${recipient}`);
      success++;
    } catch (err) {
      await appendLog(scheduleDir, `ERROR: Failed to send to ${recipient} - ${err.message}`);
      failure++;
    }
  }

  // Update lastRun (re-encrypt)
  schedule.lastRun = new Date().toISOString();
  await fs.writeFile(scheduleFile, encryptData(JSON.stringify(schedule), email));

  await appendLog(scheduleDir, `INFO: Done - Success: ${success}, Failed: ${failure}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
