const path = require('path');
const fs = require('fs').promises;

const { createFakeFirestore } = require('./helpers/fakeFirestore');

const mockFakeDb = createFakeFirestore();
jest.mock('../services/firestore', () => ({
  getDb: jest.fn(() => mockFakeDb)
}));

jest.mock('../services/mudslideService');

const buildServer = require('../services/buildServer');
const userService = require('../services/userService');
const calendlyService = require('../services/calendlyService');
const mudslideService = require('../services/mudslideService');

const CALENDLY_AUTH_BASE_URL = process.env.CALENDLY_AUTH_BASE_URL || 'https://auth.calendly.com';
const CALENDLY_API_BASE_URL = process.env.CALENDLY_API_BASE_URL || 'https://api.calendly.com';

const CALENDLY_USER_URI = `${CALENDLY_API_BASE_URL}/users/test-user-uri`;
const EVENT_TYPE_URI = `${CALENDLY_API_BASE_URL}/event_types/test-type-id`;
const OTHER_EVENT_TYPE_URI = `${CALENDLY_API_BASE_URL}/event_types/other-type-id`;

const EVENT_URI = `${CALENDLY_API_BASE_URL}/scheduled_events/good-event`;
const EVENT_URI_NO_PHONE = `${CALENDLY_API_BASE_URL}/scheduled_events/no-phone-event`;
const EVENT_URI_FOREIGN = `${CALENDLY_API_BASE_URL}/scheduled_events/foreign-event`;

const INVITEE_URI = `${CALENDLY_API_BASE_URL}/invitees/good-invitee`;
const INVITEE_URI_NO_PHONE = `${CALENDLY_API_BASE_URL}/invitees/no-phone-invitee`;

const inviteeWithPhone = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  text_reminder_number: null,
  questions_and_answers: [
    { question: 'Phone Number', answer: '+91 95383 84545', position: 0 }
  ]
};

const inviteeNoPhone = {
  name: 'No Phone Guy',
  email: 'nophone@example.com',
  text_reminder_number: null,
  questions_and_answers: []
};

function makeEvent(eventTypeUri, membershipUri) {
  return {
    event_type: eventTypeUri,
    name: 'Test Meeting',
    start_time: '2026-09-01T10:00:00.000000Z',
    end_time: '2026-09-01T10:30:00.000000Z',
    event_memberships: [{ user: membershipUri }]
  };
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function setupFetchMock() {
  global.fetch = jest.fn(async (url, opts = {}) => {
    const urlStr = String(url);

    if (urlStr.startsWith(`${CALENDLY_AUTH_BASE_URL}/oauth/token`)) {
      return jsonResponse({
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
        expires_in: 7200
      });
    }
    if (urlStr === `${CALENDLY_API_BASE_URL}/users/me`) {
      return jsonResponse({
        resource: { uri: CALENDLY_USER_URI, current_organization: `${CALENDLY_API_BASE_URL}/organizations/test-org` }
      });
    }
    if (urlStr === EVENT_URI) {
      return jsonResponse({ resource: makeEvent(EVENT_TYPE_URI, CALENDLY_USER_URI) });
    }
    if (urlStr === EVENT_URI_NO_PHONE) {
      return jsonResponse({ resource: makeEvent(EVENT_TYPE_URI, CALENDLY_USER_URI) });
    }
    if (urlStr === EVENT_URI_FOREIGN) {
      return jsonResponse({ resource: makeEvent(EVENT_TYPE_URI, `${CALENDLY_API_BASE_URL}/users/someone-else`) });
    }
    if (urlStr === INVITEE_URI) {
      return jsonResponse({ resource: inviteeWithPhone });
    }
    if (urlStr === INVITEE_URI_NO_PHONE) {
      return jsonResponse({ resource: inviteeNoPhone });
    }

    throw new Error(`Unexpected fetch call in test: ${urlStr}`);
  });
}

describe('Calendly integration', () => {
  let fastify;
  let token;
  let userDir;
  let calendlyKey;

  beforeAll(async () => {
    setupFetchMock();

    fastify = buildServer();

    const email = 'jest-calendly-test@example.com';
    const reg = await userService.registerUser(email);
    const verified = await userService.verifyToken(reg.token);
    token = verified.token;
    userDir = verified.userDir;

    mudslideService.confirmWhatsappLogin.mockResolvedValue({ loggedIn: true });
    mudslideService.sendMessage.mockResolvedValue(undefined);

    // Connect the Calendly account by driving the real authorize + callback
    // routes (rather than calling calendlyService.completeConnection
    // directly) so the pending-connect nonce mechanism is exercised too.
    const authorizeRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/authorize',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(authorizeRes.statusCode).toBe(200);
    const { url: authorizeUrl } = JSON.parse(authorizeRes.body);
    const state = new URL(authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const callbackRes = await fastify.inject({
      method: 'GET',
      url: `/api/calendly/oauth/callback?code=test-code&state=${state}`
    });
    expect(callbackRes.statusCode).toBe(302);

    const configRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` }
    });
    const config = JSON.parse(configRes.body);
    expect(config.connected).toBe(true);
    calendlyKey = config.calendlyKey;
    expect(calendlyKey).toBeTruthy();
  });

  afterAll(async () => {
    await fastify.close();
    await fs.rm(path.join(__dirname, '..', 'users', userDir), { recursive: true, force: true });
    delete global.fetch;
  });

  beforeEach(() => {
    mudslideService.sendMessage.mockClear();
    mudslideService.confirmWhatsappLogin.mockClear();
    mudslideService.confirmWhatsappLogin.mockResolvedValue({ loggedIn: true });
  });

  test('meeting CRUD: create, list, delete', async () => {
    const createRes = await fastify.inject({
      method: 'POST',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        eventTypeUri: OTHER_EVENT_TYPE_URI,
        eventTypeName: 'CRUD Test Meeting',
        messageTemplate: 'Hi {{name}}, see you for {{event_name}}!',
        phoneQuestionName: 'Phone Number'
      }
    });
    expect(createRes.statusCode).toBe(200);
    const created = JSON.parse(createRes.body);
    expect(created.success).toBe(true);
    const meetingId = created.meeting.id;
    expect(meetingId).toBeTruthy();

    const listRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` }
    });
    const listed = JSON.parse(listRes.body);
    expect(listed.meetings[meetingId]).toBeDefined();
    expect(listed.meetings[meetingId].eventTypeUri).toBe(OTHER_EVENT_TYPE_URI);

    const deleteRes = await fastify.inject({
      method: 'DELETE',
      url: `/api/calendly/config/${meetingId}`,
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(JSON.parse(deleteRes.body).success).toBe(true);

    const finalRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` }
    });
    const final = JSON.parse(finalRes.body);
    expect(final.meetings[meetingId]).toBeUndefined();
  });

  test('full webhook flow: booking with a phone number sends a WhatsApp message', async () => {
    const configRes = await fastify.inject({
      method: 'POST',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        eventTypeUri: EVENT_TYPE_URI,
        eventTypeName: 'Webhook Test Meeting',
        messageTemplate: 'Hi {{name}}, thanks for booking {{event_name}}!',
        phoneQuestionName: 'Phone Number'
      }
    });
    expect(configRes.statusCode).toBe(200);

    const webhookRes = await fastify.inject({
      method: 'POST',
      url: '/api/calendly',
      headers: { 'x-calendly-key': calendlyKey },
      payload: { event_uri: EVENT_URI, invitee_uri: INVITEE_URI }
    });

    expect(webhookRes.statusCode).toBe(200);
    const body = JSON.parse(webhookRes.body);
    expect(body.status).toBe('sent');

    expect(mudslideService.sendMessage).toHaveBeenCalledTimes(1);
    const [calledUserDir, calledToken, calledTo, calledMessage] = mudslideService.sendMessage.mock.calls[0];
    expect(calledUserDir).toBe(userDir);
    expect(calledTo).toBe(calendlyService.normalizePhone('+91 95383 84545'));
    expect(calledTo).not.toMatch(/[\s()-]/);
    expect(calledMessage).toContain('Jane Doe');
    expect(calledMessage).toContain('Test Meeting');
    expect(calledMessage).not.toContain('{{');
  });

  test('booking with no phone answer results in no_phone status and no message sent', async () => {
    const configRes = await fastify.inject({
      method: 'POST',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        eventTypeUri: EVENT_TYPE_URI,
        eventTypeName: 'Webhook Test Meeting',
        messageTemplate: 'Hi {{name}}!',
        phoneQuestionName: 'Phone Number'
      }
    });
    expect(configRes.statusCode).toBe(200);

    const webhookRes = await fastify.inject({
      method: 'POST',
      url: '/api/calendly',
      headers: { 'x-calendly-key': calendlyKey },
      payload: { event_uri: EVENT_URI_NO_PHONE, invitee_uri: INVITEE_URI_NO_PHONE }
    });

    expect(webhookRes.statusCode).toBe(200);
    const body = JSON.parse(webhookRes.body);
    expect(body.status).toBe('no_phone');
    expect(mudslideService.sendMessage).not.toHaveBeenCalled();
  });

  test('ownership pinning: event not owned by the connected account returns 403', async () => {
    const webhookRes = await fastify.inject({
      method: 'POST',
      url: '/api/calendly',
      headers: { 'x-calendly-key': calendlyKey },
      payload: { event_uri: EVENT_URI_FOREIGN, invitee_uri: INVITEE_URI }
    });

    expect(webhookRes.statusCode).toBe(403);
    expect(mudslideService.sendMessage).not.toHaveBeenCalled();
  });

  test('GET /api/calendly/code with a valid key returns the embed script containing the key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/calendly/code?token=${calendlyKey}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toContain(calendlyKey);
  });

  test('GET /api/calendly/code with a garbage token returns a 200 no-op script, not an error', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/code?token=garbage-not-a-real-key'
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toContain('invalid calendly integration key');
  });
});
