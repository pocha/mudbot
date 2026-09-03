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
      const status = await mudslideService.isWhatsappConnected(request.user.userDir, request.user.token);
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
      const { email, skipWhatsappConnect, next } = request.body;
      if (!email || !email.includes('@')) {
        return reply.code(400).send({ error: 'Valid email is required' });
      }
      // `next` only ever needs to survive a same-origin redirect after the
      // magic link is clicked — reject anything that isn't a bare relative
      // path so this can't be turned into an open redirect via the email.
      let safeNext = typeof next === 'string' && /^\/[^/\\].*$/.test(next) && !next.startsWith('//') ? next : null;
      // Legacy flag from callers (e.g. the FAQ tool) that don't need the
      // WhatsApp QR wizard at all — verify.html no longer branches on
      // whatsappConnected itself, so this now just becomes an explicit
      // `next` straight to the dashboard, same mechanism as any other caller.
      if (!safeNext && skipWhatsappConnect) safeNext = '/dashboard/';
      const { token } = await userService.registerUser(email);
      await emailService.sendRegistrationEmail(email, token, { next: safeNext });
      return { success: true, message: 'Registration email sent. Please check your inbox.' };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Registration failed' });
    }
  });

  // Deliberately doesn't report whatsappConnected — verify.html is a thin
  // gate now (just proves the token and redirects); whatsapp-connect.html
  // is the one place that cares about connection status, and it checks
  // GET /api/whatsapp/status itself once it's actually loaded.
  //
  // The new_registration owner notification fires from here (on
  // firstVerification specifically, not every hit — see verifyToken) rather
  // than from /api/register, since it's meant to signal a real person
  // actually landed on the site, not just that a link was requested. email
  // comes from the query string — verify.html's magic link already carries
  // it, and nothing is persisted server-side before this point (registerUser
  // deliberately writes nothing to disk for a brand-new email, so a
  // mistyped one never leaves an orphaned directory), so this request is
  // the only place that email is available from.
  fastify.get('/api/verify/:token', async (request, reply) => {
    try {
      const user = await userService.verifyToken(request.params.token);
      if (!user) return reply.code(401).send({ error: 'Invalid or expired token' });
      if (user.firstVerification) {
        emailService.sendOwnerNotification('new_registration', { userDir: user.userDir, email: request.query.email }).catch(() => {});
      }
      return { success: true };
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

  // Actually connects to WhatsApp to verify the device is still linked
  // (unlike /status below, which is just a local file check) — costs real
  // seconds and a proxy+mudslide round trip, so this is for one-shot checks
  // (dashboard load) rather than polling.
  fastify.get('/api/whatsapp', { preHandler: authenticateUser }, async (request, reply) => {
    // If the client (e.g. the dashboard's own fetch, on its 40s abort) gives
    // up before this resolves, kill the real mudslide/proxychains4 process
    // behind it instead of letting it run to its own ~60s ceiling regardless
    // — otherwise repeated page refreshes queue up real, uncancelled work
    // (see withSession's per-user queue) that nobody's waiting on anymore.
    const controller = new AbortController();
    const onClientClose = () => controller.abort();
    request.raw.on('close', onClientClose);
    try {
      const { connected, phoneNumber, reason } = await mudslideService.confirmWhatsappIsActuallyConnected(request.user.userDir, request.user.token, controller.signal);
      console.log('DEBUG /api/whatsapp', { userDir: request.user.userDir, connected, phoneNumber, reason });
      return { connected, phoneNumber, reason };
    } catch (error) {
      fastify.log.error(error);
      emailService.notifyOwnerOfError('confirmWhatsappIsActuallyConnected', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to check WhatsApp connection' });
    } finally {
      request.raw.off('close', onClientClose);
    }
  });

  fastify.get('/api/whatsapp/status', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.isWhatsappConnected(request.user.userDir, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to check status' });
    }
  });

  // proxyIp is fetched separately from /status specifically so it doesn't
  // block or slow down status polling / the requireWhatsapp gate on every
  // send — a real proxy+curl round trip only pays off when something is
  // actually going to display the IP.
  fastify.get('/api/whatsapp/ip', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.getWhatsappProxyIp(request.user.userDir, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      emailService.notifyOwnerOfError('getWhatsappProxyIp', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to fetch proxy IP' });
    }
  });

  fastify.get('/api/whatsapp/qr', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.getQRCode(request.user.userDir, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      emailService.notifyOwnerOfError('getQRCode', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to get QR code' });
    }
  });

  fastify.get('/api/whatsapp/groups', { preHandler: [authenticateUser, requireWhatsapp] }, async (request, reply) => {
    try {
      const groups = await mudslideService.getGroups(request.user.userDir, request.user.token);
      return { groups };
    } catch (error) {
      fastify.log.error(error);
      emailService.notifyOwnerOfError('getGroups', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to fetch groups' });
    }
  });

  // Fired once the frontend claims the user's device shows connected — that's
  // just a client-side assertion, so this re-verifies with the real network
  // check (not the cheap isWhatsappConnected requireWhatsapp uses elsewhere)
  // before telling the operator, rather than trusting the claim blindly. On
  // 409 the frontend should show a "not confirmed yet, try again" prompt —
  // same shape requireWhatsapp already returns elsewhere in this file.
  fastify.post('/api/whatsapp/notify-user-connected', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { connected } = await mudslideService.confirmWhatsappIsActuallyConnected(request.user.userDir, request.user.token);
      if (!connected) {
        return reply.code(409).send({ error: 'WhatsApp is not connected yet.', reason: 'whatsapp_not_connected' });
      }
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
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      emailService.notifyOwnerOfError('confirmWhatsappIsActuallyConnected', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to confirm connection' });
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

  // Called after user confirms the device is gone from WhatsApp Linked Devices.
  // Deletes local session files and removes all cron jobs. No mudslide/network
  // call — we no longer ask mudslide to gracefully unlink the device first
  // (that could take up to 60s and its outcome never changed what the user
  // was shown), so the modal goes straight to "please remove it manually".
  fastify.post('/api/whatsapp/logout', { preHandler: authenticateUser }, async (request, reply) => {
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

  // Reconciles the hourly device-connectivity-monitor cron for this user —
  // called on every dashboard load. Deliberately never touches
  // schedules.json (unlike createSchedule/listSchedules above), so this
  // never shows up in the user-facing schedule list; DEVICE_CHECK_SCHEDULE_ID
  // is a fixed, reserved id, never the random hex generateScheduleId() uses.
  fastify.post('/api/schedules/device-connection-check', { preHandler: authenticateUser }, async (request, reply) => {
    const DEVICE_CHECK_SCHEDULE_ID = 'device-check';
    try {
      const { userDir, token } = request.user;
      const [{ connected }, apiKeyStatus] = await Promise.all([
        mudslideService.confirmWhatsappIsActuallyConnected(userDir, token),
        userService.getApiKeyStatus(userDir)
      ]);

      if (!(connected && apiKeyStatus.permanent)) {
        await scheduleService.removeCronJob(userDir, DEVICE_CHECK_SCHEDULE_ID);
        return { monitoring: false };
      }

      if (!(await scheduleService.hasCronJob(userDir, DEVICE_CHECK_SCHEDULE_ID))) {
        const payload = scheduleService.buildCronPayload(token, { type: 'check-connection' });
        await scheduleService.addCronJob(userDir, DEVICE_CHECK_SCHEDULE_ID, '0 * * * *', payload);
      }
      return { monitoring: true };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to reconcile device monitor' });
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
      const { returnTo } = request.query || {};
      // Same relative-path-only rule as /api/register's `next` — this
      // round-trips through Calendly's own redirect, so it's exactly as
      // exposed to tampering as an emailed link.
      const safeReturnTo = typeof returnTo === 'string' && /^\/[^/\\].*$/.test(returnTo) && !returnTo.startsWith('//') ? returnTo : null;
      return { url: calendlyService.getAuthorizeUrl(request.user.userDir, request.user.token, safeReturnTo) };
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
      const returnTo = pending.returnTo || '/dashboard/calendly.html';
      const separator = returnTo.includes('?') ? '&' : '?';
      return reply.redirect(`${frontendBase}${returnTo}${separator}connected=1`);
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
