const test = require("node:test");
const { afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const semver = Module.createRequire(require.resolve("electron-updater/package.json"))("semver");

process.env.NODE_ENV = "test";

const updaterModulePath = require.resolve("../../src/updater.js");
const originalLoad = Module._load;
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalAppImage = process.env.APPIMAGE;

const STARTUP_DELAY_MS = 3000;
const PERIODIC_INTERVAL_MS = 4 * 60 * 60 * 1000;

function makeAutoUpdater({ offline = false } = {}) {
  const listeners = {};
  let channel = null;
  const autoUpdater = {
    calls: 0,
    downloads: 0,
    installs: [],
    listeners,
    feeds: [],
    currentVersion: semver.parse("1.10.3-ruivza.1"),
    get channel() {
      return channel;
    },
    set channel(value) {
      channel = value;
      // Match the real updater setter so setup must explicitly disable this.
      autoUpdater.allowDowngrade = true;
    },
    setFeedURL(feed) {
      autoUpdater.feeds.push(feed);
    },
    on(event, handler) {
      listeners[event] = handler;
    },
    removeListener() {},
    checkForUpdates() {
      autoUpdater.calls += 1;
      if (offline) {
        // electron-updater emits the error before rejecting
        const error = new Error("net::ERR_INTERNET_DISCONNECTED");
        listeners.error?.(error);
        return Promise.reject(error);
      }
      return Promise.resolve({ isUpdateAvailable: false });
    },
    downloadUpdate() {
      autoUpdater.downloads += 1;
      return Promise.resolve();
    },
    quitAndInstall(...args) {
      autoUpdater.installs.push(args);
    },
  };
  return autoUpdater;
}

// updater.js requires electron and child_process lazily (constructor, cleanup(),
// Rosetta probe), so the mocks stay installed until afterEach.
function createUpdateManager(autoUpdater, { translated = "0" } = {}) {
  delete require.cache[updaterModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater };
    if (request === "electron") return { autoUpdater: { on() {}, removeListener() {} } };
    if (request === "child_process") {
      return {
        execSync: () => {
          if (translated instanceof Error) throw translated;
          return translated;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const UpdateManager = require(updaterModulePath);
  return new UpdateManager();
}

function makeRendererWindow(sent) {
  return {
    isDestroyed: () => false,
    webContents: {
      send(channel) {
        sent.push(channel);
      },
    },
  };
}

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setArch(arch) {
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

beforeEach((t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  // Exercise a supported Apple Silicon machine regardless of the test host.
  setPlatform("darwin");
  setArch("arm64");
});

afterEach(() => {
  Module._load = originalLoad;
  setPlatform(originalPlatform);
  setArch(originalArch);
  if (originalAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = originalAppImage;
});

test("startup and periodic checks run whether or not automatic updates are on", (t) => {
  for (const enabled of [true, false, null]) {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const autoUpdater = makeAutoUpdater();
    const manager = createUpdateManager(autoUpdater);
    if (enabled !== null) manager.setAutoUpdatesEnabled(enabled);

    manager.checkForUpdatesOnStartup();
    t.mock.timers.tick(STARTUP_DELAY_MS);
    assert.equal(autoUpdater.calls, 1, `startup check with preference ${enabled}`);
    t.mock.timers.tick(PERIODIC_INTERVAL_MS);
    assert.equal(autoUpdater.calls, 2, `periodic check with preference ${enabled}`);

    manager.cleanup();
    t.mock.timers.reset();
  }
});

test("runtime and packaged update sources point only at this fork", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  const expected = {
    provider: "github",
    owner: "ruivza",
    repo: "openwhispr",
    private: false,
    channel: "ruivza",
  };
  const [{ updateProvider, macUpdateArch, provider, ...runtimeFeed }] = autoUpdater.feeds;
  assert.equal(provider, "custom");
  assert.equal(typeof updateProvider, "function");
  assert.equal(macUpdateArch, process.arch);
  assert.deepEqual({ provider: "github", ...runtimeFeed }, expected);
  const { releaseType, ...packagedFeed } = require("../../electron-builder.json").publish;
  assert.deepEqual(packagedFeed, expected);
  assert.equal(releaseType, "draft");
  assert.equal(autoUpdater.channel, "ruivza");
  assert.equal(autoUpdater.allowPrerelease, true);
  assert.equal(autoUpdater.allowDowngrade, false);
  manager.cleanup();
});

test("the real GitHub provider selects fork tags and platform-specific metadata", async () => {
  const scenarios = [
    { platform: "darwin", arch: "arm64", file: "ruivza-arm64-mac.yml" },
    // { platform: "darwin", arch: "x64", file: "ruivza-x64-mac.yml" },
    { platform: "darwin", arch: "x64", translated: "1", file: "ruivza-arm64-mac.yml" },
    { platform: "win32", arch: "x64", file: "ruivza.yml" },
    // { platform: "linux", arch: "x64", file: "ruivza-linux.yml" },
    // { platform: "linux", arch: "arm64", file: "ruivza-linux-arm64.yml" },
  ];
  const version = "1.10.3-ruivza.10";
  const tags = ["v1.10.4", "v1.10.3-beta.99", `v${version}`, "v1.10.3-ruivza.2"];
  const feedXml = `<feed>${tags
    .map(
      (tag) =>
        `<entry><title>${tag}</title><link href="https://github.com/ruivza/openwhispr/releases/tag/${tag}"/><content>Fixture release</content></entry>`
    )
    .join("")}</feed>`;
  for (const scenario of scenarios) {
    setPlatform(scenario.platform);
    setArch(scenario.arch);
    const autoUpdater = makeAutoUpdater();
    const manager = createUpdateManager(autoUpdater, scenario);
    const requests = [];
    const options = autoUpdater.feeds[0];
    const { createClient } = require("electron-updater/out/providerFactory");
    const provider = createClient(options, autoUpdater, {
      platform: scenario.platform,
      executor: {
        async request(request) {
          requests.push({ hostname: request.hostname, path: request.path });
          if (request.path.endsWith(".atom")) return feedXml;
          return JSON.stringify({
            version,
            files: [{ url: "fixture.zip", sha512: "fixture", size: 1 }],
          });
        },
      },
    });
    const result = await provider.getLatestVersion();
    assert.equal(result.tag, `v${version}`);
    assert.equal(result.version, version);
    assert.deepEqual(requests, [
      { hostname: "github.com", path: "/ruivza/openwhispr/releases.atom" },
      {
        hostname: "github.com",
        path: `/ruivza/openwhispr/releases/download/v${version}/${scenario.file}`,
      },
    ]);
    assert.equal(autoUpdater.allowDowngrade, false);
    manager.cleanup();
  }
});

test("the real updater uses SemVer revisions and never downgrades the old fork version", async () => {
  const { AppUpdater } = require("electron-updater/out/AppUpdater");
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  const updater = {
    currentVersion: autoUpdater.currentVersion,
    allowDowngrade: autoUpdater.allowDowngrade,
    isUpdateSupported: () => true,
    isUserWithinRollout: () => true,
  };
  for (const [version, expected] of [
    ["1.10.3-ruivza.1", false],
    ["1.10.3-ruivza.2", true],
    ["1.10.3-ruivza.10", true],
    ["1.10.4-ruivza.1", true],
  ]) {
    assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(updater, { version }), expected);
  }
  updater.currentVersion = semver.parse("1.10.3-ruivza.10");
  assert.equal(
    await AppUpdater.prototype.isUpdateAvailable.call(updater, { version: "1.10.3-ruivza.2" }),
    false
  );
  updater.currentVersion = semver.parse("1.10.4");
  assert.equal(
    await AppUpdater.prototype.isUpdateAvailable.call(updater, { version: "1.10.3-ruivza.1" }),
    false
  );
  manager.cleanup();
});

test("builder accepts fork metadata and keeps numeric Windows versions out of macOS buildVersion", async () => {
  const config = require("../../electron-builder.json");
  const metadata = require("../../package.json");
  const lock = require("../../package-lock.json");
  const { validateConfiguration } = require("app-builder-lib/out/util/config/config");
  const { AppInfo } = require("app-builder-lib/out/appInfo");
  await validateConfiguration(config, { isEnabled: false });
  const version = semver.parse(metadata.version);
  assert.equal(version.prerelease.length, 2);
  assert.equal(version.prerelease[0], "ruivza");
  assert.equal(Number.isInteger(version.prerelease[1]), true);
  assert.ok(version.prerelease[1] > 0);
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[""].version, metadata.version);
  const info = new AppInfo({ metadata: { ...metadata, ...config.extraMetadata }, config });
  assert.equal(info.channel, "ruivza");
  const windowsVersion = `${version.major}.${version.minor}.${version.patch}.${version.prerelease[1]}`;
  assert.equal(info.shortVersion, windowsVersion);
  assert.equal(info.shortVersionWindows, windowsVersion);
  assert.equal(config.buildVersion, undefined);
  assert.equal(info.buildVersion, metadata.version);
});

test("manual checks, download and installation remain available with automatic updates off", async () => {
  setPlatform("win32");
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  assert.equal(autoUpdater.calls, 1);
  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0);
  assert.equal((await manager.downloadUpdate()).success, true);
  assert.equal(autoUpdater.downloads, 1);
  autoUpdater.listeners["update-downloaded"]({ version: "9.9.9" });
  assert.equal((await manager.installUpdate()).success, true);
  assert.deepEqual(autoUpdater.installs, [[true, true]]);
  manager.cleanup();
});

test("before the renderer syncs the preference, an available update is not downloaded", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0);

  manager.cleanup();
});

test("with automatic updates on, an available update downloads itself exactly once", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setAutoUpdatesEnabled(true);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1);

  // A periodic re-check while the download is in flight must not start another.
  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1);

  autoUpdater.listeners["update-downloaded"]({ version: "9.9.9" });
  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1, "a downloaded update is never fetched again");

  manager.cleanup();
});

test("with automatic updates off, an available update waits for the user", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setAutoUpdatesEnabled(false);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0);

  manager.cleanup();
});

test("deferInstallOnQuit clears the flag the NSIS and AppImage quit handlers read", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);

  manager.deferInstallOnQuit();
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);

  manager.cleanup();
});

test("only a macOS update that Squirrel already holds counts as staged", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  assert.equal(manager.hasStagedUpdate(), false);

  autoUpdater.squirrelDownloadedUpdate = true;
  assert.equal(manager.hasStagedUpdate(), true);

  setPlatform("win32");
  assert.equal(manager.hasStagedUpdate(), false);

  manager.cleanup();
});

test("enabling automatic updates after the startup check found one starts the download", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0, "preference unknown, so nothing downloads yet");

  manager.setAutoUpdatesEnabled(true);
  assert.equal(autoUpdater.downloads, 1);

  manager.setAutoUpdatesEnabled(true);
  assert.equal(autoUpdater.downloads, 1, "re-syncing the preference does not restart it");

  manager.cleanup();
});

test("a failed background check only reaches renderers as update-error", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const autoUpdater = makeAutoUpdater({ offline: true });
  const manager = createUpdateManager(autoUpdater);
  const sent = [];
  manager.setWindowManager({
    mainWindow: makeRendererWindow(sent),
    controlPanelWindow: makeRendererWindow(sent),
  });

  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS);
  assert.deepEqual([...new Set(sent)], ["update-error"]);

  manager.cleanup();
});

test("Apple Silicon, Rosetta migration and Windows updates remain supported", async () => {
  for (const scenario of [
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64", translated: "1" },
    { platform: "win32", arch: "x64" },
  ]) {
    setPlatform(scenario.platform);
    setArch(scenario.arch);
    const autoUpdater = makeAutoUpdater();
    const manager = createUpdateManager(autoUpdater, scenario);
    assert.equal((await manager.getUpdateStatus()).isSupported, true, scenario.platform);
    assert.equal(autoUpdater.feeds.length, 1);
    manager.cleanup();
  }
});

test("Linux and Intel Macs never configure, check, download or install updates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const scenario of [
    { platform: "linux", arch: "x64" },
    { platform: "linux", arch: "x64", appImage: "/opt/OpenWhispr.AppImage" },
    { platform: "linux", arch: "arm64", appImage: "/opt/OpenWhispr.AppImage" },
    { platform: "darwin", arch: "x64", translated: "0" },
    { platform: "darwin", arch: "x64", translated: new Error("Unknown sysctl key") },
  ]) {
    setPlatform(scenario.platform);
    setArch(scenario.arch);
    if (scenario.appImage) process.env.APPIMAGE = scenario.appImage;
    else delete process.env.APPIMAGE;
    const autoUpdater = makeAutoUpdater();
    const manager = createUpdateManager(autoUpdater, scenario);
    manager.setAutoUpdatesEnabled(true);
    assert.equal((await manager.getUpdateStatus()).isSupported, false);
    assert.deepEqual(autoUpdater.feeds, [], "unsupported platforms never configure a feed");
    assert.deepEqual(autoUpdater.listeners, {}, "unsupported platforms never bind update events");

    manager.checkForUpdatesOnStartup();
    t.mock.timers.tick(STARTUP_DELAY_MS + PERIODIC_INTERVAL_MS);
    manager._autoCheckForUpdates("Fixture");
    const result = await manager.checkForUpdates();
    assert.equal(autoUpdater.calls, 0, "neither automatic nor manual checks run");
    assert.equal(result.updateAvailable, false);
    assert.match(result.message, /not supported/);

    manager.updateAvailable = true;
    manager._autoDownloadIfEnabled();
    assert.equal((await manager.downloadUpdate()).success, false);
    assert.equal(autoUpdater.downloads, 0, "even a stale available update never downloads");
    manager.updateDownloaded = true;
    assert.equal((await manager.installUpdate()).success, false);
    assert.deepEqual(autoUpdater.installs, [], "even a stale downloaded update never installs");
    manager.cleanup();
  }
});
