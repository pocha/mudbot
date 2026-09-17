const emailService = require('../emailService');

// One entry per distinguishable failure reason — the single source of truth
// for its HTTP status, user-facing message, and whether it notifies.
// Detection (which raw Baileys/mudslide condition maps to which reason) lives
// entirely in mudslideService.js, the one place that actually inspects real
// process output — this module only decides what to do once a reason is
// already known, so it has nothing to import from mudslideService.js (and
// nothing to create a require cycle with).
const ERROR_TYPES = {
  device_unlinked: {
    notifyOnEmail: true,
    statusCode: 400,
    defaultUserMessage: 'Your WhatsApp is not connected. Please reconnect.'
  },
  proxy_unreachable: {
    notifyOnEmail: true,
    statusCode: 503,
    defaultUserMessage: 'The residential proxy is misbehaving at the moment. Please try again in a bit.'
  },
  recipient_not_on_whatsapp: {
    notifyOnEmail: true,
    statusCode: 400,
    defaultUserMessage: 'This number is not on WhatsApp.'
  },
  timed_out: {
    notifyOnEmail: true,
    statusCode: 504,
    defaultUserMessage: 'The request took too long. Please try again.'
  },
  unexpected_closure: {
    notifyOnEmail: true,
    statusCode: 504,
    defaultUserMessage: 'Connection to WhatsApp was unexpectedly closed. Check if Watobot is still connected by visiting the dashboard.'
  }
};

// The one place email notification happens for a classified error. Safe to
// call more than once as the same error propagates up through several catch
// blocks — only the first call (whichever passes a reason, or finds one
// already tagged by an earlier call) classifies/notifies; later calls are
// no-ops. Never call emailService.notifyError directly elsewhere.
//
// `reason` is supplied by the caller — mudslideService.js does the actual
// detection against real process output — or, for idempotency, read off
// err.reason if an earlier call already tagged it. Always sets err.statusCode
// and rewrites err.message to a string safe to show the end user directly —
// classified or not (500 + generic text when unclassified) — so routes just
// do `reply.code(err.statusCode).send({ error: err.message, reason: err.reason })`,
// no fallback text or branching of their own needed. The operator email
// above still gets the original, unrewritten message (the actual
// diagnostic), since that happens before the rewrite.
function classify(err, { userDir, token, action, reason } = {}) {
  if (!err || err.__classified) return err;
  err.__classified = true;

  const finalReason = reason || err.reason;
  err.reason = finalReason;
  const type = finalReason && ERROR_TYPES[finalReason];
  // Unclassified (no reason) always notifies — an error we can't explain is
  // exactly the kind the operator most needs to see.
  const shouldNotify = type ? type.notifyOnEmail : true;
  if (shouldNotify) {
    emailService.notifyError(action, userDir, err.message, token).catch(() => {});
  }
  // Every classified error gets a safe status/message; unclassified ones fall back to a
  // generic 500 + generic text, so routes never need their own fallback text at all.
  err.statusCode = type ? type.statusCode : 500;
  err.message = type ? type.defaultUserMessage : 'Something went wrong. Please try again.';
  return err;
}

module.exports = { ERROR_TYPES, classify };
