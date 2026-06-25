const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

const COUNTER_FILE = path.join(CONFIG.USERS_DIR, '.proxy_port_counter');
let nextPort = null;

async function allocateProxyPort() {
  if (nextPort === null) {
    try { nextPort = parseInt(await fs.readFile(COUNTER_FILE, 'utf8')); }
    catch { nextPort = 10000; }
    if (!nextPort || nextPort < 10000 || nextPort > 20000) nextPort = 10000;
  }
  const port = nextPort >= 20000 ? (nextPort = 10000) : nextPort++;
  await fs.writeFile(COUNTER_FILE, String(nextPort));
  return port;
}

function getUserDir(email) {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 10);
}

function generateToken(email) {
  const userDir = getUserDir(email);
  const random = crypto.randomBytes(27).toString('hex'); // 54 hex chars
  return userDir + random; // 64 hex chars = 32 bytes as Buffer
}

function computeTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Encryption key = Buffer.from(token, 'hex') = 32 bytes, valid AES-256 key
function encryptData(text, token) {
  const key = Buffer.from(token, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptData(ciphertext, token) {
  const [ivHex, encHex] = ciphertext.split(':');
  const key = Buffer.from(token, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

async function registerUser(email) {
  const token = generateToken(email);
  const userDir = token.slice(0, 10);
  const hash = computeTokenHash(token);

  const fullUserDir = path.join(CONFIG.USERS_DIR, userDir);
  await fs.mkdir(path.join(fullUserDir, 'schedules'), { recursive: true });
  await fs.writeFile(path.join(fullUserDir, 'token_hash'), hash);

  return { token, userDir };
}

async function verifyToken(token) {
  if (!token || token.length !== 64) return null;
  const userDir = token.slice(0, 10);
  try {
    const storedHash = (await fs.readFile(
      path.join(CONFIG.USERS_DIR, userDir, 'token_hash'), 'utf8'
    )).trim();
    if (computeTokenHash(token) !== storedHash) return null;
    return { token, userDir };
  } catch {
    return null;
  }
}

async function generateApiKey(userDir, token) {
  const random = crypto.randomBytes(27).toString('hex');
  const apiKey = userDir + random; // same 64-hex format as token

  await fs.writeFile(
    path.join(CONFIG.USERS_DIR, userDir, 'api_key_hash'),
    computeTokenHash(apiKey)
  );
  // Store session token encrypted with apiKey so verifyApiKey can recover it
  await fs.writeFile(
    path.join(CONFIG.USERS_DIR, userDir, 'api_key_token'),
    encryptData(token, apiKey)
  );

  return apiKey;
}

async function verifyApiKey(apiKey) {
  if (!apiKey || apiKey.length !== 64) return null;
  const userDir = apiKey.slice(0, 10);
  try {
    const storedHash = (await fs.readFile(
      path.join(CONFIG.USERS_DIR, userDir, 'api_key_hash'), 'utf8'
    )).trim();
    if (computeTokenHash(apiKey) !== storedHash) return null;

    const encTokenRaw = (await fs.readFile(
      path.join(CONFIG.USERS_DIR, userDir, 'api_key_token'), 'utf8'
    )).trim();
    const sessionToken = decryptData(encTokenRaw, apiKey);

    return { token: sessionToken, userDir };
  } catch {
    return null;
  }
}

module.exports = {
  registerUser,
  verifyToken,
  generateApiKey,
  verifyApiKey,
  encryptData,
  decryptData,
  getUserDir,
  computeTokenHash,
  allocateProxyPort
};
