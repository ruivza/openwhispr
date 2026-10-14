const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isTransientProviderChunkError: transient,
  isFatalProviderChunkError: fatal,
} = require("../../src/helpers/providerChunkPolicy");
const {
  providerHttpError,
  PROVIDER_ERROR_CODES: C,
} = require("../../src/helpers/providerHttpErrors");

test("provider errors retry only when another attempt can help", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(transient({ status }), true);
  for (const status of [400, 401, 403, 404, 413, 422]) assert.equal(transient({ status }), false);
  for (const code of [
    C.KEY_MISSING,
    C.AUTH_FAILED,
    C.ACCESS_DENIED,
    C.QUOTA_EXHAUSTED,
    C.MODEL_NOT_FOUND,
  ]) {
    assert.equal(fatal({ code }), true);
    assert.equal(transient({ code }), false);
  }
  assert.equal(transient({ code: "NO_SPEECH_DETECTED" }), false);
  assert.equal(transient(new TypeError("fetch failed")), true);
});

test("HTTP 429 quota exhaustion is fatal while ordinary provider rate limiting retries", () => {
  const quota = providerHttpError({
    provider: "OpenAI",
    status: 429,
    body: { error: { code: "insufficient_quota" } },
    surface: "transcription",
  });
  assert.equal(fatal(quota), true);
  assert.equal(transient(quota), false);
  const rate = providerHttpError({
    provider: "OpenAI",
    status: 429,
    body: "rate limit",
    surface: "transcription",
  });
  assert.equal(fatal(rate), false);
  assert.equal(transient(rate), true);
});
