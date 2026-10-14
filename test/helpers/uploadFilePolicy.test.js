const test = require("node:test");
const assert = require("node:assert/strict");
const MB = 1024 * 1024;
const base = { local: false, cloud: false, pro: false, managed: false, provider: "openai" };

test("BYOK and Custom large files are accepted without a cloud subscription", async () => {
  const { uploadFileSizeState } = await import("../../src/helpers/uploadFilePolicy.ts");
  for (const provider of ["openai", "groq", "gemini", "mistral", "custom"]) {
    const state = uploadFileSizeState(600 * MB, { ...base, provider });
    assert.equal(state.errorKey, null);
    assert.equal(state.requiresUpgrade, false);
    assert.equal(state.isLargeFile, true);
  }
  assert.equal(uploadFileSizeState(14 * MB, { ...base, provider: "gemini" }).isLargeFile, false);
  assert.equal(uploadFileSizeState(14 * MB + 1, { ...base, provider: "gemini" }).isLargeFile, true);
  assert.equal(uploadFileSizeState(25 * MB, base).isLargeFile, false);
  assert.equal(uploadFileSizeState(25 * MB + 1, base).isLargeFile, true);
});

test("cloud plans and managed limits remain enforced; cloud chunk hint starts at 4 MiB", async () => {
  const { uploadFileSizeState: state } = await import("../../src/helpers/uploadFilePolicy.ts");
  assert.equal(state(25 * MB, { ...base, cloud: true }).errorKey, null);
  assert.equal(state(25 * MB + 1, { ...base, cloud: true }).errorKey, "paidPlanRequired");
  assert.equal(state(500 * MB, { ...base, cloud: true, pro: true }).errorKey, null);
  assert.equal(state(500 * MB + 1, { ...base, cloud: true, pro: true }).errorKey, "fileTooLarge");
  assert.equal(state(4 * MB, { ...base, cloud: true }).isLargeFile, false);
  assert.equal(state(4 * MB + 1, { ...base, cloud: true }).isLargeFile, true);
  assert.equal(state(26 * MB, { ...base, managed: true, cloud: true }).errorKey, "byokTooLarge");
  assert.equal(state(1000 * MB, { ...base, local: true }).errorKey, null);
  assert.equal(state(1000 * MB, { ...base, local: true }).isLargeFile, false);
});
