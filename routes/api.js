const userService = require('../services/userService');
const emailService = require('../services/emailService');
const mudslideService = require('../services/mudslideService');
const scheduleService = require('../services/scheduleService');
const path = require('path');
const fs = require('fs').promises;

async function routes(fastify, options) {
  
  // Authentication Middleware
  const authenticateUser = async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      const apiKey = request.headers['x-api-key'];
      
      if (!token && !apiKey) {
        return reply.code(401).send({ error: 'Authentication required (token or API key)' });
      }

      let user;
      if (token) {
        user = await userService.verifyToken(token);
      } else if (apiKey) {
        user = await userService.verifyApiKey(apiKey);
      }

      if (!user) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      // Attach user to request for use in route handlers
      request.user = user;
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Authentication failed' });
    }
  };
  
  // Health check
  fastify.get('/api/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // User Registration
  fastify.post('/api/register', async (request, reply) => {
    try {
      const { email } = request.body;
      
      if (!email || !email.includes('@')) {
        return reply.code(400).send({ error: 'Valid email is required' });
      }

      const { token } = await userService.registerUser(email);
      const magicLink = `${request.protocol}://${request.hostname}/verify.html?token=${token}`;
      
      await emailService.sendRegistrationEmail(email, token);

      return { 
        success: true, 
        message: 'Registration email sent. Please check your inbox.' 
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Registration failed' });
    }
  });

  // Verify Token and Get User Info
  fastify.get('/api/verify/:token', async (request, reply) => {
    try {
      const { token } = request.params;
      
      const user = await userService.verifyToken(token);
      if (!user) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      // Check WhatsApp login status
      const whatsappStatus = await mudslideService.checkLoginStatus(user.userDir);
      
      return {
        success: true,
        user: {
          email: user.email,
          apiKey: user.apiKey,
          whatsappConnected: whatsappStatus.loggedIn
        }
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Verification failed' });
    }
  });

  // Generate API Key
  fastify.post('/api/apikey/generate', async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return reply.code(401).send({ error: 'Token required' });
      }

      const user = await userService.verifyToken(token);
      if (!user) {
        return reply.code(401).send({ error: 'Invalid token' });
      }

      const apiKey = await userService.generateApiKey(user.userDir, token);
      
      return {
        success: true,
        apiKey: apiKey
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to generate API key' });
    }
  });

  // Get WhatsApp Login Status
  fastify.get('/api/whatsapp/status', async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return reply.code(401).send({ error: 'Token required' });
      }

      const user = await userService.verifyToken(token);
      if (!user) {
        return reply.code(401).send({ error: 'Invalid token' });
      }

      const status = await mudslideService.checkLoginStatus(user.userDir);
      return status;
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to check status' });
    }
  });

  // Get WhatsApp QR Code
  fastify.get('/api/whatsapp/qr', async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return reply.code(401).send({ error: 'Token required' });
      }

      const user = await userService.verifyToken(token);
      if (!user) {
        return reply.code(401).send({ error: 'Invalid token' });
      }

      const qrData = await mudslideService.getQRCode(user.userDir);
      return qrData;
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get QR code' });
    }
  });

  // Logout from WhatsApp
  fastify.post('/api/whatsapp/logout', async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return reply.code(401).send({ error: 'Token required' });
      }

      const user = await userService.verifyToken(token);
      if (!user) {
        return reply.code(401).send({ error: 'Invalid token' });
      }

      await mudslideService.logout(user.userDir);
      return { success: true, message: 'Logged out successfully' };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Logout failed' });
    }
  });

  // Get All Schedules
  fastify.get('/api/schedules', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const schedules = await scheduleService.listSchedules(request.user.userDir);
      return { schedules };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get schedules' });
    }
  });

  // Create Schedule
  fastify.post('/api/schedules', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const scheduleData = request.body;
      const schedule = await scheduleService.createSchedule(request.user.userDir, scheduleData);
      
      return { success: true, schedule };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to create schedule' });
    }
  });

  // Get Single Schedule
  fastify.get('/api/schedules/:id', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { id } = request.params;
      const schedule = await scheduleService.getSchedule(request.user.userDir, id);
      
      if (!schedule) {
        return reply.code(404).send({ error: 'Schedule not found' });
      }

      return { schedule };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get schedule' });
    }
  });

  // Update Schedule
  fastify.put('/api/schedules/:id', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { id } = request.params;
      const updates = request.body;
      
      const schedule = await scheduleService.updateSchedule(request.user.userDir, id, updates);
      
      return { success: true, schedule };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to update schedule' });
    }
  });

  // Delete Schedule
  fastify.delete('/api/schedules/:id', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { id } = request.params;
      await scheduleService.deleteSchedule(request.user.userDir, id);
      
      return { success: true, message: 'Schedule deleted' };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to delete schedule' });
    }
  });

  // Get Schedule Logs
  fastify.get('/api/schedules/:id/logs', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { id } = request.params;
      const limit = parseInt(request.query.limit) || 100;
      
      const logs = await scheduleService.getScheduleLogs(request.user.userDir, id, limit);
      
      return { logs };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to get logs' });
    }
  });

  // Test Send Message
  fastify.post('/api/test-send', async (request, reply) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return reply.code(401).send({ error: 'Token required' });
      }

      const user = await userService.verifyToken(token);
      if (!user) {
        return reply.code(401).send({ error: 'Invalid token' });
      }

      const { recipient, message, media } = request.body;
      
      if (!recipient || !message) {
        return reply.code(400).send({ error: 'Recipient and message are required' });
      }

      const result = await mudslideService.sendMessage(
        user.userDir, 
        recipient, 
        message, 
        media
      );
      
      return { success: true, result };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to send message' });
    }
  });

  // Send WhatsApp Message
  fastify.post('/api/message', { preHandler: authenticateUser }, async (request, reply) => {
    try {
      const { to, message, media } = request.body;
      
      if (!to || !message) {
        return reply.code(400).send({ error: 'to and message parameters are required' });
      }

      const result = await mudslideService.sendMessage(
        request.user.userDir, 
        to, 
        message, 
        media
      );
      
      return { success: true, result };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to send message' });
    }
  });
}

module.exports = routes;
