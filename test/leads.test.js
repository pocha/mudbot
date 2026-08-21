const { createFakeFirestore } = require('./helpers/fakeFirestore');

const mockFakeDb = createFakeFirestore();
jest.mock('../services/firestore', () => ({
  getDb: jest.fn(() => mockFakeDb)
}));

const leadsService = require('../services/leadsService');

describe('leadsService.buildLeadId', () => {
  test('same name/email/phone across two bookings produces the same id (dedupe)', () => {
    const id1 = leadsService.buildLeadId({ name: 'Jane Doe', email: 'Jane@Example.com', phone: '+91 95383 84545' });
    const id2 = leadsService.buildLeadId({ name: 'Jane Doe', email: 'jane@example.com ', phone: '919538384545' });
    expect(id1).toBe(id2);
  });

  test('falls back to name+email when phone is missing, producing a different id', () => {
    const withPhone = leadsService.buildLeadId({ name: 'Jane Doe', email: 'jane@example.com', phone: '919538384545' });
    const noPhone = leadsService.buildLeadId({ name: 'Jane Doe', email: 'jane@example.com', phone: null });
    expect(noPhone).not.toBe(withPhone);

    const noPhone2 = leadsService.buildLeadId({ name: 'Jane Doe', email: 'jane@example.com', phone: null });
    expect(noPhone).toBe(noPhone2);
  });
});

describe('leadsService.upsertLead', () => {
  test('writes a new lead and a second call with the same identity merges rather than duplicates', async () => {
    const leadData = {
      userDir: 'user1dir00',
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '919538384545',
      source: 'calendly',
      status: 'sent'
    };

    const id1 = await leadsService.upsertLead(leadData);
    const listAfterFirst = await leadsService.listLeads('user1dir00', { limit: 50 });
    expect(listAfterFirst).toHaveLength(1);
    expect(listAfterFirst[0].id).toBe(id1);

    const id2 = await leadsService.upsertLead({ ...leadData, status: 'failed', notes: 'rebooked' });
    expect(id2).toBe(id1);

    const listAfterSecond = await leadsService.listLeads('user1dir00', { limit: 50 });
    expect(listAfterSecond).toHaveLength(1); // merged, not duplicated
    expect(listAfterSecond[0].status).toBe('failed');
    expect(listAfterSecond[0].notes).toBe('rebooked');
  });
});

describe('ownership checks on updateLead/deleteLead', () => {
  let leadId;

  beforeEach(async () => {
    leadId = await leadsService.upsertLead({
      userDir: 'owner0001a',
      name: 'Owned Lead',
      email: 'owned@example.com',
      phone: '911111111111',
      source: 'calendly',
      status: 'sent'
    });
  });

  test('updateLead returns null when called by a different userDir', async () => {
    const result = await leadsService.updateLead('someoneelse', leadId, { notes: 'hijack attempt' });
    expect(result).toBeNull();
  });

  test('updateLead succeeds for the owning userDir', async () => {
    const result = await leadsService.updateLead('owner0001a', leadId, { notes: 'legit update' });
    expect(result).not.toBeNull();
    expect(result.notes).toBe('legit update');
  });

  test('deleteLead returns false when called by a different userDir', async () => {
    const result = await leadsService.deleteLead('someoneelse', leadId);
    expect(result).toBe(false);

    const lead = await leadsService.getLead('owner0001a', leadId);
    expect(lead).not.toBeNull(); // still there, not deleted
  });

  test('deleteLead succeeds for the owning userDir', async () => {
    const result = await leadsService.deleteLead('owner0001a', leadId);
    expect(result).toBe(true);

    const lead = await leadsService.getLead('owner0001a', leadId);
    expect(lead).toBeNull();
  });
});
