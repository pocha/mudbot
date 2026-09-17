const emailService = require('../emailService');

// The one source of truth for reason strings — every file that needs to
// compare against, assign, or branch on a reason imports these directly
// (no REASONS. prefix) instead of typing the string literal, so renaming one
// only ever means changing it here.
const DEVICE_UNLINKED = 'device_unlinked';
const PROXY_UNREACHABLE = 'proxy_unreachable';
const RECIPIENT_NOT_ON_WHATSAPP = 'recipient_not_on_whatsapp';
const TIMED_OUT = 'timed_out';
const UNEXPECTED_CLOSURE = 'unexpected_closure';

// One entry per distinguishable failure reason — the single source of truth
// for its HTTP status, user-facing message, and whether it notifies.
// Detection (which raw Baileys/mudslide condition maps to which reason) lives
// entirely in mudslideService.js, the one place that actually inspects real
// process output — this module only decides what to do once a reason is
// already known, so it has nothing to import from mudslideService.js (and
// nothing to create a require cycle with).
const ERROR_TYPES = {
  [DEVICE_UNLINKED]: {
    notifyOnEmail: true,
    statusCode: 400,
    defaultUserMessage: 'Your WhatsApp is not connected. Please reconnect.'
  },
  [PROXY_UNREACHABLE]: {
    notifyOnEmail: true,
    statusCode: 503,
    defaultUserMessage: 'The residential proxy is misbehaving at the moment. Please try again in a bit.'
  },
  [RECIPIENT_NOT_ON_WHATSAPP]: {
    notifyOnEmail: true,
    statusCode: 400,
    defaultUserMessage: 'This number is not on WhatsApp.'
  },
  [TIMED_OUT]: {
    notifyOnEmail: true,
    statusCode: 504,
    defaultUserMessage: 'The request took too long. Please try again.'
  },
  [UNEXPECTED_CLOSURE]: {
    notifyOnEmail: true,
    statusCode: 504,
    defaultUserMessage: 'Connection to WhatsApp was unexpectedly closed. Check if Watobot is still connected by visiting the dashboard.'
  }
};

// The one place email notification happens for a classified error. Safe to
// call more than once as the same error propagates up through several catch
// blocks — only the first call (whichever passes a reason, or finds one
// already tagged by an earlier call) classifies/notifies; later calls are
// no-ops (see err.notified below). Never call emailService.notifyError
// directly elsewhere — the one exception is a route that never uses
// err.statusCode/err.message at all and just wants "notify if nothing
// upstream already did", which should check err.notified itself rather than
// pay for a full (and confusing, out of place) classify() call.
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
  if (!err || err.notified) return err;
  err.notified = true;

  const finalReason = reason || err.reason;
  err.reason = finalReason;
  const type = finalReason && ERROR_TYPES[finalReason];
  // Unclassified (no reason) always notifies — an error we can't explain is
  // exactly the kind the operator most needs to see.
  const shouldNotify = type ? type.notifyOnEmail : true;
  if (shouldNotify) {
    emailService.notifyError(action, userDir, err.message, token, err.stack).catch(() => {});
  }
  // Every classified error gets a safe status/message; unclassified ones fall back to a
  // generic 500 + generic text, so routes never need their own fallback text at all.
  err.statusCode = type ? type.statusCode : 500;
  err.message = type ? type.defaultUserMessage : 'Something went wrong. Please try again.';
  return err;
}

module.exports = {
  DEVICE_UNLINKED,
  PROXY_UNREACHABLE,
  RECIPIENT_NOT_ON_WHATSAPP,
  TIMED_OUT,
  UNEXPECTED_CLOSURE,
  ERROR_TYPES,
  classify
};
