require('dotenv').config();

const fastify = require('fastify')({ logger: true });
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// Enable CORS
fastify.register(require('@fastify/cors'), {
  origin: true
});

// Serve static files
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname),
  prefix: '/'
});

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3000,
  HOST: '0.0.0.0',
  USERS_DIR: path.join(__dirname, 'users'),
  TOKENS_FILE: path.join(__dirname, 'tokens.json'),
  MUDSLIDE_PATH: path.join(__dirname, 'mudslide'),
  EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@mudbot.local'
};

// Helper Functions
async function loadTokens() {
  try {
    const data = await fs.readFile(CONFIG.TOKENS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

async function saveTokens(tokens) {
  await fs.writeFile(CONFIG.TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function encryptDirName(email, token) {
  const cipher = crypto.createCipher('aes-256-cbc', token);
  let encrypted = cipher.update(email, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decryptDirName(encrypted, token) {
  try {
    const decipher = crypto.createDecipher('aes-256-cbc', token);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    return null;
  }
}

// Register API routes
fastify.register(require('./routes/api'));

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    console.log(`Server listening on ${CONFIG.HOST}:${CONFIG.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
