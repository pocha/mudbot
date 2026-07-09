const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

const { buildFaqPrompt } = require('./src/prompt');
const { callGeminiForFaq } = require('./src/gemini');
const { renderFaqEntriesHtml, renderFaqPage } = require('./src/faqRender');
const { publishFile } = require('./src/githubPublish');
const { getDeployStatusForCommit } = require('./src/githubDeployStatus');
const { verifyTurnstileToken } = require('./src/turnstile');

// Deterministic on the group name alone (not a job/session id) so publishing
// the same-named group again always overwrites the same file rather than
// minting a new one each time — matches the "Publish" button's create-or-
// update semantics.
function slugifyGroupName(groupName) {
  const slug = groupName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const hash = crypto.createHash('sha256').update(groupName.trim().toLowerCase()).digest('hex').slice(0, 5);
  return `${slug || 'group'}-${hash}`;
}

// Mumbai — GCP's only Functions/Firestore region in India (there's no Hyderabad
// region on GCP; that's an AWS-only region, ap-south-2).
setGlobalOptions({ region: 'asia-south1' });

admin.initializeApp();
const db = admin.firestore();

// Plain deploy-time env vars (functions/.env, loaded automatically by
// Firebase on deploy) rather than defineSecret/Secret Manager — simpler for
// a solo project, at the cost of not being access-controlled/audited the way
// Secret Manager values are.

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
exports.processFaqJob = onDocumentCreated({ document: 'faqJobs/{jobId}', timeoutSeconds: 120 }, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const job = snap.data();
  const ref = snap.ref;

  try {
    await ref.update({ state: 'generating', updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const prompt = buildFaqPrompt(job.groupName, job.messages || []);
    const faq = await callGeminiForFaq(prompt, process.env.GEMINI_API_KEY);

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
    faq: faq || null, faqHtml: faq ? renderFaqEntriesHtml(faq) : null, error: error || null
  });
});

// Unauthenticated: publishes the (possibly user-edited) FAQ as a static page
// committed straight to the repo's public/whatsapp-groups/ directory, which
// the existing deploy-pages.yml workflow picks up automatically. Gated by
// Turnstile since — unlike submitFaqUpload/getFaqStatus, which only touch
// Firestore — this writes directly into the live site's repo, and is
// reachable by anyone who finds the URL, not just through the UI.
exports.publishFaq = onRequest({ cors: true, timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { groupName, faq, turnstileToken } = req.body || {};

    if (!groupName || !groupName.trim()) {
      res.status(400).json({ error: 'Group name is required to publish.' });
      return;
    }
    if (!Array.isArray(faq) || !faq.length) {
      res.status(400).json({ error: 'No FAQ content to publish.' });
      return;
    }

    const verified = await verifyTurnstileToken(turnstileToken, process.env.TURNSTILE_SECRET_KEY, req.ip);
    if (!verified) {
      res.status(400).json({ error: 'Captcha verification failed — please retry.' });
      return;
    }

    const fileSlug = slugifyGroupName(groupName);
    const repoPath = `public/whatsapp-groups/${fileSlug}.html`;
    const html = renderFaqPage(groupName, faq);

    const { commitSha } = await publishFile({
      repoPath,
      content: html,
      message: `Publish FAQ: ${groupName}`,
      token: process.env.GITHUB_TOKEN
    });

    res.json({ commitSha, faqUrl: `https://watobot.xyz/whatsapp-groups/${fileSlug}.html` });
  } catch (err) {
    console.error('publishFaq failed:', err);
    res.status(500).json({ error: err.message || 'Publish failed' });
  }
});

// Unauthenticated: polled by whatsapp-group-faq/index.html after publishFaq
// returns a commitSha, so the user only gets redirected once GitHub Pages has
// actually finished deploying the new file (not just committed it).
exports.getPublishStatus = onRequest({ cors: true }, async (req, res) => {
  const commitSha = req.query.commitSha;
  if (!commitSha) {
    res.status(400).json({ error: 'commitSha is required' });
    return;
  }

  try {
    const status = await getDeployStatusForCommit(String(commitSha), process.env.GITHUB_TOKEN);
    res.json(status);
  } catch (err) {
    console.error('getPublishStatus failed:', err);
    res.status(500).json({ error: err.message || 'Status check failed' });
  }
});
