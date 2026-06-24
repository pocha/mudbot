#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { encryptData, decryptData } = require('../services/userService');

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

async function decryptMudslideToTemp(userDir, token) {
  const encFile = path.join(USERS_DIR, userDir, '.mudslide.enc');
  const tmp = path.join('/tmp', `mudbot-${userDir}`);

  const data = await fs.readFile(encFile);
  const iv = data.slice(0, 16);
  const encrypted = data.slice(16);
  const key = crypto.createHash('sha256').update(token).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const tarBuffer = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  await fs.mkdir(tmp, { recursive: true });

  await new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', '-', '-C', tmp]);
    proc.stdin.write(tarBuffer);
    proc.stdin.end();
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed with code ${code}`));
    });
  });

  return path.join(tmp, '.mudslide');
}

async function cleanupTemp(userDir) {
  await fs.rm(path.join('/tmp', `mudbot-${userDir}`), { recursive: true, force: true });
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

async function appendLog(schDir, line) {
  await fs.appendFile(
    path.join(schDir, 'logs.txt'),
    `[${new Date().toISOString()}] ${line}\n`
  );
}

async function main() {
  const schDir = path.join(USERS_DIR, userDir, 'schedules', scheduleId);

  // Read token_hash from disk — used to decrypt the cron payload
  const tokenHash = (await fs.readFile(path.join(USERS_DIR, userDir, 'token_hash'), 'utf8')).trim();

  // Decrypt payload to recover the session token and schedule data
  const { token, recipients, message, media } = decryptPayload(encryptedPayload, tokenHash);

  // Decrypt .mudslide.enc to a temp directory
  const credPath = await decryptMudslideToTemp(userDir, token);

  await appendLog(schDir, `INFO: Starting execution for schedule ${scheduleId}`);

  let success = 0;
  let failure = 0;

  try {
    for (const recipient of recipients) {
      await appendLog(schDir, `INFO: Sending to ${recipient}`);
      try {
        let args;
        if (media) {
          const ext = media.split('.').pop().toLowerCase();
          const cmd = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? 'send-image' : 'send-file';
          args = ['-c', credPath, cmd, recipient, media];
          if (message) args.push('--caption', message);
        } else {
          args = ['-c', credPath, 'send', recipient, message];
        }
        await runMudslide(args);
        await appendLog(schDir, `SUCCESS: Sent to ${recipient}`);
        success++;
      } catch (err) {
        await appendLog(schDir, `ERROR: Failed to send to ${recipient} - ${err.message}`);
        failure++;
      }
    }
  } finally {
    await cleanupTemp(userDir);
  }

  // Update lastRun in the encrypted schedule file
  const scheduleFile = path.join(schDir, 'schedule.json');
  const raw = await fs.readFile(scheduleFile, 'utf8');
  const schedule = JSON.parse(decryptData(raw, token));
  schedule.lastRun = new Date().toISOString();
  await fs.writeFile(scheduleFile, encryptData(JSON.stringify(schedule), token));

  await appendLog(schDir, `INFO: Done - Success: ${success}, Failed: ${failure}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
