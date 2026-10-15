const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const {
  createLocalMcpServer,
  createLocalBridgeClient,
  LIMITS,
} = require("../../src/helpers/localMcpServer");

const TOKEN = "a".repeat(64); // Test-only credential; never read a real app connection file.

async function tempBridge(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-mcp-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("openwhispr-mcp-test-"));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, bridgeFilePath: path.join(dir, "cli-bridge.json") };
}

async function fixtureApi(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const received = {
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(received);
    if (handler) return handler(req, res, received);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: received }));
  });
  let port;
  for (let candidate = 8200; candidate <= 8219; candidate++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(candidate, "127.0.0.1");
      });
      port = candidate;
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  assert.ok(port, "a local CLI bridge fixture port must be available");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, requests, server };
}

async function writeBridge(file, port, extra = {}) {
  await fs.writeFile(file, JSON.stringify({ version: 1, port, token: TOKEN, ...extra }));
}

async function connectInMemory(t, options) {
  const server = createLocalMcpServer(options);
  const client = new Client({ name: "local-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const dataOf = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text).data;
};

test("real SDK stdio subprocess handshakes, lists accurate annotations, and maps local tools", async (t) => {
  const { dir, bridgeFilePath } = await tempBridge(t);
  const api = await fixtureApi(t);
  await writeBridge(bridgeFilePath, api.port);
  const shim = path.join(dir, "server.cjs");
  const modulePath = path.resolve(__dirname, "../../src/helpers/localMcpServer.js");
  await fs.writeFile(
    shim,
    `require(${JSON.stringify(modulePath)}).runLocalMcpStdio({ bridgeFilePath: ${JSON.stringify(bridgeFilePath)} }).catch(() => { process.stderr.write("test server failed\\n"); process.exitCode = 1; });`
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [shim],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const protocolErrors = [];
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport);
  t.after(() => client.close());
  assert.equal(client.getServerVersion().name, "openwhispr-local");
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name),
    [
      "notes_list",
      "notes_search",
      "notes_get",
      "notes_create",
      "notes_update",
      "folders_list",
      "dictionary_list",
      "snippets_list",
      "transcriptions_list",
      "transcriptions_get",
    ]
  );
  for (const tool of tools) {
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(
      tool.annotations.readOnlyHint,
      !["notes_create", "notes_update"].includes(tool.name)
    );
    assert.equal(tool.annotations.destructiveHint, tool.name === "notes_update");
    assert.equal(tool.annotations.idempotentHint, tool.name !== "notes_create");
  }
  const calls = [
    [
      "notes_list",
      { limit: 7, folder_id: 3, note_type: "meeting" },
      "GET",
      "/v1/notes/list?limit=7&folder_id=3&note_type=meeting",
    ],
    [
      "notes_search",
      { q: "中文 & a/b", limit: 2 },
      "GET",
      "/v1/notes/search?q=%E4%B8%AD%E6%96%87+%26+a%2Fb&limit=2",
    ],
    ["notes_get", { id: 4 }, "GET", "/v1/notes/4"],
    [
      "notes_create",
      { title: "中文", content: "test", folder_id: null },
      "POST",
      "/v1/notes/create",
    ],
    ["notes_update", { id: 4, content: "", enhanced_content: "updated" }, "PATCH", "/v1/notes/4"],
    ["folders_list", {}, "GET", "/v1/folders/list"],
    ["dictionary_list", {}, "GET", "/v1/dictionary/list"],
    ["snippets_list", {}, "GET", "/v1/snippets/list"],
    ["transcriptions_list", { limit: 3 }, "GET", "/v1/transcriptions/list?limit=3"],
    ["transcriptions_get", { id: 5 }, "GET", "/v1/transcriptions/5"],
  ];
  for (const [name, args, method, url] of calls) {
    const data = dataOf(await client.callTool({ name, arguments: args }));
    assert.equal(data.method, method);
    assert.equal(data.url, url);
    assert.ok(!JSON.stringify(data).includes(TOKEN));
  }
  assert.deepEqual(api.requests[3].body, { title: "中文", content: "test", folder_id: null });
  assert.deepEqual(api.requests[4].body, { content: "", enhanced_content: "updated" });
  assert.ok(api.requests.every(({ auth }) => auth === `Bearer ${TOKEN}`));
  assert.equal(stderr, "");
  assert.deepEqual(protocolErrors, [], "stdout must contain only valid MCP messages");
});

test("missing or invalid bridge configuration returns safe MCP tool errors without sending requests", async (t) => {
  const { bridgeFilePath } = await tempBridge(t);
  const client = await connectInMemory(t, { bridgeFilePath });
  const missing = await client.callTool({ name: "notes_list", arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /APP_NOT_RUNNING/);
  assert.ok(!missing.content[0].text.includes(bridgeFilePath));
  const api = await fixtureApi(t);
  const invalid = [
    "not JSON containing a secret",
    "[1,2,3]",
    JSON.stringify({ version: 2, port: api.port, token: TOKEN }),
    JSON.stringify({ version: 1, port: 8199, token: TOKEN }),
    JSON.stringify({ version: 1, port: 8220, token: TOKEN }),
    JSON.stringify({ version: 1, port: "8200", token: TOKEN }),
    JSON.stringify({ version: 1, port: api.port, token: "private-invalid-token" }),
    "x".repeat(LIMITS.bridgeBytes + 1),
  ];
  for (const value of invalid) {
    await fs.writeFile(bridgeFilePath, value);
    const result = await client.callTool({ name: "notes_list", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /INVALID_BRIDGE/);
    assert.ok(!result.content[0].text.includes(TOKEN));
    assert.ok(!result.content[0].text.includes("private-invalid-token"));
  }
  assert.equal(api.requests.length, 0);
});

test("bridge is re-read on every tool call after an app port and credential rotation", async (t) => {
  const { bridgeFilePath } = await tempBridge(t);
  const first = await fixtureApi(t);
  const second = await fixtureApi(t);
  await writeBridge(bridgeFilePath, first.port);
  const client = await connectInMemory(t, { bridgeFilePath });
  dataOf(await client.callTool({ name: "notes_get", arguments: { id: 1 } }));
  const rotated = "b".repeat(64);
  await writeBridge(bridgeFilePath, second.port, {
    token: rotated,
    host: "example.com",
    url: "https://example.com",
  });
  dataOf(await client.callTool({ name: "notes_get", arguments: { id: 2 } }));
  assert.equal(first.requests.length, 1);
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].auth, `Bearer ${rotated}`);
});

test("invalid tool arguments and empty updates cannot invoke the local API", async (t) => {
  const { bridgeFilePath } = await tempBridge(t);
  const api = await fixtureApi(t);
  await writeBridge(bridgeFilePath, api.port);
  const client = await connectInMemory(t, { bridgeFilePath });
  for (const call of [
    { name: "notes_get", arguments: { id: -1 } },
    { name: "notes_get", arguments: { id: "../../secret" } },
    { name: "notes_list", arguments: { limit: 0 } },
    { name: "notes_update", arguments: { id: 1 } },
    { name: "notes_search", arguments: { q: "   " } },
  ])
    assert.equal((await client.callTool(call)).isError, true);
  assert.equal(api.requests.length, 0);
});

test("HTTP errors and redirects are MCP errors and never disclose tokens or follow Location", async (t) => {
  const { bridgeFilePath } = await tempBridge(t);
  const target = await fixtureApi(t);
  const source = await fixtureApi(t, (_req, res) => {
    res.writeHead(302, {
      Location: `http://127.0.0.1:${target.port}/v1/notes/list?token=${TOKEN}`,
    });
    res.end(TOKEN);
  });
  await writeBridge(bridgeFilePath, source.port);
  const client = await connectInMemory(t, { bridgeFilePath });
  const redirect = await client.callTool({ name: "notes_list", arguments: {} });
  assert.equal(redirect.isError, true);
  assert.match(redirect.content[0].text, /REDIRECT_BLOCKED/);
  assert.ok(!redirect.content[0].text.includes(TOKEN));
  assert.equal(target.requests.length, 0);
  const forbidden = await fixtureApi(t, (_req, res) => {
    res.writeHead(401);
    res.end(TOKEN);
  });
  await writeBridge(bridgeFilePath, forbidden.port);
  const result = await client.callTool({ name: "notes_list", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 401/);
  assert.ok(!result.content[0].text.includes(TOKEN));
});

test("response limits, invalid JSON, timeouts and request body limits fail without leaking raw data", async (t) => {
  const { bridgeFilePath } = await tempBridge(t);
  const large = await fixtureApi(t, (_req, res) =>
    res.end(JSON.stringify({ data: TOKEN.repeat(3) }))
  );
  await writeBridge(bridgeFilePath, large.port);
  const client = await connectInMemory(t, { bridgeFilePath, maxResponseBytes: 64, timeoutMs: 100 });
  const tooLarge = await client.callTool({ name: "notes_list", arguments: {} });
  assert.equal(tooLarge.isError, true);
  assert.match(tooLarge.content[0].text, /RESPONSE_TOO_LARGE/);
  assert.ok(!tooLarge.content[0].text.includes(TOKEN));
  const invalid = await fixtureApi(t, (_req, res) => res.end(TOKEN));
  await writeBridge(bridgeFilePath, invalid.port);
  const badJson = await client.callTool({ name: "notes_list", arguments: {} });
  assert.equal(badJson.isError, true);
  assert.match(badJson.content[0].text, /INVALID_RESPONSE/);
  const slow = await fixtureApi(t, () => {});
  await writeBridge(bridgeFilePath, slow.port);
  const timeout = await client.callTool({ name: "notes_list", arguments: {} });
  assert.equal(timeout.isError, true);
  assert.match(timeout.content[0].text, /TIMEOUT/);
  const request = createLocalBridgeClient({ bridgeFilePath });
  await assert.rejects(request("POST", "/v1/notes/create", { content: "😀".repeat(300000) }), {
    code: "REQUEST_TOO_LARGE",
  });
  assert.equal(slow.requests.length, 1, "oversized writes must not start a request");
});

test("cancelling a local HTTP call aborts its active request", async (t) => {
  const { bridgeFilePath } = await tempBridge(t);
  let received;
  const arrival = new Promise((resolve) => {
    received = resolve;
  });
  let disconnected;
  const closed = new Promise((resolve) => {
    disconnected = resolve;
  });
  const api = await fixtureApi(t, (_req, res) => {
    res.once("close", disconnected);
    received();
  });
  await writeBridge(bridgeFilePath, api.port);
  const request = createLocalBridgeClient({ bridgeFilePath });
  const controller = new AbortController();
  const pending = request("GET", "/v1/notes/list", undefined, controller.signal);
  await arrival;
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  await closed;
  await assert.rejects(request("GET", "/v1/notes/list", undefined, controller.signal), {
    code: "CANCELLED",
  });
  assert.equal(api.requests.length, 1);
});

test(
  "SDK tool cancellation reaches the active local HTTP request",
  { timeout: 3000 },
  async (t) => {
    const { bridgeFilePath } = await tempBridge(t);
    let received;
    const arrival = new Promise((resolve) => {
      received = resolve;
    });
    let disconnected;
    const closed = new Promise((resolve) => {
      disconnected = resolve;
    });
    const api = await fixtureApi(t, (_req, res) => {
      res.once("close", disconnected);
      received();
    });
    await writeBridge(bridgeFilePath, api.port);
    const client = await connectInMemory(t, { bridgeFilePath });
    const controller = new AbortController();
    const pending = client.callTool({ name: "notes_list", arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await arrival;
    controller.abort();
    await assert.rejects(pending);
    await closed;
  }
);

test("the local HTTP client rejects nonlocal URLs, traversal and unsupported methods", async (t) => {
  const { bridgeFilePath } = await tempBridge(t);
  const request = createLocalBridgeClient({ bridgeFilePath });
  for (const [method, route] of [
    ["GET", "https://example.com/v1/notes/list"],
    ["GET", "//example.com/v1/notes/list"],
    ["GET", "/v1/../../secret"],
    ["GET", "/v1/notes/list\r\nX-Test: yes"],
    ["DELETE", "/v1/notes/1"],
  ])
    await assert.rejects(request(method, route), { code: "INVALID_REQUEST" });
});
