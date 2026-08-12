const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { proxyConfPath, getNotifyEmail } = require('./userService');
const proxyRelayManager = require('./proxyRelayManager');
const usageService = require('./usageService');
const emailService = require('./emailService');

const CONFIG = {
  MUDSLIDE_PATH: process.env.MUDSLIDE_PATH || 'mudslide',
  PROXYCHAINS_PATH: process.env.PROXYCHAINS_PATH || '',
  USERS_DIR: path.join(__dirname, '..', 'users')
};

// Tracks the active mudslide login process per user (userDir -> { proc, reapTimer }),
// so the keypress can be sent after QR scan and an unscanned session gets reaped.
// Reap window is generous (2 min) but only ever matters for the "never scanned"
// case — once a user actually scans, mudslide writes credentials and exits on its
// own within seconds (see the "press any key" handling below), well before this fires.
const loginProcs = new Map();
const LOGIN_REAP_MS = 2 * 60 * 1000;

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

const SEND_ACTIONS = new Set(['sendMessage', 'sendMedia']);

// Fire-and-forget — a notification failure must never affect the send's own
// outcome. Looks up the user's opt-in notify-email (services/userService.js);
// emailService always alerts NOTIFY_EMAIL/REPLY_TO too, regardless of whether
// the user has one set.
async function notifySendFailure(userDir, token, action, error, meta) {
  const userEmail = await getNotifyEmail(userDir, token).catch(() => null);
  await emailService.sendMessageFailureNotification({
    userDir, to: meta?.to, action, error, userEmail
  });
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
      await usageService.appendUsageLog(userDir, action, succeeded, errMsg, meta, token);
      if (!succeeded && SEND_ACTIONS.has(action)) {
        notifySendFailure(userDir, token, action, errMsg, meta).catch(() => {});
      }
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

// Kills and forgets any login process tracked for userDir. Guards on identity
// (loginProcs.get(userDir) === entry) so a stale timer/call from an older
// generation can never clobber a newer one for the same user.
function killLoginProc(userDir, entry) {
  if (loginProcs.get(userDir) !== entry) return;
  clearTimeout(entry.reapTimer);
  loginProcs.delete(userDir);
  if (!entry.proc.killed) entry.proc.kill();
}

// Kills every tracked login process, for graceful shutdown.
function killAllLoginProcs() {
  for (const [userDir, entry] of loginProcs) killLoginProc(userDir, entry);
}

async function getQRCode(userDir, token) {
  const existing = loginProcs.get(userDir);
  if (existing) killLoginProc(userDir, existing);

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
    const entry = { proc, reapTimer: null };
    loginProcs.set(userDir, entry);
    // Backstop for an unscanned QR — mudslide/Baileys almost certainly gives up
    // on its own well before this, since a real scan makes it exit within seconds
    // (see the "press any key" handling below). This just guarantees nothing
    // lingers if that internal cleanup doesn't happen.
    entry.reapTimer = setTimeout(() => killLoginProc(userDir, entry), LOGIN_REAP_MS);

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
      if (loginProcs.get(userDir) === entry) {
        clearTimeout(entry.reapTimer);
        loginProcs.delete(userDir);
      }
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
  killAllLoginProcs
};
