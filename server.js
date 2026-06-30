require('dotenv').config();
const fs = require('fs');
const path = require('path');

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

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
