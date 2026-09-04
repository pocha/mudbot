const fs = require('fs');
const path = require('path');
const { runWithLabel } = require('./helpers/debugLog');

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

  // Sets this request's own label (e.g. "GET /api/whatsapp") in an
  // AsyncLocalStorage context, readable from anywhere in the request's async
  // call chain — see services/helpers/debugLog.js (runWithLabel/getLabel,
  // and logCheckpoint's use of it). A global preHandler hook (not onRequest)
  // so it's guaranteed to run after routing is resolved
  // (request.routeOptions.url is populated) and before any route-specific
  // preHandler (authenticateUser, requireWhatsapp), which also need it.
  fastify.addHook('preHandler', (request, reply, done) => {
    const label = `${request.method} ${request.routeOptions?.url || request.url}`;
    runWithLabel(label, () => done());
  });

  // @fastify/cors defaults to methods: 'GET,HEAD,POST' when not specified —
  // routes/api.js also uses PUT (update schedule) and DELETE (delete
  // schedule), which would otherwise silently fail CORS preflight from any
  // cross-origin frontend (e.g. watobot.xyz calling api.watobot.xyz).
  fastify.register(require('@fastify/cors'), { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'] });

  // In production the real frontend is served from GitHub Pages
  // (watobot.xyz), not this VM — this API server only needs to answer
  // /api/* routes. Serving public/ here too is redundant and needlessly
  // widens the attack surface (static file/directory serving on the
  // API-only domain). Local dev is the one place this stays on by default:
  // server.js there serves public/ + /api together on the same origin.
  if (process.env.DISABLE_PUBLIC_STATIC !== 'true') {
    fastify.register(require('@fastify/static'), {
      root: path.join(__dirname, '..', 'public'),
      prefix: '/'
    });
  }

  fastify.register(require('../routes/api'));

  return fastify;
}

module.exports = buildServer;
