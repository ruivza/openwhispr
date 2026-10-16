const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const requests = [];
const connectorCalls = [];
let userDataDirectory;
let target;
let tokenState;
let officialTokenReads;
let cookieReads;
let activationDatabaseLoads;
let activationConstructions;

const electronStub = {
  app: {
    getPath: () => userDataDirectory,
    getName: () => "test",
    getVersion: () => "1.10.3-ruivza.4",
    isPackaged: false,
    on() {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on() {},
    removeHandler() {},
  },
  net: {
    fetch: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      if (!body.id) return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2024-11-05" }
              : { content: [{ type: "text", text: "# Hotkeys\nPublic help" }] },
        })
      );
    },
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      cookieReads++;
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./modelManagerBridge") return { default: {} };
    if (request === "./tokenStore")
      return {
        get: () => {
          officialTokenReads++;
          return tokenState.token;
        },
        getState: () => ({ ...tokenState }),
        subscribe: () => () => {},
      };
    if (request === "better-sqlite3") {
      activationDatabaseLoads++;
      throw new Error("Marketing activation database must not load in this fork");
    }
    if (request === "./metaActivation")
      return {
        MetaActivation: class {
          constructor() {
            activationConstructions++;
            throw new Error("Marketing activation must not initialize in this fork");
          }
        },
      };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

const oldApiUrl = process.env.OPENWHISPR_API_URL;
test.beforeEach(() => {
  userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fork-product-help-ipc-"));
  tokenState = { token: null, generation: 0 };
  officialTokenReads = cookieReads = activationDatabaseLoads = activationConstructions = 0;
  handlers.clear();
  requests.length = connectorCalls.length = 0;
  process.env.OPENWHISPR_API_URL = "https://retained-official-api.test";
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  target = {
    connectorManager: {
      query: (...args) => connectorCalls.push(args),
    },
  };
  // Exercise registration itself: restoring only the new help call used to
  // throw a ReferenceError before subsequent handlers could be registered.
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});
test.afterEach(() => {
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});
test.after(() => {
  Module._load = originalLoad;
  if (oldApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
  else process.env.OPENWHISPR_API_URL = oldApiUrl;
});

const event = () => ({ sender: Object.assign(new EventEmitter(), { id: 1 }) });
const lookup = () => handlers.get("product-help")(event(), "help", { topic: "hotkeys" });

function retainPolicy({ webSearchEnabled = false, connectorsEnabled = true } = {}) {
  const binding = require("../../src/helpers/accountScopeBinding");
  const { writeWorkspacePolicyCache } = require("../../src/helpers/workspacePolicyCache");
  tokenState = { token: "synthetic-retained-token", generation: 7 };
  binding.persist("old-official-owner", tokenState.token);
  const data = {
    managed: true,
    policyUpdatedAt: "2026-10-01",
    policy: {
      version: 1,
      transcription: { allowedModes: ["local"], allowedByokProviders: [] },
      llm: {
        allowedModes: ["local", "providers"],
        allowedByokProviders: ["openai"],
        allowedEnterpriseProviders: [],
      },
      features: { agentEnabled: true, webSearchEnabled, connectorsEnabled },
      sharing: { externalLinkSharing: "disabled" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: false,
      },
      minAppVersion: "1.10.3",
    },
  };
  const cachePath = path.join(userDataDirectory, "workspace-policy.json");
  writeWorkspacePolicyCache(
    cachePath,
    {
      apiOrigin: process.env.OPENWHISPR_API_URL,
      credentialHash: binding.hashToken(
        JSON.stringify([["Authorization", `Bearer ${tokenState.token}`]])
      ),
      accountId: "old-official-owner",
    },
    data
  );
  return cachePath;
}

test("real handler registration keeps marketing activation inert, with empty IPC results", async () => {
  tokenState = { token: "synthetic-retired-token", generation: 3 };
  assert.equal(target.metaActivation, null);
  for (const channel of [
    "activation-begin",
    "activation-stop",
    "activation-finish",
    "activation-cancel",
    "activation-close",
  ]) {
    assert.equal(await handlers.get(channel)({}, "old-capture", 200), null, channel);
  }
  assert.equal(activationDatabaseLoads, 0);
  assert.equal(activationConstructions, 0);
  assert.equal(fs.existsSync(path.join(userDataDirectory, "meta-activation.db")), false);
  assert.equal(requests.length, 0);
});

test("signed-out local owner can read public help without official authentication", async () => {
  const basics = handlers.get("product-help-basics")();
  assert.equal(basics.platform, process.platform);
  assert.equal(basics.version, "1.10.3-ruivza.4");
  assert.equal((await lookup()).source, "live");
  await handlers.get("connector-query")({}, "slack", "search", { query: "example" });
  const owner = JSON.parse(
    fs.readFileSync(path.join(userDataDirectory, "connectors", "local-profile.json"), "utf8")
  );
  assert.match(owner.accountId, /^local-profile:/);
  assert.deepEqual(connectorCalls[0][3], { policyState: "allowed", accountId: owner.accountId });
  assert.equal(handlers.get("get-active-account-scope")(), null);
  assert.equal(officialTokenReads, 0);
  assert.equal(cookieReads, 0);
  assert.equal(requests.length, 4);
  for (const { url, options } of requests) {
    assert.equal(url, "https://docs.openwhispr.com/mcp");
    assert.equal(options.useSessionCookies, false);
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
  }
});

test("retained help policy blocks network while retaining the local connector owner", async () => {
  const cachePath = retainPolicy();
  const before = fs.readFileSync(cachePath, "utf8");
  const help = await lookup();
  assert.equal(help.source, "bundled");
  assert.equal(help.reason, "policy");
  assert.equal(requests.length, 0);
  await handlers.get("connector-query")({}, "slack", "search", { query: "example" });
  assert.equal(connectorCalls[0][3].policyState, "allowed");
  assert.match(connectorCalls[0][3].accountId, /^local-profile:/);
  assert.equal(fs.readFileSync(cachePath, "utf8"), before);
  assert.equal(officialTokenReads, 0);
  assert.equal(cookieReads, 0);
});

test("help applies web-search policy independently of connector permissions", async () => {
  retainPolicy({ webSearchEnabled: true, connectorsEnabled: false });
  assert.equal((await lookup()).source, "live");
  await handlers.get("connector-query")({}, "slack", "search", { query: "example" });
  assert.equal(connectorCalls[0][3].policyState, "blocked");
  assert.match(connectorCalls[0][3].accountId, /^local-profile:/);
  assert.equal(officialTokenReads, 0);
  assert.equal(cookieReads, 0);
  assert.doesNotMatch(JSON.stringify(requests), /synthetic-retained-token|old-official-owner/);
});

test("damaged retained policy falls back to bundled help without rewriting it", async () => {
  const cachePath = retainPolicy({ webSearchEnabled: true });
  fs.writeFileSync(cachePath, "{");
  const help = await lookup();
  assert.equal(help.source, "bundled");
  assert.equal(help.reason, "unavailable");
  assert.equal(requests.length, 0);
  assert.equal(fs.readFileSync(cachePath, "utf8"), "{");
});
