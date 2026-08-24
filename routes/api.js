const userService = require('../services/userService');
const emailService = require('../services/emailService');
const mudslideService = require('../services/mudslideService');
const usageService = require('../services/usageService');
const scheduleService = require('../services/scheduleService');
const faqService = require('../services/faqService');
const calendlyService = require('../services/calendlyService');
const countries = require('../services/countries.json');

// Computed at call time, not module load — CLOUD_FUNCTIONS_BASE_URL (set by
// scripts/functions-emulator.js when the local Functions emulator is
// running) may not be known yet when this module is first required.
// Defaults to the real deployed project.
function functionUrl(name) {
  const base = process.env.CLOUD_FUNCTIONS_BASE_URL || 'https://asia-south1-wato-bot.cloudfunctions.net';
  return `${base}/${name}`;
}

async function routes(fastify, options) {

  const authenticateUser = async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      const apiKey = request.headers['x-api-key'];

      if (!token && !apiKey) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const user = token
        ? await userService.verifyToken(token)
        : await userService.verifyApiKey(apiKey);

      if (!user) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      request.user = user;
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Authentication failed' });
    }
  };

  // Only the 2 routes that actually touch mudslide need this (schedules
  // don't — they're only ever executed later by the cron job, not at
  // creation time). Without it, calling these unconnected throws an ENOENT
  // reading the (nonexistent) .mudslide.enc file, surfacing as a raw 500.
  const requireWhatsapp = async (request, reply) => {
    try {
      const status = await mudslideService.confirmWhatsappLogin(request.user.userDir, request.user.token);
      if (!status.loggedIn) {
        return reply.code(409).send({ error: 'WhatsApp is not connected yet.', reason: 'whatsapp_not_connected' });
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to check WhatsApp connection' });
    }
  };

  // Scoped to the Calendly webhook + runtime-script routes only — never
  // accepted by authenticateUser, so a leaked Calendly key can't be used
  // against /api/message or any other route.
  const authenticateCalendlyKey = async (request, reply) => {
    try {
      const key = request.query.token || request.headers['x-calendly-key'];
      if (!key) return reply.code(401).send({ error: 'Integration key required' });

      const user = await userService.verifyCalendlyKey(key);
      if (!user) return reply.code(401).send({ error: 'Invalid integration key' });

      request.user = user;
      request.calendlyKey = key;
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Authentication failed' });
    }
  };

  fastify.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/api/config', async () => ({
    contactEmail: process.env.REPLY_TO || process.env.NOTIFY_EMAIL || ''
  }));

  fastify.post('/api/register', async (request, reply) => {
    try {
      const { email, skipWhatsappConnect } = request.body;
      if (!email || !email.includes('@')) {
        return reply.code(400).send({ error: 'Valid email is required' });
      }
      const { token, userDir } = await userService.registerUser(email);
      await emailService.sendRegistrationEmail(email, token, { skipWhatsappConnect: !!skipWhatsappConnect });
      emailService.sendOwnerNotification('new_registration', { userDir, email }).catch(() => {});
      return { success: true, message: 'Registration email sent. Please check your inbox.' };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Registration failed' });
    }
  });

  fastify.get('/api/verify/:token', async (request, reply) => {
    try {
      const user = await userService.verifyToken(request.params.token);
      if (!user) return reply.code(401).send({ error: 'Invalid or expired token' });

      const whatsappStatus = await mudslideService.confirmWhatsappLogin(user.userDir, user.token);
      return {
        success: true,
        user: {
          whatsappConnected: whatsappStatus.loggedIn
        }
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Verification failed' });
    }
  });

  fastify.post('/api/apikey/generate', async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (!token) return reply.code(401).send({ error: 'Token required' });

      const user = await userService.verifyToken(token);
      if (!user) return reply.code(401).send({ error: 'Invalid token' });

      const { apiKey, expiresAt } = await userService.generateApiKey(user.userDir, user.token);
      return { success: true, apiKey, expiresAt };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to generate API key' });
    }
  });

  fastify.get('/api/apikey/status', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await userService.getApiKeyStatus(request.user.userDir);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get API key status' });
    }
  });

  fastify.get('/api/countries', async () => countries);

  // Country/city are detected AND validated client-side (see public/verify.html
  // — geolocation via ipwho.is for the auto-detect path, Nominatim for manual
  // entry, both called directly from the browser). By the time this route is
  // hit, the city is already trusted, so this just validates the country
  // code (cheap, local, no external call) and persists.
  fastify.post('/api/user/location', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { country, city } = request.body || {};

      if (!country || !city) {
        return reply.code(400).send({ valid: false, reason: 'missing_fields', message: 'Both country and city are required.' });
      }

      const countryEntry = countries.find(c => c.code === country.toLowerCase());
      if (!countryEntry) {
        return reply.code(400).send({ valid: false, reason: 'invalid_country', message: 'Please choose a valid country from the list.' });
      }

      const proxy = await userService.createOrUpdateProxyJson(request.user.userDir, request.user.token, {
        country: countryEntry.code,
        city
      });
      return { valid: true, country: proxy.country, countryName: countryEntry.name, city: proxy.city };

    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ valid: false, reason: 'error', message: 'Something went wrong. Please try again.' });
    }
  });

  fastify.get('/api/user/notify-email', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const email = await userService.getNotifyEmail(request.user.userDir, request.user.token);
      return { email };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get notification email' });
    }
  });

  fastify.post('/api/user/notify-email', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { email } = request.body || {};
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.code(400).send({ error: 'A valid email is required' });
      }
      await userService.createOrUpdateNotifyEmail(request.user.userDir, request.user.token, email);
      return { success: true, email };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to save notification email' });
    }
  });

  fastify.get('/api/whatsapp/status', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.confirmWhatsappLogin(request.user.userDir, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to check status' });
    }
  });

  fastify.get('/api/whatsapp/qr', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.getQRCode(request.user.userDir, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get QR code' });
    }
  });

  fastify.get('/api/whatsapp/groups', { preHandler: [authenticateUser, requireWhatsapp] }, async (request, reply) => {
    try {
      const groups = await mudslideService.getGroups(request.user.userDir, request.user.token);
      return { groups };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch groups' });
    }
  });

  fastify.post('/api/whatsapp/login/confirm', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const status = await mudslideService.confirmWhatsappLogin(request.user.userDir, request.user.token);
      if (status.loggedIn) {
        userService.readUserFile(
          require('path').join(__dirname, '..', 'users', request.user.userDir, 'proxy.json'),
          request.user.token
        ).then(raw => {
          const proxy = JSON.parse(raw);
          emailService.sendOwnerNotification('whatsapp_connected', {
            userDir: request.user.userDir,
            country: proxy.country,
            city: proxy.city
          });
        }).catch(() => {});
      }
      return { success: true, loggedIn: status.loggedIn };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Login confirmation failed' });
    }
  });

  fastify.post('/api/whatsapp/retry-notify', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { email, retryCount } = request.body || {};
      if (!email || !email.includes('@')) return reply.code(400).send({ error: 'Valid email is required' });
      emailService.sendWhatsappRetryEmail(email, retryCount || 1, request.user.userDir).catch(() => {});
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to send retry notification' });
    }
  });

  // Attempts graceful mudslide logout (tells WhatsApp to disconnect the device).
  // Awaits completion (up to 30 s) so the frontend can switch to the "please verify" phase.
  // Always returns success — if mudslide fails the user can remove the device manually.
  fastify.post('/api/whatsapp/logout', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      await mudslideService.whatsappDeviceDisconnect(request.user.userDir, request.user.token);
    } catch (error) {
      fastify.log.error(error);
    }
    return { success: true };
  });

  // Called after user confirms the device is gone from WhatsApp Linked Devices.
  // Deletes local session files and removes all cron jobs.
  fastify.post('/api/whatsapp/logout/confirm', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      await scheduleService.removeAllCronJobs(request.user.userDir);
      await mudslideService.purgeMudslideCache(request.user.userDir);
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Logout confirmation failed' });
    }
  });

  fastify.get('/api/schedules', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      await scheduleService.syncCronJobs(request.user.userDir, request.user.token);
      const schedules = await scheduleService.listSchedules(request.user.userDir, request.user.token);
      return { schedules };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get schedules' });
    }
  });

  fastify.post('/api/schedules', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const schedule = await scheduleService.createSchedule(
        request.user.userDir, request.user.token, request.body
      );
      return { success: true, schedule };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to create schedule' });
    }
  });

  fastify.get('/api/schedules/:id', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const schedule = await scheduleService.getSchedule(
        request.user.userDir, request.user.token, request.params.id
      );
      if (!schedule) return reply.code(404).send({ error: 'Schedule not found' });
      return { schedule };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get schedule' });
    }
  });

  fastify.put('/api/schedules/:id', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const schedule = await scheduleService.updateSchedule(
        request.user.userDir, request.user.token, request.params.id, request.body
      );
      return { success: true, schedule };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to update schedule' });
    }
  });

  fastify.delete('/api/schedules/:id', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      await scheduleService.deleteSchedule(
        request.user.userDir, request.user.token, request.params.id
      );
      return { success: true, message: 'Schedule deleted' };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to delete schedule' });
    }
  });

  fastify.get('/api/usage/logs', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const limit = parseInt(request.query.limit) || 50;
      return await usageService.getUsageLogs(request.user.userDir, limit, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get usage logs' });
    }
  });

  fastify.get('/api/usage/stats', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await usageService.getMessageStats(request.user.userDir, request.query.tz);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get usage stats' });
    }
  });

  fastify.post('/api/message', { preHandler: [authenticateUser, requireWhatsapp] }, async (request, reply) => {
    try {
      const { message, media } = request.body;
      let { to } = request.body;
      if (!to || !message) {
        return reply.code(400).send({ error: 'to and message are required' });
      }
      // Dashboard UI already strips spaces/hyphens/parens from phone numbers
      // client-side (see recipient-number-input in public/dashboard/schedules.html) —
      // API callers (curl, Zapier, etc.) bypass that, so enforce it here too.
      // No-op for group JIDs (...@g.us), which never contain these chars.
      to = to.replace(/[\s\-()]/g, '');
      await (media
        ? mudslideService.sendMedia(request.user.userDir, request.user.token, to, media, message)
        : mudslideService.sendMessage(request.user.userDir, request.user.token, to, message));
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to send message' });
    }
  });

  fastify.get('/api/faq', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const faqs = await faqService.readFaqs(request.user.userDir, request.user.token);
      return { faqs };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get FAQs' });
    }
  });

  // Called by dashboard/faqs.html on load with whatever's sitting in localStorage
  // from an anonymous FAQ-tool publish — this is what actually attaches a
  // jobId to the now-logged-in account.
  fastify.post('/api/faq/claim', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { claims } = request.body || {};
      if (!Array.isArray(claims) || !claims.length) {
        return reply.code(400).send({ error: 'claims array is required' });
      }
      const faqs = await faqService.addFaqs(request.user.userDir, request.user.token, claims);
      return { success: true, faqs };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to claim FAQs' });
    }
  });

  fastify.get('/api/calendly/authorize', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return { url: calendlyService.getAuthorizeUrl(request.user.userDir, request.user.token) };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to start Calendly connection' });
    }
  });

  // Calendly redirects the browser here after consent — no session auth
  // available on this request, so the session token comes from the
  // short-lived pending-connect entry created by /api/calendly/authorize.
  fastify.get('/api/calendly/oauth/callback', async (request, reply) => {
    try {
      const { code, state } = request.query;
      const pending = calendlyService.consumePendingConnect(state);
      if (!code || !pending) return reply.code(400).send({ error: 'Calendly connection expired, please try again' });

      await calendlyService.completeConnection(pending.userDir, pending.token, code);
      // Mirrors dashboard-calendly.html's own API_BASE domain check: locally
      // this Fastify server also serves public/ (same origin), but in
      // production the frontend is a separate GitHub Pages origin
      // (watobot.xyz) from this API server (api.watobot.xyz) — a relative
      // redirect would otherwise resolve against the wrong one.
      const host = request.headers.host || '';
      const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
      const frontendBase = isLocal ? '' : 'https://watobot.xyz';
      return reply.redirect(`${frontendBase}/dashboard/calendly.html?connected=1`);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Calendly connection failed' });
    }
  });

  // Meeting CRUD, connection status display, and leads all live directly in
  // Firestore now (frontend-managed, see views/pages/dashboard-calendly.html
  // and firestore.rules) — this route exists only to hand back the two
  // fields the VM alone can answer (its local encrypted calendly.json), so
  // the frontend can self-heal its Firestore mirror of them on every load.
  fastify.get('/api/calendly/status', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const config = await calendlyService.readConfig(request.user.userDir, request.user.token);
      return {
        connected: !!config.connected,
        calendlyKey: config.calendlyKey || null,
        name: config.calendlyName || null,
        email: config.calendlyEmail || null
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get Calendly status' });
    }
  });

  // Backs the dashboard's "Add from Calendly" picker so users select an
  // event type instead of pasting its booking URL by hand. Response items
  // also carry phone-detection fields (phoneQuestionName/phoneDetectionStatus)
  // computed from the same event type data Calendly already returns here —
  // no separate detection endpoint needed.
  fastify.get('/api/calendly/event-types', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const eventTypes = await calendlyService.getUserCalendars(request.user.userDir, request.user.token);
      return { eventTypes };
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message });
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to load Calendly event types' });
    }
  });

  fastify.post('/api/calendly/disconnect', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      await calendlyService.disconnect(request.user.userDir, request.user.token);
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to disconnect Calendly' });
    }
  });

  // Returns the tiny runtime script the user embeds, scoped to one meeting:
  // <script src="/api/calendly/code?token=...&meetingId=..."></script>.
  // Deliberately does NOT use authenticateCalendlyKey — an invalid/missing
  // token here should never break the visitor's page with a 401, just serve
  // a no-op script.
  fastify.get('/api/calendly/code', async (request, reply) => {
    reply.header('Content-Type', 'application/javascript');
    reply.header('Cache-Control', 'no-store');
    const { token: key, meetingId } = request.query;
    const user = key && meetingId && await userService.verifyCalendlyKey(key);
    if (!user) return '/* invalid calendly integration key */';

    // This script runs on the *customer's* site, not ours — a relative
    // fetch() URL would resolve against their page's own origin, not this
    // API server, and silently never fire (the fetch is wrapped in a bare
    // .catch() so visitors never see the failure). Same domain convention
    // the dashboard frontend already uses for API_BASE.
    const host = request.headers.host || '';
    const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
    const apiBase = isLocal ? `${request.protocol}://${host}` : 'https://api.watobot.xyz';
    return calendlyService.buildCalendlyEmbedScript(key, meetingId, apiBase);
  });

  // Thin by design — all booking→lead logic (ownership check, meeting
  // match, phone resolution, send, store) lives in
  // calendlyService.createLeadFromCalendlyEvent, which throws ApiError with
  // the right status for not-found/ownership-mismatch cases.
  //
  // Doubles as the dashboard's "Test Message" action (Watobot box) via the
  // optional `test: true` body flag — same route, same authenticateCalendlyKey
  // check (the dashboard already has its own calendlyKey from
  // calendlyConfig.calendlyKey), reusing a recently-loaded lead's own
  // event_uri/invitee_uri instead of a real new booking. No separate
  // test-send endpoint.
  fastify.post('/api/calendly/:meetingId/lead', { preHandler: [authenticateCalendlyKey, requireWhatsapp] }, async (request, reply) => {
    try {
      const { event_uri: eventUri, invitee_uri: inviteeUri, test } = request.body || {};
      if (!eventUri || !inviteeUri) return reply.code(400).send({ error: 'event_uri and invitee_uri are required' });

      const { userDir, token } = request.user;
      const meetingId = request.params.meetingId;

      const configRes = await fetch(functionUrl('getCalendlyMeetingConfig'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userDir, meetingId })
      });
      if (!configRes.ok) return reply.code(502).send({ error: 'Failed to load meeting config' });
      const { found, meeting } = await configRes.json();
      if (!found) return reply.code(404).send({ error: 'Meeting not found' });

      const result = await calendlyService.createLeadFromCalendlyEvent(
        userDir, token, meeting, eventUri, inviteeUri, { test: !!test }
      );
      return { success: true, status: result.status };
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message });
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to process Calendly booking' });
    }
  });

  // Leads (listing, editing, deleting, manual creation) are handled directly
  // by the dashboard frontend against Firestore, authenticated with the
  // token this route hands back — see views/pages/dashboard-calendly.html
  // and firestore.rules. This route is the ONLY place that check happens:
  // authenticateUser has already run userService.verifyToken (the real
  // check — it's the sole place with access to the per-user token_hash
  // files that make it possible) before we ever call mintFirebaseToken.
  // That Function itself performs no verification of its own — it can't,
  // it has no access to those files — it just signs whatever (token,
  // userDir) pair it's handed. Calling it directly (bypassing this route)
  // would skip the only real check in the whole flow; it's only safe here
  // because this route is IP-allowlisted as the sole caller (see
  // functions/index.js: isAllowedVmCaller) and always calls it *after*,
  // never before, verification succeeds.
  fastify.get('/api/firebase-token', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { token, userDir } = request.user;
      const res = await fetch(functionUrl('mintFirebaseToken'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, userDir })
      });
      if (!res.ok) return reply.code(502).send({ error: 'Failed to mint Firebase token' });
      const { firebaseToken } = await res.json();
      return { firebaseToken, userDir };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to mint Firebase token' });
    }
  });

}

module.exports = routes;
