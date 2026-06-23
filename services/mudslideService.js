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
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.MUDSLIDE_PATH, ['-c', credentialsPath(userDir), 'login']);
    let output = '';
    let idleTimer = null;

    const onData = (data) => {
      output += data.toString();
      // Reset idle timer — resolve 2s after output stops (QR fully printed)
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        resolve({ success: true, qr: output.trim() });
      }, 2000);
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    // If process exits cleanly before idle (e.g. already logged in)
    proc.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (output.trim()) resolve({ success: true, qr: output.trim() });
      else reject(new Error('No output from mudslide login'));
    });

    // Hard timeout — kill only if no output at all
    setTimeout(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (output.trim()) resolve({ success: true, qr: output.trim() });
      else { proc.kill(); reject(new Error('QR code timeout')); }
    }, 30000);
  });
}

async function checkLoginStatus(userDir) {
  if (!(await isLoggedIn(userDir))) return { loggedIn: false };
  // Credentials exist — consider connected without a live check,
  // since `me` requires an active WA connection and can fail transiently.
  return { loggedIn: true };
}

async function sendMessage(userDir, to, message) {
  const output = await runMudslide(['-c', credentialsPath(userDir), 'send', to, message], 30000);
  return { success: true, message: 'Message sent successfully', output };
}

async function sendMedia(userDir, to, mediaPath, caption = '') {
  const ext = mediaPath.split('.').pop().toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
  const cmd = isImage ? 'send-image' : 'send-file';
  const args = ['-c', credentialsPath(userDir), cmd, to, mediaPath];
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
