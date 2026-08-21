require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '.env.calendly') });
const path = require('path');
const { spawn } = require('child_process');

const buildServer = require('./services/buildServer');
const fastify = buildServer();

const proxyRelayManager = require('./services/proxyRelayManager');
const mudslideService = require('./services/mudslideService');

// Closes any active per-user relay listeners (services/proxyRelayManager.js)
// and kills any in-flight `mudslide login` processes so a restart doesn't
// leave orphaned sockets/processes behind. Both are in-memory-only state —
// relays are re-acquired lazily and a killed login just means the user sees
// a dead QR and requests a new one, so nothing here needs to persist.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await proxyRelayManager.closeAllRelays().catch(() => {});
    mudslideService.killAllLoginProcs();
    process.exit(0);
  });
}

function ensureDailyReportCron() {
  const scriptPath = path.join(__dirname, 'scripts', 'daily-report.js');
  const label = '# mudbot-daily-report';
  const cronLine = `5 0 * * * ${process.execPath} ${scriptPath}`;

  const get = spawn('crontab', ['-l']);
  let current = '';
  get.stdout.on('data', d => { current += d.toString(); });
  get.on('close', () => {
    if (current.includes(label)) return;
    const updated = current.trimEnd() + `\n${label}\n${cronLine}\n`;
    const set = spawn('crontab', ['-']);
    set.stdin.write(updated);
    set.stdin.end();
    set.on('close', code => {
      if (code === 0) console.log('[cron] Daily report job registered.');
      else console.warn('[cron] Failed to register daily report job.');
    });
  });
}

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT, host: '0.0.0.0' });
    ensureDailyReportCron();
    if (process.env.DATAIMPULSE_USERNAME) {
      console.log('[proxy] Residential-proxy relay active — DataImpulse country/city targeting via per-user local relays.');
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
