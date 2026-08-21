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
const mudslideService = require('../services/mudslideService');

const CALENDLY_AUTH_BASE_URL = process.env.CALENDLY_AUTH_BASE_URL || 'https://auth.calendly.com';
const CALENDLY_API_BASE_URL = process.env.CALENDLY_API_BASE_URL || 'https://api.calendly.com';

const CALENDLY_USER_URI = `${CALENDLY_API_BASE_URL}/users/test-user-uri`;
const EVENT_TYPE_URI = `${CALENDLY_API_BASE_URL}/event_types/test-type-id`;
const OTHER_EVENT_TYPE_URI = `${CALENDLY_API_BASE_URL}/event_types/other-type-id`;
const EVENT_URI = `${CALENDLY_API_BASE_URL}/scheduled_events/good-event`;
const INVITEE_URI = `${CALENDLY_API_BASE_URL}/invitees/good-invitee`;

const inviteeWithPhone = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  text_reminder_number: null,
  questions_and_answers: [
    { question: 'Phone Number', answer: '+91 95383 84545', position: 0 }
  ]
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

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function setupFetchMock() {
  global.fetch = jest.fn(async (url) => {
    const urlStr = String(url);

    if (urlStr.startsWith(`${CALENDLY_AUTH_BASE_URL}/oauth/token`)) {
      return jsonResponse({ access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expires_in: 7200 });
    }
    if (urlStr === `${CALENDLY_API_BASE_URL}/users/me`) {
      return jsonResponse({ resource: { uri: CALENDLY_USER_URI, current_organization: `${CALENDLY_API_BASE_URL}/organizations/test-org` } });
    }
    if (urlStr === EVENT_URI) {
      return jsonResponse({ resource: makeEvent(EVENT_TYPE_URI, CALENDLY_USER_URI) });
    }
    if (urlStr === INVITEE_URI) {
      return jsonResponse({ resource: inviteeWithPhone });
    }

    throw new Error(`Unexpected fetch call in test: ${urlStr}`);
  });
}

describe('Calendly integration (happy paths)', () => {
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

    // Connect via the real authorize + callback routes so the
    // pending-connect nonce mechanism is exercised too.
    const authorizeRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/authorize',
      headers: { Authorization: `Bearer ${token}` }
    });
    const { url: authorizeUrl } = JSON.parse(authorizeRes.body);
    const state = new URL(authorizeUrl).searchParams.get('state');

    await fastify.inject({ method: 'GET', url: `/api/calendly/oauth/callback?code=test-code&state=${state}` });

    const configRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` }
    });
    calendlyKey = JSON.parse(configRes.body).calendlyKey;
  });

  afterAll(async () => {
    await fastify.close();
    await fs.rm(path.join(__dirname, '..', 'users', userDir), { recursive: true, force: true });
    delete global.fetch;
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
    const meetingId = JSON.parse(createRes.body).meeting.id;

    const listRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(JSON.parse(listRes.body).meetings[meetingId].eventTypeUri).toBe(OTHER_EVENT_TYPE_URI);

    await fastify.inject({
      method: 'DELETE',
      url: `/api/calendly/config/${meetingId}`,
      headers: { Authorization: `Bearer ${token}` }
    });

    const finalRes = await fastify.inject({
      method: 'GET',
      url: '/api/calendly/config',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(JSON.parse(finalRes.body).meetings[meetingId]).toBeUndefined();
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
    const meetingId = JSON.parse(configRes.body).meeting.id;

    const webhookRes = await fastify.inject({
      method: 'POST',
      url: `/api/calendly/${meetingId}/lead`,
      headers: { 'x-calendly-key': calendlyKey },
      payload: { event_uri: EVENT_URI, invitee_uri: INVITEE_URI }
    });

    expect(JSON.parse(webhookRes.body).status).toBe('sent');

    const [calledUserDir, , calledTo, calledMessage] = mudslideService.sendMessage.mock.calls[0];
    expect(calledUserDir).toBe(userDir);
    expect(calledTo).toBe('+919538384545');
    expect(calledMessage).toContain('Jane Doe');
    expect(calledMessage).not.toContain('{{');
  });

  test('GET /api/calendly/code returns the embed script for a connected meeting', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/calendly/code?token=${calendlyKey}&meetingId=some-meeting-id`
    });
    expect(res.body).toContain(calendlyKey);
    expect(res.body).toContain('/api/calendly/some-meeting-id/lead');
  });
});
