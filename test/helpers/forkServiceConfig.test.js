const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveHostedApiUrl,
  resolveHostedAuthUrl,
} = require("../../src/helpers/forkServiceConfig");
const { createCloudApiRequestHandler } = require("../../src/helpers/cloudApiRequest");
const { createCloudConfigRequestHandler } = require("../../src/helpers/cloudConfigRequest");
const {
  createServerTokenPoster,
  fetchRealtimeTokenForProvider,
} = require("../../src/helpers/realtimeTokenProviders");

const legacyEnvironment = {
  OPENWHISPR_API_URL: "https://api.openwhispr.test",
  VITE_OPENWHISPR_API_URL: "https://api.openwhispr.test",
  AUTH_URL: "https://auth.openwhispr.test",
  VITE_AUTH_URL: "https://auth.openwhispr.test",
};

test("old environment and bundled runtime settings cannot re-enable hosted accounts or API", () => {
  assert.equal(resolveHostedApiUrl(legacyEnvironment, legacyEnvironment), "");
  assert.equal(resolveHostedAuthUrl(legacyEnvironment, legacyEnvironment), "");
  assert.equal(resolveHostedApiUrl({}, legacyEnvironment), "");
  assert.equal(resolveHostedAuthUrl({}, legacyEnvironment), "");
});

test("hosted API, route configuration and token minting stop before network or stale credentials", async () => {
  const forbidden = () => assert.fail("retired hosted services must not read credentials or fetch");
  const dependencies = {
    getApiUrl: () => resolveHostedApiUrl(legacyEnvironment),
    proxyFetch: forbidden,
    getAuthHeader: forbidden,
    getAppVersion: () => "1.10.4",
    tokenStore: { getState: forbidden },
    withPolicyHeaders: (headers) => headers,
    classifyAndLog: forbidden,
  };
  const request = createCloudApiRequestHandler(dependencies);
  for (const publicRequest of [false, true]) {
    const result = await request({ path: "/api/me/spaces", public: publicRequest });
    assert.equal(result.success, false);
    assert.match(result.error, /not configured/);
  }
  const configure = createCloudConfigRequestHandler({ ...dependencies, configPath: "stt-config" });
  assert.equal((await configure({})).success, false);
  const mint = createServerTokenPoster(dependencies);
  await assert.rejects(mint("/api/openai-realtime-token"), { code: "NO_API" });
});

test("personal realtime providers still acquire their own key without hosted sessions", async () => {
  const dependencies = {
    environmentManager: {
      getOpenAIKey: () => "synthetic-personal-key",
      getTinfoilKey: () => "synthetic-tinfoil-key",
    },
    postServerToken: () => assert.fail("personal providers do not mint official tokens"),
  };
  assert.equal(
    await fetchRealtimeTokenForProvider("openai-realtime", dependencies, { mode: "byok" }),
    "synthetic-personal-key"
  );
  assert.equal(
    await fetchRealtimeTokenForProvider("tinfoil-realtime", dependencies, { mode: "openwhispr" }),
    "synthetic-tinfoil-key"
  );
});
