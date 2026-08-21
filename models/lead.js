const { getDb } = require('../services/firestore');

function normalize(str) {
  return String(str || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Every Firestore operation on `leads` happens through this class — nothing
// outside models/lead.js should touch getDb() or the `leads` collection
// directly, so the doc shape and its persistence rules live in one place.
class Lead {
  constructor(data) {
    Object.assign(this, data);
  }

  // A "lead" represents a person, not a single booking — the doc ID is
  // deterministic from their identity so rebooking upserts the same doc
  // instead of creating a duplicate. Phone is preferred (most reliable
  // unique signal); falls back to name+email when phone wasn't captured.
  static buildId({ name, email, phone }) {
    const parts = phone
      ? [normalize(email), normalize(phone)]
      : [normalize(name), normalize(email)];
    return parts.filter(Boolean).join('_').slice(0, 1400) || `lead_${Date.now()}`;
  }

  // Fields common to any future lead source live at the top level;
  // source-specific data nests under its own key (e.g. `calendly`), since a
  // lead may later be reachable/updated by other channels too.
  static new({ userDir, name, email, phone, source, sourceData, status, messageSent = null, sendError = null, notes = null }) {
    const lead = new Lead({
      id: Lead.buildId({ name, email, phone }),
      userDir, name, email, phone, status, messageSent, sendError, notes, source,
      [source]: sourceData
    });
    return lead;
  }

  static async list(userDir, { limit = 50, cursor } = {}) {
    let query = getDb().collection('leads').where('userDir', '==', userDir).orderBy('updatedAt', 'desc').limit(limit);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    return snapshot.docs.map(doc => new Lead({ id: doc.id, ...doc.data() }));
  }

  static async findByIdForUser(userDir, leadId) {
    const doc = await getDb().collection('leads').doc(leadId).get();
    if (!doc.exists || doc.data().userDir !== userDir) return null;
    return new Lead({ id: doc.id, ...doc.data() });
  }

  async save() {
    const { id, ...data } = this;
    const now = new Date();
    await getDb().collection('leads').doc(id).set({
      ...data,
      updatedAt: now,
      createdAt: this.createdAt || now
    }, { merge: true });
    this.updatedAt = now;
    if (!this.createdAt) this.createdAt = now;
    return this;
  }

  async updateNotes(notes) {
    await getDb().collection('leads').doc(this.id).update({ notes, updatedAt: new Date() });
    this.notes = notes;
    return this;
  }

  async delete() {
    await getDb().collection('leads').doc(this.id).delete();
  }
}

module.exports = Lead;
