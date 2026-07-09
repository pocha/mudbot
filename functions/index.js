const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const Busboy = require('busboy');
const admin = require('firebase-admin');

const { extractChatText, parseWhatsAppChat } = require('./src/zipParser');
const { buildFaqPrompt } = require('./src/prompt');
const { callGeminiForFaq } = require('./src/gemini');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Best-effort only — WhatsApp export date formats vary and aren't reliably
// parseable, so this is used purely as a secondary tie-break under count,
// never surfaced as a guaranteed-accurate value.
function looseDateValue(str) {
  const t = Date.parse(str);
  return Number.isNaN(t) ? 0 : t;
}

function renderFaqHtml(faq) {
  const sorted = [...faq].sort((a, b) => {
    const countDiff = (b.count || 0) - (a.count || 0);
    if (countDiff !== 0) return countDiff;
    return looseDateValue(b.mostRecentDate) - looseDateValue(a.mostRecentDate);
  });

  return sorted
    .map(({ question, count, mostRecentDate, answers = [] }) => {
      const [latest, ...older] = answers;
      const olderHtml = older.length
        ? `
  <details class="mt-2 pl-6">
    <summary class="cursor-pointer font-label-md text-label-md text-primary font-bold">See ${older.length} earlier answer${older.length > 1 ? 's' : ''}</summary>
    <div class="mt-2 space-y-2">
      ${older.map(a => `<p class="font-body-md text-on-surface-variant"><span class="text-xs opacity-70">${escapeHtml(a.date)}</span> — ${escapeHtml(a.text)}</p>`).join('\n      ')}
    </div>
  </details>`
        : '';

      return `
<div class="pb-5 mb-5 border-b border-outline-variant last:border-b-0 last:mb-0 last:pb-0">
  <h3 class="flex gap-2 font-headline-md text-body-lg font-bold text-on-surface">
    <span class="text-primary shrink-0">Q.</span> ${escapeHtml(question)}
  </h3>
  <p class="mt-2 pl-6 font-body-md text-on-surface-variant">${escapeHtml(latest ? latest.text : '')}</p>
  <p class="mt-1 pl-6 text-xs text-on-surface-variant opacity-70">Came up ~${count || 1} time${(count || 1) === 1 ? '' : 's'} &middot; last discussed ${escapeHtml(mostRecentDate || '')}</p>${olderHtml}
</div>`.trim();
    })
    .join('\n');
}

// Mumbai — GCP's only Functions/Firestore region in India (there's no Hyderabad
// region on GCP; that's an AWS-only region, ap-south-2).
setGlobalOptions({ region: 'asia-south1' });

admin.initializeApp();
const db = admin.firestore();

const geminiApiKey = defineSecret('GEMINI_API_KEY');

const MAX_ZIP_BYTES = 10 * 1024 * 1024; // 10MB
// Zip uploads carry the group's full history for free (no live fetch cost),
// and system/join-leave noise is now filtered out before this cap is applied,
// so this can be generous. Still well under Firestore's 1MB doc limit and
// Gemini 3.1 Flash Lite's 250K TPM free-tier ceiling once truncated in
// buildFaqPrompt.
const MAX_MESSAGES = 1500;

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_ZIP_BYTES } });
    let zipBuffer = null;
    let groupName = '';
    let fileTooLarge = false;

    busboy.on('field', (name, val) => {
      if (name === 'groupName') groupName = val;
    });

    busboy.on('file', (_name, file) => {
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('limit', () => { fileTooLarge = true; file.resume(); });
      file.on('end', () => { zipBuffer = Buffer.concat(chunks); });
    });

    busboy.on('finish', () => {
      if (fileTooLarge) return reject(new Error(`Zip file exceeds ${MAX_ZIP_BYTES / (1024 * 1024)}MB limit`));
      if (!zipBuffer || !zipBuffer.length) return reject(new Error('No zip file uploaded'));
      resolve({ groupName, zipBuffer });
    });

    busboy.on('error', reject);
    busboy.end(req.rawBody);
  });
}

// Unauthenticated: accepts a WhatsApp chat-export zip, parses it, and creates a
// Firestore job doc. processFaqJob (below) picks it up and does the Gemini call.
exports.submitFaqUpload = onRequest({ cors: true, memory: '512MiB', timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { groupName, zipBuffer } = await parseMultipart(req);
    const chatText = extractChatText(zipBuffer);
    const messages = parseWhatsAppChat(chatText).slice(-MAX_MESSAGES);

    if (!messages.length) {
      res.status(400).json({ error: 'No messages could be parsed from the uploaded export.' });
      return;
    }

    const jobRef = db.collection('faqJobs').doc();
    await jobRef.set({
      groupName: groupName || 'WhatsApp Group',
      source: 'upload',
      state: 'queued',
      messageCount: messages.length,
      messages,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ jobId: jobRef.id });
  } catch (err) {
    console.error('submitFaqUpload failed:', err);
    res.status(400).json({ error: err.message || 'Upload failed' });
  }
});

// Firestore-triggered worker: does the actual Gemini call asynchronously so the
// upload request itself doesn't have to block on it.
exports.processFaqJob = onDocumentCreated({ document: 'faqJobs/{jobId}', secrets: [geminiApiKey] }, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const job = snap.data();
  const ref = snap.ref;

  try {
    await ref.update({ state: 'generating', updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const prompt = buildFaqPrompt(job.groupName, job.messages || []);
    const faq = await callGeminiForFaq(prompt, geminiApiKey.value());

    await ref.update({
      state: 'done',
      faq, // faqHtml is rendered on read (getFaqStatus) from this, not stored
      messages: admin.firestore.FieldValue.delete(), // keep the doc small once we have the result
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('processFaqJob failed:', err);
    await ref.update({
      state: 'failed',
      error: err.message || 'FAQ generation failed',
      messages: admin.firestore.FieldValue.delete(), // don't retain raw chat content on failure either
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
});

// Unauthenticated: polled by the upload page while a job is in flight.
exports.getFaqStatus = onRequest({ cors: true }, async (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) {
    res.status(400).json({ error: 'jobId is required' });
    return;
  }

  const doc = await db.collection('faqJobs').doc(String(jobId)).get();
  if (!doc.exists) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  const { state, faq, error, groupName, messageCount } = doc.data();
  res.json({
    jobId, state, groupName, messageCount: messageCount || null,
    faq: faq || null, faqHtml: faq ? renderFaqHtml(faq) : null, error: error || null
  });
});
