const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalConnectorProfile } = require("../../../src/helpers/connectors/localProfile");
const {
  createConnectorCredentials,
  slotFor,
} = require("../../../src/helpers/connectors/connectorCredentials");
const {
  createLocalConnectorPolicyResolver,
} = require("../../../src/helpers/connectors/connectorIpc");

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-local-connector-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a local profile survives restarts and stays separate from official credential slots", (t) => {
  const dir = directory(t);
  const first = createLocalConnectorProfile({ dir });
  const owner = first.getAccountId();
  assert.match(owner, /^local-profile:/);
  const restarted = createLocalConnectorProfile({ dir });
  assert.deepEqual(restarted.getScope(), first.getScope());

  const slots = new Map([[slotFor("old-official-account", "slack"), { accessToken: "old-token" }]]);
  const reads = [];
  const credentials = createConnectorCredentials({
    getAccountId: restarted.getAccountId,
    store: {
      read: (slot) => {
        reads.push(slot);
        return slots.get(slot) ?? null;
      },
      getGeneration: () => 0,
      replace: (slot, credential) => slots.set(slot, credential),
    },
  });
  assert.equal(credentials.read(owner, "slack"), null);
  credentials.replace(owner, "slack", { accessToken: "own-token" }, 0);
  assert.equal(credentials.read(owner, "slack").credential.accessToken, "own-token");
  assert.equal(slots.get(slotFor("old-official-account", "slack")).accessToken, "old-token");
  assert.ok(reads.every((slot) => slot !== slotFor("old-official-account", "slack")));
});

test("a damaged local profile fails closed instead of adopting another identity", (t) => {
  const dir = directory(t);
  const file = path.join(dir, "local-profile.json");
  const contents = JSON.stringify({
    version: 1,
    accountId: "old-official-account",
    authGeneration: 1,
  });
  fs.writeFileSync(file, contents);
  assert.throws(() => createLocalConnectorProfile({ dir }).getScope(), {
    code: "local_profile_unavailable",
  });
  assert.equal(fs.readFileSync(file, "utf8"), contents);
});

test("exclusive profile creation preserves the winner of a competing initialization", (t) => {
  const dir = directory(t);
  const winner = {
    version: 1,
    accountId: "local-profile:11111111-2222-4333-8444-555555555555",
    authGeneration: 1,
  };
  const profile = createLocalConnectorProfile({
    dir,
    fsImpl: {
      ...fs,
      writeFileSync(file, content, options) {
        assert.equal(options.flag, "wx");
        fs.writeFileSync(file, JSON.stringify(winner));
        return fs.writeFileSync(file, content, options);
      },
    },
  });
  assert.equal(profile.getAccountId(), winner.accountId);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "local-profile.json"), "utf8")).accountId,
    winner.accountId
  );
});

test("local policy accepts only a valid local owner without consulting official auth", async (t) => {
  const profile = createLocalConnectorProfile({ dir: directory(t) });
  const resolve = createLocalConnectorPolicyResolver({ getAccountScope: profile.getScope });
  assert.equal(await resolve(), "allowed");
  for (const scope of [
    null,
    { accountId: "official", authGeneration: 1 },
    { ...profile.getScope(), authGeneration: 2 },
  ]) {
    assert.equal(
      await createLocalConnectorPolicyResolver({ getAccountScope: () => scope })(),
      "unavailable"
    );
  }
});
