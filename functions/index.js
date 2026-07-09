const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

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

// Parsing and capping-by-size now happens client-side
// (public/assets/whatsapp-parser.js) so large exports never have to be
// uploaded. This is re-applied here only as a defensive backstop against a
// client sending an unbounded array directly to the endpoint — not a claim
// that the client's cap can be trusted. Same size-based approach as the
// client: a flat message count badly under-serves long-running, bursty
// groups (see capMessagesBySize's twin in whatsapp-parser.js for why).
const MAX_MESSAGES_CHARS = 900000; // headroom under Firestore's 1MiB doc limit

function capMessagesBySize(messages, maxChars) {
  let total = 0;
  let startIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const size = JSON.stringify(messages[i]).length;
    if (total + size > maxChars) break;
    total += size;
    startIndex = i;
  }

  return messages.slice(startIndex);
}

// Unauthenticated: accepts a pre-parsed, pre-capped message array (JSON body)
// and creates a Firestore job doc. processFaqJob (below) picks it up and does
// the Gemini call.
exports.submitFaqUpload = onRequest({ cors: true, timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { groupName, messages } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      res.status(400).json({ error: 'No messages provided.' });
      return;
    }

    const capped = capMessagesBySize(messages, MAX_MESSAGES_CHARS);

    const jobRef = db.collection('faqJobs').doc();
    await jobRef.set({
      groupName: groupName || 'WhatsApp Group',
      source: 'upload',
      state: 'queued',
      messageCount: capped.length,
      messages: capped,
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
// timeoutSeconds raised from the 60s default: callGeminiForFaq can now wait
// out a 429's retry delay (commonly ~15s) before retrying, on top of the
// generation call itself.
exports.processFaqJob = onDocumentCreated({ document: 'faqJobs/{jobId}', secrets: [geminiApiKey], timeoutSeconds: 120 }, async (event) => {
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
