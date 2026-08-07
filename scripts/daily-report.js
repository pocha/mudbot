#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs').promises;
const path = require('path');
const emailService = require('../services/emailService');

const USERS_DIR = path.join(__dirname, '..', 'users');

// usage.log entries' `ts` is always a cleartext ISO string (UTC), and
// usage-stats.json buckets are keyed the same way (see bumpStatsCache in
// services/mudslideService.js) — so matching on the date prefix keeps both
// sides looking at the same calendar day, no timezone math needed.
function yesterdayUTCKey() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function countInFile(filePath, dayKey) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return data.trim().split('\n').filter(Boolean).filter(line => {
      try { return JSON.parse(line).ts.slice(0, 10) === dayKey; }
      catch { return false; }
    }).length;
  } catch { return 0; }
}

// Writes totalReconciled for dayKey only when it differs from the live count —
// leaves usage-stats.json untouched otherwise, so users who never interact
// don't accumulate a file (or a day entry) for no reason.
async function reconcileStats(userPath, dayKey, reconciledCount) {
  const statsPath = path.join(userPath, 'usage-stats.json');
  let stats = {};
  try { stats = JSON.parse(await fs.readFile(statsPath, 'utf8')); } catch {}

  const existingTotal = stats[dayKey]?.total ?? 0;
  if (reconciledCount === existingTotal) return;

  stats[dayKey] = stats[dayKey] || { total: 0, success: 0, failed: 0 };
  stats[dayKey].totalReconciled = reconciledCount;
  await fs.writeFile(statsPath, JSON.stringify(stats)).catch(() => {});
}

// Recount + reconcile a single user's dayKey from usage.log. Returns null
// (and touches nothing) when the user had no activity that day.
async function processUser(userPath, dayKey) {
  const count = await countInFile(path.join(userPath, 'usage.log'), dayKey);
  if (count === 0) return null;

  await reconcileStats(userPath, dayKey, count);
  return { userDir: path.basename(userPath), total: count };
}

async function main() {
  const dayKey = yesterdayUTCKey();
  const report = [];

  let entries;
  try { entries = await fs.readdir(USERS_DIR); } catch { return; }

  for (const userDir of entries) {
    if (userDir.startsWith('.')) continue;
    const userPath = path.join(USERS_DIR, userDir);
    const stat = await fs.stat(userPath).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const result = await processUser(userPath, dayKey);
    if (result) report.push(result);
  }

  if (report.length === 0) {
    console.log('No activity yesterday — skipping report.');
    return;
  }

  await emailService.sendDailyReport(report);
  console.log(`Daily report sent: ${report.length} active user(s).`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('daily-report error:', err.message);
    process.exit(1);
  });
}

module.exports = { yesterdayUTCKey, countInFile, reconcileStats, processUser };