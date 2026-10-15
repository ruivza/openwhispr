const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("legacy telemetry settings cannot be restored by startup, setters, or window updates", async (t) => {
  const storageListeners = [];
  let backendUpdate;
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      insightsSyncEnabled: "true",
      telemetryEnabled: "true",
      cloudBackupEnabled: "true",
      dataRetentionEnabled: "true",
      customDictionary: '["OpenWhispr"]',
    },
    window: {
      addEventListener(type, listener) {
        if (type === "storage") storageListeners.push(listener);
      },
      electronAPI: {
        getOpenAIKey: async () => "",
        onSettingUpdated: (listener) => {
          backendUpdate = listener;
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-telemetry-disabled-settings-",
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  await initializeSettings();
  for (const [key, setter] of [
    ["insightsSyncEnabled", "setInsightsSyncEnabled"],
    ["telemetryEnabled", "setTelemetryEnabled"],
  ]) {
    assert.equal(useSettingsStore.getState()[key], false);
    assert.equal(
      storage.getItem(key),
      "true",
      "startup preserves old preferences without honoring them"
    );
    useSettingsStore.getState()[setter](true);
    assert.equal(useSettingsStore.getState()[key], false);
    assert.equal(storage.getItem(key), "false");
    storage.setItem(key, "true");
    storageListeners.forEach((listener) =>
      listener({
        key,
        newValue: "true",
        storageArea: storage,
      })
    );
    assert.equal(useSettingsStore.getState()[key], false);
    backendUpdate({ key, value: true });
    assert.equal(useSettingsStore.getState()[key], false);
  }
  assert.equal(
    useSettingsStore.getState().cloudBackupEnabled,
    true,
    "ordinary backup stays available"
  );
  assert.equal(
    useSettingsStore.getState().dataRetentionEnabled,
    true,
    "local history stays enabled"
  );
});
