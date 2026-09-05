const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { rmSync } = require('fs');
const crypto = require('crypto');
const { proxyConfPath, getNotifyEmail } = require('./userService');
const proxyRelayManager = require('./proxyRelayManager');
const usageService = require('./usageService');
const emailService = require('./emailService');
const { errorOnTimeout, withErrorOnTimeout } = require('./helpers/errorOnTimeout');
const { logCheckpoint } = require('./helpers/debugLog');

const CONFIG = {
  MUDSLIDE_PATH: process.env.MUDSLIDE_PATH || 'mudslide',
  PROXYCHAINS_PATH: process.env.PROXYCHAINS_PATH || '',
  USERS_DIR: path.join(__dirname, '..', 'users')
};

// Tracks the active mudslide login process per user, so the post-scan keypress can be sent and an unscanned session gets reaped after LOGIN_REAP_MS.
const loginProcs = new Map();
const LOGIN_REAP_MS = 2 * 60 * 1000;

// Per-user operation queue — ensures only one mudslide command runs at a time per user.
const userQueue = {};
const userQueueDepth = {};
// Whether withSession currently holds a relay acquisition for a user, so it's acquired once per batch and reused, not once per queued op.
const relayHeld = {};

// Watchdog ceiling for the tar spawns — a tar of the small credential folder is pure local disk I/O, so this only exists as a backstop against a wedged spawn, not an expected duration.
const DECRYPT_TIMEOUT_MS = 3000;
const ENCRYPT_TIMEOUT_MS = 3000;

// The one shared ceiling for every public API call in this file — matches mudslide's own unmodified internal --timeout watchdog default.
const OPERATION_TIMEOUT_MS = 60000;

// Margin subtracted from the inner mudslide/curl spawn's budget (see spawnBudget) so its real proc.kill() always wins the race against the outer errorOnTimeout's fake one, which starts its clock earlier and has no process handle of its own to kill.
const SPAWN_TIMEOUT_MARGIN_MS = 8000;
function spawnBudget(startedAt) {
  return Math.max(OPERATION_TIMEOUT_MS - (Date.now() - startedAt) - SPAWN_TIMEOUT_MARGIN_MS, 5000);
}

// Baileys' own connect/query timeouts passed via mudslide's --connect-timeout/--query-timeout — mudslide's unmodified defaults (3000/6000ms) were too tight for our proxy chain and caused spurious timeouts; both stay under OPERATION_TIMEOUT_MS so mudslide's own timeout handling gets a chance to produce a real diagnostic before our outer kill does.
const MUDSLIDE_CONNECT_TIMEOUT_MS = 5000;
const MUDSLIDE_QUERY_TIMEOUT_MS = 20000;

// Exact text our mudslide fork prints when Baileys reports a loggedOut disconnect — i.e. the user removed this device from WhatsApp's "Linked Devices" list (the only way to tell, since the cached creds.json otherwise still looks fine).
const DEVICE_UNLINKED_MARKER = 'Device unlinked from WhatsApp';

// Baileys' own socket.js prints this (not mudslide) when the local creds.me is missing, and starts a fresh QR-pairing handshake instead of failing fast — same underlying condition as DEVICE_UNLINKED_MARKER (session needs re-linking), so it's collapsed into that same marker rather than tracked separately.
const NOT_REGISTERED_MARKER = 'not logged in, attempting registration';

// Exact text mudslide prints when connection.update fires 'close' for any reason other than a confirmed device-unlink — e.g. a proxy that can't route to WhatsApp at all.
const CONNECTION_CLOSED_MARKER = 'Connection closed unexpectedly';

// Exact text mudslide prints right after socket.sendMessage resolves — if our own timeout kills the process during its post-send grace wait, this confirms the send already succeeded and shouldn't be discarded.
const SEND_SUCCESS_MARKER = 'Done';

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

// Tar .mudslide, AES-256 encrypt with sha256(token), write .mudslide.enc — fromDir omitted tars from users/<userDir>/ and deletes the plaintext dir (post-QR-scan case), or pass tempDir(userDir) to tar from /tmp (post-send/groups case, cleanupTemp handles deletion).
async function encryptMudslideCache(userDir, token, fromDir = null) {
  const cwd = fromDir || path.join(CONFIG.USERS_DIR, userDir);
  const key = crypto.createHash('sha256').update(token).digest();

  await logCheckpoint(userDir, 'starting tar (encrypt)...');
  // A timed-out/incomplete tar must never be written to .mudslide.enc (would corrupt the previously-good credential), so just let it throw and leave .mudslide.enc untouched.
  const tarBuffer = await spawnWithTimeout('tar', ['-czf', '-', '.mudslide'], ENCRYPT_TIMEOUT_MS, { cwd });
  await logCheckpoint(userDir, 'tar done, encrypting...');

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(tarBuffer), cipher.final()]);
  await fs.writeFile(mudslideEncFile(userDir), Buffer.concat([iv, encrypted]));

  if (!fromDir) {
    await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
  }
  await logCheckpoint(userDir, 'encrypt done');
}

// Decrypt .mudslide.enc → /tmp/mudbot-<userDir>/.mudslide, return that path (reused as-is if a prior op in the same queue batch already decrypted it).
async function decryptMudslideToTemp(userDir, token) {
  const tmp = tempDir(userDir);
  const credPath = path.join(tmp, '.mudslide');
  try {
    await fs.access(credPath);
    return credPath;  // already decrypted by an earlier op in this batch
  } catch {}

  await logCheckpoint(userDir, 'reading + decrypting...');
  const data = await fs.readFile(mudslideEncFile(userDir));
  const iv = data.slice(0, 16);
  const encrypted = data.slice(16);

  const key = crypto.createHash('sha256').update(token).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const tarBuffer = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  await fs.mkdir(tmp, { recursive: true });

  try {
    await logCheckpoint(userDir, 'starting tar extract (decrypt)...');
    await spawnWithTimeout('tar', ['-xzf', '-', '-C', tmp], DECRYPT_TIMEOUT_MS, { input: tarBuffer });
  } catch (err) {
    // Extraction failed partway — discard the possibly-corrupt temp dir rather than let the reuse check above treat it as valid later.
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await logCheckpoint(userDir, 'decrypt done');

  return credPath;
}

async function cleanupTemp(userDir) {
  await fs.rm(tempDir(userDir), { recursive: true, force: true });
}

const SEND_ACTIONS = new Set(['sendMessage', 'sendMedia']);

// Fire-and-forget — a notification failure must never affect the send's own outcome. emailService always alerts NOTIFY_EMAIL/REPLY_TO too, regardless of whether the user has their own notify-email set.
async function notifySendFailure(userDir, token, action, error, meta) {
  const userEmail = await getNotifyEmail(userDir, token).catch(() => null);
  await emailService.sendMessageFailureNotification({
    userDir, to: meta?.to, action, error, userEmail
  });
}

// Standalone connectivity check (acquires/releases its own relay, not part of the per-user queue) — runs mudslide's `me`, purges the local session once a disconnect is confirmed, and returns { connected, phoneNumber }. Gated on the full isWhatsappConnected (not just the raw file check) so a just-scanned-but-not-yet-encrypted session doesn't read as disconnected.
// phoneNumber is scraped from `me`'s own "Current user: <id>" line rather than adding a new output format to the mudslide fork.
const ME_PHONE_NUMBER_RE = /Current user:\s*(\d+):/;

// Routed through withSession (trackUsage: false, not a customer-facing interaction) so it's serialized against every other mudslide op — Baileys allows only one live WebSocket per device identity, and two of these racing get a server-side "stream:error conflict", kicking one out.
async function confirmWhatsappIsActuallyConnected(userDir, token, signal) {
  // No session file at all is the most certain "not connected" case there is — reuse 'device_unlinked' so the frontend shows "Connect WhatsApp" instead of its "we couldn't confirm" warning, which is for genuinely inconclusive checks, not this.
  if (!(await isWhatsappConnected(userDir, token)).loggedIn) {
    return { connected: false, phoneNumber: null, reason: 'device_unlinked' };
  }

  try {
    // signal only gates withSession's own "still queued, caller's gone" early-bail — never forwarded into the actual spawn, since killing a live Baileys connection mid-flight risks discarding session updates the other side already considers delivered.
    const output = await withSession(userDir, token, (credPath, timeoutMs) =>
      runMudslide(['-c', credPath, 'me'], timeoutMs, userDir, token, 'me'),
      'confirmWhatsappIsActuallyConnected', {}, false, signal);
    const match = output.match(ME_PHONE_NUMBER_RE);
    return { connected: true, phoneNumber: match ? match[1] : null };
  } catch (err) {
    // Only a confirmed unlink purges the local session — any other failure (timeout, ambiguous disconnect, proxy hiccup) means the check itself failed, not that the device is still linked, so this must never default to true.
    console.log('DEBUG confirmWhatsappIsActuallyConnected me failed', { userDir, message: err.message });
    if (err.message.includes(DEVICE_UNLINKED_MARKER)) {
      await purgeMudslideCache(userDir).catch(() => {});
      return { connected: false, phoneNumber: null, reason: 'device_unlinked' };
    }
    // runMudslide already ran diagnoseConnectivityFailure — its message carries this prefix if the proxy itself was the cause.
    if (err.message.includes(PROXY_UNREACHABLE_PREFIX)) {
      return { connected: false, phoneNumber: null, reason: 'proxy_unreachable' };
    }
    return { connected: false, phoneNumber: null };
  }
}

// Queues fn(credPath) for the user so ops run strictly sequentially — acquires the relay and decrypts once per batch (reused by later ops), releases/encrypts only after the last queued op finishes. signal is threaded down to fn's own spawn so an abandoned request can kill its real child process, and is also checked here since a call queued long enough behind others can find its own caller already gone by the time its turn comes.
function withSession(userDir, token, fn, action = 'unknown', meta = {}, trackUsage = true, signal) {
  userQueueDepth[userDir] = (userQueueDepth[userDir] || 0) + 1;

  const run = async () => {
    let succeeded = false;
    let errMsg = null;
    const startedAt = Date.now();

    const doWork = async () => {
      if (signal?.aborted) throw new Error('Request was aborted before this op started');
      // A previous op may have already purged a device-unlinked session — fail clearly here rather than with a raw ENOENT from decrypt.
      if (!(await isLoggedIn(userDir))) throw new Error(DEVICE_UNLINKED_MARKER);
      if (!relayHeld[userDir]) {
        await proxyRelayManager.acquireRelay(userDir, token);
        relayHeld[userDir] = true;
      }
      const credPath = await decryptMudslideToTemp(userDir, token);
      // fn gets whatever's left of this batch's budget (minus a margin), not the full OPERATION_TIMEOUT_MS again — see spawnBudget().
      const result = await fn(credPath, spawnBudget(startedAt), signal);
      await encryptMudslideCache(userDir, token, tempDir(userDir));
      return result;
    };

    try {
      const result = await errorOnTimeout(doWork(), OPERATION_TIMEOUT_MS, `${action} timed out after ${OPERATION_TIMEOUT_MS}ms`);
      succeeded = true;
      return result;
    } catch (err) {
      // proxyRelayManager bridges a relay-level failure (e.g. dead upstream) that can't naturally bubble up here — prefer that specific diagnostic over the generic message when one was recorded moments ago; runMudslide's own catch already diagnosed err.message otherwise.
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
      if (trackUsage) await usageService.appendUsageLog(userDir, action, succeeded, errMsg, meta, token);
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
  const started = prev.then(run, run);  // run even if previous op failed — this is the one real execution, whatever the caller below waits on

  // Queue-advancement must never depend on run() (or its own cleanup) actually finishing — a hang anywhere inside it we haven't anticipated would otherwise wedge every future op for this user forever, the same shape as the closeServer incident this is built to prevent. startedSettled distinguishes "run() genuinely finished right around the deadline, its own catch/finally already cleaned up" from "run() is still truly stuck" — only the latter forces anything, and only via synchronous, unconditionally-terminal primitives (forceDropRelay, rmSync, plain flag writes) that can never themselves become the next thing that hangs.
  let startedSettled = false;
  started.then(() => { startedSettled = true; }, () => { startedSettled = true; });

  const QUEUE_ADVANCE_TIMEOUT_MS = OPERATION_TIMEOUT_MS + 15000;
  userQueue[userDir] = Promise.race([
    started.then(() => {}, () => {}),
    new Promise(resolve => setTimeout(() => {
      if (startedSettled) return resolve();
      proxyRelayManager.forceDropRelay(userDir);
      relayHeld[userDir] = false;
      userQueueDepth[userDir] = Math.max((userQueueDepth[userDir] || 1) - 1, 0);
      try { rmSync(tempDir(userDir), { recursive: true, force: true }); } catch {}
      resolve();
    }, QUEUE_ADVANCE_TIMEOUT_MS))
  ]);

  return started;
}

const stripProxy = s => s.split('\n').filter(l => !l.trim().startsWith('[proxychains]')).join('\n').trim();

// Spawns bin, collects stdout, and kills + rejects if it doesn't close within timeoutMs — shared by the tar spawns and by runMudslide, so nothing this file spawns can hang the per-user queue forever (real proc.kill() cancellation, unlike errorOnTimeout elsewhere in this file which has no process handle to kill). signal (optional) lets an abandoned request's AbortSignal kill a real child process the same way. killOn (optional): a substring checked against stdout as it streams in — if it ever appears, the process is killed immediately instead of waiting out the full timeout, and the rejection's message is set to that same substring so callers can classify it exactly like a timeout that happened to contain it.
function spawnWithTimeout(bin, args, timeoutMs, { cwd, input, signal, killOn } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { ...(cwd ? { cwd } : {}), ...(signal ? { signal } : {}) });
    const chunks = [];
    let stderr = '';
    let killedEarly = false;

    const timer = setTimeout(() => {
      proc.kill();
      // mudslide prints its success line before its own post-send grace wait — don't discard an already-succeeded send just because we killed the process before it exited on its own.
      const stdout = Buffer.concat(chunks).toString();
      if (stdout.includes(SEND_SUCCESS_MARKER)) {
        resolve(Buffer.concat(chunks));
      } else {
        const err = new Error(`${bin} timed out after ${timeoutMs}ms`);
        // Whatever mudslide printed before we killed it, so a timeout isn't a dead end in the debug log.
        err.partialOutput = stdout;
        reject(err);
      }
    }, timeoutMs);

    proc.stdout.on('data', d => {
      chunks.push(d);
      if (killOn && !killedEarly && Buffer.concat(chunks).toString().includes(killOn)) {
        killedEarly = true;
        clearTimeout(timer);
        proc.kill();
        const err = new Error(killOn);
        err.partialOutput = Buffer.concat(chunks).toString();
        reject(err);
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (killedEarly) return;
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

async function getProxiedIpInfo(userDir, token, startedAt = Date.now(), signal) {
  const confPath = await proxyConfPath(userDir, token).catch(() => null);
  if (!confPath || !CONFIG.PROXYCHAINS_PATH) return null;

  await proxyRelayManager.acquireRelay(userDir, token);
  try {
    const stdout = await spawnWithTimeout(CONFIG.PROXYCHAINS_PATH, [
      '-f', confPath, 'curl', '-s', '--max-time', '10',
      'http://ip-api.com/json/?fields=query,city,country,countryCode'
    ], spawnBudget(startedAt), { signal }).catch(() => null);
    if (!stdout) return null;
    try {
      const { query: ip, city, country, countryCode } = JSON.parse(stdout.toString());
      return { ip, city, country, countryCode };
    } catch { return null; }
  } finally {
    await proxyRelayManager.releaseRelay(userDir);
  }
}

// Distinguishes "the proxy itself can't reach WhatsApp" from "something else is wrong" via a plain curl through the proxy chain (no mudslide/Baileys/Signal setup, so cheap enough to run right after any connectivity failure). Returns true (proxy fine), false (proxy is the problem), or null (no proxy configured — not applicable).
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

// Lets callers outside this module recognize a proxy-unreachable failure without duplicating the prefix string — set whenever diagnoseConnectivityFailure below confirmed (via checkProxyReachable) that the proxy, not a device-unlink or anything else, was the cause.
function isProxyUnreachableError(err) {
  return typeof err?.message === 'string' && err.message.includes(PROXY_UNREACHABLE_PREFIX);
}

// Only runs the relatively expensive (~8-12s) proxy check when the failure looks connectivity-related in the first place — a device-unlink or any other non-connectivity error wouldn't be explained by the proxy anyway.
async function diagnoseConnectivityFailure(userDir, token, message) {
  if (!isConnectivityFailure(message)) return message;
  const proxyOk = await checkProxyReachable(userDir, token).catch(() => null);
  return proxyOk === false ? `${PROXY_UNREACHABLE_PREFIX} (${message})` : message;
}

// Wraps a function that doesn't route through runMudslide (which diagnoses this internally) so its failures get the same treatment — assumes (userDir, token, ...) is the wrapped fn's own argument order.
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

// label identifies the call in the user's debug log (e.g. 'me', 'groups', 'to=<number>') — every invocation is logged, success or failure.
async function runMudslide(args, timeoutMs, userDir, token, label = 'mudslide', signal) {
  const confPath = (userDir && token) ? await proxyConfPath(userDir, token) : null;
  const useProxy = confPath && CONFIG.PROXYCHAINS_PATH;
  const bin  = useProxy ? CONFIG.PROXYCHAINS_PATH : CONFIG.MUDSLIDE_PATH;
  const mudslideArgs = [
    '--connect-timeout', String(MUDSLIDE_CONNECT_TIMEOUT_MS),
    '--query-timeout', String(MUDSLIDE_QUERY_TIMEOUT_MS),
    ...args
  ];
  const argv = useProxy ? ['-f', confPath, CONFIG.MUDSLIDE_PATH, ...mudslideArgs] : mudslideArgs;

  const spawnStartedAt = Date.now();
  if (userDir) await logCheckpoint(userDir, `${label}: starting mudslide (budget ${timeoutMs}ms)...`);
  try {
    // killOn: NOT_REGISTERED_MARKER cuts an unattended-pairing hang short the moment Baileys prints it, instead of waiting out the full timeoutMs budget.
    const stdout = await spawnWithTimeout(bin, argv, timeoutMs, { signal, killOn: NOT_REGISTERED_MARKER });
    const output = stripProxy(stdout.toString());
    if (userDir) await logCheckpoint(userDir, `${label}: mudslide done, took ${Date.now() - spawnStartedAt}ms`);
    if (userDir) await appendMudslideDebugLog(userDir, label, output);
    return output;
  } catch (err) {
    if (userDir) await logCheckpoint(userDir, `${label}: mudslide failed after ${Date.now() - spawnStartedAt}ms`);
    // Baileys deciding the session needs re-pairing is the same condition as a confirmed unlink — collapse it into the one marker every caller already checks for, and purge now so nothing queued behind this repeats the same hang.
    if (`${err.message || ''}\n${err.partialOutput || ''}`.includes(NOT_REGISTERED_MARKER)) {
      err.message = DEVICE_UNLINKED_MARKER;
      if (userDir) await purgeMudslideCache(userDir).catch(() => {});
    }
    if (userDir) {
      err.message = await diagnoseConnectivityFailure(userDir, token, err.message);
      const partial = err.partialOutput ? `\n${stripProxy(err.partialOutput)}` : '';
      await appendMudslideDebugLog(userDir, `${label} (FAILED)`, (err.message || '') + partial);
    }
    throw err;
  }
}

// Kills and forgets any login process tracked for userDir — guards on identity so a stale timer/call from an older generation can never clobber a newer one for the same user.
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

// Not wrapped like the rest of this file's public calls — resolves as soon as the QR text is available, while the login process keeps running in the background until scanned, tracked via loginProcs/reapTimer instead of a timeout around the whole function.
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
    // The QR text is shown directly to the user in the dashboard, so silence mudslide's own pino output just for this invocation rather than touching the shared trace-level default.
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
    // Backstop for an unscanned QR — a real scan makes mudslide exit within seconds (see the "press any key" handling below) well before this fires.
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
      // mudslide prints "press any key to exit" on stderr after a scan; stdin is a pipe (not a TTY), so send the keypress automatically.
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

// Cheap, local-only check for whether a usable session exists — also finalizes a just-scanned session (creds.json is written in plaintext the moment a scan succeeds, before encryption), which is what actually completes a login, not getQRCode itself. No network call here; that's getWhatsappProxyIp's job, kept separate so this stays cheap enough to gate every mudslide-touching request.
async function isWhatsappConnected(userDir, token) {
  const encExists = await isLoggedIn(userDir);

  // creds.json only exists after a successful scan — check it specifically to avoid a false positive from the .mudslide dir merely being created at login-start.
  let plaintextReady = false;
  try {
    await fs.access(path.join(mudslideDir(userDir), 'creds.json'));
    plaintextReady = true;
  } catch {}

  if (plaintextReady && token) {
    // Only remove the plaintext dir once it's actually encrypted — deleting it unconditionally (the old behavior) destroyed a just-scanned session for good on any transient encrypt failure, with no way to retry.
    await encryptMudslideCache(userDir, token);
    await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
  }

  return { loggedIn: plaintextReady || encExists };
}

// Real network round trip (acquires a relay) — deliberately not gated behind isWhatsappConnected, since this can legitimately be called before the device is confirmed connected.
async function getWhatsappProxyIp(userDir, token, signal) {
  const startedAt = Date.now();
  if (!(await isLoggedIn(userDir))) return { proxyIp: null };
  // Unlike everything else in this file, this is plain curl through the proxy — no Baileys connection, no local session state to desync — so it's safe to actually kill mid-flight, not just while queued.
  const proxyIp = await getProxiedIpInfo(userDir, token, startedAt, signal).catch(() => null);
  return { proxyIp };
}

async function sendMessage(userDir, token, to, message, signal) {
  // signal only gates withSession's early-bail while queued — never forwarded to the actual send, since WhatsApp's servers may already have it while our own local session update (persisted only after a normal finish) hasn't, and killing mid-flight would desync the two.
  return withSession(userDir, token, async (credPath, timeoutMs) => {
    return runMudslide(['-c', credPath, 'send', to, message], timeoutMs, userDir, token, `to=${to}`);
  }, 'sendMessage', { to, message }, true, signal);
}

// Keeps only what's useful for diagnosing a "reports success but doesn't decrypt on the recipient's device" case out of mudslide's otherwise very noisy trace-level output (1.5MB+ from a single send if kept raw): warnings/errors, session/prekey/retry-receipt activity, connection-lifecycle events, and mudslide's own non-pino signale lines (which never carry a "level" field).
const PINO_LEVEL_RE = /"level":\s*(\d+)/;
const RELEVANT_LOG_RE = /retry|resend|prekey|session|decrypt|encrypt|unavailable|not-authorized|errored|handshake|<failure|already closed|Connection Failure|usync|device/i;
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

async function sendMedia(userDir, token, to, mediaPath, caption = '', signal) {
  // Same reasoning as sendMessage above — signal only gates the queued case.
  return withSession(userDir, token, async (credPath, timeoutMs) => {
    const ext = mediaPath.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const cmd = isImage ? 'send-image' : 'send-file';
    const args = ['-c', credPath, cmd, to, mediaPath];
    if (caption) args.push('--caption', caption);
    await runMudslide(args, timeoutMs, userDir, token, `to=${to}`);
  }, 'sendMedia', { to, ...(caption && { caption }) }, true, signal);
}

async function getGroups(userDir, token, signal) {
  // signal only gates withSession's early-bail while queued — not forwarded to runMudslide/spawn, same reasoning as confirmWhatsappIsActuallyConnected above.
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
      return null;
    }).filter(Boolean);
  }, 'getGroups', {}, true, signal);
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
  // diagnoseConnectivityFailureWrapper can't apply to confirmWhatsappIsActuallyConnected — its return shape differs by error, so simply rethrowing won't do.
  confirmWhatsappIsActuallyConnected: withErrorOnTimeout(confirmWhatsappIsActuallyConnected, OPERATION_TIMEOUT_MS, `confirmWhatsappIsActuallyConnected timed out after ${OPERATION_TIMEOUT_MS}ms`),
  getWhatsappProxyIp: diagnoseConnectivityFailureWrapper(withErrorOnTimeout(getWhatsappProxyIp, OPERATION_TIMEOUT_MS, `getWhatsappProxyIp timed out after ${OPERATION_TIMEOUT_MS}ms`)),
  sendMessage,
  sendMedia,
  getGroups,
  purgeMudslideCache,
  killAllLoginProcs,
  isProxyUnreachableError
};
