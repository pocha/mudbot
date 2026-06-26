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
    const zipSuffix = proxy.zipcode ? `;zip.${proxy.zipcode}` : '';
    const login = `${process.env.DATAIMPULSE_USERNAME}__cr.${country}${zipSuffix}`;
    const conf = [
      'strict_chain', 'proxy_dns', '[ProxyList]',
      `socks5 ${process.env.DATAIMPULSE_GATEWAY || '74.81.81.81'} ${proxy.port || parseInt(process.env.DATAIMPULSE_PORT) || 10000} ${login} ${process.env.DATAIMPULSE_PASSWORD}`
    ].join('\n');
    await fs.writeFile(confPath, conf, 'utf8');
    return confPath;
  } catch { return null; }
}

async function createOrUpdateProxyJson(userDir, token, { country = null, zipcode = undefined } = {}) {
  const proxyFile = path.join(CONFIG.USERS_DIR, userDir, 'proxy.json');

  let existing = {};
  try { existing = JSON.parse(await readUserFile(proxyFile, token)); } catch {}

  if (!existing.port) {
    existing.port = await allocateProxyPort();
  }

  if (country) existing.country = country;
  if (!existing.country) existing.country = 'in';
  if (zipcode !== undefined) existing.zipcode = zipcode;

  const newContent = JSON.stringify(Object.fromEntries(Object.keys(existing).sort().map(k => [k, existing[k]])));
  try {
    const current = await readUserFile(proxyFile, token);
    if (current === newContent) return existing;
  } catch {}

  await writeUserFile(proxyFile, newContent, token);
  await proxyConfPath(userDir, token, true).catch(() => {});
  return existing;
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
    path.join(CONFIG.USERS_DIR, userDir, 'token_enc_with_api_key'),
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
