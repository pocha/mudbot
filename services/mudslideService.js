const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

const CONFIG = {
  MUDSLIDE_PATH: 'mudslide',
  USERS_DIR: path.join(__dirname, '..', 'users')
};

function credentialsPath(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
}

async function isLoggedIn(userDir) {
  try {
    const files = await fs.readdir(credentialsPath(userDir));
    return files.length > 0;
  } catch {
    return false;
  }
}

function runMudslide(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.MUDSLIDE_PATH, args);
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `mudslide exited with code ${code}`));
    });
  });
}

async function getQRCode(userDir) {
  const qr = await runMudslide(['-c', credentialsPath(userDir), 'qr'], 30000);
  return { success: true, qr };
}

async function checkLoginStatus(userDir) {
  if (!(await isLoggedIn(userDir))) return { loggedIn: false };
  try {
    const info = await runMudslide(['-c', credentialsPath(userDir), 'info'], 10000);
    return { loggedIn: true, info };
  } catch {
    return { loggedIn: false };
  }
}

async function sendMessage(userDir, to, message) {
  const output = await runMudslide(['-c', credentialsPath(userDir), 'send', to, message], 30000);
  return { success: true, message: 'Message sent successfully', output };
}

async function sendMedia(userDir, to, mediaPath, caption = '') {
  const args = ['-c', credentialsPath(userDir), 'send', to, '--media', mediaPath];
  if (caption) args.push('--caption', caption);
  const output = await runMudslide(args, 60000);
  return { success: true, message: 'Media sent successfully', output };
}

async function logout(userDir) {
  await runMudslide(['-c', credentialsPath(userDir), 'logout'], 10000);
  // Remove local session files
  await fs.rm(credentialsPath(userDir), { recursive: true, force: true });
  return { success: true };
}

module.exports = { isLoggedIn, getQRCode, checkLoginStatus, sendMessage, sendMedia, logout };
