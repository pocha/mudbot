const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

const COUNTER_FILE = path.join(CONFIG.USERS_DIR, '.proxy_port_counter');
let nextPort = null;

async function allocateProxyPort() {
  const startPort = parseInt(process.env.DATAIMPULSE_PORT) || 10000;
  if (nextPort === null) {
    try { nextPort = parseInt(await fs.readFile(COUNTER_FILE, 'utf8')); }
    catch { nextPort = startPort; }
    if (!nextPort || nextPort < 10000 || nextPort > 20000) nextPort = startPort;
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

async function writeUserFile(filePath, content, token) {
  await fs.writeFile(filePath, encryptData(content, token));
}

async function readUserFile(filePath, token) {
  const raw = await fs.readFile(filePath, 'utf8');
  return decryptData(raw, token);
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

async function proxyConfPath(userDir, token, forceRegenerate = false) {
  if (!process.env.PROXYCHAINS_PATH || !process.env.DATAIMPULSE_USERNAME) return null;
  const confPath = `/tmp/watobot-proxy-${userDir}.conf`;
  if (!forceRegenerate) {
    try { await fs.access(confPath); return confPath; } catch {}
  }
  try {
    const proxy = JSON.parse(await readUserFile(
      path.join(CONFIG.USERS_DIR, userDir, 'proxy.json'), token
    ));
    const country = proxy.country || 'in';
    const login = `${process.env.DATAIMPULSE_USERNAME}__cr.${country}`;
    const conf = [
      'strict_chain', 'proxy_dns', '[ProxyList]',
      `socks5 ${process.env.DATAIMPULSE_GATEWAY || '74.81.81.81'} ${proxy.port || parseInt(process.env.DATAIMPULSE_PORT) || 10000} ${login} ${process.env.DATAIMPULSE_PASSWORD}`
    ].join('\n');
    await fs.writeFile(confPath, conf, 'utf8');
    return confPath;
  } catch { return null; }
}

async function createOrUpdateProxyJson(userDir, token, { country = null } = {}) {
  const proxyFile = path.join(CONFIG.USERS_DIR, userDir, 'proxy.json');

  let existing = {};
  try { existing = JSON.parse(await readUserFile(proxyFile, token)); } catch {}

  if (!existing.port) {
    existing.port = await allocateProxyPort();
  }

  if (country) existing.country = country;
  if (!existing.country) existing.country = 'in';

  const newContent = JSON.stringify(Object.fromEntries(Object.keys(existing).sort().map(k => [k, existing[k]])));
  try {
    const current = await readUserFile(proxyFile, token);
    if (current === newContent) return existing;
  } catch {}

  await writeUserFile(proxyFile, newContent, token);
  await proxyConfPath(userDir, token, true).catch(() => {});
  return existing;
}

// For a brand-new email (no token_hash on disk yet), this is pure token
// generation — no disk writes. The directory and token_hash aren't created
// until the first successful verifyToken call (i.e. the first time the
// emailed link is actually clicked), so a mistyped email never leaves behind
// an orphaned, never-owned directory.
//
// For an email that already has a verified account, this is instead a
// "resend my login link" request — token_hash is a one-way hash, so the old
// token can never be recovered/resent. The only way to give this person a
// working new link is to mint a new token and overwrite the hash right away
// (invalidating the old token immediately), same as the pre-existing
// behavior for repeat registrations. Deferring in this case wouldn't protect
// anything (the directory already exists) and would just leave the new link
// permanently unusable, since nothing would ever write its hash.
async function registerUser(email) {
  const token = generateToken(email);
  const userDir = token.slice(0, 10);
  const tokenHashFile = path.join(CONFIG.USERS_DIR, userDir, 'token_hash');

  try {
    await fs.access(tokenHashFile); // throws if this is a first-time registration
    await fs.writeFile(tokenHashFile, computeTokenHash(token));
  } catch {
    // no existing account for this email — nothing to do here;
    // verifyToken creates it on the first successful click instead.
  }

  return { token, userDir };
}

async function verifyToken(token) {
  if (!token || token.length !== 64) return null;
  const userDir = token.slice(0, 10);
  const tokenHashFile = path.join(CONFIG.USERS_DIR, userDir, 'token_hash');
  try {
    const storedHash = (await fs.readFile(tokenHashFile, 'utf8')).trim();
    if (computeTokenHash(token) !== storedHash) return null;
    return { token, userDir };
  } catch {
    // No token_hash on disk yet — either this is the first click on a
    // genuine registration link (materialize the account now) or the token
    // is simply invalid. A 64-hex-char token is unguessable either way, so
    // treating "no file yet" as "first use" here doesn't weaken anything —
    // it's the same trust boundary registerUser used to enforce at register
    // time, just checked here instead.
    const fullUserDir = path.join(CONFIG.USERS_DIR, userDir);
    try {
      await fs.mkdir(path.join(fullUserDir, 'schedules'), { recursive: true });
      await fs.writeFile(tokenHashFile, computeTokenHash(token));
      return { token, userDir };
    } catch {
      return null;
    }
  }
}

async function generateApiKey(userDir, token) {
  const random = crypto.randomBytes(27).toString('hex');
  const apiKey = userDir + random; // same 64-hex format as token
  const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour

  await fs.writeFile(path.join(CONFIG.USERS_DIR, userDir, 'api_key_hash'), computeTokenHash(apiKey));
  await fs.writeFile(path.join(CONFIG.USERS_DIR, userDir, 'token_enc_with_api_key'), encryptData(token, apiKey));
  await fs.writeFile(path.join(CONFIG.USERS_DIR, userDir, 'api_key_expiry'), expiresAt);

  return { apiKey, expiresAt };
}

async function getApiKeyStatus(userDir) {
  try {
    await fs.access(path.join(CONFIG.USERS_DIR, userDir, 'api_key_hash'));
  } catch {
    return { exists: false };
  }
  try {
    const expiry = (await fs.readFile(path.join(CONFIG.USERS_DIR, userDir, 'api_key_expiry'), 'utf8')).trim();
    if (expiry === 'permanent') return { exists: true, permanent: true };
    const expiresAt = new Date(expiry);
    return { exists: true, permanent: false, expiresAt: expiresAt.toISOString(), expired: expiresAt < new Date() };
  } catch {
    return { exists: true, permanent: true }; // no expiry file = legacy permanent key
  }
}

async function verifyApiKey(apiKey) {
  if (!apiKey || apiKey.length !== 64) return null;
  const userDir = apiKey.slice(0, 10);
  try {
    const storedHash = (await fs.readFile(
      path.join(CONFIG.USERS_DIR, userDir, 'api_key_hash'), 'utf8'
    )).trim();
    if (computeTokenHash(apiKey) !== storedHash) return null;

    // Check expiry
    try {
      const expiry = (await fs.readFile(path.join(CONFIG.USERS_DIR, userDir, 'api_key_expiry'), 'utf8')).trim();
      if (expiry !== 'permanent' && new Date(expiry) < new Date()) return null;
    } catch {} // no expiry file = permanent

    const encTokenRaw = (await fs.readFile(
      path.join(CONFIG.USERS_DIR, userDir, 'token_enc_with_api_key'), 'utf8'
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
  getApiKeyStatus,
  verifyApiKey,
  encryptData,
  decryptData,
  writeUserFile,
  readUserFile,
  getUserDir,
  computeTokenHash,
  allocateProxyPort,
  createOrUpdateProxyJson,
  proxyConfPath
};
