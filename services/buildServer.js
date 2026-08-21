const fs = require('fs');
const path = require('path');

function buildServer() {
  const fastifyOptions = { logger: true, trustProxy: true };

  const baseUrl = process.env.BASE_URL || '';
  const localCertPath = path.join(__dirname, '..', 'certs', 'localhost.pem');
  const localKeyPath = path.join(__dirname, '..', 'certs', 'localhost-key.pem');

  if (baseUrl.startsWith('http://')) {
    // Explicit plain-HTTP request (e.g. the test harness spawns the server
    // with BASE_URL=http://localhost so it can talk to it without dealing
    // with a self-signed cert) — skip all HTTPS logic entirely, even if
    // local mkcert certs happen to exist on this machine.
  } else if (fs.existsSync(localCertPath) && fs.existsSync(localKeyPath)) {
    // Local dev HTTPS via mkcert (`mkcert -cert-file certs/localhost.pem
    // -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1`). Needed
    // because things like Cloudflare Turnstile assume a secure context and
    // misbehave (failed postMessage, broken cookie handling) on plain
    // http://localhost. Checked before the Let's Encrypt branch below since
    // these certs only ever exist on a dev machine (gitignored) — a
    // BASE_URL of https://localhost for local dev would otherwise fall into
    // the Let's Encrypt branch and silently drop to plain HTTP, since
    // /etc/letsencrypt never has a "localhost" domain on it.
    fastifyOptions.https = {
      key: fs.readFileSync(localKeyPath),
      cert: fs.readFileSync(localCertPath)
    };
  } else if (baseUrl.startsWith('https://')) {
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

  // @fastify/cors defaults to methods: 'GET,HEAD,POST' when not specified —
  // routes/api.js also uses PUT (update schedule) and DELETE (delete
  // schedule), which would otherwise silently fail CORS preflight from any
  // cross-origin frontend (e.g. watobot.xyz calling api.watobot.xyz).
  fastify.register(require('@fastify/cors'), { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'] });

  fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/'
  });

  fastify.register(require('../routes/api'));

  return fastify;
}

module.exports = buildServer;
