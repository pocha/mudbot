const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

// Helper to generate unique schedule ID
function generateScheduleId() {
  return crypto.randomBytes(8).toString('hex');
}

// Create a new schedule
async function createSchedule(userDir, scheduleData) {
  const scheduleId = generateScheduleId();
  const schedulesDir = path.join(CONFIG.USERS_DIR, userDir, 'schedules');
  const scheduleDir = path.join(schedulesDir, scheduleId);
  
  // Create schedule directory
  await fs.mkdir(scheduleDir, { recursive: true });
  
  // Prepare schedule metadata
  const schedule = {
    id: scheduleId,
    name: scheduleData.name,
    recipients: scheduleData.recipients, // Array of phone numbers
    message: scheduleData.message,
    media: scheduleData.media || null, // Optional media path
    cronExpression: scheduleData.cronExpression,
    enabled: scheduleData.enabled !== false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null
  };
  
  // Save schedule metadata
  await fs.writeFile(
    path.join(scheduleDir, 'schedule.json'),
    JSON.stringify(schedule, null, 2)
  );
  
  return schedule;
}

// List all schedules for a user
async function listSchedules(userDir) {
  const schedulesDir = path.join(CONFIG.USERS_DIR, userDir, 'schedules');
  
  try {
    const entries = await fs.readdir(schedulesDir, { withFileTypes: true });
    const schedules = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const scheduleFile = path.join(schedulesDir, entry.name, 'schedule.json');
        try {
          const data = await fs.readFile(scheduleFile, 'utf8');
          schedules.push(JSON.parse(data));
        } catch (error) {
          // Skip invalid schedules
          console.error(`Error reading schedule ${entry.name}:`, error.message);
        }
      }
    }
    
    return schedules;
  } catch (error) {
    return [];
  }
}

// Get a specific schedule
async function getSchedule(userDir, scheduleId) {
  const scheduleFile = path.join(CONFIG.USERS_DIR, userDir, 'schedules', scheduleId, 'schedule.json');
  
  try {
    const data = await fs.readFile(scheduleFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

// Update a schedule
async function updateSchedule(userDir, scheduleId, updates) {
  const schedule = await getSchedule(userDir, scheduleId);
  
  if (!schedule) {
    throw new Error('Schedule not found');
  }
  
  // Merge updates
  Object.assign(schedule, updates);
  schedule.updatedAt = new Date().toISOString();
  
  // Save updated schedule
  const scheduleFile = path.join(CONFIG.USERS_DIR, userDir, 'schedules', scheduleId, 'schedule.json');
  await fs.writeFile(scheduleFile, JSON.stringify(schedule, null, 2));
  
  return schedule;
}

// Delete a schedule
async function deleteSchedule(userDir, scheduleId) {
  const scheduleDir = path.join(CONFIG.USERS_DIR, userDir, 'schedules', scheduleId);
  
  try {
    // Remove from crontab first
    await removeCronJob(userDir, scheduleId);
    
    // Delete schedule directory
    await fs.rm(scheduleDir, { recursive: true, force: true });
    
    return { success: true };
  } catch (error) {
    throw new Error(`Failed to delete schedule: ${error.message}`);
  }
}

// Get schedule logs
async function getScheduleLogs(userDir, scheduleId, limit = 50) {
  const logsFile = path.join(CONFIG.USERS_DIR, userDir, 'schedules', scheduleId, 'logs.txt');
  
  try {
    const data = await fs.readFile(logsFile, 'utf8');
    const lines = data.trim().split('\n');
    
    // Return last N lines
    return lines.slice(-limit);
  } catch (error) {
    return [];
  }
}

// Append log entry
async function appendLog(userDir, scheduleId, logEntry) {
  const logsFile = path.join(CONFIG.USERS_DIR, userDir, 'schedules', scheduleId, 'logs.txt');
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${logEntry}\n`;
  
  await fs.appendFile(logsFile, logLine);
}

// Add cron job for schedule
async function addCronJob(userDir, scheduleId, cronExpression) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'run-schedule.sh');
    const cronCommand = `${cronExpression} ${scriptPath} ${userDir} ${scheduleId}`;
    const cronLabel = `# mudbot-${userDir}-${scheduleId}`;
    
    // Get current crontab
    const getCrontab = spawn('crontab', ['-l']);
    let currentCrontab = '';
    
    getCrontab.stdout.on('data', (data) => {
      currentCrontab += data.toString();
    });
    
    getCrontab.on('close', (code) => {
      // Remove old entry if exists
      const lines = currentCrontab.split('\n').filter(line => 
        !line.includes(`mudbot-${userDir}-${scheduleId}`)
      );
      
      // Add new entry
      lines.push(cronLabel);
      lines.push(cronCommand);
      lines.push(''); // Empty line at end
      
      const newCrontab = lines.join('\n');
      
      // Set new crontab
      const setCrontab = spawn('crontab', ['-']);
      setCrontab.stdin.write(newCrontab);
      setCrontab.stdin.end();
      
      setCrontab.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          reject(new Error('Failed to update crontab'));
        }
      });
    });
  });
}

// Remove cron job for schedule
async function removeCronJob(userDir, scheduleId) {
  return new Promise((resolve, reject) => {
    // Get current crontab
    const getCrontab = spawn('crontab', ['-l']);
    let currentCrontab = '';
    
    getCrontab.stdout.on('data', (data) => {
      currentCrontab += data.toString();
    });
    
    getCrontab.stderr.on('data', () => {
      // Ignore stderr (might be "no crontab for user")
    });
    
    getCrontab.on('close', () => {
      // Remove entries related to this schedule
      const lines = currentCrontab.split('\n').filter(line => 
        !line.includes(`mudbot-${userDir}-${scheduleId}`)
      );
      
      const newCrontab = lines.join('\n');
      
      // Set new crontab
      const setCrontab = spawn('crontab', ['-']);
      setCrontab.stdin.write(newCrontab);
      setCrontab.stdin.end();
      
      setCrontab.on('close', (code) => {
        resolve({ success: true });
      });
    });
  });
}

module.exports = {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  getScheduleLogs,
  appendLog,
  addCronJob,
  removeCronJob
};
