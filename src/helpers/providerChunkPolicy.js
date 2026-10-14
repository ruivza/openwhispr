const { PROVIDER_ERROR_CODES: C } = require("./providerHttpErrors");

const FATAL_CODES = new Set([
  C.KEY_MISSING,
  C.AUTH_FAILED,
  C.ACCESS_DENIED,
  C.QUOTA_EXHAUSTED,
  C.MODEL_NOT_FOUND,
]);
const TRANSIENT_CODES = new Set([C.RATE_LIMITED, C.UNAVAILABLE, C.TIMEOUT, C.UNREACHABLE]);

function isFatalProviderChunkError(error) {
  return FATAL_CODES.has(error.code) || [401, 403].includes(error.status ?? error.statusCode);
}

// Unlike OpenWhispr's quota response, a provider's ordinary 429 can clear on retry.
function isTransientProviderChunkError(error) {
  if (isFatalProviderChunkError(error)) return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  const status = error.status ?? error.statusCode;
  if (status != null) return status === 408 || status === 429 || status >= 500;
  return !error.code && error.name !== "AbortError";
}

module.exports = { isFatalProviderChunkError, isTransientProviderChunkError };
