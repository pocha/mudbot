const fs = require('fs');
const path = require('path');

function buildServer() {
  const fastifyOptions = { logger: true, trustProxy: true };

  const baseUrl = process.env.BASE_URL || '';
  const localCertPath = path.join(__dirname, '..', 'certs', 'localhost.pem');
  const localKeyPath = path.join(__dirname, '..', 'certs', 'localhost-key.pem');

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
  } else if (fs.existsSync(localCertPath) && fs.existsSync(localKeyPath)) {
    // Local dev HTTPS via mkcert (`mkcert -cert-file certs/localhost.pem
    // -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1`). Needed
    // because things like Cloudflare Turnstile assume a secure context and
    // misbehave (failed postMessage, broken cookie handling) on plain
    // http://localhost.
    fastifyOptions.https = {
      key: fs.readFileSync(localKeyPath),
      cert: fs.readFileSync(localCertPath)
    };
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
