const fs = require('fs').promises;
const path = require('path');
const { getLabel } = require('./requestContext');

const USERS_DIR = path.join(__dirname, '..', '..', 'users');

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
// Prefixed with the current request's own label (e.g. "GET /api/whatsapp"),
// read from requestContext — set once per request, not threaded through
// every function call — so a checkpoint deep inside acquireRelay/decrypt/
// encrypt/runMudslide can always be traced back to which API call produced
// it, even with several requests for the same user queued close together.
async function logCheckpoint(userDir, message) {
  if (!userDir) return;
  const label = getLabel();
  await fs.appendFile(
    path.join(USERS_DIR, userDir, 'mudslide-debug.log'),
    `[${new Date().toISOString()}]${label ? ` ${label}` : ''} ${message}\n`,
  ).catch(() => {});
}

module.exports = { logCheckpoint };