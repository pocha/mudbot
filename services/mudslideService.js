const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

const CONFIG = {
  MUDSLIDE_PATH: path.join(__dirname, '..', 'mudslide'),
  USERS_DIR: path.join(__dirname, '..', 'users')
};

// Check if user has Mudslide credentials (is logged in)
async function isLoggedIn(userDir) {
  const credentialsPath = path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
  
  try {
    await fs.access(credentialsPath);
    // Check if directory has session files
    const files = await fs.readdir(credentialsPath);
    return files.length > 0;
  } catch (error) {
    return false;
  }
}

// Get QR code for WhatsApp login
async function getQRCode(userDir) {
  return new Promise((resolve, reject) => {
    const credentialsPath = path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
    
    const mudslide = spawn(CONFIG.MUDSLIDE_PATH, [
      '-c', credentialsPath,
      'qr'
    ]);
    
    let qrData = '';
    let errorData = '';
    
    mudslide.stdout.on('data', (data) => {
      qrData += data.toString();
    });
    
    mudslide.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    mudslide.on('close', (code) => {
      if (code === 0) {
        // Extract QR code from output
        resolve({ success: true, qr: qrData.trim() });
      } else {
        reject(new Error(errorData || 'Failed to generate QR code'));
      }
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      mudslide.kill();
      reject(new Error('QR code generation timeout'));
    }, 30000);
  });
}

// Check login status by attempting to verify connection
async function checkLoginStatus(userDir) {
  const loggedIn = await isLoggedIn(userDir);
  
  if (!loggedIn) {
    return { loggedIn: false };
  }
  
  // Additional verification by trying to get connection info
  return new Promise((resolve) => {
    const credentialsPath = path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
    
    const mudslide = spawn(CONFIG.MUDSLIDE_PATH, [
      '-c', credentialsPath,
      'info'
    ]);
    
    let outputData = '';
    
    mudslide.stdout.on('data', (data) => {
      outputData += data.toString();
    });
    
    mudslide.on('close', (code) => {
      if (code === 0) {
        resolve({ loggedIn: true, info: outputData.trim() });
      } else {
        resolve({ loggedIn: false });
      }
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      mudslide.kill();
      resolve({ loggedIn: false });
    }, 10000);
  });
}

// Send WhatsApp message
async function sendMessage(userDir, to, message) {
  return new Promise((resolve, reject) => {
    const credentialsPath = path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
    
    const mudslide = spawn(CONFIG.MUDSLIDE_PATH, [
      '-c', credentialsPath,
      'send',
      to,
      message
    ]);
    
    let outputData = '';
    let errorData = '';
    
    mudslide.stdout.on('data', (data) => {
      outputData += data.toString();
    });
    
    mudslide.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    mudslide.on('close', (code) => {
      if (code === 0) {
        resolve({ 
          success: true, 
          message: 'Message sent successfully',
          output: outputData.trim()
        });
      } else {
        reject(new Error(errorData || 'Failed to send message'));
      }
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      mudslide.kill();
      reject(new Error('Message send timeout'));
    }, 30000);
  });
}

// Send message with media (image, document, etc.)
async function sendMedia(userDir, to, mediaPath, caption = '') {
  return new Promise((resolve, reject) => {
    const credentialsPath = path.join(CONFIG.USERS_DIR, userDir, '.mudslide');
    
    const args = [
      '-c', credentialsPath,
      'send',
      to,
      '--media', mediaPath
    ];
    
    if (caption) {
      args.push('--caption', caption);
    }
    
    const mudslide = spawn(CONFIG.MUDSLIDE_PATH, args);
    
    let outputData = '';
    let errorData = '';
    
    mudslide.stdout.on('data', (data) => {
      outputData += data.toString();
    });
    
    mudslide.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    mudslide.on('close', (code) => {
      if (code === 0) {
        resolve({ 
          success: true, 
          message: 'Media sent successfully',
          output: outputData.trim()
        });
      } else {
        reject(new Error(errorData || 'Failed to send media'));
      }
    });
    
    // Timeout after 60 seconds for media upload
    setTimeout(() => {
      mudslide.kill();
      reject(new Error('Media send timeout'));
    }, 60000);
  });
}

module.exports = {
  isLoggedIn,
  getQRCode,
  checkLoginStatus,
  sendMessage,
  sendMedia
};
