const { createFakeFirestore } = require('./helpers/fakeFirestore');

const mockFakeDb = createFakeFirestore();
jest.mock('../services/firestore', () => ({
  getDb: jest.fn(() => mockFakeDb)
}));

const Lead = require('../models/lead');
const leadsService = require('../services/leadsService');

test('Lead.save: a second save with the same identity merges into the same doc (dedupe)', async () => {
  const lead1 = Lead.new({
    userDir: 'user1dir00', name: 'Jane Doe', email: 'jane@example.com', phone: '919538384545',
    source: 'calendly', sourceData: { eventUri: 'x' }, status: 'sent'
  });
  await lead1.save();

  const lead2 = Lead.new({
    userDir: 'user1dir00', name: 'Jane Doe', email: 'jane@example.com', phone: '919538384545',
    source: 'calendly', sourceData: { eventUri: 'x' }, status: 'failed', notes: 'rebooked'
  });
  await lead2.save();
  expect(lead2.id).toBe(lead1.id);

  const list = await Lead.list('user1dir00', { limit: 50 });
  expect(list).toHaveLength(1);
  expect(list[0].status).toBe('failed');
  expect(list[0].notes).toBe('rebooked');
});

test('leadsService.updateLead updates notes for the owning userDir', async () => {
  const lead = Lead.new({
    userDir: 'owner0001a', name: 'Owned Lead', email: 'owned@example.com', phone: '911111111111',
    source: 'calendly', sourceData: { eventUri: 'y' }, status: 'sent'
  });
  await lead.save();

  const result = await leadsService.updateLead('owner0001a', lead.id, { notes: 'legit update' });
  expect(result.notes).toBe('legit update');
});
