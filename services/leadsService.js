const { getDb } = require('./firestore');

function normalize(str) {
  return String(str || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A "lead" represents a person, not a single booking — the doc ID is
// deterministic from their identity so rebooking upserts the same doc
// instead of creating a duplicate. Phone is preferred (most reliable
// unique signal); falls back to name+email when phone wasn't captured.
function buildLeadId({ name, email, phone }) {
  const parts = phone
    ? [normalize(email), normalize(phone)]
    : [normalize(name), normalize(email)];
  return parts.filter(Boolean).join('_').slice(0, 1400) || `lead_${Date.now()}`;
}

async function upsertLead(leadData) {
  const id = buildLeadId(leadData);
  const now = new Date();
  await getDb().collection('leads').doc(id).set({
    ...leadData,
    updatedAt: now,
    createdAt: leadData.createdAt || now
  }, { merge: true });
  return id;
}

async function listLeads(userDir, { limit = 50, cursor } = {}) {
  let query = getDb().collection('leads').where('userDir', '==', userDir).orderBy('updatedAt', 'desc').limit(limit);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getLead(userDir, leadId) {
  const doc = await getDb().collection('leads').doc(leadId).get();
  if (!doc.exists || doc.data().userDir !== userDir) return null;
  return { id: doc.id, ...doc.data() };
}

async function updateLead(userDir, leadId, patch) {
  const lead = await getLead(userDir, leadId);
  if (!lead) return null;
  await getDb().collection('leads').doc(leadId).update({ notes: patch.notes, updatedAt: new Date() });
  return { ...lead, notes: patch.notes };
}

async function deleteLead(userDir, leadId) {
  const lead = await getLead(userDir, leadId);
  if (!lead) return false;
  await getDb().collection('leads').doc(leadId).delete();
  return true;
}

module.exports = { buildLeadId, upsertLead, listLeads, getLead, updateLead, deleteLead };
