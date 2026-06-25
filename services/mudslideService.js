const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { readUserFile, proxyConfPath } = require('./userService');

const CONFIG = {
  MUDSLIDE_PATH: process.env.MUDSLIDE_PATH || 'mudslide',
  PROXYCHAINS_PATH: process.env.PROXYCHAINS_PATH || '',
  USERS_DIR: path.join(__dirname, '..', 'users')
};

// Holds the active mudslide login process so confirmLogin() can send a keypress.
let loginProc = null;



function mudslideEncFile(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, '.mudslide.enc');
}

function mudslideDir(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
}

function tempDir(userDir) {
  return path.join('/tmp', `mudbot-${userDir}`);
}

async function isLoggedIn(userDir) {
  try {
    await fs.access(mudslideEncFile(userDir));
    return true;
  } catch {
    return false;
  }
}

// Tar .mudslide dir, encrypt with sha256(token), write .mudslide.enc, delete .mudslide dir.
async function encryptMudslide(userDir, token) {
  const key = crypto.createHash('sha256').update(token).digest();

  const tarBuffer = await new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-czf', '-', '.mudslide'], {
      cwd: path.join(CONFIG.USERS_DIR, userDir)
    });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar failed with code ${code}`));
    });
  });

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(tarBuffer), cipher.final()]);
  await fs.writeFile(mudslideEncFile(userDir), Buffer.concat([iv, encrypted]));

  // await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
}

// Decrypt .mudslide.enc → /tmp/mudbot-<userDir>/.mudslide, return that path.
async function decryptMudslideToTemp(userDir, token) {
  const data = await fs.readFile(mudslideEncFile(userDir));
  const iv = data.slice(0, 16);
  const encrypted = data.slice(16);

  const key = crypto.createHash('sha256').update(token).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const tarBuffer = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  const tmp = tempDir(userDir);
  await fs.mkdir(tmp, { recursive: true });

  await new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', '-', '-C', tmp]);
    proc.stdin.write(tarBuffer);
    proc.stdin.end();
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed with code ${code}`));
    });
  });

  return path.join(tmp, '.mudslide');
}

async function cleanupTemp(userDir) {
  await fs.rm(tempDir(userDir), { recursive: true, force: true });
}

const stripProxy = s => s.split('\n').filter(l => !l.trim().startsWith('[proxychains]')).join('\n').trim();

async function runMudslide(args, timeoutMs, userDir, token) {
  const confPath = (userDir && token) ? await proxyConfPath(userDir, token) : null;
  const useProxy = confPath && CONFIG.PROXYCHAINS_PATH;
  const bin  = useProxy ? CONFIG.PROXYCHAINS_PATH : CONFIG.MUDSLIDE_PATH;
  const argv = useProxy ? ['-f', confPath, CONFIG.MUDSLIDE_PATH, ...args] : args;

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('mudslide timeout'));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stripProxy(stdout));
      else reject(new Error(stripProxy(stderr) || `mudslide exited with code ${code}`));
    });
  });
}

async function getQRCode(userDir, token) {
  if (loginProc && !loginProc.killed) {
    loginProc.kill();
    loginProc = null;
  }

  const confPath = token ? await proxyConfPath(userDir, token) : null;
  const useProxy = confPath && CONFIG.PROXYCHAINS_PATH;
  const bin  = useProxy ? CONFIG.PROXYCHAINS_PATH : CONFIG.MUDSLIDE_PATH;
  const argv = useProxy
    ? ['-f', confPath, CONFIG.MUDSLIDE_PATH, '-c', mudslideDir(userDir), 'login']
    : ['-c', mudslideDir(userDir), 'login'];

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv);
    loginProc = proc;
    let output = '';
    let idleTimer = null;
    let resolved = false;
    let keypressSent = false;

    const onData = (data) => {
      output += data.toString();

      // After the user scans the QR, mudslide enters loginSecondPass() and prints
      // "press any key to exit" while blocking on stdin. Since our stdin is a pipe
      // (not a TTY) it would hang forever — send the keypress automatically so
      // mudslide can terminate cleanly once the user clicks Continue in the UI.
      if (output.includes('press any key') && !keypressSent) {
        keypressSent = true;
        proc.stdin.write('\n');
        return;
      }

      if (idleTimer) clearTimeout(idleTimer);
      // Only start the idle timer once we have content beyond mudslide's
      // initialization messages — the QR code arrives after those.
      const meaningful = output.split('\n')
        .filter(l => !l.trim().startsWith('Created mudslide cache folder'))
        .filter(l => !l.trim().startsWith('[proxychains]'))
        .join('\n').trim();
      if (meaningful && !resolved) {
        idleTimer = setTimeout(() => {
          resolved = true;
          resolve({ success: true, qr: stripProxy(output) });
        }, 2000);
      }
    };


    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('close', () => {
      loginProc = null;
      if (idleTimer) clearTimeout(idleTimer);
      if (!resolved) {
        if (output.trim()) resolve({ success: true, qr: stripProxy(output) });
        else reject(new Error('No output from mudslide login'));
      }
    });

    setTimeout(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!resolved) {
        if (output.trim()) resolve({ success: true, qr: stripProxy(output) });
        else { proc.kill(); reject(new Error('QR code timeout')); }
      }
    }, 30000);
  });
}

// Called when the user clicks "Continue" after seeing Google Chrome in Linked Devices.
// The keypress was already sent automatically; this just verifies creds.json exists
// and triggers encryption of .mudslide → .mudslide.enc.
async function confirmLogin(userDir, token) {
  return await checkLoginStatus(userDir, token);
}

async function checkLoginStatus(userDir, token) {
  const encExists = await isLoggedIn(userDir);

  // creds.json is only written by mudslide after a successful QR scan.
  // The .mudslide dir itself is created at login-start (before scan), so
  // we check for creds.json specifically to avoid false positives.
  let plaintextReady = false;
  try {
    await fs.access(path.join(mudslideDir(userDir), 'creds.json'));
    plaintextReady = true;
  } catch {}

  if (plaintextReady && token) {
    await encryptMudslide(userDir, token);
    return { loggedIn: true };
  }

  if (plaintextReady) {
    return { loggedIn: true };
  }

  return { loggedIn: encExists };
}

async function sendMessage(userDir, token, to, message) {
  const credPath = await decryptMudslideToTemp(userDir, token);
  try {
    const output = await runMudslide(['-c', credPath, 'send', to, message], 60000, userDir, token);
    return { success: true, message: 'Message sent successfully', output };
  } finally {
    await cleanupTemp(userDir);
  }
}

async function sendMedia(userDir, token, to, mediaPath, caption = '') {
  const credPath = await decryptMudslideToTemp(userDir, token);
  try {
    const ext = mediaPath.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const cmd = isImage ? 'send-image' : 'send-file';
    const args = ['-c', credPath, cmd, to, mediaPath];
    if (caption) args.push('--caption', caption);
    const output = await runMudslide(args, 60000, userDir, token);
    return { success: true, message: 'Media sent successfully', output };
  } finally {
    await cleanupTemp(userDir);
  }
}

async function getGroups(userDir, token) {
  const credPath = await decryptMudslideToTemp(userDir, token);
  try {
    const output = await runMudslide(['-c', credPath, 'groups'], 60000, userDir, token);

    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        return parsed.map(g => ({ name: g.subject || g.name || g.id, id: g.id })).filter(g => g.id);
      }
    } catch {}

    return output.split('\n').filter(Boolean).map(line => {
      try {
        const g = JSON.parse(line);
        if (g && g.id) return { name: g.subject || g.name || g.id, id: g.id };
      } catch {}
      const match = line.match(/^(.*?)\s*\(([^)]+@g\.us)\)\s*$/);
      if (match) return { name: match[1].trim(), id: match[2].trim() };
      if (line.includes('@g.us')) return { name: line.trim(), id: line.trim() };
      return null;
    }).filter(Boolean);
  } finally {
    await cleanupTemp(userDir);
  }
}

// Attempts a graceful mudslide logout (signals WhatsApp to disconnect the device).
// Called fire-and-forget from the route — file cleanup happens in cleanupAfterLogout().
async function logout(userDir, token) {
  if (!token) return;
  try {
    const credPath = await decryptMudslideToTemp(userDir, token);
    await runMudslide(['-c', credPath, 'logout'], 60000, userDir, token);
  } catch {}
  await cleanupTemp(userDir).catch(() => {});
}

// Deletes the encrypted session files after the user has confirmed the device
// is removed from WhatsApp Linked Devices.
async function cleanupAfterLogout(userDir) {
  await fs.rm(mudslideDir(userDir), { recursive: true, force: true });
  await fs.rm(mudslideEncFile(userDir), { force: true });
}

module.exports = {
  isLoggedIn,
  getQRCode,
  confirmLogin,
  checkLoginStatus,
  sendMessage,
  sendMedia,
  getGroups,
  logout,
  cleanupAfterLogout,
  encryptMudslide,
  decryptMudslideToTemp,
  cleanupTemp
};
