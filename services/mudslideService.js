const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { proxyConfPath, encryptData, decryptData } = require('./userService');
const proxyRelayManager = require('./proxyRelayManager');

const CONFIG = {
  MUDSLIDE_PATH: process.env.MUDSLIDE_PATH || 'mudslide',
  PROXYCHAINS_PATH: process.env.PROXYCHAINS_PATH || '',
  USERS_DIR: path.join(__dirname, '..', 'users')
};

// Holds the active mudslide login process so the keypress can be sent after QR scan.
let loginProc = null;

// Per-user operation queue — ensures only one mudslide command runs at a time per user.
const userQueue = {};
const userQueueDepth = {};

function mudslideEncFile(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, '.mudslide.enc');
}

function mudslideDir(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
}

function tempDir(userDir) {
  return path.join('/tmp', `mudbot-${userDir}`);
}

async function isLoggedIn(userDir) {
  try { await fs.access(mudslideEncFile(userDir)); return true; } catch { return false; }
}

// Tar .mudslide, AES-256 encrypt with sha256(token), write .mudslide.enc.
// fromDir: directory containing .mudslide to tar.
//   - omit after QR scan → tars from users/<userDir>/, deletes the plaintext dir
//   - pass tempDir(userDir) after send/groups → tars from /tmp, cleanupTemp handles deletion
async function encryptMudslideCache(userDir, token, fromDir = null) {
  const cwd = fromDir || path.join(CONFIG.USERS_DIR, userDir);
  const key = crypto.createHash('sha256').update(token).digest();

  const tarBuffer = await new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-czf', '-', '.mudslide'], { cwd });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar failed with code ${code}`));
    });
  });

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(tarBuffer), cipher.final()]);
  await fs.writeFile(mudslideEncFile(userDir), Buffer.concat([iv, encrypted]));

  if (!fromDir) {
    await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
  }
}

// Decrypt .mudslide.enc → /tmp/mudbot-<userDir>/.mudslide, return that path.
// If the temp dir already exists (previous op in same queue batch), reuse it.
async function decryptMudslideToTemp(userDir, token) {
  const tmp = tempDir(userDir);
  const credPath = path.join(tmp, '.mudslide');
  try {
    await fs.access(credPath);
    return credPath;  // already decrypted by an earlier op in this batch
  } catch {}

  const data = await fs.readFile(mudslideEncFile(userDir));
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

  return credPath;
}

async function cleanupTemp(userDir) {
  await fs.rm(tempDir(userDir), { recursive: true, force: true });
}

// Queues fn(credPath) for the user — operations are strictly sequential per user,
// ensuring WhatsApp sees one message at a time. Decrypts once on first op in a
// batch, reuses the temp dir for subsequent ops, then encrypts and cleans up only
// after the last queued op completes.
function withSession(userDir, token, fn, action = 'unknown', meta = {}) {
  userQueueDepth[userDir] = (userQueueDepth[userDir] || 0) + 1;

  const run = async () => {
    let credPath = null;
    let succeeded = false;
    let errMsg = null;
    try {
      await proxyRelayManager.acquireRelay(userDir, token);
      credPath = await decryptMudslideToTemp(userDir, token);
      const result = await fn(credPath);
      succeeded = true;
      return result;
    } catch (err) {
      errMsg = err.message;
      throw err;
    } finally {
      await appendUsageLog(userDir, action, succeeded, errMsg, meta, token);
      userQueueDepth[userDir]--;
      if (userQueueDepth[userDir] === 0) {
        if (credPath) {
          try { await encryptMudslideCache(userDir, token, tempDir(userDir)); }
          finally { await cleanupTemp(userDir); }
        } else {
          await cleanupTemp(userDir);
        }
      }
      await proxyRelayManager.releaseRelay(userDir);
    }
  };
  const prev = userQueue[userDir] || Promise.resolve();
  const next = prev.then(run, run);          // run even if previous op failed
  userQueue[userDir] = next.catch(() => {});  // don't let errors block the queue
  return next;
}

const MESSAGE_ACTIONS = new Set(['sendMessage', 'sendMedia']);

function usageStatsPath(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, 'usage-stats.json');
}

// Bumps today's UTC bucket for message-send actions. Read-modify-write is safe
// without extra locking because all appendUsageLog calls for a given user
// already run sequentially through withSession's per-user queue.
async function bumpStatsCache(userDir, action, success) {
  if (!MESSAGE_ACTIONS.has(action)) return;

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
  await fs.appendFile(
    path.join(CONFIG.USERS_DIR, userDir, 'usage.log'),
    JSON.stringify(entry) + '\n'
  ).catch(() => {});
  await bumpStatsCache(userDir, action, success);
}

async function getUsageLogs(userDir, limit = 50, token = null) {
  try {
    const data = await fs.readFile(path.join(CONFIG.USERS_DIR, userDir, 'usage.log'), 'utf8');
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
  return { total: 0, success: 0, failed: 0 };
}

function addBucket(target, src) {
  target.total += src.total;
  target.success += src.success;
  target.failed += src.failed;
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

async function getMessageStats(userDir, tz) {
  let stats = {};
  try {
    stats = JSON.parse(await fs.readFile(usageStatsPath(userDir), 'utf8'));
  } catch {}

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

const stripProxy = s => s.split('\n').filter(l => !l.trim().startsWith('[proxychains]')).join('\n').trim();

async function getProxiedIpInfo(userDir, token) {
  const confPath = await proxyConfPath(userDir, token).catch(() => null);
  if (!confPath || !CONFIG.PROXYCHAINS_PATH) return null;

  await proxyRelayManager.acquireRelay(userDir, token);
  try {
    return await new Promise(resolve => {
      const proc = spawn(CONFIG.PROXYCHAINS_PATH, [
        '-f', confPath, 'curl', '-s', '--max-time', '10',
        'http://ip-api.com/json/?fields=query,city,country,countryCode'
      ]);
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => {
        try {
          const { query: ip, city, country, countryCode } = JSON.parse(out);
          resolve({ ip, city, country, countryCode });
        } catch { resolve(null); }
      });
      setTimeout(() => { proc.kill(); resolve(null); }, 15000);
    });
  } finally {
    await proxyRelayManager.releaseRelay(userDir);
  }
}

async function runMudslide(args, timeoutMs, userDir, token) {
  const confPath = (userDir && token) ? await proxyConfPath(userDir, token) : null;
  const useProxy = confPath && CONFIG.PROXYCHAINS_PATH;
  const bin  = useProxy ? CONFIG.PROXYCHAINS_PATH : CONFIG.MUDSLIDE_PATH;
  const argv = useProxy ? ['-f', confPath, CONFIG.MUDSLIDE_PATH, ...args] : args;

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('mudslide timeout'));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stripProxy(stdout));
      else reject(new Error(stripProxy(stderr) || `mudslide exited with code ${code}`));
    });
  });
}

async function getQRCode(userDir, token) {
  if (loginProc && !loginProc.killed) {
    loginProc.kill();
    loginProc = null;
  }

  await purgeMudslideCache(userDir);

  const confPath = token ? await proxyConfPath(userDir, token) : null;
  const useProxy = confPath && CONFIG.PROXYCHAINS_PATH;
  const bin  = useProxy ? CONFIG.PROXYCHAINS_PATH : CONFIG.MUDSLIDE_PATH;
  const argv = useProxy
    ? ['-f', confPath, CONFIG.MUDSLIDE_PATH, '-c', mudslideDir(userDir), 'login']
    : ['-c', mudslideDir(userDir), 'login'];

  if (useProxy) await proxyRelayManager.acquireRelay(userDir, token);
  let relayReleased = !useProxy;
  const releaseRelayOnce = () => {
    if (relayReleased) return;
    relayReleased = true;
    proxyRelayManager.releaseRelay(userDir).catch(() => {});
  };

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv);
    loginProc = proc;
    let output = '';
    let idleTimer = null;
    let resolved = false;
    let keypressSent = false;

    const onStdout = (data) => {
      output += data.toString();
      if (idleTimer) clearTimeout(idleTimer);
      const meaningful = output.split('\n')
        .filter(l => !l.trim().startsWith('Created mudslide cache folder'))
        .filter(l => !l.trim().startsWith('[proxychains]'))
        .join('\n').trim();
      if (meaningful && !resolved) {
        idleTimer = setTimeout(() => {
          resolved = true;
          resolve({ success: true, qr: stripProxy(output) });
        }, 2000);
      }
    };

    const onStderr = (data) => {
      const text = data.toString();
      // mudslide prints "press any key to exit" on stderr after QR scan.
      // stdin is a pipe (not a TTY) so it would hang — send keypress automatically.
      if (text.includes('press any key') && !keypressSent) {
        keypressSent = true;
        proc.stdin.write('\n');
      }
    };

    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);

    proc.on('close', () => {
      loginProc = null;
      releaseRelayOnce();
      if (idleTimer) clearTimeout(idleTimer);
      if (!resolved) {
        if (output.trim()) resolve({ success: true, qr: stripProxy(output) });
        else reject(new Error('No output from mudslide login'));
      }
    });

    setTimeout(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!resolved) {
        if (output.trim()) resolve({ success: true, qr: stripProxy(output) });
        else { proc.kill(); reject(new Error('QR code timeout')); }
      }
    }, 30000);
  });
}

async function confirmWhatsappLogin(userDir, token) {
  const encExists = await isLoggedIn(userDir);

  // creds.json is written only after a successful QR scan — check it specifically
  // to avoid false positives from the .mudslide dir being created at login-start.
  let plaintextReady = false;
  try {
    await fs.access(path.join(mudslideDir(userDir), 'creds.json'));
    plaintextReady = true;
  } catch {}

  if (plaintextReady && token) {
    try {
      await encryptMudslideCache(userDir, token);
    } finally {
      await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
    }
  }

  const loggedIn = plaintextReady || encExists;
  if (!loggedIn) return { loggedIn: false };

  const proxyIp = await getProxiedIpInfo(userDir, token).catch(() => null);
  return { loggedIn: true, proxyIp };
}

async function sendMessage(userDir, token, to, message) {
  return withSession(userDir, token, credPath =>
    runMudslide(['-c', credPath, 'send', to, message], 60000, userDir, token),
    'sendMessage', { to, message }
  );
}

async function sendMedia(userDir, token, to, mediaPath, caption = '') {
  return withSession(userDir, token, async credPath => {
    const ext = mediaPath.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const cmd = isImage ? 'send-image' : 'send-file';
    const args = ['-c', credPath, cmd, to, mediaPath];
    if (caption) args.push('--caption', caption);
    await runMudslide(args, 60000, userDir, token);
  }, 'sendMedia', { to, ...(caption && { caption }) });
}

async function getGroups(userDir, token) {
  return withSession(userDir, token, async credPath => {
    const output = await runMudslide(['-c', credPath, 'groups'], 60000, userDir, token);

    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        return parsed.map(g => ({ name: g.subject || g.name || g.id, id: g.id })).filter(g => g.id);
      }
    } catch {}

    return output.split('\n').filter(Boolean).map(line => {
      try {
        const g = JSON.parse(line);
        if (g && g.id) return { name: g.subject || g.name || g.id, id: g.id };
      } catch {}
      const match = line.match(/^(.*?)\s*\(([^)]+@g\.us)\)\s*$/);
      if (match) return { name: match[1].trim(), id: match[2].trim() };
      if (line.includes('@g.us')) return { name: line.trim(), id: line.trim() };
      return null;
    }).filter(Boolean);
  }, 'getGroups');
}

// Signals WhatsApp to remove this device. Queued so it waits for any in-flight
// send to finish before disconnecting.
async function whatsappDeviceDisconnect(userDir, token) {
  if (!token) return;
  try {
    await withSession(userDir, token, credPath =>
      runMudslide(['-c', credPath, 'logout'], 60000, userDir, token),
      'logout'
    );
  } catch {}
}

// Deletes all session files after the user confirms device removal from WhatsApp.
async function purgeMudslideCache(userDir) {
  await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
  await fs.rm(mudslideEncFile(userDir), { force: true });
  await fs.rm(`/tmp/watobot-proxy-${userDir}.conf`, { force: true });
}

module.exports = {
  getQRCode,
  confirmWhatsappLogin,
  sendMessage,
  sendMedia,
  getGroups,
  whatsappDeviceDisconnect,
  purgeMudslideCache,
  getUsageLogs,
  getMessageStats
};
