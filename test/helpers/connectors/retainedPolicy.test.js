const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};
const { hashToken } = require("../../../src/helpers/accountScopeBinding");
const {
  createRetainedConnectorPolicyReader,
} = require("../../../src/helpers/connectors/retainedPolicy");
Module._load = originalLoad;
const { createWorkspacePolicyManager } = require("../../../src/helpers/workspacePolicyManager");
const {
  createLocalConnectorPolicyResolver,
} = require("../../../src/helpers/connectors/connectorIpc");

const localScope = {
  accountId: "local-profile:11111111-2222-4333-8444-555555555555",
  authGeneration: 1,
};
const policy = () => ({
  version: 1,
  transcription: { allowedModes: ["local"], allowedByokProviders: [] },
  llm: { allowedModes: ["local"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: true, webSearchEnabled: false, connectorsEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: "1.8.1",
});

async function setup(t, data = { managed: true, policy: policy(), policyUpdatedAt: "2026-10-01" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-retained-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, "workspace-policy.json");
  const state = { token: "synthetic-old-token", generation: 0 };
  let binding = { version: 1, accountId: "old-official-owner", tokenHash: hashToken(state.token) };
  let origin = "https://api.openwhispr.test/path";
  let version = "1.8.1";
  let requests = 0;
  // Produce an authentic v2 cache with the existing manager, including its
  // header fingerprint. Reading it below must never call this transport again.
  const manager = createWorkspacePolicyManager({
    cachePath,
    getApiUrl: () => origin,
    getAppVersion: () => version,
    tokenStore: { getState: () => ({ ...state }) },
    proxyFetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });
  assert.equal(
    (await manager.getPolicy({ accountId: binding.accountId, expectedAuthGeneration: 0 })).success,
    true
  );
  const read = createRetainedConnectorPolicyReader({
    cachePath,
    getApiUrl: () => origin,
    getTokenState: () => ({ ...state }),
    getAccountBinding: () => binding,
    getAppVersion: () => version,
  });
  const resolve = createLocalConnectorPolicyResolver({
    getAccountScope: () => localScope,
    getPolicySnapshot: read,
  });
  return {
    cachePath,
    state,
    read,
    resolve,
    requests: () => requests,
    setBinding: (value) => (binding = value),
    setOrigin: (value) => (origin = value),
    setVersion: (value) => (version = value),
    mutateData(change) {
      const envelope = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      change(envelope.entries[0].data);
      fs.writeFileSync(cachePath, JSON.stringify(envelope));
    },
  };
}

test("retains the verified origin/credential policy without signing in, fetching or changing files", async (t) => {
  const context = await setup(t);
  const before = fs.readFileSync(context.cachePath, "utf8");
  assert.equal(context.read().accountId, "old-official-owner");
  assert.equal(await context.resolve(), "blocked");
  assert.equal(await context.resolve(), "blocked");
  assert.equal(context.requests(), 1);
  assert.equal(fs.readFileSync(context.cachePath, "utf8"), before);
});

test("no verified legacy identity, matching origin/credential or cache keeps local connectors available", async (t) => {
  const context = await setup(t);
  context.state.token = null;
  assert.equal(await context.resolve(), "allowed");
  context.state.token = "different-token";
  assert.equal(await context.resolve(), "allowed");
  context.setBinding({ version: 1, accountId: "owner", tokenHash: hashToken(context.state.token) });
  assert.equal(
    await context.resolve(),
    "allowed",
    "a valid binding cannot adopt another token's cache"
  );
  context.state.token = "synthetic-old-token";
  context.setBinding(null);
  assert.equal(await context.resolve(), "allowed");
  context.setBinding({ version: 1, accountId: "owner", tokenHash: hashToken(context.state.token) });
  context.setOrigin("https://different-origin.test");
  assert.equal(await context.resolve(), "allowed");
  context.setOrigin("");
  assert.equal(await context.resolve(), "allowed");
  context.setOrigin("https://api.openwhispr.test");
  fs.unlinkSync(context.cachePath);
  assert.equal(await context.resolve(), "allowed");
  assert.equal(context.requests(), 1);
});

test("managed feature and minimum-version denials are enforced in the main-process resolver", async (t) => {
  const context = await setup(t);
  context.mutateData((data) => (data.policy.features.connectorsEnabled = true));
  assert.equal(await context.resolve(), "allowed");
  context.mutateData((data) => (data.policy.features.agentEnabled = false));
  assert.equal(await context.resolve(), "blocked");
  context.mutateData((data) => (data.policy.features.agentEnabled = true));
  context.setVersion("1.8.0");
  assert.equal(await context.resolve(), "unavailable");
  assert.equal(context.read().code, "APP_UPDATE_REQUIRED");
  context.setVersion(null);
  assert.equal(await context.resolve(), "unavailable");
  context.setVersion("1.9.0");
  assert.equal(await context.resolve(), "allowed");
  context.setVersion("1.8.1-ruivza.4");
  assert.equal(await context.resolve(), "allowed");
  context.setVersion("1.8.0-ruivza.4");
  assert.equal(await context.resolve(), "unavailable");
});

test("malformed retained managed policy and damaged cache fail closed without erasing them", async (t) => {
  const context = await setup(t);
  const original = fs.readFileSync(context.cachePath, "utf8");
  for (const change of [
    (data) => (data.policy = null),
    (data) => (data.policy.features.connectorsEnabled = "no"),
    (data) => (data.policyUpdatedAt = "invalid"),
    (data) => (data.policy.minAppVersion = "newest"),
    (data) => (data.managed = "yes"),
  ]) {
    fs.writeFileSync(context.cachePath, original);
    context.mutateData(change);
    const before = fs.readFileSync(context.cachePath, "utf8");
    assert.equal(await context.resolve(), "unavailable");
    assert.equal(fs.readFileSync(context.cachePath, "utf8"), before);
  }
  for (const contents of ["{", '{"version":2,"entries":null}', '{"version":1,"entries":[]}']) {
    fs.writeFileSync(context.cachePath, contents);
    assert.equal(await context.resolve(), "unavailable");
    assert.equal(fs.readFileSync(context.cachePath, "utf8"), contents);
  }
  fs.writeFileSync(context.cachePath, original);
  const envelope = JSON.parse(original);
  envelope.entries[0].data = null;
  fs.writeFileSync(context.cachePath, JSON.stringify(envelope));
  assert.equal(await context.resolve(), "unavailable");
  assert.equal(context.requests(), 1);
});

test("retains unmanaged availability but honors the existing requiresManagedPolicy marker", async (t) => {
  const context = await setup(t, { managed: false, policy: null, policyUpdatedAt: null });
  assert.equal(await context.resolve(), "allowed");
  context.mutateData((data) => (data.requiresManagedPolicy = true));
  assert.equal(await context.resolve(), "unavailable");
});

test("local resolver fails closed on policy-reader failure or an invalid local owner", async () => {
  for (const getPolicySnapshot of [
    () => undefined,
    () => {
      throw new Error("unreadable retained policy");
    },
  ]) {
    assert.equal(
      await createLocalConnectorPolicyResolver({
        getAccountScope: () => localScope,
        getPolicySnapshot,
      })(),
      "unavailable"
    );
  }
  assert.equal(
    await createLocalConnectorPolicyResolver({
      getAccountScope: () => null,
      getPolicySnapshot: () => null,
    })(),
    "unavailable"
  );
});
