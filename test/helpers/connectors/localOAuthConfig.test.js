const test = require("node:test");
const assert = require("node:assert/strict");
const { ownRelayRedirectUri } = require("../../../src/helpers/connectors/localOAuthConfig");
const { createConnectors } = require("../../../src/helpers/connectors/createConnectors");
const { memoryCredentials } = require("./slackFixtures");

test("relay configuration requires an explicit own HTTPS endpoint", () => {
  for (const uri of [
    undefined,
    "",
    "not-a-url",
    "http://localhost/callback",
    "https://openwhispr.com/auth/slack/callback",
    "https://auth.openwhispr.com/callback",
    "https://openwhispr.com./callback",
    "https://user:pass@relay.example.test/callback",
    "https://relay.example.test/callback#token",
  ]) {
    assert.equal(ownRelayRedirectUri(uri), null, String(uri));
  }
  assert.equal(
    ownRelayRedirectUri("https://relay.example.test/slack/callback"),
    "https://relay.example.test/slack/callback"
  );
});

test("official OAuth defaults never configure the local connectors or start external authorization", async () => {
  const externalCalls = [];
  const connectors = createConnectors({
    env: {
      SLACK_CLIENT_ID: "official-slack",
      LINEAR_CLIENT_ID: "official-linear",
      GMAIL_CLIENT_ID: "official-gmail",
      GMAIL_CLIENT_SECRET: "official-secret",
      GOOGLE_CALENDAR_CLIENT_ID: "official-calendar",
      GOOGLE_CALENDAR_CLIENT_SECRET: "calendar-secret",
      GITHUB_APP_CLIENT_ID: "official-github",
      GITHUB_APP_SLUG: "official-app",
    },
    credentials: memoryCredentials(),
    fetch: async () => {
      externalCalls.push("fetch");
      throw new Error("Unexpected request");
    },
    runOAuthLoopbackFlow: async () => {
      externalCalls.push("browser");
      throw new Error("Unexpected browser");
    },
    OAuthFlowError: Error,
    i18n: { t: (key) => key },
    logger: { info() {}, warn() {}, error() {} },
    openExternal: async () => {
      externalCalls.push("external");
    },
    writeClipboard() {},
    getGoogleCalendarAccounts: () => [],
    broadcast() {},
  });
  for (const connector of connectors.filter((item) => item.id !== "email")) {
    assert.equal((await connector.getStatus()).configured, false, connector.id);
    await assert.rejects(connector.authorize(), { code: "not_configured" }, connector.id);
  }
  assert.deepEqual(externalCalls, []);
});
