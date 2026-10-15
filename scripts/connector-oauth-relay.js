// Run behind your own HTTPS reverse proxy. Register these exact public URLs
// in your Slack/Linear OAuth apps and CONNECTOR_*_OAUTH_REDIRECT_URI settings:
//   https://your-host/auth/slack/callback
//   https://your-host/auth/linear/callback
// This service never handles tokens: the desktop validates state and exchanges
// the authorization code using its PKCE verifier over the provider connection.
const http = require("node:http");

const CALLBACKS = new Map([
  ["/auth/slack/callback", "/slack/callback"],
  ["/auth/linear/callback", "/linear/callback"],
]);

function handleConnectorOAuthRelay(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  const reject = (status) => {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid OAuth callback");
  };
  if (request.method !== "GET") return reject(405);
  if (typeof request.url !== "string" || request.url.length > 16384) return reject(400);
  let callback;
  try {
    callback = new URL(request.url, "http://relay.invalid");
  } catch {
    return reject(400);
  }
  const path = CALLBACKS.get(callback.pathname);
  if (!path) return reject(404);
  const params = callback.searchParams;
  const state = params.get("state");
  const match = /^v1\.([1-9][0-9]{0,4})\.[a-f0-9]{64}$/.exec(state || "");
  const port = match ? Number(match[1]) : 0;
  if (port < 1024 || port > 65535 || params.getAll("state").length !== 1) return reject(400);
  const code = params.get("code");
  const error = params.get("error");
  if (
    Boolean(code) === Boolean(error) ||
    params.getAll("code").length > 1 ||
    params.getAll("error").length > 1
  )
    return reject(400);
  const target = new URL(`http://127.0.0.1:${port}${path}`);
  target.searchParams.set("state", state);
  target.searchParams.set(code ? "code" : "error", code || error);
  response.writeHead(302, { Location: target.toString() });
  response.end();
}

if (require.main === module) {
  const port = Number(process.env.CONNECTOR_RELAY_PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid CONNECTOR_RELAY_PORT");
  http.createServer(handleConnectorOAuthRelay).listen(port, "127.0.0.1", () => {
    console.log(
      `Connector OAuth relay listening on 127.0.0.1:${port}; configure your HTTPS reverse proxy.`
    );
  });
}

module.exports = { handleConnectorOAuthRelay };
