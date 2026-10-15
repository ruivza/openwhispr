function configuredString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// A relay is supplied by the owner of the OAuth app. No official service is
// selected implicitly; PKCE and loopback state validation still run unchanged.
function ownRelayRedirectUri(value) {
  const configured = configuredString(value);
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      hostname === "openwhispr.com" ||
      hostname.endsWith(".openwhispr.com")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

module.exports = { configuredString, ownRelayRedirectUri };
