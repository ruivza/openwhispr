const fork = require("../config/fork.json");

// Retired hosted-service configuration remains available for a separately
// provisioned backend, but old environment files cannot enable it in this build.
function resolveHostedApiUrl(env = process.env, runtimeEnv = {}) {
  if (!fork.hostedServicesEnabled) return "";
  return (
    env.OPENWHISPR_API_URL ||
    env.VITE_OPENWHISPR_API_URL ||
    runtimeEnv.VITE_OPENWHISPR_API_URL ||
    ""
  );
}

function resolveHostedAuthUrl(env = process.env, runtimeEnv = {}) {
  if (!fork.officialAccountEnabled) return "";
  return (
    env.AUTH_URL || env.VITE_AUTH_URL || runtimeEnv.VITE_AUTH_URL || "https://auth.openwhispr.com"
  );
}

module.exports = { resolveHostedApiUrl, resolveHostedAuthUrl };
