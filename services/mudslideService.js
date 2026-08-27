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
// Whether withSession currently holds a proxyRelayManager acquisition for a
// user — set on acquire, unset on release, so the relay is acquired once per
// batch (reused by every op after the first) instead of every single op,
// mirroring how decryptMudslideToTemp reuses its temp dir across a batch.
const relayHeld = {};

// Tar spawns are otherwise unbounded — if one wedges (e.g. mid-write when the
// process is killed for some other reason), it would hang forever with no
// watchdog, permanently blocking every subsequent queued op for that user
// behind it (see the note on withSession below).
const DECRYPT_TIMEOUT_MS = 20000;
const ENCRYPT_TIMEOUT_MS = 20000;
// acquireRelay -> readUserFile is just local fs + in-memory crypto, no lock,
// no network — genuinely low hang risk, but a wedged disk/mount is still
// possible and there's no cost to guarding it too.
const RELAY_ACQUIRE_TIMEOUT_MS = 15000;

// Applied to every send via our mudslide fork's --live-check/--typing/--wait-ack
// flags: reject before sending to a number that isn't on WhatsApp, show a brief
// typing indicator, then confirm delivery instead of firing blind.
const TYPING_MS = 1500;
const WAIT_ACK_MS = 15000;
// We deliberately don't pass mudslide's own --timeout flag: its argParser is
// `parseInt` passed directly to commander, which calls it as parseInt(value,
// previousValue) — previousValue (the option's default, 60) lands in parseInt's
// radix slot, so ANY explicit --timeout value parses to NaN and fires almost
// instantly instead of waiting (setTimeout(fn, NaN) fires on the next tick).
// mudslide keeps its own unpatched 60s default watchdog (safe — only the
// argParser path is broken), and this is just the node-side spawnWithTimeout
// kill in runMudslide, covering connect + live-check + typing + send + wait-ack.
const SEND_TIMEOUT_MS = 75000;

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

  // If this times out, the tar output is incomplete — must never be written
  // to .mudslide.enc (that would corrupt the real, previously-good
  // credential with a truncated one), so just let it throw here and leave
  // .mudslide.enc untouched.
  const tarBuffer = await spawnWithTimeout('tar', ['-czf', '-', '.mudslide'], ENCRYPT_TIMEOUT_MS, { cwd });

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

  try {
    await spawnWithTimeout('tar', ['-xzf', '-', '-C', tmp], DECRYPT_TIMEOUT_MS, { input: tarBuffer });
  } catch (err) {
    // Extraction was killed or failed partway through — the temp dir may
    // hold a corrupt/incomplete session. Discard it rather than let the
    // reuse check above (fs.access(credPath)) treat it as valid on the next
    // queued op or the next request.
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

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
// ensuring WhatsApp sees one message at a time. Acquires the relay and decrypts
// once on the first op in a batch, reuses both for subsequent ops, then releases
// the relay and encrypts/cleans up only after the last queued op completes.
function withSession(userDir, token, fn, action = 'unknown', meta = {}) {
  userQueueDepth[userDir] = (userQueueDepth[userDir] || 0) + 1;

  const run = async () => {
    let credPath = null;
    let succeeded = false;
    let errMsg = null;
    try {
      // One retry of the whole operation for transient failures (a denied
      // proxy connection, a relay that failed to come up, ...) — skipped when
      // the failed attempt is flagged unsafeToRetry (see spawnWithTimeout),
      // since we can't rule out the underlying send having already gone
      // through. Before retrying, reset to a clean slate rather than reusing
      // whatever the failed attempt left behind: release the relay (so the
      // reacquire below gets a fresh instance instead of a possibly-degraded
      // one) and wipe the decrypted temp dir (mudslide/Baileys may have
      // written partial/mutated session state into it before failing —
      // retrying from the last-known-good .mudslide.enc avoids carrying that
      // forward).
      let result;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (!relayHeld[userDir]) {
            await withTimeout(proxyRelayManager.acquireRelay(userDir, token), RELAY_ACQUIRE_TIMEOUT_MS, 'acquireRelay');
            relayHeld[userDir] = true;
          }
          credPath = await decryptMudslideToTemp(userDir, token);
          result = await fn(credPath);
          break;
        } catch (err) {
          if (attempt === 2 || err.unsafeToRetry) throw err;
          // Record the first attempt's failure so it's not silently lost —
          // it ends up in the final appendUsageLog call below (which spreads
          // meta into the logged payload) whether this op ultimately
          // succeeds on retry or fails again with a different error.
          meta.retryReason = err.message;
          if (relayHeld[userDir]) {
            await proxyRelayManager.releaseRelay(userDir).catch(() => {});
            relayHeld[userDir] = false;
          }
          await cleanupTemp(userDir).catch(() => {});
          credPath = null;
        }
      }
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
        if (relayHeld[userDir]) {
          await proxyRelayManager.releaseRelay(userDir);
          relayHeld[userDir] = false;
        }
      }
    }
  };
  const prev = userQueue[userDir] || Promise.resolve();
  const next = prev.then(run, run);          // run even if previous op failed
  userQueue[userDir] = next.catch(() => {});  // don't let errors block the queue
  return next;
}

const stripProxy = s => s.split('\n').filter(l => !l.trim().startsWith('[proxychains]')).join('\n').trim();

// Bare timeout race for a step with no subprocess to kill — can't cancel the
// underlying work, but stops the caller (and the per-user queue behind it)
// from waiting on it forever.
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// Spawns bin, collects stdout, and kills + rejects if it doesn't close
// within timeoutMs — shared by the tar spawns in decryptMudslideToTemp/
// encryptMudslideCache and by runMudslide below, so nothing this file spawns
// can hang the per-user queue forever.
function spawnWithTimeout(bin, args, timeoutMs, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, cwd ? { cwd } : undefined);
    const chunks = [];
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      // We had to force-kill it ourselves, so there's no way to tell whether
      // the underlying send already went out before it hung — same reasoning
      // as the 'Action timed out' case below, be conservative.
      const err = new Error(`${bin} timed out after ${timeoutMs}ms`);
      err.unsafeToRetry = true;
      reject(err);
    }, timeoutMs);

    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else {
        const stdout = Buffer.concat(chunks).toString();
        const err = new Error(stripProxy(stderr) || stripProxy(stdout) || `${bin} exited with code ${code}`);
        // mudslide's own --timeout watchdog (preAction hook, defaults to 60s)
        // prints this via signale to stdout before process.exit(1) — it's a
        // flat wall-clock timer covering the whole action, so it can fire
        // *after* a send already succeeded (e.g. mid --wait-ack). We can't
        // tell pre- from post-send from here, so treat it as unsafe to retry.
        err.unsafeToRetry = stdout.includes('Action timed out');
        reject(err);
      }
    });

    if (input !== undefined) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

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

  const stdout = await spawnWithTimeout(bin, argv, timeoutMs);
  return stripProxy(stdout.toString());
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

const SEND_CHECK_ARGS = ['--live-check', '--typing', String(TYPING_MS), '--wait-ack', String(WAIT_ACK_MS)];

async function sendMessage(userDir, token, to, message) {
  return withSession(userDir, token, credPath =>
    runMudslide(['-c', credPath, 'send', to, message, ...SEND_CHECK_ARGS], SEND_TIMEOUT_MS, userDir, token),
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
    args.push(...SEND_CHECK_ARGS);
    await runMudslide(args, SEND_TIMEOUT_MS, userDir, token);
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
  killAllLoginProcs,
  SEND_CHECK_ARGS
};
