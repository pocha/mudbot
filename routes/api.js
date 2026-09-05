const userService = require('../services/userService');
const emailService = require('../services/emailService');
const mudslideService = require('../services/mudslideService');
const usageService = require('../services/usageService');
const scheduleService = require('../services/scheduleService');
const faqService = require('../services/faqService');
const calendlyService = require('../services/calendlyService');
const countries = require('../services/countries.json');

// Shown as-is to the end user whenever mudslideService.isProxyUnreachableError(error) is true — a transient DataImpulse-side issue, not something fixed by reconnecting the device, so the wording steers to "try again" rather than "disconnect and reconnect".
const PROXY_UNREACHABLE_USER_MESSAGE = 'The residential proxy is misbehaving at the moment. Please try again in a bit.';

// Computed at call time, not module load — CLOUD_FUNCTIONS_BASE_URL (set by scripts/functions-emulator.js) may not be known yet when this module is first required. Defaults to the real deployed project.
function functionUrl(name) {
  const base = process.env.CLOUD_FUNCTIONS_BASE_URL || 'https://asia-south1-wato-bot.cloudfunctions.net';
  return `${base}/${name}`;
}

// Ties an AbortSignal to this request's own client connection closing early, so a long-running mudslide op behind the route can stop waiting on a caller that's already gone. Not used on /api/whatsapp/qr (its login flow is intentionally decoupled from the request lifecycle). What the signal actually cancels for each route is decided in the corresponding mudslideService function, not here — most only cancel an op still queued, never one already running, to avoid discarding local session state that only persists after a normal finish.
function withClientAbortSignal(request, fn) {
  const controller = new AbortController();
  const onClientClose = () => controller.abort();
  request.raw.on('close', onClientClose);
  return fn(controller.signal).finally(() => request.raw.off('close', onClientClose));
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

  // Only the 2 routes that actually touch mudslide need this (schedules don't — they only run later via cron). Without it, an unconnected account throws a raw ENOENT reading the nonexistent .mudslide.enc file, surfacing as a raw 500.
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

  // Scoped to the Calendly webhook + runtime-script routes only — never accepted by authenticateUser, so a leaked Calendly key can't be used against /api/message or any other route.
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
      // `next` only ever needs to survive a same-origin redirect after the magic link is clicked — reject anything that isn't a bare relative path so this can't become an open redirect via the email.
      let safeNext = typeof next === 'string' && /^\/[^/\\].*$/.test(next) && !next.startsWith('//') ? next : null;
      // Legacy flag for callers (e.g. the FAQ tool) that don't need the WhatsApp QR wizard — verify.html no longer branches on whatsappConnected itself, so this now just becomes an explicit `next` straight to the dashboard.
      if (!safeNext && skipWhatsappConnect) safeNext = '/dashboard/';
      const { token } = await userService.registerUser(email);
      await emailService.sendRegistrationEmail(email, token, { next: safeNext });
      return { success: true, message: 'Registration email sent. Please check your inbox.' };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Registration failed' });
    }
  });

  // Deliberately doesn't report whatsappConnected — verify.html is a thin gate now (proves the token, redirects); whatsapp-connect.html is the one place that cares, and checks GET /api/whatsapp/status itself once loaded. The new_registration owner notification fires from here (on firstVerification only, not every hit) rather than /api/register, since it signals a real person landed on the site, not just that a link was requested — email comes from the query string since registerUser writes nothing to disk for a brand-new email, so this request is the only place it's available.
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

  // Country/city are detected AND validated client-side (public/verify.html — ipwho.is for auto-detect, Nominatim for manual entry), so by the time this route is hit the city is already trusted; this just validates the country code (cheap, local) and persists.
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

  // Actually connects to WhatsApp to verify the device is still linked (unlike /status below, a local file check) — costs real seconds and a proxy+mudslide round trip, so this is for one-shot checks (dashboard load), not polling.
  fastify.get('/api/whatsapp', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { connected, phoneNumber, reason } = await withClientAbortSignal(request, signal =>
        mudslideService.confirmWhatsappIsActuallyConnected(request.user.userDir, request.user.token, signal));
      console.log('DEBUG /api/whatsapp', { userDir: request.user.userDir, connected, phoneNumber, reason });
      return { connected, phoneNumber, reason };
    } catch (error) {
      fastify.log.error(error);
      emailService.notifyOwnerOfError('confirmWhatsappIsActuallyConnected', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to check WhatsApp connection' });
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

  // Fetched separately from /status specifically so it doesn't block or slow down status polling / the requireWhatsapp gate on every send — a real proxy+curl round trip only pays off when something is actually going to display the IP.
  fastify.get('/api/whatsapp/ip', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await withClientAbortSignal(request, signal =>
        mudslideService.getWhatsappProxyIp(request.user.userDir, request.user.token, signal));
    } catch (error) {
      fastify.log.error(error);
      if (mudslideService.isProxyUnreachableError(error)) {
        return reply.code(503).send({ error: PROXY_UNREACHABLE_USER_MESSAGE, reason: 'proxy_unreachable' });
      }
      emailService.notifyOwnerOfError('getWhatsappProxyIp', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to fetch proxy IP' });
    }
  });

  fastify.get('/api/whatsapp/qr', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.getQRCode(request.user.userDir, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      if (mudslideService.isProxyUnreachableError(error)) {
        return reply.code(503).send({ error: PROXY_UNREACHABLE_USER_MESSAGE, reason: 'proxy_unreachable' });
      }
      emailService.notifyOwnerOfError('getQRCode', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to get QR code' });
    }
  });

  fastify.get('/api/whatsapp/groups', { preHandler: [authenticateUser, requireWhatsapp] }, async (request, reply) => {
    try {
      const groups = await withClientAbortSignal(request, signal =>
        mudslideService.getGroups(request.user.userDir, request.user.token, signal));
      return { groups };
    } catch (error) {
      fastify.log.error(error);
      if (mudslideService.isProxyUnreachableError(error)) {
        return reply.code(503).send({ error: PROXY_UNREACHABLE_USER_MESSAGE, reason: 'proxy_unreachable' });
      }
      emailService.notifyOwnerOfError('getGroups', request.user.userDir, error.message).catch(() => {});
      return reply.code(500).send({ error: 'Failed to fetch groups' });
    }
  });

  // Fired once the frontend claims the device shows connected — a client-side assertion, so this re-verifies with the real network check before telling the operator, rather than trusting the claim blindly. On 409 the frontend should show a "not confirmed yet, try again" prompt, same shape requireWhatsapp returns elsewhere.
  fastify.post('/api/whatsapp/notify-user-connected', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { connected, reason } = await withClientAbortSignal(request, signal =>
        mudslideService.confirmWhatsappIsActuallyConnected(request.user.userDir, request.user.token, signal));
      if (!connected) {
        // A proxy hiccup right now doesn't mean the QR scan failed — the device may well be linked, we just couldn't verify it — so this gets its own response instead of pushing the user to rescan a QR that was never the problem.
        if (reason === 'proxy_unreachable') {
          return reply.code(503).send({ error: PROXY_UNREACHABLE_USER_MESSAGE, reason: 'proxy_unreachable' });
        }
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

  // Called after the user confirms the device is gone from WhatsApp's Linked Devices — deletes local session files and cron jobs. No mudslide/network call, since we no longer ask mudslide to gracefully unlink first (could take up to 60s and never changed what the user was shown).
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

  // Reconciles the hourly device-connectivity-monitor cron for this user, called on every dashboard load. Never touches schedules.json, so it never shows up in the user-facing schedule list — DEVICE_CHECK_SCHEDULE_ID is a fixed, reserved id, never the random hex generateScheduleId() uses.
  fastify.post('/api/schedules/device-connection-check', { preHandler: authenticateUser }, async (request, reply) => {
    const DEVICE_CHECK_SCHEDULE_ID = 'device-check';
    try {
      const { userDir, token } = request.user;
      const [{ connected, reason }, apiKeyStatus] = await withClientAbortSignal(request, signal => Promise.all([
        mudslideService.confirmWhatsappIsActuallyConnected(userDir, token, signal),
        userService.getApiKeyStatus(userDir)
      ]));

      if(connected && apiKeyStatus.permanent) {
        // need to setup monitoring
        if (!(await scheduleService.hasCronJob(userDir, DEVICE_CHECK_SCHEDULE_ID))) {
          const payload = scheduleService.buildCronPayload(token, { type: 'check-connection' });
          await scheduleService.addCronJob(userDir, DEVICE_CHECK_SCHEDULE_ID, '0 * * * *', payload);
        }
        return { monitoring: true };
      }

      if (reason == "device_unlinked" || !apiKeyStatus.permanent) {
        await scheduleService.removeCronJob(userDir, DEVICE_CHECK_SCHEDULE_ID);
        return { monitoring: false };
      }

      // could be a glitch in connection check, let it stay as before
      return { monitoring: await scheduleService.hasCronJob(userDir, DEVICE_CHECK_SCHEDULE_ID) };

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
      // Dashboard UI already strips spaces/hyphens/parens client-side; API callers (curl, Zapier, etc.) bypass that, so enforce it here too — a no-op for group JIDs (...@g.us), which never contain these chars.
      to = to.replace(/[\s\-()]/g, '');
      await withClientAbortSignal(request, signal => media
        ? mudslideService.sendMedia(request.user.userDir, request.user.token, to, media, message, signal)
        : mudslideService.sendMessage(request.user.userDir, request.user.token, to, message, signal));
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      if (mudslideService.isProxyUnreachableError(error)) {
        return reply.code(503).send({ error: PROXY_UNREACHABLE_USER_MESSAGE, reason: 'proxy_unreachable' });
      }
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

  // Called by dashboard/faqs.html on load with whatever's sitting in localStorage from an anonymous FAQ-tool publish — this is what actually attaches a jobId to the now-logged-in account.
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
      // Same relative-path-only rule as /api/register's `next` — this round-trips through Calendly's own redirect, exactly as exposed to tampering as an emailed link.
      const safeReturnTo = typeof returnTo === 'string' && /^\/[^/\\].*$/.test(returnTo) && !returnTo.startsWith('//') ? returnTo : null;
      return { url: calendlyService.getAuthorizeUrl(request.user.userDir, request.user.token, safeReturnTo) };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to start Calendly connection' });
    }
  });

  // Calendly redirects the browser here after consent — no session auth on this request, so the session token comes from the short-lived pending-connect entry /api/calendly/authorize created.
  fastify.get('/api/calendly/oauth/callback', async (request, reply) => {
    try {
      const { code, state } = request.query;
      const pending = calendlyService.consumePendingConnect(state);
      if (!code || !pending) return reply.code(400).send({ error: 'Calendly connection expired, please try again' });

      await calendlyService.completeConnection(pending.userDir, pending.token, code);
      // Mirrors dashboard-calendly.html's own API_BASE domain check — locally this server also serves public/ (same origin), but in production the frontend (watobot.xyz) and API (api.watobot.xyz) are separate origins, so a relative redirect would resolve against the wrong one.
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

  // Meeting CRUD, connection status, and leads all live directly in Firestore now (frontend-managed — see dashboard-calendly.html and firestore.rules); this route exists only to hand back the two fields only the VM can answer (its local encrypted calendly.json), so the frontend can self-heal its Firestore mirror on every load.
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

  // Backs the dashboard's "Add from Calendly" picker so users select an event type instead of pasting its booking URL by hand — response items also carry phone-detection fields computed from the same event type data, so no separate detection endpoint is needed.
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

  // Returns the tiny runtime script the user embeds, scoped to one meeting. Deliberately does NOT use authenticateCalendlyKey — an invalid/missing token here should never break the visitor's page with a 401, just serve a no-op script.
  fastify.get('/api/calendly/code', async (request, reply) => {
    reply.header('Content-Type', 'application/javascript');
    reply.header('Cache-Control', 'no-store');
    const { token: key, meetingId } = request.query;
    const user = key && meetingId && await userService.verifyCalendlyKey(key);
    if (!user) return '/* invalid calendly integration key */';

    // This script runs on the customer's site, not ours — a relative fetch() URL would resolve against their page's own origin and silently never fire, so this needs the absolute API origin (same domain convention the dashboard frontend uses for API_BASE).
    const host = request.headers.host || '';
    const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
    const apiBase = isLocal ? `${request.protocol}://${host}` : 'https://api.watobot.xyz';
    return calendlyService.buildCalendlyEmbedScript(key, meetingId, apiBase);
  });

  // Thin by design — all booking→lead logic lives in calendlyService.createLeadFromCalendlyEvent, which throws ApiError with the right status for not-found/ownership-mismatch cases. Also doubles as the dashboard's "Test Message" action via the optional `test: true` body flag, reusing a recently-loaded lead's own event_uri/invitee_uri instead of a real new booking — no separate test-send endpoint.
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

  // Leads (listing, editing, deleting, manual creation) are handled directly by the dashboard frontend against Firestore, authenticated with the token this route hands back. This is the ONLY place that check happens — authenticateUser has already run userService.verifyToken (the sole holder of the per-user token_hash files that make it possible) before mintFirebaseToken is ever called; that Function itself verifies nothing (it can't) and just signs whatever (token, userDir) pair it's handed, so calling it directly would skip the only real check in the flow — it's only safe here because this route is IP-allowlisted as the sole caller (functions/index.js: isAllowedVmCaller) and always calls it after verification succeeds, never before.
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