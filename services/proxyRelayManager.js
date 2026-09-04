// Per-user lifecycle for the local DataImpulse relay (services/dataimpulseRelay.js).
//
// Each user gets their own relay listener, lazily started the first time
// they need one and stopped once nothing is using it — mirroring the
// existing per-user mudslide job queue in mudslideService.js (see
// userQueueDepth there): acquire on enqueue, release when the last queued
// job finishes. getQRCode/getProxiedIpInfo aren't part of that queue, so
// they acquire/release directly around their own single spawn.
//
// The relay listens on 127.0.0.1:<port>, reusing the user's existing
// DataImpulse sticky port (allocateProxyPort() in userService.js) as the
// local port too — no separate port-allocation scheme needed, and no
// collision risk since one is a loopback bind and the other is remote.
const path = require('path');
const { readUserFile } = require('./userService');
const { startRelay } = require('./dataimpulseRelay');
const { logCheckpoint } = require('./helpers/debugLog');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users'),
  HTTP_GATEWAY: process.env.DATAIMPULSE_HTTP_GATEWAY || 'gw.dataimpulse.com'
};

// userDir -> { server, refcount, country, city, port }
const relays = new Map();

// userDir -> { message, ts } — the most recent relay-level diagnostic (e.g.
// a dead upstream) for a user. dataimpulseRelay.js's 'connect' handler runs
// as its own event callback with no await-chain back to whichever request
// happened to be using the relay at the time, so a failure there can't
// naturally bubble into that request's own error — this is the bridge:
// recorded here when it happens, read (and cleared) by whoever next reports
// a failure for that user, so an operator sees "Residential IP did not
// respond on port X" in the failure email instead of a generic timeout.
const lastRelayError = new Map();

function recordRelayError(userDir, message) {
  lastRelayError.set(userDir, { message, ts: Date.now() });
}

function takeLastRelayError(userDir, withinMs = 30000) {
  const entry = lastRelayError.get(userDir);
  if (entry && Date.now() - entry.ts <= withinMs) {
    lastRelayError.delete(userDir);
    return entry.message;
  }
  return null;
}

function normalizeCity(city) {
  return city ? city.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

async function readProxyMeta(userDir, token) {
  const raw = await readUserFile(path.join(CONFIG.USERS_DIR, userDir, 'proxy.json'), token);
  return JSON.parse(raw);
}

// server.close() only waits for connections to end on their own — it never
// terminates them. A CONNECT-tunneled socket (see dataimpulseRelay.js) can
// sit open indefinitely if it doesn't close cleanly, so this races close()
// against a short timeout and, if that fires, forces it: destroyActiveTunnels
// (server.close() explicitly excludes upgraded/CONNECT sockets, so this is
// the only thing that actually reaches them) plus closeAllConnections for
// any ordinary ones.
async function closeServer(server, timeoutMs = 5000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      server.destroyActiveTunnels?.();
      server.closeAllConnections?.();
    }, timeoutMs);
    server.close(() => { clearTimeout(timer); resolve(); });
  });
}

// Ensures a relay is running for this user with their current country/city,
// (re)starting it if the config changed since it was last started. Safe to
// call repeatedly/concurrently — increments a refcount either way. No-ops
// (returns false) if residential proxying isn't configured at all, or the
// user has no proxy.json yet.
async function acquireRelay(userDir, token) {
  if (!process.env.DATAIMPULSE_USERNAME || !process.env.DATAIMPULSE_PASSWORD) return false;

  const proxy = await readProxyMeta(userDir, token).catch(() => null);
  if (!proxy || !proxy.port) return false;

  const country = proxy.country || 'in';
  const city = proxy.city || '';
  const existing = relays.get(userDir);

  if (existing && existing.country === country && existing.city === city && existing.port === proxy.port) {
    existing.refcount++;
    return true;
  }

  await logCheckpoint(userDir, 'starting relay...');

  if (existing) {
    relays.delete(userDir);
    await closeServer(existing.server);
  }

  const server = await startRelay({
    country,
    targetSuffix: city ? `;city.${normalizeCity(city)}` : '',
    upstreamHost: CONFIG.HTTP_GATEWAY,
    upstreamPort: proxy.port,
    localPort: proxy.port,
    username: process.env.DATAIMPULSE_USERNAME,
    password: process.env.DATAIMPULSE_PASSWORD,
    onError: message => recordRelayError(userDir, message)
  });

  relays.set(userDir, { server, refcount: 1, country, city, port: proxy.port });
  await logCheckpoint(userDir, 'relay started');
  return true;
}

async function releaseRelay(userDir) {
  const existing = relays.get(userDir);
  if (!existing) return;
  existing.refcount--;
  if (existing.refcount <= 0) {
    relays.delete(userDir);
    await closeServer(existing.server);
  }
}

async function closeAllRelays() {
  const all = [...relays.values()];
  relays.clear();
  await Promise.all(all.map(r => closeServer(r.server)));
}

module.exports = { acquireRelay, releaseRelay, closeAllRelays, takeLastRelayError };