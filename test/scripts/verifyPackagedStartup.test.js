const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { WebSocketServer } = require("ws");
const {
  isControlPanelTarget,
  startupFailure,
  validateProbe,
  PROBE,
  connectCdp,
} = require("../../scripts/verify-packaged-startup.cjs");
const version = require("../../package.json").version;
const catalog = require("../../src/models/modelRegistryData.json");

function readyProbe() {
  return {
    ready: true,
    version,
    models: Object.fromEntries(
      ["whisper", "parakeet"].map((provider) => [
        provider,
        {
          success: true,
          models: Object.keys(catalog[`${provider}Models`]).map((model) => ({
            model,
            downloaded: false,
            success: true,
          })),
        },
      ])
    ),
    database: { transcriptions: [], notes: [] },
  };
}

function probeContext({ interactive = true, apiOverrides = {} } = {}) {
  const ready = readyProbe();
  const calls = [];
  const values = {
    getAppVersion: { version },
    setAutoUpdatesEnabled: undefined,
    listWhisperModels: ready.models.whisper,
    listParakeetModels: ready.models.parakeet,
    getTranscriptions: ready.database.transcriptions,
    getNotes: ready.database.notes,
  };
  const api = Object.fromEntries(
    Object.entries(values).map(([method, value]) => [
      method,
      async (...args) => {
        calls.push([method, ...args]);
        return value;
      },
    ])
  );
  Object.assign(api, apiOverrides);
  return {
    calls,
    context: {
      document: {
        readyState: "complete",
        getElementById: () => ({
          textContent: "Welcome to OpenWhispr",
          querySelectorAll: () => [
            { disabled: !interactive, getClientRects: () => (interactive ? [{}] : []) },
          ],
        }),
      },
      window: {
        electronAPI: new Proxy(api, {
          get(target, method) {
            assert.ok(method in target, `Unexpected startup probe API: ${String(method)}`);
            return target[method];
          },
        }),
      },
    },
  };
}

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

test("readiness requires the fork version, both static model catalogs and working database IPC", () => {
  const ready = readyProbe();
  assert.equal(validateProbe({ ready: false }, version), false);
  assert.equal(validateProbe(ready, version), true);
  for (const override of [
    { version: "1.10.3" },
    { models: undefined },
    { database: undefined },
    { database: { transcriptions: [], notes: { error: "Database not initialized" } } },
    { database: { transcriptions: null, notes: [] } },
  ])
    assert.throws(() => validateProbe({ ...ready, ...override }, version));

  for (const provider of ["whisper", "parakeet"]) {
    for (const update of [
      (listing) => (listing.success = false),
      (listing) => (listing.models = []),
      (listing) => listing.models.pop(),
      (listing) => (listing.models[0].model = "unknown-model"),
      (listing) => (listing.models[0].success = false),
      (listing) => delete listing.models[0].downloaded,
    ]) {
      const invalid = readyProbe();
      update(invalid.models[provider]);
      assert.throws(() => validateProbe(invalid, version));
    }
  }
});

test("the renderer probe reads static models and database IPC with no installed models", async () => {
  const { context, calls } = probeContext();
  const result = await vm.runInNewContext(PROBE, context);
  assert.equal(validateProbe(result, version), true);
  assert.deepEqual(calls, [
    ["setAutoUpdatesEnabled", false],
    ["getAppVersion"],
    ["listWhisperModels"],
    ["listParakeetModels"],
    ["getTranscriptions", 1],
    ["getNotes", null, 1],
  ]);
});

test("a loaded page without controls or required static-model/database preload APIs is not ready", async () => {
  for (const options of [
    { interactive: false },
    { apiOverrides: { listWhisperModels: undefined } },
    { apiOverrides: { listParakeetModels: undefined } },
    { apiOverrides: { getTranscriptions: undefined } },
    { apiOverrides: { getNotes: undefined } },
  ]) {
    const { context } = probeContext(options);
    assert.equal((await vm.runInNewContext(PROBE, context)).ready, false);
  }
});

test("the renderer probe propagates static-model and database IPC failures", async () => {
  for (const method of [
    "listWhisperModels",
    "listParakeetModels",
    "getTranscriptions",
    "getNotes",
  ]) {
    const { context } = probeContext({
      apiOverrides: {
        [method]: async () => {
          throw new Error(`${method} unavailable`);
        },
      },
    });
    await assert.rejects(vm.runInNewContext(PROBE, context), new RegExp(`${method} unavailable`));
  }
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
