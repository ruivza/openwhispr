const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { syncUpstream } = require("./sync-upstream.cjs");
const { setVersionMetadata } = require("./upstream-version.cjs");

function git(root, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Sync Test",
      "-c",
      "user.email=sync@example.invalid",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  ).trim();
}

function fixture(t, mobile = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-sync-tests-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("openwhispr-sync-tests-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, "init", "-b", "main");
  const write = (file, content) => fs.writeFileSync(path.join(work, file), content);
  write(
    "package.json",
    JSON.stringify({ name: "fixture", version: "1.10.3", scripts: { original: "keep" } }, null, 2)
  );
  write(
    "package-lock.json",
    JSON.stringify(
      {
        name: "fixture",
        version: "1.10.3",
        packages: { "": { version: "1.10.3" }, dependency: { version: "9.9.9" } },
      },
      null,
      2
    )
  );
  write(
    "electron-builder.json",
    JSON.stringify(
      { extraMetadata: { shortVersion: "1.10.3.0", shortVersionWindows: "1.10.3.0" } },
      null,
      2
    )
  );
  write("shared.txt", "base\n");
  if (mobile) {
    fs.mkdirSync(path.join(work, "openwhispr-mobile", "config"), { recursive: true });
    write("openwhispr-mobile/app.base.json", JSON.stringify({ expo: { version: "1.2.3" } }));
    write("openwhispr-mobile/feature.txt", "Official mobile base\n");
  }
  git(work, "add", ".");
  git(work, "commit", "-m", "Official base");
  const upstreamUrl = path.join(root, "upstream.git");
  const originUrl = path.join(root, "fork.git");
  git(root, "clone", "--bare", work, upstreamUrl);
  setVersionMetadata(work, "1.10.3-ruivza.1");
  const pkg = JSON.parse(fs.readFileSync(path.join(work, "package.json")));
  pkg.scripts.fork = "retain my custom command";
  write("package.json", JSON.stringify(pkg, null, 2));
  write("shared.txt", "fork change\n");
  write("fork.txt", "Keep my changes\n");
  if (mobile) {
    write(
      "openwhispr-mobile/config/fork-version.json",
      JSON.stringify({ upstreamVersion: "1.2.3", revision: "4" })
    );
  }
  git(work, "add", ".");
  git(work, "commit", "-m", "Fork changes");
  git(root, "clone", "--bare", work, originUrl);
  const original = git(work, "rev-parse", "HEAD");
  const upstream = path.join(root, "official");
  git(root, "clone", upstreamUrl, upstream);
  const advance = (changes = { "upstream.txt": "New official change\n" }, version) => {
    for (const [file, content] of Object.entries(changes))
      fs.writeFileSync(path.join(upstream, file), content);
    if (version) setVersionMetadata(upstream, version);
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "Official update");
    git(upstream, "push", "origin", "main");
    return git(upstream, "rev-parse", "HEAD");
  };
  const head = () => git(root, "--git-dir", originUrl, "rev-parse", "main");
  const show = (file) => git(root, "--git-dir", originUrl, "show", `main:${file}`);
  return { root, work, original, originUrl, upstreamUrl, advance, head, show };
}

test("no new upstream commits leaves main and its revision untouched", async (t) => {
  const f = fixture(t);
  let validations = 0;
  const result = await syncUpstream({ ...f, validate: async () => validations++ });
  assert.equal(result.status, "up_to_date");
  assert.equal(f.head(), f.original);
  assert.equal(validations, 0);
});

test("clean merge retains fork commits and updates only fork version metadata", async (t) => {
  const f = fixture(t);
  const upstream = f.advance({}, "1.10.4");
  const result = await syncUpstream({
    ...f,
    validate: async (root) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
      assert.equal(pkg.scripts.fork, "retain my custom command");
      assert.equal(pkg.version, "1.10.4-ruivza.1");
    },
  });
  assert.equal(result.status, "synced", JSON.stringify(result));
  assert.equal(f.show("fork.txt"), "Keep my changes");
  assert.equal(JSON.parse(f.show("electron-builder.json")).extraMetadata.shortVersion, "1.10.4.1");
  assert.equal(JSON.parse(f.show("package-lock.json")).packages.dependency.version, "9.9.9");
  assert.equal(
    git(f.root, "--git-dir", f.originUrl, "show", "-s", "--format=%P", "main"),
    `${f.original} ${upstream}`
  );
  assert.match(
    git(f.root, "--git-dir", f.originUrl, "show", "-s", "--format=%B", "main"),
    /\[skip ci\]/
  );
});

test("same official version increments the fork revision without publishing tags", async (t) => {
  const f = fixture(t);
  f.advance();
  const result = await syncUpstream({ ...f, validate: async () => {} });
  assert.equal(result.status, "synced", JSON.stringify(result));
  assert.equal(result.version, "1.10.3-ruivza.2");
  assert.equal(git(f.root, "--git-dir", f.originUrl, "tag", "--list"), "");
});

test("text conflicts report their paths and do not update main", async (t) => {
  const f = fixture(t);
  f.advance({ "shared.txt": "Official conflicting change\n" });
  const result = await syncUpstream({
    ...f,
    validate: async () => assert.fail("conflicts must stop before validation"),
  });
  assert.equal(result.status, "conflict", JSON.stringify(result));
  assert.deepEqual(result.conflicts, ["shared.txt"]);
  assert.equal(f.head(), f.original);
});

test("failed candidate checks preserve main and write a diagnostic result", async (t) => {
  const f = fixture(t);
  f.advance();
  const resultPath = path.join(f.root, "result.json");
  const result = await syncUpstream({
    ...f,
    resultPath,
    validate: async () => {
      throw new Error("Fork account policy changed");
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.details.join(" "), /Fork account policy changed/);
  assert.equal(f.head(), f.original);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath)), result);
});

test("checks cannot silently change the tracked candidate after validation", async (t) => {
  const f = fixture(t);
  f.advance();
  const result = await syncUpstream({
    ...f,
    validate: async (root) => fs.writeFileSync(path.join(root, "fork.txt"), "Unexpected edit\n"),
  });
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.match(result.details.join(" "), /checks changed tracked files/);
  assert.equal(f.head(), f.original);
});

for (const [officialVersion, revision] of [
  ["1.2.3", "5"],
  ["1.2.4", "1"],
]) {
  test(`mobile changes follow official ${officialVersion} with fork revision ${revision}`, async (t) => {
    const f = fixture(t, true);
    f.advance({
      "openwhispr-mobile/app.base.json": JSON.stringify({ expo: { version: officialVersion } }),
      "openwhispr-mobile/feature.txt": "Official mobile update\n",
    });
    const result = await syncUpstream({ ...f, validate: async () => {} });
    assert.equal(result.status, "synced", JSON.stringify(result));
    assert.deepEqual(JSON.parse(f.show("openwhispr-mobile/config/fork-version.json")), {
      upstreamVersion: officialVersion,
      revision,
    });
  });
}

test("a concurrent user push is kept instead of being overwritten", async (t) => {
  const f = fixture(t);
  f.advance();
  let userCommit;
  const result = await syncUpstream({
    ...f,
    validate: async () => {},
    beforePush: async () => {
      fs.writeFileSync(path.join(f.work, "user.txt"), "Concurrent user work\n");
      git(f.work, "add", ".");
      git(f.work, "commit", "-m", "User work");
      userCommit = git(f.work, "rev-parse", "HEAD");
      git(f.work, "push", f.originUrl, "main");
    },
  });
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(f.head(), userCommit);
  assert.equal(f.show("user.txt"), "Concurrent user work");
});

test("dry-run validates a candidate while leaving the remote unchanged", async (t) => {
  const f = fixture(t);
  f.advance();
  const result = await syncUpstream({ ...f, dryRun: true, validate: async () => {} });
  assert.equal(result.status, "synced", JSON.stringify(result));
  assert.equal(result.dryRun, true);
  assert.equal(f.head(), f.original);
});
