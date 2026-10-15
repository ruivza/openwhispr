const path = require("node:path");

// The adapter reads the existing CLI bridge credentials itself. Only executable
// paths go into client configuration; no account, API key or bridge token does.
function getLocalMcpConfig({
  appPath,
  executable = process.execPath,
  appImage = process.env.APPIMAGE,
}) {
  // AppImage's executable AND script paths live in a temporary mount. A saved
  // client configuration would stop working after the desktop app restarts.
  if (appImage)
    throw new Error("Local MCP requires an installation with a stable executable path.");
  return {
    mcpServers: {
      openwhispr: {
        command: executable,
        args: [path.join(appPath, "src", "helpers", "localMcpServer.js")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };
}

module.exports = { getLocalMcpConfig };
