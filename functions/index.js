const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

const { buildFaqPrompt } = require('./src/prompt');
const { callGeminiForFaq } = require('./src/gemini');
const { renderFaqEntriesHtml, renderFaqPage } = require('./src/faqRender');
const { publishFile } = require('./src/githubPublish');
const { getDeployStatusForCommit } = require('./src/githubDeployStatus');
const { verifyTurnstileToken } = require('./src/turnstile');

// Random, not derived from the group name — two unrelated groups that happen
// to share a display name (e.g. two different "Residents Group"s) would
// otherwise collide and overwrite each other's file, since a name-derived
// hash is identical for identical names. The random suffix is generated once
// per jobId (see publishFaq) and stored in the job doc, so it stays stable
// across every subsequent republish of the same FAQ regardless of later
// group-name edits — the published URL never moves once assigned.
//
// Only the slug is persisted/returned anywhere (Firestore, API responses,
// faq.json) — never a full URL. Callers reconstruct the URL from the slug
// using their own base-URL constant, so there's exactly one place (per
// caller) that knows the actual published domain/path.
function generateFaqSlug(groupName) {
  const slug = groupName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').slice(0, 5);
  return `${slug || 'group'}-${suffix}`;
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
// and creates (or, given an existing jobId, overwrites/resets) a Firestore
// job doc. processFaqJob (below) picks it up and does the Gemini call. Gated
// by Turnstile — this is the expensive-to-abuse step (a real Gemini call
// against a rate-limited quota), unlike getFaqStatus which just reads
// Firestore.
exports.submitFaqUpload = onRequest({ cors: true, timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { groupName, messages, jobId, turnstileToken } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      res.status(400).json({ error: 'No messages provided.' });
      return;
    }

    const verified = await verifyTurnstileToken(turnstileToken, process.env.TURNSTILE_SECRET_KEY, req.ip);
    if (!verified) {
      res.status(400).json({ error: 'Captcha verification failed — please retry.' });
      return;
    }

    const capped = capMessagesBySize(messages, MAX_MESSAGES_CHARS);

    // Reuses the given jobId when present (a regenerate against an existing
    // FAQ project) so the same doc — and the same edit URL — carries forward,
    // rather than minting a new jobId on every resubmit. Firestore only
    // auto-generates an id when .doc() is called with zero arguments —
    // passing an explicit `undefined` (e.g. via `.doc(jobId || undefined)`)
    // still counts as an argument and fails path validation instead.
    const jobRef = jobId ? db.collection('faqJobs').doc(jobId) : db.collection('faqJobs').doc();
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
//
// onDocumentWritten (not onDocumentCreated) — submitFaqUpload now reuses an
// existing jobId for regenerate requests, which is an *update* to an existing
// doc, not a creation. onDocumentCreated only fires on creation, so it would
// silently never re-trigger on a regenerate. The state === 'queued' guard
// below is what keeps this from re-processing the worker's own subsequent
// writes (generating/done/failed), which would otherwise also match.
exports.processFaqJob = onDocumentWritten({ document: 'faqJobs/{jobId}', timeoutSeconds: 120 }, async (event) => {
  const snap = event.data && event.data.after;
  if (!snap || !snap.exists) return;
  const job = snap.data();
  if (job.state !== 'queued') return;
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

  const { state, faq, error, groupName, messageCount, faqSlug } = doc.data();
  res.json({
    jobId, state, groupName, messageCount: messageCount || null,
    faq: faq || null, faqHtml: faq ? renderFaqEntriesHtml(faq) : null, error: error || null,
    faqSlug: faqSlug || null
  });
});

// Unauthenticated: publishes the (possibly user-edited) FAQ as a static page
// committed straight to the repo's public/whatsapp-group-faq/ directory, which
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
    const { groupName, faq, jobId, turnstileToken } = req.body || {};

    if (!jobId) {
      res.status(400).json({ error: 'jobId is required to publish.' });
      return;
    }
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

    const jobRef = db.collection('faqJobs').doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
      res.status(404).json({ error: 'FAQ job not found.' });
      return;
    }

    // Assigned once per jobId and reused on every subsequent publish of the
    // same FAQ, so the URL stays stable even if the group name is edited
    // later (see generateFaqSlug for why it's random rather than
    // name-derived).
    const faqSlug = jobSnap.data().faqSlug || generateFaqSlug(groupName);

    // Persist the (possibly edited) FAQ + the assigned faqSlug back to the
    // job doc before publishing, so both survive a reload / a later visit via
    // ?jobId= — without this, edits made in the browser only ever exist in
    // currentFaq client-side and would silently revert next time
    // getFaqStatus is read. Done before the GitHub commit so a GitHub
    // failure still leaves the edit (and the assigned slug) saved and
    // retriable rather than lost.
    await jobRef.update({
      faq,
      faqSlug,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const repoPath = `public/whatsapp-group-faq/${faqSlug}.html`;
    const html = renderFaqPage(groupName, faq);

    const { commitSha } = await publishFile({
      repoPath,
      content: html,
      message: `Publish FAQ: ${groupName}`,
      token: process.env.GITHUB_TOKEN
    });

    res.json({ commitSha, faqSlug });
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

// --- Leads (Calendly integration) ---
//
// Both functions below are only ever called by the main Watobot VM (never a
// browser) — restricted to its static IP via ALLOWED_VM_IP (functions/.env).
// This is deliberately lighter than GCP IAM invoker restriction: it protects
// against external callers exactly as well (TCP means a caller can't fake a
// source IP and still complete the handshake), and — like IAM — does not
// protect against the VM itself being compromised, since compromised code
// running there would still originate from the allowed IP. What it *does*
// close off: a secrets/config leak that doesn't come with the ability to
// make requests through the VM's own network position no longer yields
// anything usable here.
function isAllowedVmCaller(req) {
  // Firebase sets this automatically under `firebase emulators:start` — a
  // local emulator is by construction only reachable from the machine
  // running it, so the IP check exists to protect the real deployed
  // functions and has nothing to add here. The deployed functions never
  // see this env var set, so this bypass never applies to them.
  if (process.env.FUNCTIONS_EMULATOR === 'true') return true;
  return req.ip === process.env.ALLOWED_VM_IP;
}

// Mirrors models/lead.js's Lead.buildId on the main app, and a third copy in
// the dashboard frontend (views/pages/dashboard-calendly.html) for manual
// lead creation — functions/ is a fully separate deploy target with no
// shared-code mechanism to the main app, so this small pure function is
// deliberately duplicated rather than shared. Keep all three in sync by hand
// if this logic ever changes.
function normalizeLeadField(str) {
  return String(str || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function buildLeadId({ name, email, phone }) {
  const parts = phone
    ? [normalizeLeadField(email), normalizeLeadField(phone)]
    : [normalizeLeadField(name), normalizeLeadField(email)];
  return parts.filter(Boolean).join('_').slice(0, 1400) || `lead_${Date.now()}`;
}

// The only path that ever writes to `leads` outside of the frontend's own
// (Security-Rules-checked) writes — used for bookings coming through the
// Calendly webhook, where there's no legitimate user browser in the request
// at all (it's fired by an anonymous site visitor), so there's no Firebase
// Auth identity to check against Security Rules in the first place.
exports.createLead = onRequest({ timeoutSeconds: 30 }, async (req, res) => {
  if (!isAllowedVmCaller(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { userDir, ...leadData } = req.body || {};
  if (!userDir) {
    res.status(400).json({ error: 'userDir is required' });
    return;
  }
  const id = buildLeadId(leadData);

  await db.collection('users').doc(userDir).collection('leads').doc(id).set({
    ...leadData,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(leadData.status === 'sent' ? {
      messageCount: admin.firestore.FieldValue.increment(1),
      lastSentAt: admin.firestore.FieldValue.serverTimestamp()
    } : {})
  }, { merge: true });

  res.status(200).json({ success: true, id });
});

// Read-only lookup used solely by the Calendly webhook route
// (POST /api/calendly/:meetingId/lead) — the one place with no live frontend
// session to source a meeting's non-secret config (message template,
// auto-send toggle, detected phone question) from directly. Everywhere else,
// the dashboard reads/writes this same data straight from Firestore itself.
exports.getCalendlyMeetingConfig = onRequest({ timeoutSeconds: 15 }, async (req, res) => {
  if (!isAllowedVmCaller(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { userDir, meetingId } = req.body || {};
  if (!userDir || !meetingId) {
    res.status(400).json({ error: 'userDir and meetingId are required' });
    return;
  }

  const snap = await db.collection('users').doc(userDir).get();
  const meeting = snap.exists && snap.data().calendlyConfig?.meetings?.[meetingId];
  if (!meeting) {
    res.status(404).json({ found: false });
    return;
  }

  res.status(200).json({ found: true, meeting });
});

// Mints a Firebase custom token for the dashboard frontend to sign in with.
// The UID is the caller's actual Watobot session token (never stored in
// recoverable form anywhere server-side — only its hash, or data encrypted
// under it — so even a compromised VM can't mint identities for arbitrary or
// dormant users, only whoever's token happens to be in-flight during the
// compromise). `userDir` travels as a custom claim rather than the UID,
// since it's the stable identity `leads` docs are keyed by and Security
// Rules match against — unlike the token, it doesn't change on
// re-registration, so a user keeps access to their existing leads even after
// getting a new login link.
//
// This function performs no verification of its own — it can't; that would
// require the per-user token_hash files that only exist on the VM's local
// disk. It trusts whatever (token, userDir) pair it's given. That's safe
// only because the VM itself already ran the real check (userService.
// verifyToken, via the authenticateUser preHandler) before ever calling
// here — see the comment on GET /api/firebase-token in routes/api.js for
// why that ordering matters and can't be skipped by calling this directly.
exports.mintFirebaseToken = onRequest({ timeoutSeconds: 15 }, async (req, res) => {
  if (!isAllowedVmCaller(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { token, userDir } = req.body || {};
  if (!token || !userDir) {
    res.status(400).json({ error: 'token and userDir are required' });
    return;
  }

  const firebaseToken = await admin.auth().createCustomToken(token, { userDir });
  res.status(200).json({ firebaseToken });
});
