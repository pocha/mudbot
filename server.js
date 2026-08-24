require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '.env.calendly') });
const path = require('path');
const { spawn } = require('child_process');

const buildServer = require('./services/buildServer');
const fastify = buildServer();

const proxyRelayManager = require('./services/proxyRelayManager');
const mudslideService = require('./services/mudslideService');
const { startFunctionsEmulatorIfNeeded } = require('./scripts/functions-emulator');

const DAILY_REPORT_CRON_LABEL = '# mudbot-daily-report';

// Closes any active per-user relay listeners (services/proxyRelayManager.js)
// and kills any in-flight `mudslide login` processes so a restart doesn't
// leave orphaned sockets/processes behind. Both are in-memory-only state —
// relays are re-acquired lazily and a killed login just means the user sees
// a dead QR and requests a new one, so nothing here needs to persist.
//
// Also removes the daily-report cron entry (see ensureDailyReportCron) —
// safe to do on every stop because production expects the process manager
// (systemd/pm2/etc.) to restart the server automatically if it dies, which
// re-registers the cron within the same start() call. A stop that's never
// followed by a restart (e.g. this repo's test suite spawning/killing its
// own server instances) then correctly leaves no cron behind either.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await proxyRelayManager.closeAllRelays().catch(() => {});
    mudslideService.killAllLoginProcs();
    await removeDailyReportCron().catch(() => {});
    process.exit(0);
  });
}

// Returns a Promise (rather than fire-and-forget) so start() can await it —
// without that, a server stopped shortly after starting could race
// removeDailyReportCron(): the removal finds nothing yet (registration still
// in flight), then the registration completes afterward unopposed, leaving a
// stale cron entry behind. Awaiting here makes registration complete before
// the process is considered "up," so any later stop is strictly ordered
// after it.
function ensureDailyReportCron() {
  return new Promise(resolve => {
    const scriptPath = path.join(__dirname, 'scripts', 'daily-report.js');
    const cronLine = `5 0 * * * ${process.execPath} ${scriptPath}`;

    const get = spawn('crontab', ['-l']);
    let current = '';
    get.stdout.on('data', d => { current += d.toString(); });
    get.on('close', () => {
      if (current.includes(DAILY_REPORT_CRON_LABEL)) return resolve();
      const updated = current.trimEnd() + `\n${DAILY_REPORT_CRON_LABEL}\n${cronLine}\n`;
      const set = spawn('crontab', ['-']);
      set.stdin.write(updated);
      set.stdin.end();
      set.on('close', code => {
        if (code === 0) console.log('[cron] Daily report job registered.');
        else console.warn('[cron] Failed to register daily report job.');
        resolve();
      });
    });
  });
}

function removeDailyReportCron() {
  return new Promise(resolve => {
    const get = spawn('crontab', ['-l']);
    let current = '';
    get.stdout.on('data', d => { current += d.toString(); });
    get.on('close', () => {
      if (!current.includes(DAILY_REPORT_CRON_LABEL)) return resolve();

      // Drop the label line and the cron line immediately after it.
      const lines = current.split('\n');
      const idx = lines.indexOf(DAILY_REPORT_CRON_LABEL);
      if (idx === -1) return resolve();
      lines.splice(idx, 2);

      const set = spawn('crontab', ['-']);
      set.stdin.write(lines.join('\n'));
      set.stdin.end();
      set.on('close', code => {
        if (code === 0) console.log('[cron] Daily report job removed.');
        else console.warn('[cron] Failed to remove daily report job.');
        resolve();
      });
    });
  });
}

const start = async () => {
  try {
    await startFunctionsEmulatorIfNeeded();
    await fastify.listen({ port: process.env.PORT, host: '0.0.0.0' });
    await ensureDailyReportCron();
    if (process.env.DATAIMPULSE_USERNAME) {
      console.log('[proxy] Residential-proxy relay active — DataImpulse country/city targeting via per-user local relays.');
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
