const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOCAL_PROFILE_PATTERN =
  /^local-profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isLocalConnectorScope(scope) {
  return Boolean(
    scope && LOCAL_PROFILE_PATTERN.test(scope.accountId) && scope.authGeneration === 1
  );
}

// This namespace owns new third-party logins and receipts on this device.
// Existing official-account credential slots are neither read nor migrated.
function createLocalConnectorProfile({ dir, fsImpl = fs, randomUUID = crypto.randomUUID }) {
  const file = path.join(dir, "local-profile.json");
  let scope = null;

  function read() {
    const stored = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (stored.version !== 1 || !isLocalConnectorScope(stored)) {
      throw Object.assign(new Error("Invalid local connector profile"), {
        code: "local_profile_unavailable",
      });
    }
    return Object.freeze({ accountId: stored.accountId, authGeneration: 1 });
  }

  function getScope() {
    if (scope) return scope;
    try {
      scope = read();
      return scope;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const candidate = { version: 1, accountId: `local-profile:${randomUUID()}`, authGeneration: 1 };
    if (!isLocalConnectorScope(candidate)) throw new Error("Invalid local connector profile id");
    try {
      // Exclusive creation never replaces another profile. A partial/corrupt
      // file fails closed on read instead of silently adopting a new owner.
      fsImpl.writeFileSync(file, JSON.stringify(candidate), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    scope = read();
    return scope;
  }

  return { getScope, getAccountId: () => getScope().accountId };
}

module.exports = { createLocalConnectorProfile, isLocalConnectorScope };
