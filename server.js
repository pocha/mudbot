require('dotenv').config();
const fs = require('fs');
const path = require('path');

const isLocal = (process.env.BASE_URL || '').startsWith('http://localhost');

const fastifyOptions = { logger: true, trustProxy: true };

if (!isLocal) {
  fastifyOptions.https = {
    key: fs.readFileSync('/etc/letsencrypt/live/watobot.xyz/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/watobot.xyz/fullchain.pem')
  };
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
