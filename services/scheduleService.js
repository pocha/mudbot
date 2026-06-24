const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { encryptData, decryptData, computeTokenHash } = require('./userService');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

function generateScheduleId() {
  return crypto.randomBytes(8).toString('hex');
}

function scheduleDir(userDir, scheduleId) {
  return path.join(CONFIG.USERS_DIR, userDir, 'schedules', scheduleId);
}

async function writeSchedule(userDir, token, scheduleId, schedule) {
  const file = path.join(scheduleDir(userDir, scheduleId), 'schedule.json');
  await fs.writeFile(file, encryptData(JSON.stringify(schedule), token));
}

async function readSchedule(userDir, token, scheduleId) {
  const file = path.join(scheduleDir(userDir, scheduleId), 'schedule.json');
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(decryptData(raw, token));
}

// Encrypts {token, recipients, message, media} using sha256(token) as key.
// scheduleId stays outside this payload as a plaintext cron argv.
function buildCronPayload(token, scheduleData) {
  const key = Buffer.from(computeTokenHash(token), 'hex');
  const iv = crypto.randomBytes(16);
  const payload = JSON.stringify({
    token,
    recipients: scheduleData.recipients,
    message: scheduleData.message,
    media: scheduleData.media || null
  });
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64url');
}

async function createSchedule(userDir, token, scheduleData) {
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

  await writeSchedule(userDir, token, scheduleId, schedule);

  const encryptedPayload = buildCronPayload(token, schedule);
  await addCronJob(userDir, scheduleId, schedule.cronExpression, encryptedPayload);

  return schedule;
}

async function listSchedules(userDir, token) {
  const dir = path.join(CONFIG.USERS_DIR, userDir, 'schedules');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const schedules = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          schedules.push(await readSchedule(userDir, token, entry.name));
        } catch (err) {
          // Decryption failure means the schedule belongs to a previous token.
          // Delete it so stale data doesn't accumulate.
          console.error(`Deleting unreadable schedule ${entry.name}:`, err.message);
          await fs.rm(scheduleDir(userDir, entry.name), { recursive: true, force: true });
        }
      }
    }
    return schedules;
  } catch {
    return [];
  }
}

async function getSchedule(userDir, token, scheduleId) {
  try {
    return await readSchedule(userDir, token, scheduleId);
  } catch {
    return null;
  }
}

async function updateSchedule(userDir, token, scheduleId, updates) {
  const schedule = await getSchedule(userDir, token, scheduleId);
  if (!schedule) throw new Error('Schedule not found');

  Object.assign(schedule, updates);
  schedule.updatedAt = new Date().toISOString();

  await writeSchedule(userDir, token, scheduleId, schedule);

  // Rebuild cron entry with fresh encrypted payload
  await removeCronJob(userDir, scheduleId);
  const encryptedPayload = buildCronPayload(token, schedule);
  await addCronJob(userDir, scheduleId, schedule.cronExpression, encryptedPayload);

  return schedule;
}

async function deleteSchedule(userDir, token, scheduleId) {
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

async function addCronJob(userDir, scheduleId, cronExpression, encryptedPayload) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-schedule.js');
  const nodePath = process.execPath; // full path to the node binary running this server
  const cronCommand = `${cronExpression} ${nodePath} ${scriptPath} ${userDir} ${scheduleId} ${encryptedPayload}`;
  const cronLabel = `# mudbot-${userDir}-${scheduleId}`;

  return new Promise((resolve, reject) => {
    const getCrontab = spawn('crontab', ['-l']);
    let current = '';
    getCrontab.stdout.on('data', d => { current += d.toString(); });
    getCrontab.stderr.on('data', () => {});

    getCrontab.on('close', () => {
      const lines = current.split('\n')
        .filter(l => !l.includes(`mudbot-${userDir}-${scheduleId}`) &&
                    !l.includes(`run-schedule.js ${userDir} ${scheduleId} `))
        .filter(l => l.trim() !== ''); // strip blank lines
      lines.push(cronLabel, cronCommand);

      const setCrontab = spawn('crontab', ['-']);
      setCrontab.stdin.write(lines.join('\n') + '\n');
      setCrontab.stdin.end();
      setCrontab.on('close', code => {
        if (code === 0) resolve({ success: true });
        else reject(new Error('Failed to update crontab'));
      });
    });
  });
}

async function removeAllCronJobs(userDir) {
  return new Promise((resolve) => {
    const getCrontab = spawn('crontab', ['-l']);
    let current = '';
    getCrontab.stdout.on('data', d => { current += d.toString(); });
    getCrontab.stderr.on('data', () => {});

    getCrontab.on('close', () => {
      const lines = current.split('\n')
        .filter(l => !l.includes(`mudbot-${userDir}-`) &&
                    !l.includes(`run-schedule.js ${userDir} `))
        .filter(l => l.trim() !== '');

      const setCrontab = spawn('crontab', ['-']);
      setCrontab.stdin.write(lines.join('\n') + '\n');
      setCrontab.stdin.end();
      setCrontab.on('close', () => resolve({ success: true }));
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
        .filter(l => !l.includes(`mudbot-${userDir}-${scheduleId}`) &&
                    !l.includes(`run-schedule.js ${userDir} ${scheduleId} `))
        .filter(l => l.trim() !== '');

      const setCrontab = spawn('crontab', ['-']);
      setCrontab.stdin.write(lines.join('\n') + '\n');
      setCrontab.stdin.end();
      setCrontab.on('close', () => resolve({ success: true }));
    });
  });
}

// Checks all schedule files against crontab; re-adds any missing entries.
// Called on GET /api/schedules to auto-restore cron after a server migration.
async function syncCronJobs(userDir, token) {
  const schedules = await listSchedules(userDir, token);
  if (!schedules.length) return;

  const currentCrontab = await new Promise(resolve => {
    const proc = spawn('crontab', ['-l']);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => resolve(out));
  });

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const label = `# mudbot-${userDir}-${schedule.id}`;
    if (!currentCrontab.includes(label)) {
      const encryptedPayload = buildCronPayload(token, schedule);
      await addCronJob(userDir, schedule.id, schedule.cronExpression, encryptedPayload);
    }
  }
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
  removeCronJob,
  removeAllCronJobs,
  syncCronJobs
};
