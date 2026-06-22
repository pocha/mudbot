const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { encryptData, decryptData } = require('./userService');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

function generateScheduleId() {
  return crypto.randomBytes(8).toString('hex');
}

function scheduleDir(userDir, scheduleId) {
  return path.join(CONFIG.USERS_DIR, userDir, 'schedules', scheduleId);
}

async function writeSchedule(userDir, email, scheduleId, schedule) {
  const file = path.join(scheduleDir(userDir, scheduleId), 'schedule.json');
  await fs.writeFile(file, encryptData(JSON.stringify(schedule), email));
}

async function readSchedule(userDir, email, scheduleId) {
  const file = path.join(scheduleDir(userDir, scheduleId), 'schedule.json');
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(decryptData(raw, email));
}

async function createSchedule(userDir, email, scheduleData) {
  const scheduleId = generateScheduleId();
  await fs.mkdir(scheduleDir(userDir, scheduleId), { recursive: true });

  const schedule = {
    id: scheduleId,
    name: scheduleData.name,
    recipients: scheduleData.recipients,
    message: scheduleData.message,
    media: scheduleData.media || null,
    cronExpression: scheduleData.cronExpression,
    enabled: scheduleData.enabled !== false,
    createdAt: new Date().toISOString(),
    lastRun: null
  };

  await writeSchedule(userDir, email, scheduleId, schedule);
  return schedule;
}

async function listSchedules(userDir, email) {
  const dir = path.join(CONFIG.USERS_DIR, userDir, 'schedules');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const schedules = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          schedules.push(await readSchedule(userDir, email, entry.name));
        } catch (err) {
          console.error(`Error reading schedule ${entry.name}:`, err.message);
        }
      }
    }
    return schedules;
  } catch {
    return [];
  }
}

async function getSchedule(userDir, email, scheduleId) {
  try {
    return await readSchedule(userDir, email, scheduleId);
  } catch {
    return null;
  }
}

async function updateSchedule(userDir, email, scheduleId, updates) {
  const schedule = await getSchedule(userDir, email, scheduleId);
  if (!schedule) throw new Error('Schedule not found');

  Object.assign(schedule, updates);
  schedule.updatedAt = new Date().toISOString();

  await writeSchedule(userDir, email, scheduleId, schedule);
  return schedule;
}

async function deleteSchedule(userDir, email, scheduleId) {
  await removeCronJob(userDir, scheduleId);
  await fs.rm(scheduleDir(userDir, scheduleId), { recursive: true, force: true });
  return { success: true };
}

async function getScheduleLogs(userDir, scheduleId, limit = 50) {
  const logsFile = path.join(scheduleDir(userDir, scheduleId), 'logs.txt');
  try {
    const data = await fs.readFile(logsFile, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

async function appendLog(userDir, scheduleId, logEntry) {
  const logsFile = path.join(scheduleDir(userDir, scheduleId), 'logs.txt');
  await fs.appendFile(logsFile, `[${new Date().toISOString()}] ${logEntry}\n`);
}

async function addCronJob(userDir, scheduleId, cronExpression) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-schedule.js');
  const cronCommand = `${cronExpression} node ${scriptPath} ${userDir} ${scheduleId}`;
  const cronLabel = `# watobot-${userDir}-${scheduleId}`;

  return new Promise((resolve, reject) => {
    const getCrontab = spawn('crontab', ['-l']);
    let current = '';
    getCrontab.stdout.on('data', d => { current += d.toString(); });
    getCrontab.stderr.on('data', () => {});

    getCrontab.on('close', () => {
      const lines = current.split('\n')
        .filter(l => !l.includes(`watobot-${userDir}-${scheduleId}`));
      lines.push(cronLabel, cronCommand, '');

      const setCrontab = spawn('crontab', ['-']);
      setCrontab.stdin.write(lines.join('\n'));
      setCrontab.stdin.end();
      setCrontab.on('close', code => {
        if (code === 0) resolve({ success: true });
        else reject(new Error('Failed to update crontab'));
      });
    });
  });
}

async function removeCronJob(userDir, scheduleId) {
  return new Promise((resolve) => {
    const getCrontab = spawn('crontab', ['-l']);
    let current = '';
    getCrontab.stdout.on('data', d => { current += d.toString(); });
    getCrontab.stderr.on('data', () => {});

    getCrontab.on('close', () => {
      const lines = current.split('\n')
        .filter(l => !l.includes(`watobot-${userDir}-${scheduleId}`));

      const setCrontab = spawn('crontab', ['-']);
      setCrontab.stdin.write(lines.join('\n'));
      setCrontab.stdin.end();
      setCrontab.on('close', () => resolve({ success: true }));
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
