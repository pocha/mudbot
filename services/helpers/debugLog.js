const fs = require('fs').promises;
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const USERS_DIR = path.join(__dirname, '..', '..', 'users');

// The current request's own identifier (e.g. "GET /api/whatsapp"), set once
// per request (see buildServer.js's preHandler hook) and readable from
// anywhere in that request's async call chain — deep inside
// mudslideService.js, proxyRelayManager.js, etc. — without threading it
// through every function signature in between. Node's AsyncLocalStorage
// propagates automatically through awaits/promises/callbacks descended from
// the runWithLabel() call, so this also just works for preHandler-invoked
// functions (authenticateUser, requireWhatsapp) — they run in the same
// request's async context as the route handler itself.
const storage = new AsyncLocalStorage();
function runWithLabel(label, fn) {
  return storage.run({ label }, fn);
}
function getLabel() {
  return storage.getStore()?.label;
}

// A single timestamped progress marker appended straight to a user's own
// mudslide-debug.log — not a full mudslide-trace block, just a breadcrumb.
// Used at the boundary of each real step across the codebase (relay
// acquire, decrypt, the mudslide spawn itself, encrypt) so a request that
// times out client-side (most in-flight mudslide/relay ops are deliberately
// never killed server-side once started — see withSession's own comment)
// still leaves a trail of how far it actually got, instead of the debug log
// going silent until either a clean finish or a hard failure. Lives in its
// own module (not mudslideService.js) so proxyRelayManager.js can use it too
// without a circular require between the two.
//
// Prefixed with the current request's own label (read from the
// AsyncLocalStorage context above) so a checkpoint deep inside
// acquireRelay/decrypt/encrypt/runMudslide can always be traced back to
// which API call produced it, even with several requests for the same user
// queued close together.
async function logCheckpoint(userDir, message) {
  if (!userDir) return;
  const label = getLabel();
  await fs.appendFile(
    path.join(USERS_DIR, userDir, 'mudslide-debug.log'),
    `[${new Date().toISOString()}]${label ? ` ${label}` : ''} ${message}\n`,
  ).catch(() => {});
}

module.exports = { logCheckpoint, runWithLabel };
