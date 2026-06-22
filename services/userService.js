const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users'),
  TOKENS_FILE: path.join(__dirname, '..', 'tokens.json')
};

const SERVER_SECRET = process.env.SERVER_SECRET;

// --- Crypto helpers ---

// Encrypt/decrypt using SERVER_SECRET — for tokens.json values
function encryptWithSecret(text) {
  const key = crypto.scryptSync(SERVER_SECRET, 'tokensalt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptWithSecret(ciphertext) {
  const [ivHex, encHex] = ciphertext.split(':');
  const key = crypto.scryptSync(SERVER_SECRET, 'tokensalt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

// Encrypt/decrypt using hash(email + SERVER_SECRET) — for all user files
function encryptData(text, email) {
  const key = crypto.createHash('sha256').update(email + SERVER_SECRET).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptData(ciphertext, email) {
  const [ivHex, encHex] = ciphertext.split(':');
  const key = crypto.createHash('sha256').update(email + SERVER_SECRET).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

// Deterministic 10-char directory name from email
function getUserDir(email) {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 10);
}

// --- Token storage (entire file encrypted with SERVER_SECRET) ---

async function loadTokens() {
  try {
    const raw = await fs.readFile(CONFIG.TOKENS_FILE, 'utf8');
    const decrypted = decryptWithSecret(raw.trim());
    return JSON.parse(decrypted);
  } catch {
    return {};
  }
}

async function saveTokens(tokens) {
  const encrypted = encryptWithSecret(JSON.stringify(tokens));
  await fs.writeFile(CONFIG.TOKENS_FILE, encrypted);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// --- User operations ---

async function registerUser(email) {
  const tokens = await loadTokens();

  // Check if a token already maps to this user's dir (re-registration: issue new token, keep dir)
  const userDir = getUserDir(email);
  const fullUserDir = path.join(CONFIG.USERS_DIR, userDir);

  const token = generateToken();
  tokens[token] = encryptWithSecret(email);
  await saveTokens(tokens);

  // Create dir structure if first time
  await fs.mkdir(path.join(fullUserDir, 'schedules'), { recursive: true });

  return { token, userDir };
}

async function verifyToken(token) {
  const tokens = await loadTokens();
  const encryptedEmail = tokens[token];
  if (!encryptedEmail) return null;

  try {
    const email = decryptWithSecret(encryptedEmail);
    const userDir = getUserDir(email);
    return { email, token, userDir };
  } catch {
    return null;
  }
}

async function generateApiKey(userDir, email) {
  const apiKey = crypto.randomBytes(32).toString('hex');

  // Store encrypted api_key file in user dir
  const encryptedKey = encryptData(apiKey, email);
  await fs.writeFile(path.join(CONFIG.USERS_DIR, userDir, 'api_key'), encryptedKey);

  // Add apiKey -> encryptedEmail entry to tokens.json
  const tokens = await loadTokens();
  tokens[apiKey] = encryptWithSecret(email);
  await saveTokens(tokens);

  return apiKey;
}

async function verifyApiKey(apiKey) {
  const tokens = await loadTokens();
  const encryptedEmail = tokens[apiKey];
  if (!encryptedEmail) return null;

  try {
    const email = decryptWithSecret(encryptedEmail);
    const userDir = getUserDir(email);

    // Find the session token for this user
    let userToken = null;
    for (const [key, val] of Object.entries(tokens)) {
      if (key.length === 64 && key !== apiKey) {
        try {
          const e = decryptWithSecret(val);
          if (e === email) { userToken = key; break; }
        } catch { /* skip */ }
      }
    }

    return { email, token: userToken, userDir, apiKey };
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
  getUserDir
};
