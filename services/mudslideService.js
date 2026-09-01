const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { proxyConfPath, getNotifyEmail } = require('./userService');
const proxyRelayManager = require('./proxyRelayManager');
const usageService = require('./usageService');
const emailService = require('./emailService');
const { errorOnTimeout, withErrorOnTimeout } = require('./helpers/errorOnTimeout');

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

// The one shared ceiling for every public API call in this file (the two
// errorOnTimeout wraps below and withSession's own) — matches mudslide's own
// unmodified internal --timeout watchdog default.
const OPERATION_TIMEOUT_MS = 60000;

// The *inner* mudslide/curl spawn is never given the full OPERATION_TIMEOUT_MS
// directly — it's given whatever's left of that budget, minus this margin,
// measured from when the outer errorOnTimeout wrap actually started ticking
// (see spawnBudget() below). Without this, the inner spawnWithTimeout's real
// proc.kill() and the outer errorOnTimeout's fake one (it has no process
// handle — see helpers/errorOnTimeout.js) would share the same deadline
// while starting their clocks at different times (the outer starts before
// acquireRelay/decrypt, the inner only after) — so the outer could fire
// first, orphaning a still-running mudslide process against the very
// directory (tempDir(userDir), a fixed path per user) the next queued op is
// about to recreate via a fresh decrypt. This margin guarantees the inner
// kill always wins that race, so the outer wrap only ever needs to catch a
// stuck acquireRelay/decrypt, never a still-alive spawn.
const SPAWN_TIMEOUT_MARGIN_MS = 8000;
function spawnBudget(startedAt) {
  return Math.max(OPERATION_TIMEOUT_MS - (Date.now() - startedAt) - SPAWN_TIMEOUT_MARGIN_MS, 5000);
}

// Baileys' own WebSocket connect/query timeouts, passed to mudslide via its
// --connect-timeout/--query-timeout flags (mudslide's own unmodified
// defaults, 3000/6000ms, are too tight for our proxy chain and were causing
// spurious timeout crashes). Both stay comfortably under OPERATION_TIMEOUT_MS
// so mudslide's own graceful timeout handling gets a chance to fire (and be
// caught, with a real diagnostic message) before our outer spawnWithTimeout
// kill does. connectTimeoutMs doesn't need to cover tunnel establishment to
// the residential IP — dataimpulseRelay's own attemptConnect already bounds
// that separately (5s) before Baileys' connect attempt even starts; this
// only covers the TLS/WebSocket/noise-handshake layer on top of that
// already-open tunnel.
const MUDSLIDE_CONNECT_TIMEOUT_MS = 10000;
const MUDSLIDE_QUERY_TIMEOUT_MS = 20000;

// Exact text our mudslide fork's `me` prints (via signale, to stdout) when
// Baileys reports connection.update close with DisconnectReason.loggedOut —
// i.e. the user removed this device from WhatsApp's own "Linked Devices"
// list. Locally cached creds.json still exists and looks fine (checkLoggedIn
// is just a file check), so this is the only way to actually tell.
const DEVICE_UNLINKED_MARKER = 'Device unlinked from WhatsApp';

// Exact text mudslide's onConnectionOpen prints when connection.update fires
// 'close' for any reason other than a confirmed device-unlink — a proxy that
// can't route to WhatsApp at all looks like this, not a device-unlink.
const CONNECTION_CLOSED_MARKER = 'Connection closed unexpectedly';

function isConnectivityFailure(message) {
  return typeof message === 'string' &&
    (message.includes('timed out') || message.includes(CONNECTION_CLOSED_MARKER));
}

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

// Standalone connectivity check, not part of the per-user queue — same as
// getQRCode/getProxiedIpInfo below, it acquires/releases its own relay
// directly. Runs mudslide's `me`, which our fork fails fast and distinctly
// on a loggedOut disconnect (see mudslide's whatsapp.ts isLoggedOutDisconnect)
// instead of hanging like `send`/`groups` do. Purges the local session itself
// once a disconnect is confirmed, so callers just get { connected, phoneNumber }
// back. Prerequisite is the full isWhatsappConnected (not just the raw
// isLoggedIn file check) so a session that was *just* scanned but not yet
// finalized into .mudslide.enc doesn't read as "not connected" here.
//
// phoneNumber is scraped from `me`'s own "Current user: <id>" line
// (id looks like "<number>:<deviceId>@s.whatsapp.net") rather than adding
// any new output format to the mudslide fork — `me` already prints this for
// its own CLI-identity purpose, so no reason to touch mudslide just to read
// it. Regex, not a fixed line-start match, since signale prefixes the line
// with its own log-type label.
const ME_PHONE_NUMBER_RE = /Current user:\s*(\d+):/;

async function confirmWhatsappIsActuallyConnected(userDir, token) {
  const startedAt = Date.now();
  if (!(await isWhatsappConnected(userDir, token)).loggedIn) return { connected: false, phoneNumber: null };
  await proxyRelayManager.acquireRelay(userDir, token);
  try {
    const credPath = await decryptMudslideToTemp(userDir, token);
    try {
      const output = await runMudslide(['-c', credPath, 'me'], spawnBudget(startedAt), userDir, token, 'me');
      const match = output.match(ME_PHONE_NUMBER_RE);
      return { connected: true, phoneNumber: match ? match[1] : null };
    } catch (err) {
      // Only a confirmed unlinked-device disconnect purges the local
      // session — anything else (timeout, a generic/ambiguous disconnect,
      // a proxy hiccup) means the check itself failed, not that we've
      // proven the device is still linked, so this must NOT default to
      // true. A stale-but-reporting-fine connection is exactly the bug
      // this function exists to catch.
      console.log('DEBUG confirmWhatsappIsActuallyConnected me failed', { userDir, message: err.message });
      if (err.message.includes(DEVICE_UNLINKED_MARKER)) {
        await purgeMudslideCache(userDir).catch(() => {});
        return { connected: false, phoneNumber: null, reason: 'device_unlinked' };
      }
      // runMudslide already ran diagnoseConnectivityFailure on this error —
      // its message carries the proxy-unreachable prefix if that's the cause.
      if (err.message.includes(PROXY_UNREACHABLE_PREFIX)) {
        return { connected: false, phoneNumber: null, reason: 'proxy_unreachable' };
      }
      return { connected: false, phoneNumber: null };
    }
  } finally {
    await cleanupTemp(userDir).catch(() => {});
    await proxyRelayManager.releaseRelay(userDir).catch(() => {});
  }
}

// Queues fn(credPath) for the user — operations are strictly sequential per user,
// ensuring WhatsApp sees one message at a time. Acquires the relay and decrypts
// once on the first op in a batch, reuses both for subsequent ops, then releases
// the relay and encrypts/cleans up only after the last queued op completes.
function withSession(userDir, token, fn, action = 'unknown', meta = {}) {
  userQueueDepth[userDir] = (userQueueDepth[userDir] || 0) + 1;

  const run = async () => {
    let succeeded = false;
    let errMsg = null;
    const startedAt = Date.now();

    const doWork = async () => {
      // A previous op (this batch, or an earlier request) may have already
      // purged a device-unlinked session (see confirmWhatsappIsActuallyConnected) —
      // fail with a clear message here rather than a raw ENOENT from decrypt.
      if (!(await isLoggedIn(userDir))) throw new Error(DEVICE_UNLINKED_MARKER);
      if (!relayHeld[userDir]) {
        await proxyRelayManager.acquireRelay(userDir, token);
        relayHeld[userDir] = true;
      }
      const credPath = await decryptMudslideToTemp(userDir, token);
      // fn's own spawnWithTimeout call gets whatever's left of this batch's
      // budget (minus a margin), not the full OPERATION_TIMEOUT_MS again —
      // see spawnBudget()'s comment for why that margin matters.
      const result = await fn(credPath, spawnBudget(startedAt));
      await encryptMudslideCache(userDir, token, tempDir(userDir));
      return result;
    };

    try {
      const result = await errorOnTimeout(doWork(), OPERATION_TIMEOUT_MS, `${action} timed out after ${OPERATION_TIMEOUT_MS}ms`);
      succeeded = true;
      return result;
    } catch (err) {
      // A relay-level failure (e.g. a dead upstream) doesn't naturally bubble
      // up to here — dataimpulseRelay.js's 'connect' handler runs as its own
      // event callback, not in this call chain — so proxyRelayManager bridges
      // it via a small per-user note instead. Prefer that specific diagnostic
      // over the generic timeout message when one was recorded moments ago.
      // err.message is already diagnosed if it came from runMudslide (see its
      // own catch) — this outer timeout only ever fires for a stuck
      // acquireRelay/decrypt (see spawnBudget's comment), neither of which is
      // a proxy-health question, so nothing further to diagnose here.
      errMsg = proxyRelayManager.takeLastRelayError(userDir) || err.message;
      if (relayHeld[userDir]) {
        relayHeld[userDir] = false;
        await proxyRelayManager.releaseRelay(userDir).catch(() => {});
      }
      await cleanupTemp(userDir).catch(() => {});
      if (SEND_ACTIONS.has(action)) {
        notifySendFailure(userDir, token, action, errMsg, meta).catch(() => {});
      }
      throw err;
    } finally {
      await usageService.appendUsageLog(userDir, action, succeeded, errMsg, meta, token);
      userQueueDepth[userDir]--;
      if (userQueueDepth[userDir] === 0) {
        await cleanupTemp(userDir);
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

// Spawns bin, collects stdout, and kills + rejects if it doesn't close
// within timeoutMs — shared by the tar spawns in decryptMudslideToTemp/
// encryptMudslideCache and by runMudslide below, so nothing this file spawns
// can hang the per-user queue forever. This is real, working cancellation
// (proc.kill()), unlike errorOnTimeout (used everywhere else in this file),
// which can only stop the caller from waiting — it has no process handle to
// kill, so it isn't used here.
function spawnWithTimeout(bin, args, timeoutMs, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, cwd ? { cwd } : undefined);
    const chunks = [];
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else {
        const stdout = Buffer.concat(chunks).toString();
        reject(new Error(stripProxy(stderr) || stripProxy(stdout) || `${bin} exited with code ${code}`));
      }
    });

    if (input !== undefined) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

async function getProxiedIpInfo(userDir, token, startedAt = Date.now()) {
  const confPath = await proxyConfPath(userDir, token).catch(() => null);
  if (!confPath || !CONFIG.PROXYCHAINS_PATH) return null;

  await proxyRelayManager.acquireRelay(userDir, token);
  try {
    const stdout = await spawnWithTimeout(CONFIG.PROXYCHAINS_PATH, [
      '-f', confPath, 'curl', '-s', '--max-time', '10',
      'http://ip-api.com/json/?fields=query,city,country,countryCode'
    ], spawnBudget(startedAt)).catch(() => null);
    if (!stdout) return null;
    try {
      const { query: ip, city, country, countryCode } = JSON.parse(stdout.toString());
      return { ip, city, country, countryCode };
    } catch { return null; }
  } finally {
    await proxyRelayManager.releaseRelay(userDir);
  }
}

// Distinguishes "the residential IP/proxy itself can't reach WhatsApp" from
// "something else is wrong" — a plain curl through the user's proxy chain
// rather than a full mudslide/Baileys connection (no credential decrypt, no
// WebSocket handshake, no Signal protocol setup), so it's cheap enough to
// run right after a timeout/connection-close failure without adding cost to
// the healthy path. Returns true (proxy reachable, issue is elsewhere),
// false (proxy itself is the problem), or null (no proxy configured for
// this account — not applicable, don't blame the proxy either way).
async function checkProxyReachable(userDir, token) {
  const confPath = await proxyConfPath(userDir, token).catch(() => null);
  if (!confPath || !CONFIG.PROXYCHAINS_PATH) return null;

  try {
    await proxyRelayManager.acquireRelay(userDir, token);
  } catch {
    return false;
  }
  const stdout = await spawnWithTimeout(CONFIG.PROXYCHAINS_PATH, [
    '-f', confPath, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8',
    'https://web.whatsapp.com'
  ], 12000).catch(() => '');
  await proxyRelayManager.releaseRelay(userDir).catch(() => {});
  return /^2/.test(stdout.toString().trim());
}

const PROXY_UNREACHABLE_PREFIX = 'Residential proxy is not reachable — likely a bad or expired sticky IP, contact the Watobot operator.';

// Only actually runs the (relatively expensive, ~up to 8-12s) proxy check
// when the failure looks connectivity-related in the first place — a
// device-unlink, a bad recipient, or any other non-connectivity error is
// left alone, since checking proxy health wouldn't explain those anyway.
async function diagnoseConnectivityFailure(userDir, token, message) {
  if (!isConnectivityFailure(message)) return message;
  const proxyOk = await checkProxyReachable(userDir, token).catch(() => null);
  return proxyOk === false ? `${PROXY_UNREACHABLE_PREFIX} (${message})` : message;
}

// Wraps a function that doesn't route through runMudslide (which diagnoses
// this internally — see its own catch below) so its failures get the same
// treatment. Assumes (userDir, token, ...) is the wrapped fn's own argument
// order, matching every function this is used on.
function diagnoseConnectivityFailureWrapper(fn) {
  return async (userDir, token, ...rest) => {
    try {
      return await fn(userDir, token, ...rest);
    } catch (err) {
      err.message = await diagnoseConnectivityFailure(userDir, token, err.message);
      throw err;
    }
  };
}

// label identifies the call in the user's debug log (e.g. 'me', 'groups',
// 'to=<number>') — every invocation gets logged, success or failure, so a
// health check like confirmWhatsappIsActuallyConnected's `me` call is no
// longer invisible here (it previously only ever reached a console.log on
// failure, never on success, and never into the user's own log file).
async function runMudslide(args, timeoutMs, userDir, token, label = 'mudslide') {
  const confPath = (userDir && token) ? await proxyConfPath(userDir, token) : null;
  const useProxy = confPath && CONFIG.PROXYCHAINS_PATH;
  const bin  = useProxy ? CONFIG.PROXYCHAINS_PATH : CONFIG.MUDSLIDE_PATH;
  const mudslideArgs = [
    '--connect-timeout', String(MUDSLIDE_CONNECT_TIMEOUT_MS),
    '--query-timeout', String(MUDSLIDE_QUERY_TIMEOUT_MS),
    ...args
  ];
  const argv = useProxy ? ['-f', confPath, CONFIG.MUDSLIDE_PATH, ...mudslideArgs] : mudslideArgs;

  try {
    const stdout = await spawnWithTimeout(bin, argv, timeoutMs);
    const output = stripProxy(stdout.toString());
    if (userDir) await appendMudslideDebugLog(userDir, label, output);
    return output;
  } catch (err) {
    if (userDir) err.message = await diagnoseConnectivityFailure(userDir, token, err.message);
    if (userDir) await appendMudslideDebugLog(userDir, `${label} (FAILED)`, err.message || '');
    throw err;
  }
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

// Deliberately not wrapped like the rest of this file (see withSession and
// the "one wrap per public API call" convention elsewhere) — it resolves as
// soon as the QR text is available, while the underlying login process keeps
// running in the background for however long it takes to scan, tracked here
// via loginProcs/reapTimer instead of a timeout around the whole function.
async function getQRCode(userDir, token) {
  const existing = loginProcs.get(userDir);
  if (existing) killLoginProc(userDir, existing);

  await purgeMudslideCache(userDir);

  const confPath = token ? await proxyConfPath(userDir, token) : null;
  const useProxy = confPath && CONFIG.PROXYCHAINS_PATH;
  const bin  = useProxy ? CONFIG.PROXYCHAINS_PATH : CONFIG.MUDSLIDE_PATH;
  const mudslideArgs = [
    '-c', mudslideDir(userDir),
    '--connect-timeout', String(MUDSLIDE_CONNECT_TIMEOUT_MS),
    '--query-timeout', String(MUDSLIDE_QUERY_TIMEOUT_MS),
    // The QR text captured below is shown directly to the end user in the
    // dashboard — unlike sendMessage's debug logging, none of mudslide's own
    // pino output belongs there, so silence it just for this invocation
    // rather than touching the shared trace-level default.
    '--log-level', 'silent',
    'login'
  ];
  const argv = useProxy
    ? ['-f', confPath, CONFIG.MUDSLIDE_PATH, ...mudslideArgs]
    : mudslideArgs;

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

// Cheap, local-only check: does a usable session exist. Also finalizes a
// just-scanned session (creds.json is written in plaintext the moment a QR
// scan succeeds, before it's been encrypted into .mudslide.enc) — this is
// what actually detects and completes a login, not getQRCode itself (which
// resolves long before the scan happens). No proxy/network call here; that's
// getWhatsappProxyIp's job, kept separate specifically so this stays cheap
// enough to gate every mudslide-touching request without adding real cost.
async function isWhatsappConnected(userDir, token) {
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

  return { loggedIn: plaintextReady || encExists };
}

// Real network round trip (acquires a relay) — deliberately not gated behind
// isWhatsappConnected, since this can legitimately be called before the
// device is confirmed connected.
async function getWhatsappProxyIp(userDir, token) {
  const startedAt = Date.now();
  if (!(await isLoggedIn(userDir))) return { proxyIp: null };
  const proxyIp = await getProxiedIpInfo(userDir, token, startedAt).catch(() => null);
  return { proxyIp };
}

async function sendMessage(userDir, token, to, message) {
  return withSession(userDir, token, async (credPath, timeoutMs) => {
    return runMudslide(['-c', credPath, 'send', to, message], timeoutMs, userDir, token, `to=${to}`);
  }, 'sendMessage', { to, message });
}

// mudslide's trace-level logging is nearly all noisy per-frame websocket/pino
// output — appending it raw grows mudslide-debug.log unbounded (1.5MB+ from
// a single send). Keep only what's actually useful for diagnosing a
// "reports success but doesn't decrypt on the recipient's device" case:
// warnings/errors, session/prekey/retry-receipt activity (the signals a
// failed session establishment or a recipient-side decrypt failure would
// show up as), connection-lifecycle events (a generic "Connection closed
// unexpectedly" from a `me` check is otherwise a dead end — the actual
// reason, e.g. Baileys' own "connection errored"/timeout/handshake lines,
// logs at info (level 30) and was being silently dropped), and mudslide's
// own non-pino signale output (e.g. the "DEBUG sendPayload result" summary
// line), which never carries a "level" field.
const PINO_LEVEL_RE = /"level":\s*(\d+)/;
const RELEVANT_LOG_RE = /retry|resend|prekey|session|decrypt|encrypt|unavailable|not-authorized|errored|handshake|<failure|already closed|Connection Failure/i;
function filterRelevantMudslideOutput(output) {
  return output.split('\n').filter(line => {
    if (!line.trim()) return false;
    const levelMatch = line.match(PINO_LEVEL_RE);
    if (!levelMatch) return true;
    if (Number(levelMatch[1]) >= 40) return true;
    return RELEVANT_LOG_RE.test(line);
  }).join('\n');
}

async function appendMudslideDebugLog(userDir, label, output) {
  const entry = `\n--- ${new Date().toISOString()} ${label} ---\n${filterRelevantMudslideOutput(output)}\n`;
  await fs.appendFile(path.join(CONFIG.USERS_DIR, userDir, 'mudslide-debug.log'), entry).catch(() => {});
}

async function sendMedia(userDir, token, to, mediaPath, caption = '') {
  return withSession(userDir, token, async (credPath, timeoutMs) => {
    const ext = mediaPath.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const cmd = isImage ? 'send-image' : 'send-file';
    const args = ['-c', credPath, cmd, to, mediaPath];
    if (caption) args.push('--caption', caption);
    await runMudslide(args, timeoutMs, userDir, token, `to=${to}`);
  }, 'sendMedia', { to, ...(caption && { caption }) });
}

async function getGroups(userDir, token) {
  return withSession(userDir, token, async (credPath, timeoutMs) => {
    const output = await runMudslide(['-c', credPath, 'groups'], timeoutMs, userDir, token, 'groups');

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

// Deletes all session files after the user confirms device removal from WhatsApp.
async function purgeMudslideCache(userDir) {
  await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
  await fs.rm(mudslideEncFile(userDir), { force: true });
  await fs.rm(`/tmp/watobot-proxy-${userDir}.conf`, { force: true });
}

module.exports = {
  getQRCode: diagnoseConnectivityFailureWrapper(getQRCode),
  isWhatsappConnected,
  //diagnoseConnectivityFailureWrapper() cant be applied on confirmWhatsappIsActuallyConnected 
  //as the return type is different based on the error. So simply throwing error will not do 
  confirmWhatsappIsActuallyConnected: withErrorOnTimeout(confirmWhatsappIsActuallyConnected, OPERATION_TIMEOUT_MS, `confirmWhatsappIsActuallyConnected timed out after ${OPERATION_TIMEOUT_MS}ms`),
  getWhatsappProxyIp: diagnoseConnectivityFailureWrapper(withErrorOnTimeout(getWhatsappProxyIp, OPERATION_TIMEOUT_MS, `getWhatsappProxyIp timed out after ${OPERATION_TIMEOUT_MS}ms`)),
  sendMessage,
  sendMedia,
  getGroups,
  purgeMudslideCache,
  killAllLoginProcs
};