const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { WebSocketServer } = require("ws");
const {
  isControlPanelTarget,
  startupFailure,
  validateProbe,
  connectCdp,
} = require("../../scripts/verify-packaged-startup.cjs");

test("only this package's real control-panel file is accepted, including escaped path spaces", () => {
  const file = path.resolve("fixture app/resources/app.asar/src/dist/index.html");
  const url = pathToFileURL(file).href + "?panel=true";
  assert.equal(isControlPanelTarget({ type: "page", url }, file), true);
  for (const target of [
    { type: "page", url: pathToFileURL(file).href },
    { type: "page", url: "http://127.0.0.1:5173/?panel=true" },
    {
      type: "page",
      url: pathToFileURL(path.resolve("other/app.asar/src/dist/index.html")).href + "?panel=true",
    },
    { type: "page", url: "about:blank" },
    { type: "webview", url },
  ])
    assert.equal(isControlPanelTarget(target, file), false);
});

test("startup exceptions fail even when the main process remains alive; expected device warnings do not", () => {
  for (const output of [
    "Failed to start app: ZodError invalid_format",
    "Uncaught Exception: module missing",
    "Unhandled Rejection at: Promise reason: error",
    "Control panel renderer process gone",
  ])
    assert.ok(startupFailure(output));
  assert.equal(
    startupFailure("Whisper startup init error (non-fatal): no model\nMicrophone unavailable"),
    undefined
  );
});

test("readiness requires the expected fork version and a usable registry, not merely loaded HTML", () => {
  const version = require("../../package.json").version;
  const ready = { ready: true, version, manifestVersion: 2, modelCount: 1 };
  assert.equal(validateProbe({ ready: false }, version), false);
  assert.equal(validateProbe(ready, version), true);
  for (const override of [
    { version: "1.10.3" },
    { manifestVersion: 0 },
    { manifestVersion: undefined },
    { modelCount: 0 },
  ])
    assert.throws(() => validateProbe({ ...ready, ...override }, version));
});

test("the CDP client awaits IPC probe results and reports renderer exceptions and protocol errors", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  server.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message.method === "Runtime.enable") {
        socket.send(
          JSON.stringify({
            method: "Runtime.exceptionThrown",
            params: {
              exceptionDetails: {
                text: "Uncaught",
                exception: { description: "ZodError in renderer" },
              },
            },
          })
        );
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else socket.send(JSON.stringify({ id: message.id, error: { message: "IPC failed" } }));
    })
  );
  const errors = [];
  const client = await connectCdp(`ws://127.0.0.1:${server.address().port}`, (error) =>
    errors.push(error)
  );
  t.after(() => client.close());
  await client.send("Runtime.enable");
  assert.deepEqual(errors, ["ZodError in renderer"]);
  await assert.rejects(client.send("Runtime.evaluate"), /IPC failed/);
});
