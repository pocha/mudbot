const path = require('path');
const fs = require('fs').promises;

jest.mock('../services/mudslideService');

const CREATE_LEAD_FUNCTION_URL = 'https://asia-south1-wato-bot.cloudfunctions.net/createLead';

const calendlyService = require('../services/calendlyService');
const userService = require('../services/userService');
const mudslideService = require('../services/mudslideService');

const CALENDLY_AUTH_BASE_URL = process.env.CALENDLY_AUTH_BASE_URL || 'https://auth.calendly.com';
const CALENDLY_API_BASE_URL = process.env.CALENDLY_API_BASE_URL || 'https://api.calendly.com';

const CALENDLY_USER_URI = `${CALENDLY_API_BASE_URL}/users/test-user-uri`;
const EVENT_TYPE_URI = `${CALENDLY_API_BASE_URL}/event_types/test-type-id`;
const EVENT_URI = `${CALENDLY_API_BASE_URL}/scheduled_events/good-event`;
const INVITEE_URI = `${CALENDLY_API_BASE_URL}/invitees/good-invitee`;
const EVENT_TYPES_LIST_URL = `${CALENDLY_API_BASE_URL}/event_types?user=${encodeURIComponent(CALENDLY_USER_URI)}&active=true&count=100`;

const inviteeWithPhone = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  timezone: 'Asia/Kolkata',
  text_reminder_number: null,
  questions_and_answers: [
    { question: 'Phone Number', answer: '+91 95383 84545', position: 0 }
  ]
};

const testEvent = {
  event_type: EVENT_TYPE_URI,
  name: 'Test Meeting',
  start_time: '2026-09-01T10:00:00.000000Z',
  end_time: '2026-09-01T10:30:00.000000Z',
  location: { type: 'physical', location: '123 Main St' },
  event_memberships: [{ user: CALENDLY_USER_URI }]
};

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

let createLeadCalls = [];

function setupFetchMock() {
  createLeadCalls = [];
  global.fetch = jest.fn(async (url, opts) => {
    const urlStr = String(url);

    if (urlStr.startsWith(`${CALENDLY_AUTH_BASE_URL}/oauth/token`)) {
      return jsonResponse({ access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expires_in: 7200 });
    }
    if (urlStr === `${CALENDLY_API_BASE_URL}/users/me`) {
      return jsonResponse({
        resource: {
          uri: CALENDLY_USER_URI,
          current_organization: `${CALENDLY_API_BASE_URL}/organizations/test-org`,
          name: 'Test User',
          email: 'test-user@example.com'
        }
      });
    }
    if (urlStr === EVENT_TYPES_LIST_URL) {
      return jsonResponse({
        collection: [
          {
            uri: EVENT_TYPE_URI,
            name: 'Discovery Call',
            scheduling_url: 'https://calendly.com/test/discovery-call',
            custom_questions: [
              { name: 'Phone Number', type: 'phone_number', required: true }
            ]
          }
        ],
        pagination: { next_page: null }
      });
    }
    if (urlStr === EVENT_URI) {
      return jsonResponse({ resource: testEvent });
    }
    if (urlStr === INVITEE_URI) {
      return jsonResponse({ resource: inviteeWithPhone });
    }
    if (urlStr === CREATE_LEAD_FUNCTION_URL) {
      createLeadCalls.push(JSON.parse(opts.body));
      return jsonResponse({ success: true, id: 'fake-lead-id' });
    }

    throw new Error(`Unexpected fetch call in test: ${urlStr}`);
  });
}

// Unit tests against services/calendlyService.js's own exported functions
// directly (not through HTTP routes) — happy paths only. Calendly's real API
// responses are mocked at the fetch layer above; meeting CRUD/leads have no
// server-side surface to test anymore (frontend-direct Firestore, see
// README's "How Calendly data is stored and accessed") so this only covers
// what's still genuinely VM-side logic.
describe('calendlyService (happy paths)', () => {
  let token;
  let userDir;

  beforeAll(async () => {
    setupFetchMock();

    const email = 'jest-calendly-test@example.com';
    const reg = await userService.registerUser(email);
    const verified = await userService.verifyToken(reg.token);
    token = verified.token;
    userDir = verified.userDir;

    mudslideService.sendMessage.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await fs.rm(path.join(__dirname, '..', 'users', userDir), { recursive: true, force: true });
    delete global.fetch;
  });

  test('getAuthorizeUrl + consumePendingConnect: round-trips the pending-connect nonce', () => {
    const url = calendlyService.getAuthorizeUrl(userDir, token);
    expect(url).toContain('https://auth.calendly.com/oauth/authorize');

    const state = new URL(url).searchParams.get('state');
    const pending = calendlyService.consumePendingConnect(state);
    expect(pending).toMatchObject({ userDir, token });

    // single-use — a second consume for the same state comes back empty
    expect(calendlyService.consumePendingConnect(state)).toBeNull();
  });

  test('completeConnection: exchanges the code and connects the account', async () => {
    const config = await calendlyService.completeConnection(userDir, token, 'test-code');
    expect(config.connected).toBe(true);
    expect(config.calendlyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(config.name).toBe('Test User');
    expect(config.email).toBe('test-user@example.com');

    const stored = await calendlyService.readConfig(userDir, token);
    expect(stored.connected).toBe(true);
    expect(stored.calendlyUserUri).toBe(CALENDLY_USER_URI);
  });

  test('getUserCalendars: lists event types with phone-detection fields', async () => {
    const calendars = await calendlyService.getUserCalendars(userDir, token);
    expect(calendars).toHaveLength(1);
    expect(calendars[0]).toMatchObject({
      uri: EVENT_TYPE_URI,
      name: 'Discovery Call',
      phoneQuestionName: 'Phone Number',
      phoneDetectionStatus: 'found_required'
    });
  });

  test('resolveMessageTemplate: substitutes all supported placeholders', () => {
    const message = calendlyService.resolveMessageTemplate(
      'Hi {{name}} ({{email}}), thanks for booking {{event_name}} at {{event_time}}, ' +
      'ending {{event_end_time}}, tz {{timezone}}, location {{location}}.',
      {
        name: 'Jane Doe', email: 'jane@example.com', eventName: 'Discovery Call',
        eventStartTime: '2026-09-01T10:00:00.000000Z', eventEndTime: '2026-09-01T10:30:00.000000Z',
        timezone: 'Asia/Kolkata', location: { location: '123 Main St' }
      }
    );
    expect(message).toContain('Jane Doe');
    expect(message).toContain('jane@example.com');
    expect(message).toContain('Discovery Call');
    expect(message).toContain('Asia/Kolkata');
    expect(message).toContain('123 Main St');
    expect(message).not.toContain('{{');
  });

  test('buildCalendlyEmbedScript: returns the embeddable snippet for a meeting', () => {
    const script = calendlyService.buildCalendlyEmbedScript('fake-calendly-key', 'meeting-id-123', 'https://api.watobot.xyz');
    expect(script).toContain('fake-calendly-key');
    expect(script).toContain('/api/calendly/meeting-id-123/lead');
  });

  test('createLeadFromCalendlyEvent: happy path sends a WhatsApp message and posts the lead', async () => {
    const meeting = {
      eventTypeUri: EVENT_TYPE_URI,
      eventTypeName: 'Discovery Call',
      phoneQuestionName: 'Phone Number',
      autoSendEnabled: true,
      messageTemplate: 'Hi {{name}}, thanks for booking {{event_name}}!'
    };

    const result = await calendlyService.createLeadFromCalendlyEvent(userDir, token, meeting, EVENT_URI, INVITEE_URI);
    expect(result.status).toBe('sent');

    const [calledUserDir, , calledTo, calledMessage] = mudslideService.sendMessage.mock.calls[0];
    expect(calledUserDir).toBe(userDir);
    expect(calledTo).toBe('+919538384545');
    expect(calledMessage).toContain('Jane Doe');
    expect(calledMessage).not.toContain('{{');

    // createLead (functions/index.js) is a separate deploy target with its
    // own responsibility for actually writing to Firestore — this only
    // verifies the VM posts it the right payload, not that a doc landed.
    expect(createLeadCalls).toHaveLength(1);
    expect(createLeadCalls[0]).toMatchObject({
      userDir, name: 'Jane Doe', email: 'jane@example.com', phone: '+919538384545',
      source: 'calendly', status: 'sent'
    });
  });
});
