require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const fastifyOptions = { logger: true, trustProxy: true };

const baseUrl = process.env.BASE_URL || '';
if (baseUrl.startsWith('https://')) {
  try {
    const domain = new URL(baseUrl).hostname;
    fastifyOptions.https = {
      key: fs.readFileSync(`/etc/letsencrypt/live/${domain}/privkey.pem`),
      cert: fs.readFileSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`)
    };
  } catch (e) {
    console.error('[WARN] SSL cert not found — starting without HTTPS. Run certbot to obtain a certificate.');
  }
}

const fastify = require('fastify')(fastifyOptions);

fastify.register(require('@fastify/cors'), { origin: true });

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/'
});

fastify.register(require('./routes/api'));

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
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
