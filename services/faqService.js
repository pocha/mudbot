const path = require('path');
const { writeUserFile, readUserFile } = require('./userService');

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

function faqFile(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, 'faq.json');
}

async function readFaqs(userDir, token) {
  try {
    return JSON.parse(await readUserFile(faqFile(userDir), token));
  } catch {
    return [];
  }
}

// Just the reference (jobId/faqSlug/groupName), not the FAQ content itself —
// Firestore (and the published static page) are the source of truth for
// that; duplicating it here would just be another thing to go stale.
async function addFaqs(userDir, token, entries) {
  const existing = await readFaqs(userDir, token);
  const merged = existing.filter(e => !entries.some(n => n.jobId === e.jobId));
  for (const entry of entries) {
    merged.push({ ...entry, createdAt: entry.createdAt || new Date().toISOString() });
  }
  await writeUserFile(faqFile(userDir), JSON.stringify(merged), token);
  return merged;
}

module.exports = { readFaqs, addFaqs };
