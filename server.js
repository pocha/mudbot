require('dotenv').config();
const fs = require('fs');
const path = require('path');

const httpsOptions = {
  https: {
    key: fs.readFileSync('/etc/letsencrypt/live/watobot.xyz/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/watobot.xyz/fullchain.pem')
  },
  logger: true
};

const fastify = require('fastify')(httpsOptions);

fastify.register(require('@fastify/cors'), { origin: true });

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/'
});

fastify.register(require('./routes/api'));

const start = async () => {
  try {
    // This will now successfully bind directly to 443
    await fastify.listen({ port: process.env.PORT || 443, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
