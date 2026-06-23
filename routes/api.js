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
      const { token } = await userService.registerUser(email);
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

      const whatsappStatus = await mudslideService.checkLoginStatus(user.userDir);
      return {
        success: true,
        user: {
          email: user.email,
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

      const apiKey = await userService.generateApiKey(user.userDir, user.email);
      return { success: true, apiKey };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to generate API key' });
    }
  });

  fastify.get('/api/whatsapp/status', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.checkLoginStatus(request.user.userDir);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to check status' });
    }
  });

  fastify.get('/api/whatsapp/qr', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      return await mudslideService.getQRCode(request.user.userDir);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get QR code' });
    }
  });

  fastify.get('/api/whatsapp/groups', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const groups = await mudslideService.getGroups(request.user.userDir);
      return { groups };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch groups' });
    }
  });

  fastify.post('/api/whatsapp/logout', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      await mudslideService.logout(request.user.userDir);
      return { success: true, message: 'Logged out successfully' };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Logout failed' });
    }
  });

  fastify.get('/api/schedules', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const schedules = await scheduleService.listSchedules(request.user.userDir, request.user.email);
      return { schedules };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get schedules' });
    }
  });

  fastify.post('/api/schedules', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const schedule = await scheduleService.createSchedule(
        request.user.userDir, request.user.email, request.body
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
        request.user.userDir, request.user.email, request.params.id
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
        request.user.userDir, request.user.email, request.params.id, request.body
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
        request.user.userDir, request.user.email, request.params.id
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
        ? await mudslideService.sendMedia(request.user.userDir, to, media, message)
        : await mudslideService.sendMessage(request.user.userDir, to, message);
      return { success: true, result };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to send message' });
    }
  });
}

module.exports = routes;
