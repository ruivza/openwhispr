const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToString } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadSettings(t, initialStorage = {}) {
  const { storage } = installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-local-startup-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  return { vite, storage, useSettingsStore, state: useSettingsStore.getState() };
}

test("fresh local startup has no official inference or authenticated account", async (t) => {
  const { state } = await loadSettings(t);
  for (const key of [
    "transcriptionMode",
    "meetingTranscriptionMode",
    "uploadTranscriptionMode",
    "cleanupMode",
    "chatAgentMode",
    "dictationAgentMode",
    "translationMode",
    "noteFormattingMode",
  ]) {
    assert.equal(state[key], "local", key);
  }
  assert.equal(state.useLocalWhisper, true);
  assert.equal(state.meetingUseLocalWhisper, true);
  assert.equal(state.uploadUseLocalWhisper, true);
  assert.equal(state.isSignedIn, false);
  assert.equal(state.chatAgentProvider, "");
  assert.equal(state.chatAgentModel, "", "a cloud model is not invented as an installed model");
});

test("legacy official routing migrates in memory while existing local model and saved account preferences survive", async (t) => {
  const { state, storage, useSettingsStore } = await loadSettings(t, {
    isSignedIn: "true",
    transcriptionMode: "openwhispr",
    cloudTranscriptionMode: "openwhispr",
    cleanupMode: "local",
    cleanupProvider: "llama",
    cleanupModel: "llama-3.2-1b-instruct-q4_k_m",
    chatAgentMode: "openwhispr",
    chatAgentProvider: "groq",
    chatAgentModel: "openai/gpt-oss-120b",
  });
  assert.equal(state.isSignedIn, false);
  assert.equal(state.transcriptionMode, "local");
  assert.equal(state.cloudTranscriptionMode, "byok");
  assert.equal(state.chatAgentMode, "local");
  assert.equal(state.chatAgentProvider, "llama");
  assert.equal(state.chatAgentModel, "llama-3.2-1b-instruct-q4_k_m");
  assert.equal(storage.getItem("isSignedIn"), "true");
  assert.equal(storage.getItem("transcriptionMode"), "openwhispr");
  state.setIsSignedIn(true);
  assert.equal(useSettingsStore.getState().isSignedIn, false);
});

test("BYOK, self-hosted and manual enterprise selections remain usable", async (t) => {
  const { state } = await loadSettings(t, {
    _providerSettingsMigrated: "1",
    uploadTranscriptionMigrated: "true",
    transcriptionMode: "enterprise",
    enterpriseTranscriptionSetupMode: "manual",
    uploadTranscriptionMode: "providers",
    uploadCloudTranscriptionMode: "byok",
    uploadCloudTranscriptionProvider: "openai",
    uploadCloudTranscriptionModel: "whisper-1",
    cleanupMode: "self-hosted",
    cleanupProvider: "custom",
    cleanupModel: "private-model",
    cleanupRemoteUrl: "http://localhost:8080",
    cleanupCloudMode: "byok",
    chatAgentMode: "enterprise",
    enterpriseSetupMode: "manual",
    chatAgentProvider: "bedrock",
    chatAgentModel: "custom-enterprise-model",
    chatAgentCloudMode: "byok",
  });
  assert.equal(state.transcriptionMode, "enterprise");
  assert.equal(state.enterpriseTranscriptionSetupMode, "manual");
  assert.equal(state.uploadTranscriptionMode, "providers");
  assert.equal(state.uploadCloudTranscriptionModel, "whisper-1");
  assert.equal(state.cleanupMode, "self-hosted");
  assert.equal(state.cleanupRemoteUrl, "http://localhost:8080");
  assert.equal(state.chatAgentMode, "enterprise");
  assert.equal(state.enterpriseSetupMode, "manual");
  assert.equal(state.chatAgentModel, "custom-enterprise-model");
});

test("local onboarding resumes at permissions and cannot navigate back into official login", async (t) => {
  const { vite } = await loadSettings(t);
  const { createOnboardingSession, getLocalOnboardingRoute } = await vite.ssrLoadModule(
    "/components/onboarding/flow.ts"
  );
  const { normalizeForkOnboardingSession } = await vite.ssrLoadModule(
    "/components/onboarding/useOnboardingSession.ts"
  );
  const original = {
    ...createOnboardingSession(),
    setupMode: "cloud",
    authPath: "account",
    history: ["auth"],
  };
  const session = normalizeForkOnboardingSession(original);
  assert.equal(session.authPath, "guest");
  assert.equal(session.currentStepId, "permissions");
  assert.equal(session.setupMode, null);
  assert.deepEqual(session.history, []);
  const route = getLocalOnboardingRoute({
    authPath: "account",
    setupMode: "byok",
    agentAllowed: true,
  });
  assert.deepEqual(route, [
    "permissions",
    "dictation-hotkey",
    "setup-choice",
    "byok-dictation",
    "byok-assistant",
  ]);
  assert.equal(original.authPath, "account", "legacy session is retained without mutation");
});

test("unconfigured note formatting inherits the existing BYOK cleanup route coherently", async (t) => {
  const { state, vite } = await loadSettings(t, {
    _providerSettingsMigrated: "1",
    _llmScopeKeysMigrated: "1",
    cleanupMode: "providers",
    cleanupCloudMode: "byok",
    cleanupProvider: "openai",
    cleanupModel: "gpt-4.1-mini",
    noteFormattingMode: "openwhispr",
    noteFormattingProvider: "",
    noteFormattingModel: "",
  });
  const { selectResolvedNoteFormatting } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const resolved = selectResolvedNoteFormatting(state);
  assert.equal(resolved.mode, "providers");
  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.model, "gpt-4.1-mini");
  assert.equal(resolved.cloudMode, "byok");
});

test("useAuth settles as signed out without invoking the official session hook", async (t) => {
  installBrowserGlobals(t);
  let sessionCalls = 0;
  globalThis.__forkSessionCall = () => sessionCalls++;
  t.after(() => delete globalThis.__forkSessionCall);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-auth-",
    mockModules: {
      "/lib/auth": `
        export const authClient = { useSession() { globalThis.__forkSessionCall(); throw new Error("official session used"); } };
        export const getGracePeriodRemainingMs = () => 0;
        export const isWithinGracePeriod = () => false;
      `,
    },
  });
  const { useAuth } = await vite.ssrLoadModule("/hooks/useAuth.ts");
  let auth;
  function Harness() {
    auth = useAuth();
    return null;
  }
  renderToString(React.createElement(Harness));
  assert.equal(sessionCalls, 0);
  assert.equal(auth.isSignedIn, false);
  assert.equal(auth.isLoaded, true);
  assert.equal(auth.user, null);
  assert.equal(await auth.refetch(), null);
});

test("real official auth entry points cannot open a browser or send SDK network requests", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let protocolCalls = 0;
  let browserCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("unexpected network request");
  };
  globalThis.__forkOpenExternal = () => browserCalls++;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.__forkOpenExternal;
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getOAuthProtocol: async () => {
          protocolCalls++;
          return "openwhispr";
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-real-disabled-auth-",
    mockModules: {
      "/utils/externalLinks":
        "export const openExternalLink = () => globalThis.__forkOpenExternal();",
    },
  });
  const auth = await vite.ssrLoadModule("/lib/auth.ts");
  const social = await auth.signInWithSocial("google");
  const sso = await auth.signInWithSSO("person@example.com");
  assert.equal(social.error?.code, "ACCOUNT_DISABLED");
  assert.equal(sso.error?.code, "ACCOUNT_DISABLED");
  await auth.openAdminConsole();
  // Exercise the actual Better Auth client and its disabled custom fetch, too.
  await auth.authClient.getSession().catch(() => undefined);
  assert.equal(protocolCalls, 0);
  assert.equal(browserCalls, 0);
  assert.equal(fetchCalls, 0);
});
