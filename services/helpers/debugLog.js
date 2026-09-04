const fs = require('fs').promises;
const path = require('path');

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
async function logCheckpoint(userDir, message) {
  if (!userDir) return;
  await fs.appendFile(
    path.join(USERS_DIR, userDir, 'mudslide-debug.log'),
    `[${new Date().toISOString()}] ${message}\n`,
  ).catch(() => {});
}

module.exports = { logCheckpoint };