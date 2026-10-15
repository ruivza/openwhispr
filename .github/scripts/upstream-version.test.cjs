const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseOfficialVersion,
  parseForkVersion,
  deriveNextVersion,
  setVersionMetadata,
  deriveMobileVersion,
  setMobileVersionMetadata,
} = require("./upstream-version.cjs");

const PACKAGE =
  '{\r\n\t"name":"fixture",\r\n "version" : "1.10.3-ruivza.1",\r\n "dependencies":{"unchanged":"1.10.3-ruivza.1"},\r\n "nested":{"version":"1.10.3-ruivza.1"}\r\n}\r\n';
const LOCK =
  '{"version":"1.10.3-ruivza.1","lockfileVersion":3,"packages":{"":{"name":"fixture","version"  :  "1.10.3-ruivza.1"},"node_modules/fixture":{"version":"1.10.3-ruivza.1","resolved":"https://example.test/{quoted}","integrity":"unchanged"}},"array":[true,null,1,{"version":"untouched"}]}';
const BUILDER =
  '{\n  "extraMetadata" : {"windowsTrayIdentity":true,"shortVersion":"1.10.3.1", "shortVersionWindows" : "1.10.3.1"},\n  "win":{"target":["nsis"]},\n  "untouched":"escaped quote \\" and brace }"\n}\n';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-upstream-version-"));
  const files = {
    "package.json": PACKAGE,
    "package-lock.json": LOCK,
    "electron-builder.json": BUILDER,
    ...overrides,
  };
  for (const [filename, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, filename), text, "utf8");
  }
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("openwhispr-upstream-version-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, read: (filename) => fs.readFileSync(path.join(root, filename), "utf8") };
}

test("same official baseline increments numeric fork revisions", () => {
  for (const [before, after] of [
    [1, 2],
    [9, 10],
    [99, 100],
  ]) {
    assert.equal(deriveNextVersion(`1.10.3-ruivza.${before}`, "1.10.3"), `1.10.3-ruivza.${after}`);
  }
  assert.deepEqual(parseOfficialVersion("0.10.3"), { major: 0, minor: 10, patch: 3 });
  assert.deepEqual(parseForkVersion("1.10.3-ruivza.7"), {
    major: 1,
    minor: 10,
    patch: 3,
    revision: 7,
  });
});

test("official patch, minor and major upgrades reset the revision to one", () => {
  for (const upstream of ["1.10.4", "1.11.0", "2.0.0"]) {
    assert.equal(deriveNextVersion("1.10.3-ruivza.99", upstream), `${upstream}-ruivza.1`);
  }
});

test("official baselines cannot move backwards", () => {
  for (const upstream of ["1.10.2", "1.9.99", "0.99.99"]) {
    assert.throws(() => deriveNextVersion("1.10.3-ruivza.2", upstream), /backwards/);
  }
});

test("version parsing rejects noncanonical versions and unsafe integers", () => {
  for (const value of [
    "v1.2.3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3.4",
    "1.2.3-beta.1",
    "1.2.3+build",
    " 1.2.3",
    null,
  ]) {
    assert.throws(() => parseOfficialVersion(value), /Invalid official version/);
  }
  for (const value of [
    "1.2.3",
    "1.2.3-ruivza.0",
    "1.2.3-ruivza.01",
    "1.2.3-ruivza.-1",
    "1.2.3-ruivza.1+build",
    "1.2.3-Ruivza.1",
    "1.2.3-ruivza.1\n",
    1,
  ]) {
    assert.throws(() => parseForkVersion(value), /Invalid fork version/);
  }
  assert.throws(() => parseOfficialVersion("9007199254740992.0.0"), /safe integers/);
  assert.throws(() => parseForkVersion("1.2.3-ruivza.9007199254740992"), /safe integers/);
  assert.throws(
    () => deriveNextVersion("1.2.3-ruivza.9007199254740991", "1.2.3"),
    /safe integer range/
  );
});

test("fork metadata changes exactly five strings and preserves all other bytes", (t) => {
  const { root, read } = fixture(t);
  const result = setVersionMetadata(root, "1.10.3-ruivza.2");
  assert.deepEqual(result, {
    version: "1.10.3-ruivza.2",
    windowsVersion: "1.10.3.2",
    changedFiles: ["package.json", "package-lock.json", "electron-builder.json"],
  });
  assert.equal(
    read("package.json"),
    PACKAGE.replace('"version" : "1.10.3-ruivza.1"', '"version" : "1.10.3-ruivza.2"')
  );
  assert.equal(
    read("package-lock.json"),
    LOCK.replace('"version":"1.10.3-ruivza.1"', '"version":"1.10.3-ruivza.2"').replace(
      '"version"  :  "1.10.3-ruivza.1"',
      '"version"  :  "1.10.3-ruivza.2"'
    )
  );
  assert.equal(read("electron-builder.json"), BUILDER.replaceAll('"1.10.3.1"', '"1.10.3.2"'));
  assert.deepEqual(setVersionMetadata(root, "1.10.3-ruivza.2").changedFiles, []);
});

test("stable merge-base normalization touches only the three package versions", (t) => {
  const { root, read } = fixture(t, {
    "electron-builder.json": "not valid JSON, deliberately unread",
  });
  assert.deepEqual(setVersionMetadata(root, "1.10.2"), {
    version: "1.10.2",
    windowsVersion: null,
    changedFiles: ["package.json", "package-lock.json"],
  });
  assert.equal(JSON.parse(read("package.json")).version, "1.10.2");
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, "1.10.2");
  assert.equal(lock.packages[""].version, "1.10.2");
  assert.equal(lock.packages["node_modules/fixture"].version, "1.10.3-ruivza.1");
  assert.equal(read("electron-builder.json"), "not valid JSON, deliberately unread");
});

test("malformed JSON, missing fields and wrong types fail before any write", (t) => {
  for (const [filename, content, error] of [
    ["package-lock.json", "{bad-json", /package-lock\.json: invalid JSON/],
    ["package-lock.json", '{"version":"1.10.3","packages":{}}', /missing property/],
    [
      "electron-builder.json",
      '{"extraMetadata":{"shortVersion":1,"shortVersionWindows":"1.10.3.1"}}',
      /expected a version string/,
    ],
    ["electron-builder.json", '{"extraMetadata":[]}', /expected a JSON object/],
  ]) {
    const { root, read } = fixture(t, { [filename]: content });
    assert.throws(() => setVersionMetadata(root, "1.10.3-ruivza.2"), error);
    assert.equal(read("package.json"), PACKAGE);
    assert.equal(read(filename), content);
  }
});

test("duplicate target properties are rejected and escaped property names work", (t) => {
  const duplicate = fixture(t, { "package.json": '{"version":"1.10.3","version":"1.10.3"}' });
  assert.throws(() => setVersionMetadata(duplicate.root, "1.10.3-ruivza.2"), /duplicate property/);
  assert.equal(duplicate.read("package.json"), '{"version":"1.10.3","version":"1.10.3"}');
  const escaped = fixture(t, {
    "package-lock.json": LOCK.replace('"packages"', '"pack\\u0061ges"'),
  });
  setVersionMetadata(escaped.root, "1.10.4-ruivza.1");
  assert.equal(
    JSON.parse(escaped.read("package-lock.json")).packages[""].version,
    "1.10.4-ruivza.1"
  );
  assert.ok(escaped.read("package-lock.json").includes('"pack\\u0061ges"'));
  assert.equal(
    JSON.parse(escaped.read("electron-builder.json")).extraMetadata.shortVersion,
    "1.10.4.1"
  );
});

test("mobile revisions increment independently, reset on official upgrades and reject downgrades", () => {
  const before = { upstreamVersion: "1.2.3", revision: "9" };
  assert.deepEqual(deriveMobileVersion(before, "1.2.3"), {
    upstreamVersion: "1.2.3",
    revision: "10",
  });
  assert.deepEqual(deriveMobileVersion(before, "1.2.4"), {
    upstreamVersion: "1.2.4",
    revision: "1",
  });
  assert.throws(() => deriveMobileVersion(before, "1.2.2"), /backwards/);
  assert.throws(() => deriveMobileVersion({ ...before, revision: 9 }, "1.2.3"), /integer string/);
  assert.deepEqual(before, { upstreamVersion: "1.2.3", revision: "9" });
});

test("mobile metadata updates only its two strings without changing desktop or package metadata", (t) => {
  const { root, read } = fixture(t);
  const filename = "openwhispr-mobile/config/fork-version.json";
  const content =
    '{\r\n  "upstreamVersion" : "1.2.3", "revision":"1", "untouched":{"revision":"1"}\r\n}\r\n';
  fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
  fs.writeFileSync(path.join(root, filename), content);
  const packageFile = path.join(root, "openwhispr-mobile/package.json");
  fs.writeFileSync(packageFile, '{"version":"other-package-version"}');
  assert.deepEqual(setMobileVersionMetadata(root, "1.2.4", "2"), {
    upstreamVersion: "1.2.4",
    revision: "2",
    forkVersion: "1.2.4.2",
    changedFiles: [filename],
  });
  const expected = content
    .replace('"upstreamVersion" : "1.2.3"', '"upstreamVersion" : "1.2.4"')
    .replace('"revision":"1"', '"revision":"2"');
  assert.equal(read(filename), expected);
  assert.deepEqual(setMobileVersionMetadata(root, "1.2.4", "2").changedFiles, []);
  assert.throws(() => setMobileVersionMetadata(root, "1.2.4", "0"), /Invalid fork version/);
  assert.equal(read(filename), expected);
  assert.equal(read("package.json"), PACKAGE);
  assert.equal(read("package-lock.json"), LOCK);
  assert.equal(read("electron-builder.json"), BUILDER);
  assert.equal(fs.readFileSync(packageFile, "utf8"), '{"version":"other-package-version"}');
});
