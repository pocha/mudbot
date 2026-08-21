const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { writeUserFile, readUserFile, generateCalendlyKey } = require('./userService');
const mudslideService = require('./mudslideService');
const ApiError = require('./apiError');

const CREATE_LEAD_FUNCTION_URL = 'https://asia-south1-wato-bot.cloudfunctions.net/createLead';

const CONFIG = {
  USERS_DIR: path.join(__dirname, '..', 'users')
};

const CALENDLY_AUTH_BASE_URL = process.env.CALENDLY_AUTH_BASE_URL || 'https://auth.calendly.com';
const CALENDLY_API_BASE_URL = process.env.CALENDLY_API_BASE_URL || 'https://api.calendly.com';

function calendlyFile(userDir) {
  return path.join(CONFIG.USERS_DIR, userDir, 'calendly.json');
}

async function readConfig(userDir, token) {
  try {
    return JSON.parse(await readUserFile(calendlyFile(userDir), token));
  } catch {
    return { connected: false, meetings: {} };
  }
}

async function writeConfig(userDir, token, config) {
  await writeUserFile(calendlyFile(userDir), JSON.stringify(config), token);
}

// The OAuth callback is a plain browser redirect from Calendly — there's no
// Authorization header on it, but writing calendly.json needs the user's
// session token as the AES key. So /api/calendly/authorize (which does have
// the token, via authenticateUser) stashes {userDir, token} here under a
// random single-use nonce, passed through as Calendly's `state` param, and
// the callback looks it up. In-memory only (single-process deployment,
// matches the rest of this codebase's per-process assumptions) with a short
// TTL — this is a transient OAuth handshake value, not user data.
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingConnects = new Map();

function createPendingConnect(userDir, token) {
  const nonce = crypto.randomBytes(16).toString('hex');
  pendingConnects.set(nonce, { userDir, token, expiresAt: Date.now() + PENDING_TTL_MS });
  return nonce;
}

function consumePendingConnect(nonce) {
  const entry = pendingConnects.get(nonce);
  pendingConnects.delete(nonce);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

function getAuthorizeUrl(userDir, token) {
  const state = createPendingConnect(userDir, token);
  const params = new URLSearchParams({
    client_id: process.env.CALENDLY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.CALENDLY_REDIRECT_URI,
    state
  });
  return `${CALENDLY_AUTH_BASE_URL}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const res = await fetch(`${CALENDLY_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.CALENDLY_CLIENT_ID,
      client_secret: process.env.CALENDLY_CLIENT_SECRET,
      redirect_uri: process.env.CALENDLY_REDIRECT_URI
    })
  });
  if (!res.ok) throw new Error(`Calendly token exchange failed: ${res.status}`);
  return res.json();
}

// Calendly rotates the refresh token on every use — the new one is always
// persisted, or the next refresh would fail with a stale token.
async function refreshAccessToken(userDir, token, config) {
  const res = await fetch(`${CALENDLY_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: process.env.CALENDLY_CLIENT_ID,
      client_secret: process.env.CALENDLY_CLIENT_SECRET
    })
  });
  if (!res.ok) throw new Error(`Calendly token refresh failed: ${res.status}`);
  const data = await res.json();

  config.accessToken = data.access_token;
  config.refreshToken = data.refresh_token;
  config.expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await writeConfig(userDir, token, config);
  return config;
}

// Serializes refreshes per user so two near-simultaneous webhook calls don't
// both refresh and have the second overwrite the first's (already rotated)
// refresh token with a stale one.
const refreshLocks = new Map();

async function getValidAccessToken(userDir, token) {
  let config = await readConfig(userDir, token);
  if (!config.connected) throw new Error('Calendly not connected');

  const expiresSoon = !config.expiresAt || new Date(config.expiresAt).getTime() - Date.now() < 60000;
  if (!expiresSoon) return config.accessToken;

  const pending = refreshLocks.get(userDir) || Promise.resolve();
  const next = pending.then(() => refreshAccessToken(userDir, token, config));
  refreshLocks.set(userDir, next.catch(() => {}));
  config = await next;
  return config.accessToken;
}

async function calendlyApiGet(userDir, token, url) {
  const accessToken = await getValidAccessToken(userDir, token);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Calendly API request failed: ${res.status}`);
  return res.json();
}

async function fetchEventDetails(userDir, token, eventUri) {
  const { resource } = await calendlyApiGet(userDir, token, eventUri);
  return resource;
}

async function fetchInviteeDetails(userDir, token, inviteeUri) {
  const { resource } = await calendlyApiGet(userDir, token, inviteeUri);
  return resource;
}

async function fetchCurrentUser(accessToken) {
  const res = await fetch(`${CALENDLY_API_BASE_URL}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Calendly /users/me failed: ${res.status}`);
  const { resource } = await res.json();
  return resource;
}

// Handles the full OAuth callback: token exchange, connecting the account,
// and (first connection only) generating the permanent Calendly key.
async function completeConnection(userDir, token, code) {
  const tokenData = await exchangeCodeForToken(code);
  const me = await fetchCurrentUser(tokenData.access_token);

  const existing = await readConfig(userDir, token);
  const config = {
    connected: true,
    calendlyUserUri: me.uri,
    calendlyOrgUri: me.current_organization,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
    calendlyKey: existing.calendlyKey || (await generateCalendlyKey(userDir, token)).calendlyKey,
    meetings: existing.meetings || {}
  };
  await writeConfig(userDir, token, config);
  return config;
}

async function disconnect(userDir, token) {
  try { await fs.unlink(calendlyFile(userDir)); } catch {}
}

async function listMeetings(userDir, token) {
  const config = await readConfig(userDir, token);
  return config.meetings || {};
}

async function upsertMeeting(userDir, token, meetingId, meetingData) {
  const config = await readConfig(userDir, token);
  const id = meetingId || crypto.randomUUID();
  const now = new Date().toISOString();
  config.meetings = config.meetings || {};
  config.meetings[id] = {
    eventTypeUri: meetingData.eventTypeUri,
    eventTypeName: meetingData.eventTypeName,
    messageTemplate: meetingData.messageTemplate,
    phoneQuestionName: meetingData.phoneQuestionName || null,
    allowedOrigin: meetingData.allowedOrigin || null,
    createdAt: config.meetings[id]?.createdAt || now,
    updatedAt: now
  };
  await writeConfig(userDir, token, config);
  return { id, ...config.meetings[id] };
}

async function deleteMeeting(userDir, token, meetingId) {
  const config = await readConfig(userDir, token);
  if (config.meetings) delete config.meetings[meetingId];
  await writeConfig(userDir, token, config);
}

function resolveMessageTemplate(template, { name, eventName, eventStartTime }) {
  return template
    .replace(/{{\s*name\s*}}/gi, name || '')
    .replace(/{{\s*event_name\s*}}/gi, eventName || '')
    .replace(/{{\s*event_time\s*}}/gi, eventStartTime ? new Date(eventStartTime).toLocaleString() : '');
}

function extractPhone(invitee, phoneQuestionName) {
  if (phoneQuestionName) {
    const match = (invitee.questions_and_answers || []).find(
      qa => qa.question?.trim().toLowerCase() === phoneQuestionName.trim().toLowerCase()
    );
    if (match?.answer) return { phone: match.answer, phoneSource: 'custom_question' };
  }
  if (invitee.text_reminder_number) {
    return { phone: invitee.text_reminder_number, phoneSource: 'sms_reminder' };
  }
  return { phone: null, phoneSource: 'missing' };
}

function normalizePhone(phone) {
  return phone.replace(/[\s\-()]/g, '');
}

// Fetches the invitee and resolves their phone number in one call — the only
// way callers outside this module need invitee data, so extractPhone/
// normalizePhone/fetchInviteeDetails stay internal rather than each being a
// separate exported step.
async function getUserPhoneFromEvent(userDir, token, inviteeUri, phoneQuestionName) {
  const invitee = await fetchInviteeDetails(userDir, token, inviteeUri);
  const { phone, phoneSource } = extractPhone(invitee, phoneQuestionName);
  return {
    name: invitee.name,
    email: invitee.email,
    phone: phone ? normalizePhone(phone) : null,
    phoneSource
  };
}

// The one-line embed, scoped to one configured meeting:
// <script src="/api/calendly/code?token=...&meetingId=..."></script>
// Listens for Calendly's postMessage event and relays it to
// /api/calendly/<meetingId>/lead.
function buildCalendlyEmbedScript(calendlyKey, meetingId, apiBase = '') {
  return `(function(){
  function isCalendlyEvent(e) {
    return e.origin === "https://calendly.com" && e.data && e.data.event && e.data.event.indexOf("calendly.") === 0;
  }
  window.addEventListener("message", function(e) {
    if (!isCalendlyEvent(e) || e.data.event !== "calendly.event_scheduled") return;
    fetch("${apiBase}/api/calendly/${meetingId}/lead", {
      method: "POST",
      headers: { "x-calendly-key": "${calendlyKey}", "Content-Type": "application/json" },
      body: JSON.stringify({
        event_uri: e.data.payload.event.uri,
        invitee_uri: e.data.payload.invitee.uri
      })
    }).catch(function(){});
  });
})();`;
}

// Orchestrates a booking → lead: validates the event belongs to the
// connected account and matches the given meeting, resolves the invitee's
// phone, sends the WhatsApp message, and stores the resulting lead (via the
// createLead Cloud Function — see functions/index.js; this is the one path
// with no legitimate user browser in the request, so it can't go through
// the frontend's own Security-Rules-checked Firestore writes like every
// other lead-management action does). Throws ApiError with the right
// status for the route to surface directly (not found / ownership
// mismatch), rather than the route hand-rolling each check.
async function createLeadFromCalendlyEvent(userDir, token, meetingId, eventUri, inviteeUri) {
  const config = await readConfig(userDir, token);
  if (!config.connected) throw new ApiError(404, 'Calendly not connected');

  const meeting = config.meetings?.[meetingId];
  if (!meeting) throw new ApiError(404, 'Meeting not found');

  const event = await fetchEventDetails(userDir, token, eventUri);

  // Never trust event_uri/invitee_uri as authorization on their own — confirm
  // this event actually belongs to the connected Calendly account first.
  const belongsToUser = (event.event_memberships || []).some(m => m.user === config.calendlyUserUri);
  if (!belongsToUser) throw new ApiError(403, 'Event does not belong to the connected Calendly account');

  if (event.event_type !== meeting.eventTypeUri) {
    throw new ApiError(400, 'Event type does not match this meeting configuration');
  }

  const { name, email, phone, phoneSource } = await getUserPhoneFromEvent(
    userDir, token, inviteeUri, meeting.phoneQuestionName
  );

  const sourceData = {
    eventUri, inviteeUri, eventTypeUri: event.event_type,
    eventName: event.name, eventStartTime: event.start_time, eventEndTime: event.end_time,
    phoneSource
  };

  if (!phone) {
    await postLead({ userDir, name, email, phone: null, source: 'calendly', calendly: sourceData, status: 'no_phone' });
    return { status: 'no_phone' };
  }

  const message = resolveMessageTemplate(meeting.messageTemplate, {
    name, eventName: event.name, eventStartTime: event.start_time
  });

  let status, messageSent = null, sendError = null;
  try {
    await mudslideService.sendMessage(userDir, token, phone, message);
    status = 'sent';
    messageSent = message;
  } catch (err) {
    status = 'failed';
    sendError = err.message;
  }

  await postLead({ userDir, name, email, phone, source: 'calendly', calendly: sourceData, status, messageSent, sendError });
  return { status };
}

async function postLead(leadData) {
  const res = await fetch(CREATE_LEAD_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(leadData)
  });
  if (!res.ok) {
    // Don't fail the whole webhook response over a lead-storage hiccup — the
    // WhatsApp message (the part the user actually notices) already sent.
    console.error(`createLead call failed: ${res.status}`);
  }
}

module.exports = {
  readConfig,
  getAuthorizeUrl,
  consumePendingConnect,
  completeConnection,
  disconnect,
  fetchEventDetails,
  upsertMeeting,
  deleteMeeting,
  resolveMessageTemplate,
  getUserPhoneFromEvent,
  buildCalendlyEmbedScript,
  createLeadFromCalendlyEvent
};
