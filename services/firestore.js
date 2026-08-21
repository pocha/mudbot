const admin = require('firebase-admin');

// Lazy-initialized: requiring this module must never throw just because
// FIREBASE_SERVICE_ACCOUNT_JSON isn't set — the rest of the app (WhatsApp,
// schedules, FAQ) has nothing to do with Firestore and must keep booting
// fine on deployments that haven't configured Calendly yet. The cost is
// only paid the first time a Calendly/leads route actually runs.
let db = null;

function getDb() {
  if (!db) {
    const app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
    }, 'watobot-main');
    db = admin.firestore(app);
  }
  return db;
}

module.exports = { getDb };
