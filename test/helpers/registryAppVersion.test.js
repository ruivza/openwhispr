const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRegistryAppVersion } = require("../../src/models/registryAppVersion.js");
const { selectCatalog } = require("../../src/models/registrySchema.cjs");
const seed = require("../../src/models/modelRegistryData.json");

test("only complete safe fork revisions normalize to their upstream compatibility version", () => {
  for (const [value, expected] of [
    [
      require("../../package.json").version,
      require("../../package.json").version.split("-ruivza.")[0],
    ],
    ["0.0.0-ruivza.1", "0.0.0"],
    ["1.10.3-ruivza.2", "1.10.3"],
    ["9007199254740991.0.0-ruivza.9007199254740991", "9007199254740991.0.0"],
  ]) {
    assert.equal(normalizeRegistryAppVersion(value), expected);
    assert.doesNotThrow(() => selectCatalog(seed, {}, normalizeRegistryAppVersion(value)));
  }
});

test("canonical versions and non-string values are preserved for the original schema", () => {
  const object = {};
  for (const value of ["0.0.0", "1.10.3", undefined, null, 1, object]) {
    assert.equal(normalizeRegistryAppVersion(value), value);
  }
});

test("malformed and unsafe versions stay unchanged and fail the registry validator", () => {
  for (const value of [
    "1.10",
    "01.10.3-ruivza.2",
    "1.010.3-ruivza.2",
    "1.10.03-ruivza.2",
    "1.10.3-ruivza.0",
    "1.10.3-ruivza.01",
    "1.10.3-ruivza.-1",
    "1.10.3-ruivza.2.extra",
    "1.10.3-ruivza.2+build",
    "1.10.3-ruivza.2\n",
    " 1.10.3-ruivza.2",
    "1.10.3-beta.2",
    "9007199254740992.0.0-ruivza.1",
    "0.9007199254740992.0-ruivza.1",
    "0.0.9007199254740992-ruivza.1",
    "1.10.3-ruivza.9007199254740992",
  ]) {
    assert.equal(normalizeRegistryAppVersion(value), value, value);
    assert.throws(() => selectCatalog(seed, {}, normalizeRegistryAppVersion(value)), {
      name: "ZodError",
    });
  }
});
