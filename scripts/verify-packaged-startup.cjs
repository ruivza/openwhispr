#!/usr/bin/env node
// Run only on disposable GitHub runners: normal startup also registers the OS
// protocol and CLI bridge outside userData. Never point this check at user data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const WebSocket = require("ws");

function isControlPanelTarget(target, expectedPage) {
  try {
    const url = new URL(target.url);
    const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    return (
      target.type === "page" &&
      url.protocol === "file:" &&
      url.searchParams.get("panel") === "true" &&
      normalize(fileURLToPath(url)) === normalize(expectedPage)
    );
  } catch {
    return false;
  }
}

function startupFailure(output) {
  return output.match(
    /(?:Failed to start app:|Uncaught Exception:|Unhandled Rejection at:|ZodError|Control panel renderer process gone|Control panel crashed, reloading on show)[^\r\n]*/i
  )?.[0];
}

function validateProbe(value, expectedVersion) {
  if (!value?.ready) return false;
  assert.equal(value.version, expectedVersion, "Packaged app version differs from package.json");
  const catalog = require("../src/models/modelRegistryData.json");
  for (const provider of ["whisper", "parakeet"]) {
    const listing = value.models?.[provider];
    assert.equal(listing?.success, true, `Packaged ${provider} model IPC failed`);
    assert.ok(Array.isArray(listing.models), `Packaged ${provider} model list is missing`);
    const expectedModels = Object.keys(catalog[`${provider}Models`]).sort();
    assert.ok(expectedModels.length > 0, `Static ${provider} catalog has no models`);
    assert.deepEqual(
      Array.from(listing.models, (model) => model.model).sort(),
      expectedModels,
      `Packaged ${provider} models differ from the static catalog`
    );
    for (const model of listing.models) {
      assert.equal(model.success, true, `Packaged model status failed: ${model.model}`);
      assert.equal(typeof model.downloaded, "boolean", `Invalid model status: ${model.model}`);
    }
  }
  for (const table of ["transcriptions", "notes"])
    assert.ok(Array.isArray(value.database?.[table]), `Packaged ${table} database IPC failed`);
  return true;
}

async function connectCdp(url, onException) {
  const socket = new WebSocket(url, { handshakeTimeout: 3000 });
  const pending = new Map();
  let nextId = 0;
  socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      const error = message.params.exceptionDetails;
      onException(error.exception?.description || error.text);
    } else if (message.method === "Inspector.targetCrashed") {
      onException("Packaged renderer crashed");
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Packaged renderer debugging connection closed"));
    }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Packaged renderer timed out: ${method}`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.terminate(),
  };
}

const PROBE = `(async () => {
  const root = document.getElementById("root");
  const api = window.electronAPI;
  const methods = ["getAppVersion", "setAutoUpdatesEnabled", "listWhisperModels",
    "listParakeetModels", "getTranscriptions", "getNotes"];
  if (document.readyState !== "complete" ||
      methods.some(method => typeof api?.[method] !== "function"))
    return { ready: false };
  // Use the existing preference IPC; never let a test install an update.
  await api.setAutoUpdatesEnabled(false);
  const interactive = [...(root?.querySelectorAll("button, [role=button]") || [])]
    .some(button => !button.disabled && button.getClientRects().length > 0);
  if (!interactive || !root.textContent.trim()) return { ready: false };
  const version = await api.getAppVersion();
  // These existing IPCs read the bundled static model lists and local database.
  // Listing models must work before any model is downloaded; do not start a download.
  const [whisper, parakeet, transcriptions, notes] = await Promise.all([
    api.listWhisperModels(),
    api.listParakeetModels(),
    api.getTranscriptions(1),
    api.getNotes(null, 1),
  ]);
  return {
    ready: true,
    version: version.version,
    models: { whisper, parakeet },
    database: { transcriptions, notes },
  };
})()`;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function verifyPackagedStartup(appPath, { timeoutMs = 90000 } = {}) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error("Packaged startup verification requires a disposable GitHub Actions runner");
  if (!["win32", "darwin"].includes(process.platform))
    throw new Error("Packaged startup verification supports Windows and macOS only");
  const executable = path.resolve(
    appPath.endsWith(".app") ? path.join(appPath, "Contents/MacOS/OpenWhispr") : appPath
  );
  const resources = path.join(
    path.dirname(executable),
    process.platform === "darwin" ? "../Resources" : "resources"
  );
  const expectedPage = path.resolve(resources, "app.asar/src/dist/index.html");
  assert.ok(fs.existsSync(executable), `Missing packaged executable: ${executable}`);
  assert.ok(
    fs.existsSync(path.join(resources, "app.asar")),
    "Expected the actual packaged app.asar"
  );
  const expectedVersion = require("../package.json").version;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-packaged-startup-"));
  const logFile = path.resolve("build", `packaged-startup-${process.platform}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const port = await availablePort();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    OPENWHISPR_CHANNEL: "production",
    START_MINIMIZED: "false",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  let output = "";
  let failure;
  let stopping = false;
  let client;
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--console-logs",
      "--enable-logging=file",
      `--log-file=${path.join(profile, "chromium.log")}`,
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    }
  );
  const record = (bytes) => {
    const text = String(bytes);
    fs.appendFileSync(logFile, text);
    output = (output + text).slice(-65536);
    failure ||= startupFailure(output);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.once("error", (error) => {
    failure = error.message;
  });
  child.once("exit", (code, signal) => {
    if (!stopping)
      failure = `Packaged app exited before verification (code=${code}, signal=${signal})`;
  });
  try {
    const deadline = Date.now() + timeoutMs;
    let readySince;
    while (Date.now() < deadline) {
      if (failure) throw new Error(failure);
      if (!client) {
        let targets = [];
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(1500),
          });
          if (response.ok) targets = await response.json();
        } catch {
          /* Chromium has not started listening yet. */
        }
        const target = targets.find((item) => isControlPanelTarget(item, expectedPage));
        if (target) {
          const endpoint = new URL(target.webSocketDebuggerUrl);
          assert.equal(endpoint.protocol, "ws:");
          assert.equal(endpoint.hostname, "127.0.0.1");
          assert.equal(endpoint.port, String(port));
          client = await connectCdp(endpoint.href, (error) => {
            failure = error;
          });
          await client.send("Runtime.enable");
        }
      }
      if (client) {
        const result = await client.send("Runtime.evaluate", {
          expression: PROBE,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description || result.exceptionDetails.text
          );
        if (validateProbe(result.result?.value, expectedVersion)) {
          readySince ??= Date.now();
          if (Date.now() - readySince >= 5000) {
            if (failure) throw new Error(failure);
            console.log(
              `Packaged startup passed: ${expectedVersion}; interactive control panel, static models and database IPC stable for 5 seconds.`
            );
            console.log(`Startup log: ${logFile}`);
            return;
          }
        } else readySince = undefined;
      }
      await delay(500);
    }
    throw new Error(
      "Timed out waiting for an interactive packaged control panel, static models and database IPC"
    );
  } catch (error) {
    throw new Error(`${error.message}\nStartup log: ${logFile}\n${output.slice(-6000)}`);
  } finally {
    stopping = true;
    client?.close();
    if (child.pid) {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
    // The generated directory is the only recursive deletion target.
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith("openwhispr-packaged-startup-"));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

module.exports = {
  isControlPanelTarget,
  startupFailure,
  validateProbe,
  PROBE,
  connectCdp,
  verifyPackagedStartup,
};
if (require.main === module) {
  const appPath = process.argv[2];
  if (!appPath || process.argv.length !== 3) {
    console.error("Usage: node scripts/verify-packaged-startup.cjs PACKAGED_EXE_OR_APP");
    process.exitCode = 1;
  } else
    verifyPackagedStartup(appPath).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
