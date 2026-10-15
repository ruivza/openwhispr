const FORK_APP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-ruivza\.([1-9]\d*)$/;

// Model compatibility follows the upstream version; updater/display versions
// retain the fork revision. Leave all other inputs to the registry's validator.
export function normalizeRegistryAppVersion(value) {
  if (typeof value !== "string") return value;
  const match = FORK_APP_VERSION.exec(value);
  if (!match || !match.slice(1).map(Number).every(Number.isSafeInteger)) return value;
  return match.slice(1, 4).join(".");
}
