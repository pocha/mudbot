// Races a promise against a timeout, rejecting with a descriptive Error if
// it doesn't settle in time. The message is the diagnostic — every caller
// names what it's wrapping, so a failure reports exactly where it happened
// without needing a separate timeout per internal sub-call.
function errorOnTimeout(promise, timeoutMs, message) {
  promise.catch(() => {}); // don't let a late rejection (after losing the race) become unhandled
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

// Wraps an async function so every call races against the same timeout —
// lets a whole-function timeout be declared once, where the function is
// exported, instead of repeating errorOnTimeout(fn(...args), ...) at every
// call site.
function withErrorOnTimeout(fn, timeoutMs, message) {
  return (...args) => errorOnTimeout(fn(...args), timeoutMs, message);
}

module.exports = { errorOnTimeout, withErrorOnTimeout };