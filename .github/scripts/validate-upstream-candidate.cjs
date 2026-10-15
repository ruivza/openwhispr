const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { parseForkVersion, parseOfficialVersion } = require("./upstream-version.cjs");

async function validateCandidate(root) {
  root = path.resolve(root);
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const json = (file) => JSON.parse(read(file));
  const fork = json("src/config/fork.json");
  assert.equal(fork.officialAccountEnabled, false, "Official accounts must remain disabled");
  assert.equal(fork.hostedServicesEnabled, false, "Hosted services must remain disabled");
  const { version } = json("package.json");
  const { major, minor, patch, revision } = parseForkVersion(version);
  const lock = json("package-lock.json");
  assert.equal(lock.version, version, "Lockfile version must match package.json");
  assert.equal(lock.packages?.[""].version, version, "Lockfile root package version must match");
  const builder = json("electron-builder.json");
  for (const field of ["shortVersion", "shortVersionWindows"]) {
    assert.equal(builder.extraMetadata?.[field], `${major}.${minor}.${patch}.${revision}`, field);
  }
  assert.equal(builder.publish?.owner, "ruivza", "Update feed owner must remain the fork");
  assert.equal(builder.publish?.repo, "openwhispr", "Update feed repository must remain the fork");
  assert.equal(builder.publish?.channel, "ruivza", "Update feed channel must remain ruivza");

  const mobileVersion = json("openwhispr-mobile/config/fork-version.json");
  parseOfficialVersion(mobileVersion.upstreamVersion);
  assert.equal(
    mobileVersion.upstreamVersion,
    json("openwhispr-mobile/app.base.json").expo?.version,
    "Mobile fork upstreamVersion must match the Expo app version"
  );
  assert.ok(
    typeof mobileVersion.revision === "string" &&
      /^[1-9]\d*$/.test(mobileVersion.revision) &&
      Number.isSafeInteger(Number(mobileVersion.revision)),
    "Mobile fork revision must be a positive safe integer string"
  );

  const { load } = createRequire(path.join(root, "package.json"))("js-yaml");
  const workflows = new Map();
  for (const file of fs.readdirSync(path.join(root, ".github/workflows"))) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = load(read(`.github/workflows/${file}`), { filename: file });
    assert.ok(workflow?.jobs && workflow.on, `${file}: expected a workflow with jobs and triggers`);
    workflows.set(file, workflow);
  }
  const disabled = (condition) =>
    condition === false ||
    (typeof condition === "string" && /^(?:false|\$\{\{\s*false\s*\}\})$/.test(condition.trim()));
  const desktop = workflows.get("build-and-notarize.yml")?.jobs;
  assert.ok(disabled(desktop?.["build-linux"]?.if), "Desktop Linux builds must remain disabled");
  assert.deepEqual(
    desktop?.["build-macos"]?.strategy?.matrix,
    { arch: ["arm64"] },
    "Mac matrix must be arm64 only"
  );
  const windowsBuilds = desktop?.["build-windows"]?.steps?.filter((step) =>
    /npm run build:win\b/.test(step.run || "")
  );
  assert.equal(windowsBuilds?.length, 1, "Expected one Windows build command");
  assert.ok(
    /--x64\b/.test(windowsBuilds[0].run) ||
      (desktop["build-windows"]["runs-on"] === "windows-latest" &&
        !desktop["build-windows"].strategy?.matrix),
    "Windows builds must use x64 explicitly or the existing x64 runner without a matrix"
  );
  assert.doesNotMatch(
    windowsBuilds[0].run,
    /--(?:arm64|ia32)\b/,
    "Unsupported Windows architecture"
  );
  const aec = workflows.get("build-meeting-aec-helper.yml")?.jobs?.build?.strategy?.matrix;
  assert.deepEqual(
    Object.keys(aec || {}),
    ["include"],
    "AEC matrix must use explicit supported targets"
  );
  assert.deepEqual(
    aec.include.map((entry) => `${entry.platform}:${entry.arch}`).sort(),
    ["darwin:arm64", "win32:x64"],
    "AEC supports only Windows x64 and Mac arm64"
  );
  assert.ok(
    disabled(workflows.get("build-linux-text-monitor.yml")?.jobs?.build?.if),
    "Linux text monitor must remain disabled"
  );
  assert.ok(
    disabled(workflows.get("update-nix.yml")?.jobs?.["update-nix"]?.if),
    "Nix updates must remain disabled"
  );
  const iosTriggers = workflows.get("build-ios-unsigned.yml")?.on;
  assert.deepEqual(
    typeof iosTriggers === "string" ? [iosTriggers] : Object.keys(iosTriggers || {}),
    ["workflow_dispatch"],
    "iOS builds must remain manual only"
  );
  const publisher = workflows.get("publish-packages.yml");
  assert.equal(publisher?.name, "Publish Windows packages", "Publisher must remain Windows only");
  assert.match(
    publisher?.jobs?.publish?.if || "",
    /^\s*github\.repository\s*==\s*['"]ruivza\/openwhispr['"]\s*&&/,
    "Publisher must require the fork repository"
  );

  const freshImport = (file) => {
    const url = pathToFileURL(path.join(root, file));
    url.searchParams.set("candidate", randomUUID());
    return import(url.href);
  };
  const policy = await freshImport("src/services/syncPassPolicy.ts");
  assert.equal(
    policy.resolveSyncConsent({
      authValidated: true,
      signedIn: true,
      backupEnabled: true,
      subscribed: true,
      backupAllowedByPolicy: true,
      dataRetentionEnabled: true,
      insightsSyncEnabled: true,
    }).analytics,
    false,
    "Saved opt-in must not enable analytics uploads"
  );
  assert.equal(
    policy.canOfferAnalyticsClaim({
      signedIn: true,
      syncAllowedByPolicy: true,
      dataRetentionEnabled: true,
      insightsSyncEnabled: true,
      unclaimedCount: 1,
    }),
    false,
    "Local counters must not be offered for cloud upload"
  );
  const mobile = await freshImport("openwhispr-mobile/src/lib/fork.ts");
  assert.equal(
    mobile.HOSTED_SERVICES_ENABLED,
    false,
    "Mobile hosted services must remain disabled"
  );
  assert.deepEqual(mobile.localSelection({ mode: "openwhispr" }), { mode: "local" });
  const byok = { mode: "providers", providerId: "openai", endpoint: "https://fixture.invalid" };
  assert.equal(mobile.localSelection(byok), byok, "Existing BYOK selection must remain intact");
  return { version, workflows: workflows.size };
}

module.exports = { validateCandidate };

if (require.main === module) {
  validateCandidate(process.argv[2] || process.cwd()).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
