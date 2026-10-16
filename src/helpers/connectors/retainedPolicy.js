const fs = require("fs");
const { hashToken, resolveBootAccountScope } = require("../accountScopeBinding");
const { parseCanonicalAppVersion, normalizeInstalledAppVersion } = require("../appVersion");
const { isValidPolicyShape } = require("../policyValidation");
const { readWorkspacePolicyCache } = require("../workspacePolicyCache");

function unavailable(code = "POLICY_UNRESOLVABLE") {
  return { success: false, status: "error", code };
}

function meetsMinimumVersion(version, minimum) {
  const current = parseCanonicalAppVersion(normalizeInstalledAppVersion(version));
  const required = parseCanonicalAppVersion(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

// The normal cache reader deliberately treats broken files as an empty cache.
// For retained managed policy, distinguish a missing/nonmatching entry from a
// damaged envelope or matching entry so corruption cannot remove restrictions.
function hasNoRetainedEntry(cachePath, identity) {
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (envelope?.version !== 2 || !Array.isArray(envelope.entries)) return false;
  return !envelope.entries.some(
    (entry) =>
      entry?.identity?.apiOrigin === identity.apiOrigin &&
      entry.identity.credentialHash === identity.credentialHash
  );
}

// Read only: no auth restoration, policy refresh, cache mutation or token use on
// the network. The verified legacy bearer is solely a key into the existing v2
// origin/credential cache; connector credentials still belong to the local UUID.
function createRetainedConnectorPolicyReader({
  cachePath,
  getApiUrl,
  getTokenState,
  getAccountBinding,
  getAppVersion,
}) {
  return () => {
    try {
      const state = getTokenState();
      const accountId = resolveBootAccountScope({
        token: state?.token,
        binding: getAccountBinding(),
      });
      if (!accountId) return null;
      const apiUrl = getApiUrl();
      if (!apiUrl) return null;
      const apiOrigin = new URL(apiUrl).origin;
      if (apiOrigin === "null") return unavailable();
      // Match workspacePolicyManager.captureIdentity's exact header hash.
      const identity = {
        apiOrigin,
        credentialHash: hashToken(JSON.stringify([["Authorization", `Bearer ${state.token}`]])),
        accountId,
      };
      const data = readWorkspacePolicyCache(cachePath, identity);
      if (!data) return hasNoRetainedEntry(cachePath, identity) ? null : unavailable();
      if (typeof data.managed !== "boolean") return unavailable();
      if (data.managed) {
        if (
          !isValidPolicyShape(data.policy) ||
          typeof data.policyUpdatedAt !== "string" ||
          !Number.isFinite(Date.parse(data.policyUpdatedAt))
        ) {
          return unavailable();
        }
        if (
          data.policy.minAppVersion &&
          !meetsMinimumVersion(getAppVersion(), data.policy.minAppVersion)
        ) {
          return unavailable("APP_UPDATE_REQUIRED");
        }
      } else if (
        data.requiresManagedPolicy === true ||
        (data.policy != null && !isValidPolicyShape(data.policy)) ||
        data.policyUpdatedAt != null
      ) {
        return unavailable();
      }
      return {
        success: true,
        status: "cached",
        accountId,
        authGeneration: state.generation,
        managed: data.managed,
        policy: data.policy ?? null,
        policyUpdatedAt: data.policyUpdatedAt ?? null,
      };
    } catch {
      return unavailable();
    }
  };
}

module.exports = { createRetainedConnectorPolicyReader };
