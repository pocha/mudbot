// Lets a service throw with an intended HTTP status attached, so a route's
// catch block can surface it directly instead of always falling back to a
// generic 500 (the convention everywhere else in this codebase, since no
// other service needed to distinguish error types from its callers before).
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = ApiError;
