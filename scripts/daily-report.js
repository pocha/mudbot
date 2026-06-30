#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs').promises;
const path = require('path');
const emailService = require('../services/emailService');

const USERS_DIR = path.join(__dirname, '..', 'users');

function yesterdayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  return { start, end };
}

async function countInFile(filePath, start, end) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return data.trim().split('\n').filter(Boolean).filter(line => {
      try { const { ts } = JSON.parse(line); return ts >= start && ts < end; }
      catch { return false; }
    }).length;
  } catch { return 0; }
}

async function main() {
  const { start, end } = yesterdayRange();
  const report = [];

  let entries;
  try { entries = await fs.readdir(USERS_DIR); } catch { return; }

  for (const userDir of entries) {
    if (userDir.startsWith('.')) continue;
    const userPath = path.join(USERS_DIR, userDir);
    const stat = await fs.stat(userPath).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const apiCount = await countInFile(path.join(userPath, 'usage.log'), start, end);

    let schedCount = 0;
    try {
      const schedIds = await fs.readdir(path.join(userPath, 'schedules'));
      for (const id of schedIds) {
        schedCount += await countInFile(path.join(userPath, 'schedules', id, 'logs.txt'), start, end);
      }
    } catch {}

    const total = apiCount + schedCount;
    if (total > 0) report.push({ userDir, apiCount, schedCount, total });
  }

  if (report.length === 0) {
    console.log('No activity yesterday — skipping report.');
    return;
  }

  await emailService.sendDailyReport(report);
  console.log(`Daily report sent: ${report.length} active user(s).`);
}

main().catch(err => {
  console.error('daily-report error:', err.message);
  process.exit(1);
});
