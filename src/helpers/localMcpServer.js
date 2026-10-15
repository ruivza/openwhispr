// A stdio adapter for the existing local CLI API. It never opens a listener,
// reads the app database directly, or uses an official account credential.
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");

const LIMITS = Object.freeze({
  bridgeBytes: 4096,
  requestBytes: 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  timeoutMs: 15000,
});

class LocalMcpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cancelledError() {
  return new LocalMcpError("CANCELLED", "The local API request was cancelled.");
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

async function readBridgeConfig(bridgeFilePath) {
  let file;
  let bytes;
  try {
    file = await fs.open(bridgeFilePath, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMITS.bridgeBytes) throw new Error();
    // Bound the read itself, including a file replaced or grown after stat().
    const buffer = Buffer.alloc(LIMITS.bridgeBytes + 1);
    const result = await file.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > LIMITS.bridgeBytes) throw new Error();
    bytes = buffer.subarray(0, result.bytesRead).toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new LocalMcpError("APP_NOT_RUNNING", "Open the desktop app before using local MCP.");
    }
    throw new LocalMcpError(
      "INVALID_BRIDGE",
      "The desktop app's local connection file is invalid."
    );
  } finally {
    await file?.close().catch(() => {});
  }

  let config;
  try {
    config = JSON.parse(bytes);
  } catch {
    // Do not include file contents, paths, or parser errors in tool output.
  }
  if (
    !config ||
    Array.isArray(config) ||
    config.version !== 1 ||
    !Number.isInteger(config.port) ||
    config.port < 8200 ||
    config.port > 8219 ||
    typeof config.token !== "string" ||
    !/^[a-f0-9]{64}$/i.test(config.token)
  ) {
    throw new LocalMcpError(
      "INVALID_BRIDGE",
      "The desktop app's local connection file is invalid."
    );
  }
  return { port: config.port, token: config.token };
}

function createLocalBridgeClient({
  bridgeFilePath = path.join(os.homedir(), ".openwhispr", "cli-bridge.json"),
  timeoutMs = LIMITS.timeoutMs,
  maxResponseBytes = LIMITS.responseBytes,
} = {}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    throw new LocalMcpError("INVALID_OPTIONS", "Invalid local MCP request limits.");
  }

  return async function requestLocalApi(method, route, body, signal) {
    throwIfCancelled(signal);
    // Only adapter-owned relative API paths are accepted; the host cannot be
    // supplied by a tool argument or by extra fields in the connection file.
    let url;
    try {
      url = new URL(route, "http://127.0.0.1");
    } catch {}
    if (
      !url ||
      url.origin !== "http://127.0.0.1" ||
      !url.pathname.startsWith("/v1/") ||
      /[\r\n]/.test(route) ||
      !["GET", "POST", "PATCH"].includes(method)
    ) {
      throw new LocalMcpError("INVALID_REQUEST", "Invalid local API request.");
    }
    let payload;
    try {
      payload = body === undefined ? undefined : JSON.stringify(body);
    } catch {
      throw new LocalMcpError("INVALID_REQUEST", "Invalid local API request body.");
    }
    if (payload !== undefined && Buffer.byteLength(payload) > LIMITS.requestBytes) {
      throw new LocalMcpError("REQUEST_TOO_LARGE", "The local API request exceeds 1 MiB.");
    }
    // Re-read for every call: an app restart rotates both the port and token.
    // Writes are never retried automatically, since they may already have landed.
    const config = await readBridgeConfig(bridgeFilePath);
    throwIfCancelled(signal);

    return new Promise((resolve, reject) => {
      let settled = false;
      let req;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          req?.destroy();
          reject(error);
        } else resolve(result);
      };
      const onAbort = () => finish(cancelledError());
      req = http.request(
        {
          hostname: "127.0.0.1",
          port: config.port,
          method,
          path: `${url.pathname}${url.search}`,
          agent: false,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${config.token}`,
            ...(payload !== undefined
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          // node:http does not follow redirects. Never forward the local token to
          // a Location URL, including another loopback port.
          if (res.statusCode >= 300 && res.statusCode < 400) {
            finish(
              new LocalMcpError(
                "REDIRECT_BLOCKED",
                "The local API returned an unexpected redirect."
              )
            );
            res.destroy();
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            finish(
              new LocalMcpError(
                "API_REJECTED",
                `The desktop API rejected the request (HTTP ${res.statusCode}).`
              )
            );
            res.destroy();
            return;
          }
          let size = 0;
          const chunks = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              finish(
                new LocalMcpError(
                  "RESPONSE_TOO_LARGE",
                  "The local API response is too large; request fewer results."
                )
              );
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.once("error", () =>
            finish(
              new LocalMcpError(
                "CONNECTION_FAILED",
                "The desktop app's local connection was interrupted."
              )
            )
          );
          res.once("end", () => {
            if (settled) return;
            let result;
            try {
              result = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
            } catch {}
            if (
              !result ||
              typeof result !== "object" ||
              Array.isArray(result) ||
              !Object.hasOwn(result, "data")
            ) {
              finish(
                new LocalMcpError(
                  "INVALID_RESPONSE",
                  "The desktop app returned an invalid local API response."
                )
              );
            } else {
              // The bridge does not normally echo its credential. Still redact
              // that exact per-launch secret if it ever appears in API output.
              finish(
                null,
                JSON.parse(
                  JSON.stringify(result).replaceAll(config.token, "[redacted local credential]")
                )
              );
            }
          });
        }
      );
      req.once("error", () =>
        finish(
          new LocalMcpError(
            "CONNECTION_FAILED",
            "The desktop app is not reachable. Open or restart it, then try again."
          )
        )
      );
      timer = setTimeout(
        () =>
          finish(new LocalMcpError("TIMEOUT", "The desktop app's local API request timed out.")),
        timeoutMs
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      req.end(payload);
    });
  };
}

function queryPath(route, values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.size ? `${route}?${query}` : route;
}

function createLocalMcpServer(options = {}) {
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "openwhispr-local", version: "1.0.0" });
  const request = createLocalBridgeClient(options);
  const id = z.number().int().positive().safe();
  const limit = z.number().int().min(1).max(1000).optional();
  const text = z.string().max(LIMITS.requestBytes);
  const noteType = z.enum(["personal", "meeting", "upload"]);
  const register = (
    name,
    description,
    inputSchema,
    method,
    route,
    { readOnly = true, body } = {}
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: name === "notes_update",
          idempotentHint: name !== "notes_create",
          openWorldHint: false,
        },
      },
      async (args, extra) => {
        try {
          const requestBody = body?.(args);
          if (name === "notes_update" && Object.keys(requestBody).length === 0) {
            throw new LocalMcpError(
              "INVALID_REQUEST",
              "Provide at least one note field to update."
            );
          }
          const result = await request(
            method,
            typeof route === "function" ? route(args) : route,
            requestBody,
            extra.signal
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          // Only our fixed diagnostics may cross stdio. HTTP bodies, exception
          // strings, local file paths, and the local bearer token never do.
          const message =
            error instanceof LocalMcpError
              ? `${error.code}: ${error.message}`
              : "LOCAL_API_ERROR: The local API request failed.";
          return { isError: true, content: [{ type: "text", text: message }] };
        }
      }
    );
  };

  register(
    "notes_list",
    "List notes in the desktop app's current local data scope.",
    { limit, folder_id: id.optional(), note_type: noteType.optional() },
    "GET",
    (args) => queryPath("/v1/notes/list", args)
  );
  register(
    "notes_search",
    "Search the desktop app's local notes by text.",
    { q: z.string().trim().min(1).max(4096), limit },
    "GET",
    (args) => queryPath("/v1/notes/search", args)
  );
  register(
    "notes_get",
    "Read one local note by its numeric id.",
    { id },
    "GET",
    (args) => `/v1/notes/${args.id}`
  );
  register(
    "notes_create",
    "Create a local note. Each call creates a new note.",
    {
      title: text.optional(),
      content: text.optional(),
      note_type: noteType.optional(),
      folder_id: id.nullable().optional(),
    },
    "POST",
    "/v1/notes/create",
    { readOnly: false, body: (args) => args }
  );
  register(
    "notes_update",
    "Replace the supplied fields of an existing local note. Empty content clears that field; omitted fields remain unchanged.",
    {
      id,
      title: text.optional(),
      content: text.optional(),
      enhanced_content: text.optional(),
      folder_id: id.nullable().optional(),
    },
    "PATCH",
    (args) => `/v1/notes/${args.id}`,
    {
      readOnly: false,
      body: ({ id: _id, ...fields }) => fields,
    }
  );
  register(
    "folders_list",
    "List the desktop app's local note folders.",
    {},
    "GET",
    "/v1/folders/list"
  );
  register(
    "dictionary_list",
    "Read the local custom dictionary.",
    {},
    "GET",
    "/v1/dictionary/list"
  );
  register("snippets_list", "Read the local text snippets.", {}, "GET", "/v1/snippets/list");
  register(
    "transcriptions_list",
    "List recent local dictation transcriptions.",
    { limit },
    "GET",
    (args) => queryPath("/v1/transcriptions/list", args)
  );
  register(
    "transcriptions_get",
    "Read one local dictation transcription by id.",
    { id },
    "GET",
    (args) => `/v1/transcriptions/${args.id}`
  );
  return server;
}

async function runLocalMcpStdio(options = {}) {
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
  const { stdin = process.stdin, stdout = process.stdout, ...clientOptions } = options;
  const server = createLocalMcpServer(clientOptions);
  await server.connect(new StdioServerTransport(stdin, stdout));
  return server;
}

module.exports = { createLocalMcpServer, runLocalMcpStdio, createLocalBridgeClient, LIMITS };

if (require.main === module) {
  runLocalMcpStdio().catch(() => {
    process.stderr.write("Local MCP server could not start.\n");
    process.exitCode = 1;
  });
}
