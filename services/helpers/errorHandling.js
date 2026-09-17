const emailService = require('../emailService');

// Exact text our mudslide fork prints when Baileys reports a loggedOut disconnect — i.e. the user removed this device from WhatsApp's "Linked Devices" list (the only way to tell, since the cached creds.json otherwise still looks fine).
const DEVICE_UNLINKED_MARKER = 'Device unlinked from WhatsApp';

// Set by mudslideService's diagnoseConnectivityFailure once it's actively confirmed (via a real curl probe through the user's proxy) that the proxy itself, not a device-unlink or anything else, was the cause — this module never runs that probe itself, it only recognizes the prefix once diagnoseConnectivityFailure has already rewritten err.message with it.
const PROXY_UNREACHABLE_PREFIX = 'Residential proxy is not reachable — likely a bad or expired sticky IP, contact the Watobot operator.';

// Exact text mudslide's --live-check prints before exiting when the recipient isn't registered on WhatsApp at all.
const RECIPIENT_NOT_ON_WHATSAPP_MARKER = 'Recipient does not exist on WhatsApp';

// Exact text mudslide prints when connection.update fires 'close' for any reason other than a confirmed device-unlink — e.g. a proxy that can't route to WhatsApp at all.
const CONNECTION_CLOSED_MARKER = 'Connection closed unexpectedly';

function isConnectivityFailure(message) {
  return typeof message === 'string' &&
    (message.includes('timed out') || message.includes(CONNECTION_CLOSED_MARKER));
}

// One entry per distinguishable failure reason. `marker` is the literal text
// classify() detects it from; `timed_out` has none — it's whatever's left
// over once isConnectivityFailure() matches but nothing more specific did
// (i.e. a real timeout that diagnoseConnectivityFailure could NOT confirm
// was proxy-caused).
const ERROR_TYPES = {
  device_unlinked: {
    marker: DEVICE_UNLINKED_MARKER,
    notifyOnEmail: true,
    defaultUserMessage: 'Your WhatsApp is not connected. Please reconnect.'
  },
  proxy_unreachable: {
    marker: PROXY_UNREACHABLE_PREFIX,
    notifyOnEmail: true,
    defaultUserMessage: 'Our residential proxy is temporarily unreachable. Please try again shortly.'
  },
  recipient_not_on_whatsapp: {
    marker: RECIPIENT_NOT_ON_WHATSAPP_MARKER,
    notifyOnEmail: false,
    defaultUserMessage: 'This number is not on WhatsApp.'
  },
  timed_out: {
    marker: null,
    notifyOnEmail: false,
    defaultUserMessage: 'The request took too long. Please try again.'
  }
};

function matchReason(message) {
  for (const [reason, type] of Object.entries(ERROR_TYPES)) {
    if (type.marker && typeof message === 'string' && message.includes(type.marker)) return reason;
  }
  return isConnectivityFailure(message) ? 'timed_out' : undefined;
}

// The one place classification AND (when warranted) email notification happen
// for a raw error. Safe to call more than once as the same error propagates
// up through several catch blocks — only the first call classifies/notifies,
// later calls are no-ops. Never call emailService.notifyError directly
// elsewhere.
function classify(err, { userDir, token, action } = {}) {
  if (!err || err.__classified) return err;
  err.__classified = true;

  const reason = matchReason(err.message);
  err.reason = reason;
  const type = reason && ERROR_TYPES[reason];
  // Unclassified (reason undefined) always notifies — an error we can't
  // explain is exactly the kind the operator most needs to see.
  const shouldNotify = type ? type.notifyOnEmail : true;
  if (shouldNotify) {
    emailService.notifyError(action, userDir, err.message, token).catch(() => {});
  }
  return err;
}

module.exports = {
  DEVICE_UNLINKED_MARKER,
  PROXY_UNREACHABLE_PREFIX,
  RECIPIENT_NOT_ON_WHATSAPP_MARKER,
  CONNECTION_CLOSED_MARKER,
  isConnectivityFailure,
  ERROR_TYPES,
  classify
};
