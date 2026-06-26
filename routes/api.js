const userService = require('../services/userService');
const emailService = require('../services/emailService');
const mudslideService = require('../services/mudslideService');
const scheduleService = require('../services/scheduleService');

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

  fastify.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.post('/api/register', async (request, reply) => {
    try {
      const { email } = request.body;
      if (!email || !email.includes('@')) {
        return reply.code(400).send({ error: 'Valid email is required' });
      }
      const { token, userDir } = await userService.registerUser(email);
      await emailService.sendRegistrationEmail(email, token);
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

      const whatsappStatus = await mudslideService.checkLoginStatus(user.userDir, user.token);
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

      const apiKey = await userService.generateApiKey(user.userDir, user.token);
      return { success: true, apiKey };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to generate API key' });
    }
  });

  fastify.post('/api/user/location', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { zipcode, force } = request.body || {};

      if (!zipcode) {
        return reply.code(400).send({ valid: false, reason: 'missing_zipcode', message: 'PIN code is required.' });
      }

      const zip = zipcode.trim();

      if (!/^\d{3,10}$/.test(zip)) {
        return { valid: false, reason: 'invalid_format', message: 'PIN code must be digits only (3–10 digits).' };
      }

      // Call ip-api and Nominatim in parallel with 8 s timeout each
      const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
      ]);

      const [ipResult, zipResult] = await Promise.allSettled([
        withTimeout(
          fetch(`http://ip-api.com/json/${request.ip}?fields=countryCode`)
            .then(r => r.json()).then(d => d.countryCode?.toLowerCase() || null),
          8000
        ),
        withTimeout(
          fetch(`https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&format=json&addressdetails=1&limit=1`, {
            headers: { 'User-Agent': 'Watobot/1.0 (watobot.com)' }
          }).then(r => r.json()).then(data => {
            if (!Array.isArray(data) || data.length === 0) return { found: false };
            const addr = data[0].address || {};
            return {
              found: true,
              country: addr.country_code?.toLowerCase() || null,
              countryName: addr.country || null,
              city: addr.city || addr.town || addr.village || addr.municipality || addr.county || addr.state || null
            };
          }),
          8000
        )
      ]);

      const ipCountry = ipResult.status === 'fulfilled' ? ipResult.value : null;
      const zipInfo  = zipResult.status === 'fulfilled' ? zipResult.value : null;
      const ipOk  = ipCountry !== null;
      const zipOk = zipInfo !== null;

      // Zipcode not found (Nominatim returned empty)
      if (zipOk && !zipInfo.found) {
        return { valid: false, reason: 'invalid_zipcode', message: 'This PIN code was not found. Please double-check and try again.' };
      }

      // Both APIs failed
      if (!zipOk && !ipOk) {
        return { valid: false, reason: 'api_error', message: 'Unable to verify your location right now. Please try again in a moment.' };
      }

      // Nominatim failed, IP works → proceed with IP country, no zipcode stored
      if (!zipOk && ipOk) {
        const proxy = await userService.createOrUpdateProxyJson(request.user.userDir, request.user.token, { country: ipCountry });
        return { valid: true, country: proxy.country, warning: 'pin_validation_unavailable', message: "Couldn't validate your PIN code — using your detected region instead." };
      }

      // Nominatim found the zipcode — determine country to store
      const zipcodeCountry = zipInfo.country;
      const countryToStore = zipcodeCountry || ipCountry || 'in';

      if (!force) {
        // ip-api failed: can't compare — ask user to confirm the PIN's country
        if (!ipOk && zipcodeCountry) {
          return {
            valid: false,
            reason: 'confirm_country',
            zipcodeCountry: zipcodeCountry.toUpperCase(),
            zipcodeCountryName: zipInfo.countryName,
            zipcodeCity: zipInfo.city,
            message: `Couldn't detect your region. This PIN code is from ${zipInfo.countryName || zipcodeCountry.toUpperCase()}. If that's your location, proceed.`
          };
        }

        // ip-api worked but countries don't match
        if (ipOk && zipcodeCountry && ipCountry && zipcodeCountry !== ipCountry) {
          return {
            valid: false,
            reason: 'country_mismatch',
            ipCountry: ipCountry.toUpperCase(),
            zipcodeCountry: zipcodeCountry.toUpperCase(),
            zipcodeCountryName: zipInfo.countryName,
            zipcodeCity: zipInfo.city,
            message: `This PIN code belongs to ${zipInfo.countryName || zipcodeCountry.toUpperCase()}, not your detected location (${ipCountry.toUpperCase()}). Please enter your correct local PIN code.`
          };
        }
      }

      // All good — store zipcode + country from Nominatim
      const proxy = await userService.createOrUpdateProxyJson(request.user.userDir, request.user.token, { country: countryToStore, zipcode: zip });
      return { valid: true, country: proxy.country, zipcodeCity: zipInfo.city };

    } catch (err) {
      fastify.log.error(err);
      const { zipcode } = request.body || {};
      return zipcode ? { valid: false, reason: 'error', message: 'Something went wrong. Please try again.' } : { country: null };
    }
  });

  fastify.get('/api/whatsapp/status', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.checkLoginStatus(request.user.userDir, request.user.token);
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

  fastify.get('/api/whatsapp/groups', { preHandler: authenticateUser }, async (request, reply) => {
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
      const status = await mudslideService.confirmLogin(request.user.userDir, request.user.token);
      return { success: true, loggedIn: status.loggedIn };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Login confirmation failed' });
    }
  });

  // Attempts graceful mudslide logout (tells WhatsApp to disconnect the device).
  // Awaits completion (up to 30 s) so the frontend can switch to the "please verify" phase.
  // Always returns success — if mudslide fails the user can remove the device manually.
  fastify.post('/api/whatsapp/logout', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      await mudslideService.logout(request.user.userDir, request.user.token);
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
      await mudslideService.cleanupAfterLogout(request.user.userDir);
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

  fastify.get('/api/schedules/:id/logs', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const limit = parseInt(request.query.limit) || 100;
      const logs = await scheduleService.getScheduleLogs(request.user.userDir, request.params.id, limit);
      return { logs };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get logs' });
    }
  });

  fastify.post('/api/message', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { to, message, media } = request.body;
      if (!to || !message) {
        return reply.code(400).send({ error: 'to and message are required' });
      }
      const result = media
        ? await mudslideService.sendMedia(request.user.userDir, request.user.token, to, media, message)
        : await mudslideService.sendMessage(request.user.userDir, request.user.token, to, message);
      return { success: true, result };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to send message' });
    }
  });
}

module.exports = routes;
