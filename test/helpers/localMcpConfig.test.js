const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { getLocalMcpConfig } = require("../../src/helpers/localMcpConfig");

test("local MCP configuration preserves paths with spaces without shell quoting or credentials", () => {
  const appPath = path.resolve("fixtures/Program Files/OpenWhispr/resources/app.asar");
  const executable = path.resolve("fixtures/Program Files/OpenWhispr/OpenWhispr.exe");
  const config = getLocalMcpConfig({ appPath, executable, appImage: "" });
  const server = config.mcpServers.openwhispr;
  assert.equal(server.command, executable);
  assert.deepEqual(server.args, [path.join(appPath, "src/helpers/localMcpServer.js")]);
  assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(Object.keys(server).sort(), ["args", "command", "env"]);
});

test("AppImage cannot copy a configuration containing a transient mount path", () => {
  assert.throws(
    () =>
      getLocalMcpConfig({
        appPath: "/tmp/.mount_app/resources/app.asar",
        appImage: "/opt/app.AppImage",
      }),
    /stable executable path/
  );
});
