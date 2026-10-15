const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalConnectorProfile } = require("../../../src/helpers/connectors/localProfile");
const {
  createConnectorCredentials,
} = require("../../../src/helpers/connectors/connectorCredentials");
const { createConnectorManager } = require("../../../src/helpers/connectors/connectorManager");
const { createPendingActions } = require("../../../src/helpers/connectors/pendingActions");
const {
  registerConnectorIpc,
  createLocalConnectorPolicyResolver,
} = require("../../../src/helpers/connectors/connectorIpc");

test("signed-out local connector IPC keeps approval, deduplication, reconnection and revocation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-local-connector-ipc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = createLocalConnectorProfile({ dir });
  const values = new Map();
  let generation = 0;
  const credentials = createConnectorCredentials({
    getAccountId: profile.getAccountId,
    store: {
      read: (slot) => values.get(slot) ?? null,
      getGeneration: () => generation,
      replace: (slot, value) => {
        values.set(slot, value);
        generation += 1;
      },
      clear: (slot) => {
        values.delete(slot);
        generation += 1;
      },
    },
  });
  let sends = 0;
  let revokes = 0;
  const connector = {
    id: "test",
    actions: { post: { kind: "approval", editable: { body: "text" } } },
    authorize: async () => ({ userId: "third-party-user", accessToken: "test-token" }),
    revoke: async () => {
      revokes += 1;
    },
    getStatus: async () => ({
      connected: Boolean(credentials.read(profile.getAccountId(), "test")),
    }),
    getBinding: async () => {
      const entry = credentials.read(profile.getAccountId(), "test");
      return entry
        ? {
            ownerAccountId: profile.getAccountId(),
            accountId: entry.credential.userId,
            generation: entry.generation,
          }
        : null;
    },
    prepare: async () => ({
      status: "ready",
      payload: {},
      preview: {
        verbKey: "post",
        destinationLabel: "test-target",
        accountLabel: "test-user",
        body: "draft",
      },
    }),
    commit: async (_action, _payload, edits) => {
      assert.equal(edits.body, "approved edit");
      sends += 1;
      return { state: "sent" };
    },
  };
  const receipts = new Map();
  const manager = createConnectorManager({
    connectors: [connector],
    credentials,
    getAccountId: profile.getAccountId,
    pendingActions: createPendingActions(),
    logger: { info() {}, warn() {}, error() {} },
    actionLog: {
      insert: (row) => receipts.set(row.id, row),
      update: (id, patch, fromState) => {
        const row = receipts.get(id);
        if (!row || (fromState && row.state !== fromState)) return 0;
        receipts.set(id, { ...row, ...patch });
        return 1;
      },
      reconcileInterrupted: () => ({}),
      listRecent: (_connector, _limit, owner) =>
        [...receipts.values()].filter((row) => row.accountId === owner),
    },
  });
  const handlers = new Map();
  registerConnectorIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    manager,
    getAccountScope: profile.getScope,
    getPolicyState: createLocalConnectorPolicyResolver({ getAccountScope: profile.getScope }),
  });
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  assert.equal((await call("connector-connect", "test")).status, "connected");
  const pending = await call("connector-prepare", "test", "post", {});
  assert.equal(pending.status, "ready");
  assert.equal(sends, 0, "preparing a card cannot send");
  assert.equal(receipts.get(pending.actionId).accountId, profile.getAccountId());
  assert.equal(
    (await call("connector-commit", pending.actionId, { body: "approved edit" })).state,
    "sent"
  );
  assert.equal(
    (await call("connector-commit", pending.actionId, { body: "approved edit" })).state,
    "not_sent"
  );
  assert.equal(sends, 1);

  const stale = await call("connector-prepare", "test", "post", {});
  await call("connector-connect", "test");
  assert.equal(
    (await call("connector-commit", stale.actionId, { body: "approved edit" })).state,
    "not_sent"
  );
  assert.equal(sends, 1, "a reconnect invalidates the old approval");
  assert.equal((await call("connector-disconnect", "test")).status, "disconnected");
  assert.equal(revokes, 1);
  assert.equal(credentials.read(profile.getAccountId(), "test"), null);
});
