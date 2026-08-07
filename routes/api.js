const userService = require('../services/userService');
const emailService = require('../services/emailService');
const mudslideService = require('../services/mudslideService');
const scheduleService = require('../services/scheduleService');
const faqService = require('../services/faqService');
const countries = require('../services/countries.json');

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
      return await mudslideService.getUsageLogs(request.user.userDir, limit, request.user.token);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get usage logs' });
    }
  });

  fastify.get('/api/usage/stats', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.getMessageStats(request.user.userDir, request.query.tz);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get usage stats' });
    }
  });

  fastify.post('/api/message', { preHandler: [authenticateUser, requireWhatsapp] }, async (request, reply) => {
    try {
      const { to, message, media } = request.body;
      if (!to || !message) {
        return reply.code(400).send({ error: 'to and message are required' });
      }
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

  // Called by dashboard.html on load with whatever's sitting in localStorage
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
}

module.exports = routes;
