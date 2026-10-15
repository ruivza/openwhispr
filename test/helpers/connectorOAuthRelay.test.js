const test = require("node:test");
const assert = require("node:assert/strict");
const { handleConnectorOAuthRelay } = require("../../scripts/connector-oauth-relay");
const http = require("node:http");
const Module = require("node:module");
const { once } = require("node:events");

function relay(url, method = "GET") {
  const result = { headers: {} };
  handleConnectorOAuthRelay(
    { url, method },
    {
      setHeader: (key, value) => {
        result.headers[key] = value;
      },
      writeHead: (status, headers = {}) => {
        result.status = status;
        Object.assign(result.headers, headers);
      },
      end: (body) => {
        result.body = body;
      },
    }
  );
  return result;
}
const state = `v1.49152.${"a".repeat(64)}`;

test("own relay forwards provider code/state only to the desktop's fixed loopback callback", () => {
  for (const provider of ["slack", "linear"]) {
    const result = relay(
      `/auth/${provider}/callback?state=${state}&code=synthetic-code&next=https://other.test&access_token=never-forward`
    );
    assert.equal(result.status, 302);
    const target = new URL(result.headers.Location);
    assert.equal(target.origin, "http://127.0.0.1:49152");
    assert.equal(target.pathname, `/${provider}/callback`);
    assert.deepEqual([...target.searchParams.keys()], ["state", "code"]);
    assert.equal(target.searchParams.get("state"), state);
    assert.equal(target.searchParams.get("code"), "synthetic-code");
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.headers["Referrer-Policy"], "no-referrer");
  }
});

test("own relay preserves a provider denial without accepting ambiguous callbacks", () => {
  const result = relay(`/auth/slack/callback?state=${state}&error=access_denied`);
  assert.equal(result.status, 302);
  assert.equal(new URL(result.headers.Location).searchParams.get("error"), "access_denied");
  for (const query of [
    "code=x",
    `state=${state}`,
    `state=${state}&state=${state}&code=x`,
    `state=${state}&code=x&code=y`,
    `state=${state}&code=x&error=denied`,
    `state=v1.80.${"a".repeat(64)}&code=x`,
    `state=v1.99999.${"a".repeat(64)}&code=x`,
    "state=https://other.test&code=x",
    "state=v1.49152.bad&code=x",
  ]) {
    const rejected = relay(`/auth/slack/callback?${query}`);
    assert.equal(rejected.status, 400, query);
    assert.equal(rejected.headers.Location, undefined);
  }
  assert.equal(relay(`/auth/slack/callback?state=${state}&code=x`, "POST").status, 405);
  assert.equal(relay(`/auth/unknown/callback?state=${state}&code=x`).status, 404);
});

test("own relay completes the real desktop loopback flow without any official callback", async (t) => {
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../src/helpers/oauthLoopbackFlow");
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === modulePath && request === "./externalUrlOpener") {
      return { openExternalUrl: async () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let runOAuthLoopbackFlow;
  try {
    ({ runOAuthLoopbackFlow } = require(modulePath));
  } finally {
    Module._load = originalLoad;
  }
  const server = http.createServer(handleConnectorOAuthRelay);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let opened;
  const authorizationStarted = new Promise((resolve) => {
    opened = resolve;
  });
  const publicUri = "https://own-relay.test/auth/slack/callback";
  const controller = new AbortController();
  t.after(() => controller.abort());
  const flow = runOAuthLoopbackFlow({
    publicRedirectUri: publicUri,
    callbackPath: "/slack/callback",
    errorParam: "slack_error",
    signal: controller.signal,
    buildAuthUrl: (uri, relayState, challenge) => {
      assert.equal(uri, publicUri);
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      opened(relayState);
      return "https://provider.test/authorize";
    },
    handleCallback: async (code, uri, verifier) => {
      assert.equal(code, "synthetic-provider-code");
      assert.equal(uri, publicUri);
      assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
      return { connected: true };
    },
    renderResultPage: ({ ok }) => (ok ? "Own account connected" : "Connection refused"),
  });
  // Catch a rejected callback immediately as well as through assert below.
  flow.catch(() => {});
  const relayState = await authorizationStarted;
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/auth/slack/callback?state=${relayState}&code=synthetic-provider-code`
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Own account connected");
  assert.deepEqual(await flow, { connected: true });
});
