const path = require('path');
const fs = require('fs').promises;
const { encryptData, decryptData } = require('./userService');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

function usageLogPath(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, 'usage.log');
}

function usageStatsPath(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, 'usage-stats.json');
}

// Bumps today's UTC bucket for every WhatsApp interaction (messages, group
// fetches, logout, etc — anything appendUsageLog is called for). Read-modify-write
// is safe without extra locking because all appendUsageLog calls for a given
// user already run sequentially through mudslideService's per-user queue.
async function bumpStatsCache(userDir, action, success) {
  const statsPath = usageStatsPath(userDir);
  let stats = {};
  try {
    stats = JSON.parse(await fs.readFile(statsPath, 'utf8'));
  } catch {}

  const day = new Date().toISOString().slice(0, 10);
  const bucket = stats[day] || { total: 0, success: 0, failed: 0 };
  bucket.total++;
  bucket[success ? 'success' : 'failed']++;
  stats[day] = bucket;

  await fs.writeFile(statsPath, JSON.stringify(stats)).catch(() => {});
}

async function appendUsageLog(userDir, action, success, error = null, meta = {}, token = null) {
  const payload = { action, success, ...meta };
  if (error) payload.error = error;
  const ts = new Date().toISOString();
  const entry = token
    ? { ts, enc: encryptData(JSON.stringify(payload), token) }
    : { ts, ...payload };
  await fs.appendFile(usageLogPath(userDir), JSON.stringify(entry) + '\n').catch(() => {});
  await bumpStatsCache(userDir, action, success);
}

async function getUsageLogs(userDir, limit = 50, token = null) {
  try {
    const data = await fs.readFile(usageLogPath(userDir), 'utf8');
    const all = data.trim().split('\n').filter(Boolean).reduce((acc, line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.enc && token) {
          const decrypted = JSON.parse(decryptData(parsed.enc, token));
          acc.push({ ts: parsed.ts, ...decrypted });
        } else {
          acc.push(parsed);
        }
      } catch {}
      return acc;
    }, []);
    return { count: all.length, logs: all.slice(-limit) };
  } catch {
    return { count: 0, logs: [] };
  }
}

function emptyBucket() {
  return { total: 0, success: 0, failed: 0, reconciledTotal: 0 };
}

// reconciledTotal sums each day's totalReconciled (written nightly by
// scripts/daily-report.js from a token-less recount of usage.log, only when it
// differs from the live total) where present, falling back to the live total
// for days that weren't flagged. Differing from `total` signals the live
// per-request counter drifted for at least one day in this period.
function addBucket(target, src) {
  target.total += src.total;
  target.success += src.success;
  target.failed += src.failed;
  target.reconciledTotal += (src.totalReconciled ?? src.total);
}

function localDateStr(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Buckets are keyed by UTC calendar day; approximate their local-timezone day
// by re-formatting midday UTC of that key in the requested tz. This can
// misattribute activity near a day boundary by up to one bucket for users far
// from UTC — acceptable for a summary stat, not exact accounting.
function bucketKeyToLocalDateStr(key, tz) {
  return localDateStr(new Date(`${key}T12:00:00Z`), tz);
}

// Returns null when the user has no usage-stats.json at all (never interacted) —
// callers use this to distinguish "no data yet" from "data exists, all zero".
async function getMessageStats(userDir, tz) {
  let stats;
  try {
    stats = JSON.parse(await fs.readFile(usageStatsPath(userDir), 'utf8'));
  } catch {
    return null;
  }

  const zone = tz || 'UTC';
  const now = new Date();
  const todayStr = localDateStr(now, zone);
  const yesterdayStr = addDays(todayStr, -1);

  const dow = (new Date(`${todayStr}T00:00:00Z`).getUTCDay() + 6) % 7; // days since Monday
  const weekStart = addDays(todayStr, -dow);
  const lastWeekEnd = addDays(weekStart, -1);
  const lastWeekStart = addDays(lastWeekEnd, -6);

  const thisMonth = todayStr.slice(0, 7);
  const [y, m] = thisMonth.split('-').map(Number);
  const lastMonthDate = new Date(Date.UTC(y, m - 2, 1));
  const lastMonth = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;

  const result = {
    total: emptyBucket(),
    day: { current: emptyBucket(), previous: emptyBucket() },
    week: { current: emptyBucket(), previous: emptyBucket() },
    month: { current: emptyBucket(), previous: emptyBucket() }
  };

  for (const [key, bucket] of Object.entries(stats)) {
    addBucket(result.total, bucket);

    const localKey = bucketKeyToLocalDateStr(key, zone);
    if (localKey === todayStr) addBucket(result.day.current, bucket);
    if (localKey === yesterdayStr) addBucket(result.day.previous, bucket);
    if (localKey >= weekStart && localKey <= todayStr) addBucket(result.week.current, bucket);
    if (localKey >= lastWeekStart && localKey <= lastWeekEnd) addBucket(result.week.previous, bucket);
    if (localKey.slice(0, 7) === thisMonth) addBucket(result.month.current, bucket);
    if (localKey.slice(0, 7) === lastMonth) addBucket(result.month.previous, bucket);
  }

  return result;
}

module.exports = {
  appendUsageLog,
  getUsageLogs,
  getMessageStats
};