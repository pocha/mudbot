const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users'),
  TOKENS_FILE: path.join(__dirname, '..', 'tokens.json')
};

// Token management
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
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(token, 'salt', 32);
  // Use deterministic IV derived from token to ensure same email+token always produces same encrypted name
  const iv = crypto.createHash('sha256').update(token + 'iv').digest().slice(0, 16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(email, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptDirName(encrypted, token) {
  try {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(token, 'salt', 32);
    const parts = encrypted.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    return null;
  }
}

// Helper function to check if user already exists by email
async function findUserByEmail(email) {
  const tokens = await loadTokens();
  
  // Iterate through all entries to find if email already registered
  for (const [key, encryptedDirName] of Object.entries(tokens)) {
    // Skip API keys (they have different patterns but we need to check all)
    // Try to get metadata from this directory
    try {
      const userDir = path.join(CONFIG.USERS_DIR, encryptedDirName);
      const metadataPath = path.join(userDir, 'metadata.json');
      const data = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(data);
      
      if (metadata.email === email && key.length === 64) { // 64 chars = token (32 bytes hex)
        return { token: key, encryptedDirName };
      }
    } catch (error) {
      // Directory doesn't exist or can't read metadata, continue
      continue;
    }
  }
  
  return null;
}

// User operations
async function registerUser(email) {
  // Check if user already exists
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    return { exists: true, token: existingUser.token };
  }
  
  // Generate new token
  const token = generateToken();
  const encryptedDirName = encryptDirName(email, token);
  const userDir = path.join(CONFIG.USERS_DIR, encryptedDirName);
  
  // Create user directory structure
  await fs.mkdir(userDir, { recursive: true });
  await fs.mkdir(path.join(userDir, 'schedules'), { recursive: true });
  await fs.mkdir(path.join(userDir, 'logs'), { recursive: true });
  
  // Create user metadata file
  const metadata = {
    email,
    createdAt: new Date().toISOString(),
    apiKey: null,
    mudslideLoggedIn: false
  };
  
  await fs.writeFile(
    path.join(userDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );
  
  // Save token mapping: token -> encryptedDirName
  const tokens = await loadTokens();
  tokens[token] = encryptedDirName;
  await saveTokens(tokens);
  
  return { exists: false, token, userDir: encryptedDirName };
}

async function getUserMetadata(userDir) {
  try {
    const metadataPath = path.join(CONFIG.USERS_DIR, userDir, 'metadata.json');
    const data = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

async function updateUserMetadata(userDir, updates) {
  const metadataPath = path.join(CONFIG.USERS_DIR, userDir, 'metadata.json');
  const metadata = await getUserMetadata(userDir) || {};
  
  Object.assign(metadata, updates);
  metadata.updatedAt = new Date().toISOString();
  
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  return metadata;
}

async function generateApiKey(userDir, token) {
  const apiKey = crypto.randomBytes(32).toString('hex');
  
  // Encrypt API key for storage in metadata
  const key = crypto.createHash('sha256').update(token).digest();
  const iv = crypto.createHash('sha256').update(token + 'apikey').digest().slice(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encryptedApiKey = cipher.update(apiKey, 'utf8', 'hex');
  encryptedApiKey += cipher.final('hex');
  
  await updateUserMetadata(userDir, { apiKey: encryptedApiKey });
  
  // Add API key to tokens.json: apiKey -> encryptedDirName
  const tokens = await loadTokens();
  const encryptedDirName = path.basename(path.join(CONFIG.USERS_DIR, userDir));
  tokens[apiKey] = encryptedDirName;
  await saveTokens(tokens);
  
  return apiKey;
}

function decryptApiKey(encryptedApiKey, token) {
  try {
    const key = crypto.createHash('sha256').update(token).digest();
    const iv = crypto.createHash('sha256').update(token + 'apikey').digest().slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedApiKey, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    return null;
  }
}

async function verifyApiKey(apiKey) {
  const tokens = await loadTokens();
  
  // Direct lookup: apiKey -> encryptedDirName
  const encryptedDirName = tokens[apiKey];
  if (!encryptedDirName) {
    return null;
  }
  
  // Get metadata to retrieve email and other info
  const metadata = await getUserMetadata(encryptedDirName);
  if (!metadata) {
    return null;
  }
  
  // Find the token for this user (need to iterate to find which token maps to this dir)
  let userToken = null;
  for (const [key, dirName] of Object.entries(tokens)) {
    if (dirName === encryptedDirName && key.length === 64) { // 64 chars = token
      userToken = key;
      break;
    }
  }
  
  return { 
    email: metadata.email, 
    token: userToken, 
    userDir: encryptedDirName,
    apiKey 
  };
}

async function verifyToken(token) {
  const tokens = await loadTokens();
  
  // Direct lookup: token -> encryptedDirName
  const encryptedDirName = tokens[token];
  if (!encryptedDirName) {
    return null;
  }
  
  const userDir = path.join(CONFIG.USERS_DIR, encryptedDirName);
  
  try {
    await fs.access(userDir);
    const metadata = await getUserMetadata(encryptedDirName);
    
    if (!metadata) {
      return null;
    }
    
    // Decrypt API key if it exists
    let apiKey = null;
    if (metadata.apiKey) {
      apiKey = decryptApiKey(metadata.apiKey, token);
    }
    
    return { 
      email: metadata.email, 
      token, 
      userDir: encryptedDirName,
      apiKey 
    };
  } catch (error) {
    return null;
  }
}

module.exports = {
  registerUser,
  getUserMetadata,
  updateUserMetadata,
  generateApiKey,
  verifyApiKey,
  verifyToken
};
