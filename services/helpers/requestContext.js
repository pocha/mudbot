const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// The current request's own identifier (e.g. "GET /api/whatsapp"), set once
// per request (see server.js's onRequest hook) and readable from anywhere in
// that request's async call chain — deep inside mudslideService.js,
// proxyRelayManager.js, etc. — without threading it through every function
// signature in between. Node's AsyncLocalStorage propagates automatically
// through awaits/promises/callbacks descended from the runWithLabel() call,
// so this also just works for preHandler-invoked functions (authenticateUser,
// requireWhatsapp) — they run in the same request's async context as the
// route handler itself.
function runWithLabel(label, fn) {
  return storage.run({ label }, fn);
}

function getLabel() {
  return storage.getStore()?.label;
}

module.exports = { runWithLabel, getLabel };