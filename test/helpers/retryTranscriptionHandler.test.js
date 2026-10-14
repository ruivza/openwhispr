const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly against a fake `this`.
const handlers = new Map();
const fetches = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// A 44-byte RIFF header is enough for isWavFormat, which only sniffs the magic.
const WAV_BUFFER = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
]);
const CONVERTED_WAV = Buffer.concat([WAV_BUFFER, Buffer.from("converted")]);

// Conversion is mocked rather than run: spawning ffmpeg from a unit test would
// make it slow and dependent on the runner having a usable binary.
const wavConversions = [];
let convertBehavior = async () => CONVERTED_WAV;

const cortiCalls = [];
const tinfoilCalls = [];
let cortiBehavior = async () => ({ text: "corti text" });

// Kept installed for the whole file: the corti client is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (opts) => {
          cortiCalls.push(opts);
          return cortiBehavior(opts);
        },
      };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (opts) => {
          tinfoilCalls.push(opts);
          return { text: "tinfoil text", model: "tinfoil-model" };
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    if (request === "./ffmpegUtils") {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        convertBufferToWav: async (buffer, options) => {
          wavConversions.push(buffer);
          return convertBehavior(buffer, options);
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the retry handler can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const dbRows = new Map([
    [7, { id: 7, audio_duration_ms: 1200 }],
    [8, { id: 8, audio_duration_ms: 1200 }],
  ]);
  const target = {
    _uploadCancelRegistry:
      require("../../src/helpers/uploadCancelRegistry").createUploadCancelRegistry(),
    sessionId: "test-session",
    audioStorageManager: {
      // 7 is a stored WebM recording, 8 one already in WAV.
      getAudioBuffer: (id) => (id === 7 ? Buffer.from([1, 2, 3]) : id === 8 ? WAV_BUFFER : null),
    },
    databaseManager: {
      updateTranscriptionText: () => {},
      updateTranscriptionStatus: () => {},
      updateTranscriptionAudio: () => {},
      getTranscriptionById: (id) => dbRows.get(id),
    },
    environmentManager: {
      getOpenAIKey: () => "sk-openai",
      getGroqKey: () => "gk-groq",
      getMistralKey: () => "mk-mistral",
      getXaiKey: () => "xk-xai",
      getTinfoilKey: () => "tk-tinfoil",
      getCustomTranscriptionKey: () => "ck-custom",
      getCortiClientId: () => "corti-id",
      getCortiClientSecret: () => "corti-secret",
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let retryHandler;
let fakeThis;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis = buildFakeThis();
  Ctor.prototype.setupHandlers.call(fakeThis);
  retryHandler = handlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

const invoke = (settings, id = 7) => retryHandler({ sender: {} }, id, settings);

test("retry: corti routes to the corti client, never OpenAI", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cortiEnvironment: "eu",
    cortiTenant: "acme",
    preferredLanguage: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(cortiCalls.length, 1);
  assert.equal(cortiCalls[0].environment, "eu");
  assert.equal(cortiCalls[0].tenant, "acme");
  assert.equal(cortiCalls[0].language, "en");
  assert.equal(fetches.length, 0, "corti retry must not touch HTTP endpoints");
});

test("retry: custom misconfiguration fails closed with a coded error", async () => {
  fetches.length = 0;
  for (const cloudTranscriptionBaseUrl of ["", "https://api.openai.com/v1", "not a url"]) {
    const result = await invoke({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(result.success, false, cloudTranscriptionBaseUrl);
    assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID", cloudTranscriptionBaseUrl);
  }
  assert.equal(fetches.length, 0);
});

test("retry: openwhispr cloud masks a leftover BYOK misconfiguration", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "openwhispr",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "",
  });
  // BrowserWindow.fromWebContents is stubbed to null, so the cloud branch
  // produces no result — but the route error must NOT surface.
  assert.equal(result.success, false);
  assert.notEqual(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.match(result.error, /No transcription engine available/);
  assert.equal(fetches.length, 0);
});

test("retry: Azure custom endpoints get deployment URLs and api-key auth", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /myres\.openai\.azure\.com\/openai\/deployments\/my-deployment/);
  assert.equal(fetches[0].init.headers["api-key"], "ck-custom");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
});

test("retry: plain custom endpoints use Bearer auth at the configured URL", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
    cloudTranscriptionModel: "parasail-model",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, "https://stt.parasail.example.com/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer ck-custom");
});

const CUSTOM_SETTINGS = {
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
  cloudTranscriptionModel: "parasail-model",
};

const uploadedPart = () => fetches[0].init.body.get("file");

test("retry: a stored WebM is re-encoded before reaching a custom endpoint", async () => {
  // Without this the renderer-side fix covers fresh dictations only, and every
  // retry of a recording that failed for the container reason fails again.
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(CUSTOM_SETTINGS);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 1, "the stored container must be converted");
  const part = uploadedPart();
  assert.equal(part.name, "audio.wav");
  assert.equal(part.type, "audio/wav");
  assert.equal(part.size, CONVERTED_WAV.length, "the converted bytes are what gets uploaded");
});

test("retry: audio already in WAV is uploaded untouched", async () => {
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(CUSTOM_SETTINGS, 8);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 0, "re-encoding WAV would only cost time");
  assert.equal(uploadedPart().size, WAV_BUFFER.length);
});

test("retry: WAV expansion preserves uploads that fit the provider limit", async (t) => {
  for (const wavSize of [25 * 1024 * 1024, 25 * 1024 * 1024 + 1]) {
    await t.test(`${wavSize} converted bytes`, async () => {
      fetches.length = 0;
      const converted = Buffer.alloc(wavSize);
      WAV_BUFFER.copy(converted);
      convertBehavior = async () => converted;
      try {
        const result = await invoke(CUSTOM_SETTINGS);
        assert.equal(result.success, true);
        const part = uploadedPart();
        const fits = wavSize === 25 * 1024 * 1024;
        assert.equal(part.type, fits ? "audio/wav" : "audio/webm");
        assert.equal(part.name, fits ? "audio.wav" : "audio.webm");
        assert.deepEqual(
          Buffer.from(await part.arrayBuffer()),
          fits ? converted : Buffer.from([1, 2, 3])
        );
      } finally {
        convertBehavior = async () => CONVERTED_WAV;
      }
    });
  }
});

test("retry: built-in providers keep sending the stored container", async () => {
  fetches.length = 0;
  wavConversions.length = 0;

  await invoke({
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionModel: "whisper-1",
  });

  assert.equal(wavConversions.length, 0, "only custom endpoints need the re-encode");
  assert.equal(uploadedPart().name, "audio.webm");
});

test("retry: a conversion failure falls open to the stored container", async () => {
  fetches.length = 0;
  wavConversions.length = 0;
  convertBehavior = async () => {
    throw new Error("ffmpeg missing");
  };

  try {
    const result = await invoke(CUSTOM_SETTINGS);
    assert.equal(result.success, true, "a failed re-encode must not fail the retry");
    const part = uploadedPart();
    assert.equal(part.name, "audio.webm");
    assert.equal(part.type, "audio/webm");
  } finally {
    convertBehavior = async () => CONVERTED_WAV;
  }
});

test("retry: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
  assert.equal(tinfoilCalls.length, 0);
});

test("retry: mistral goes to Mistral with x-api-key", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
});

test("retry: a missing BYOK key on the generic provider branch is a classified error", async () => {
  fetches.length = 0;
  const originalGetMistralKey = fakeThis.environmentManager.getMistralKey;
  fakeThis.environmentManager.getMistralKey = () => "";
  try {
    const result = await invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Mistral" });
    assert.equal(fetches.length, 0, "a missing key must fail before any request is sent");
  } finally {
    fakeThis.environmentManager.getMistralKey = originalGetMistralKey;
  }
});

test("retry: missing Corti credentials are a classified error", async () => {
  fetches.length = 0;
  const cortiCallsBefore = cortiCalls.length;
  const originalGetCortiClientId = fakeThis.environmentManager.getCortiClientId;
  fakeThis.environmentManager.getCortiClientId = () => "";
  try {
    const result = await invoke({
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "eu",
      cortiTenant: "acme",
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Corti" });
    assert.equal(
      cortiCalls.length,
      cortiCallsBefore,
      "a missing credential must fail before calling Corti"
    );
  } finally {
    fakeThis.environmentManager.getCortiClientId = originalGetCortiClientId;
  }
});

test("proxy-corti-transcription: missing credentials are a classified error", async () => {
  const fn = handlers.get("proxy-corti-transcription");
  assert.ok(fn, "proxy-corti-transcription must be registered");
  const cortiCallsBefore = cortiCalls.length;
  const originalGetCortiClientId = fakeThis.environmentManager.getCortiClientId;
  fakeThis.environmentManager.getCortiClientId = () => "";
  try {
    const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Corti" });
    assert.equal(
      cortiCalls.length,
      cortiCallsBefore,
      "a missing credential must fail before calling Corti"
    );
  } finally {
    fakeThis.environmentManager.getCortiClientId = originalGetCortiClientId;
  }
});

test("proxy transcription handlers resolve to structured errors instead of rejecting", async () => {
  fetchResponse = () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
    json: async () => ({}),
  });
  cortiBehavior = async () => {
    const err = new Error("Corti API Error: 401");
    err.code = "INVALID_KEY";
    throw err;
  };
  try {
    for (const channel of [
      "proxy-mistral-transcription",
      "proxy-xai-transcription",
      "proxy-corti-transcription",
    ]) {
      const fn = handlers.get(channel);
      assert.ok(fn, `${channel} must be registered`);
      const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
      assert.equal(typeof result.error, "string", channel);
    }
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const invokeUpload = (payload) => {
  const uploadHandler = handlers.get("transcribe-audio-file-byok");
  assert.ok(uploadHandler, "transcribe-audio-file-byok must be registered");
  fsNode.writeFileSync(uploadTempFile, Buffer.from([1, 2, 3, 4]));
  return uploadHandler({ sender: {} }, { filePath: uploadTempFile, ...payload });
};

test("upload: mistral sends x-api-key with a provider-validated model and no language on auto", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "mk-mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "gpt-4o-mini-transcribe", // stale from an openai era — must degrade
    provider: "mistral",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
  const body = fetches[0].init.body.toString();
  assert.match(body, /voxtral-mini-latest/);
  assert.doesNotMatch(body, /name="language"/);
});

test("upload: openai diarization fields ride the route, Bearer auth", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-openai");
  const body = fetches[0].init.body.toString();
  assert.match(body, /gpt-4o-transcribe-diarize/);
  assert.match(body, /diarized_json/);
});

test("upload: sentinel custom URL fails closed before any request", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.equal(fetches.length, 0);
});

test("upload: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://inference.tinfoil.sh/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
});

// An uploaded file is frequently not in the dictation language, and a wrong hint
// silently mistranscribes it — so BYOK cloud uploads auto-detect even when the
// user has pinned a preferred language for dictation.
test("upload: a preferred language never constrains a BYOK cloud upload", async () => {
  for (const provider of ["openai", "groq", "custom"]) {
    fetches.length = 0;
    const result = await invokeUpload({
      apiKey: "sk-key",
      baseUrl: provider === "custom" ? "https://gateway.example.com/v1" : "",
      model: "whisper-1",
      provider,
      language: "de",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, true, provider);
    assert.doesNotMatch(fetches[0].init.body.toString(), /name="language"/, provider);
  }
});

// Providers that require a concrete language still receive one.
test("upload: corti and xai still get their language", async () => {
  fetches.length = 0;
  const xai = await invokeUpload({
    apiKey: "xk-key",
    baseUrl: "",
    model: "grok-stt",
    provider: "xai",
    language: "de",
    transcriptionMode: "providers",
  });
  assert.equal(xai.success, true);
  assert.match(fetches[0].url, /api\.x\.ai/);
  const xaiBody = fetches[0].init.body.toString();
  assert.match(xaiBody, /name="language"[\s\S]*?de/);
  assert.doesNotMatch(xaiBody, /name="model"/);

  const corti = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "corti-transcribe",
    provider: "corti",
    language: "",
    environment: "eu",
    tenant: " acme ",
    transcriptionMode: "providers",
  });
  assert.equal(corti.success, true);
  assert.equal(cortiCalls.at(-1).language, "en", "corti needs a concrete primaryLanguage");
  assert.equal(cortiCalls.at(-1).environment, "eu");
  assert.equal(cortiCalls.at(-1).tenant, "acme");
});

// #1459 made cloudTranscriptionBaseUrl Custom-only, so provider id alone can no
// longer tell whether a Custom endpoint fronts a diarization-capable API.
test("upload: a Custom endpoint fronting OpenAI or Mistral keeps diarization", async () => {
  fetches.length = 0;
  const openaiFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(openaiFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /gpt-4o-transcribe-diarize/);

  fetches.length = 0;
  const mistralFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.mistral.ai/v1/audio/transcriptions",
    model: "voxtral-mini-latest",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(mistralFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /name="diarize"/);

  fetches.length = 0;
  const unknownGateway = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://gateway.example.com/v1",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(unknownGateway.success, true, "an unknown gateway degrades, never fails");
  assert.doesNotMatch(fetches[0].init.body.toString(), /diarized_json/);
});

test("upload: a self-hosted Azure endpoint keeps its deployment URL", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "",
    provider: "custom",
    language: "",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(
    fetches[0].url,
    "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

// Electron's net.fetch rejects with a plain Error whose message is the Chromium
// net error and no code; both BYOK handlers must classify it before replying.
async function withFetchRejecting(message, run) {
  const originalFetchResponse = fetchResponse;
  fetchResponse = () => {
    throw new Error(message);
  };
  try {
    return await run();
  } finally {
    fetchResponse = originalFetchResponse;
  }
}

test("retry: a net::ERR_* failure from a BYOK provider is classified as unreachable", async () => {
  const result = await withFetchRejecting("net::ERR_INTERNET_DISCONNECTED", () =>
    invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_UNREACHABLE");
  assert.equal(result.messageKey, "providerErrors.unreachable");
  assert.equal(result.messageParams.provider, "Mistral");
  assert.equal(result.surface, "transcription");
});

test("retry: a self-hosted timeout names the user's server", async () => {
  const result = await withFetchRejecting("net::ERR_CONNECTION_TIMED_OUT", () =>
    invoke({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionMode: "byok",
    })
  );
  assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(result.messageKey, "providerErrors.selfHosted.timeout");
});

test("retry: a cancelled request (net::ERR_ABORTED) is not classified", async () => {
  const result = await withFetchRejecting("net::ERR_ABORTED", () =>
    invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.messageKey, undefined);
  assert.equal(result.error, "net::ERR_ABORTED");
});

test("upload: a net::ERR_* failure from a BYOK provider is classified as unreachable", async () => {
  const result = await withFetchRejecting("net::ERR_NAME_NOT_RESOLVED", () =>
    invokeUpload({
      apiKey: "sk-openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-transcribe",
      provider: "openai",
      language: "",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_UNREACHABLE");
  assert.equal(result.messageParams.provider, "OpenAI");
  assert.equal(result.surface, "transcription");
  assert.equal(result.error, "Couldn't reach OpenAI. Check your connection.");
});

test("upload: an HTTP failure logs its status and a redacted body", async (t) => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const warnings = [];
  t.mock.method(debugLogger, "warn", (message, meta) => warnings.push({ message, meta }));
  const originalFetchResponse = fetchResponse;
  t.after(() => {
    fetchResponse = originalFetchResponse;
  });
  const body = '{"error":{"message":"Incorrect API key provided: sk-proj-leakedKey12345"}}';
  fetchResponse = () => ({
    ok: false,
    status: 401,
    headers: new Headers(),
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
  });

  assert.equal(result.code, "PROVIDER_AUTH_FAILED");
  const failure = warnings.find(({ message }) => message === "BYOK file transcription failed");
  assert.ok(failure, "the failure must be logged");
  assert.equal(failure.meta.status, 401);
  assert.match(failure.meta.body, /Incorrect API key provided/);
  assert.equal(failure.meta.body.includes("sk-proj-leakedKey12345"), false);
});

function chunkedUploadFixture(t, sizeBytes, count = 3) {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-large-upload-test-"));
  const filePath = path.join(dir, "large.mp3");
  const fd = fs.openSync(filePath, "w");
  fs.ftruncateSync(fd, sizeBytes);
  fs.closeSync(fd);
  const chunkDirs = [];
  t.mock.method(
    require("../../src/helpers/ffmpegUtils"),
    "splitAudioFile",
    async (input, output, options) => {
      assert.equal(input, filePath);
      assert.equal(options.segmentDuration, 240);
      options.signal.throwIfAborted();
      chunkDirs.push(output);
      return {
        durationSeconds: count * 240,
        chunkPaths: Array.from({ length: count }, (_, index) => {
          const chunk = path.join(output, `chunk-${index}.mp3`);
          fs.writeFileSync(chunk, `part-${index}`);
          return chunk;
        }),
      };
    }
  );
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    assert.notEqual(file, filePath, "large source must never be buffered whole");
    return originalRead.call(this, file, ...args);
  });
  const previousResponse = fetchResponse;
  t.after(() => {
    fetchResponse = previousResponse;
    assert.equal(fakeThis._uploadCancelRegistry.cancel("large-upload"), 0, "controller released");
    assert.ok(fs.existsSync(filePath), "source preserved");
    for (const chunkDir of chunkDirs) assert.equal(fs.existsSync(chunkDir), false);
    // This directory was created by this fixture, under the system temp dir.
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fetches.length = 0;
  cortiCalls.length = 0;
  tinfoilCalls.length = 0;
  const progress = [];
  return {
    filePath,
    progress,
    invoke: (options) =>
      handlers.get("transcribe-audio-file-byok")(
        { sender: { send: (channel, payload) => progress.push({ channel, ...payload }) } },
        {
          filePath,
          requestId: "large-upload",
          apiKey: "provider-key",
          model: "whisper-1",
          transcriptionMode: "providers",
          ...options,
        }
      ),
  };
}

test("large BYOK and Custom uploads use the shared splitter and retain provider routing/auth", async (t) => {
  for (const provider of [
    "openai",
    "groq",
    "mistral",
    "xai",
    "custom",
    "gemini",
    "corti",
    "tinfoil",
  ]) {
    await t.test(provider, async (t) => {
      const cap = provider === "gemini" ? 14 : 25;
      const fixture = chunkedUploadFixture(t, cap * 1024 * 1024 + 1);
      fetchResponse = (_, init) => {
        const index =
          provider === "gemini"
            ? Buffer.from(JSON.parse(init.body).input[0].data, "base64").toString().slice(-1)
            : init.body.toString().match(/part-(\d)/)[1];
        const data =
          provider === "gemini"
            ? { status: "completed", output_text: `text ${index}` }
            : { text: `text ${index}`, segments: [{ text: `text ${index}`, start: 1, end: 2 }] };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(data),
          json: async () => data,
        };
      };
      const result = await fixture.invoke({
        provider,
        baseUrl: "https://stt.example.com/v1",
        model: provider === "gemini" ? "gemini-3.5-transcribe" : "whisper-1",
        timestamps: true,
      });
      assert.equal(result.success, true, result.error);
      assert.equal(result.durationSeconds, 720);
      assert.equal(fixture.progress.at(-1).chunksCompleted, 3);
      assert.ok(fixture.progress.every((p) => p.requestId === "large-upload"));
      if (provider === "tinfoil") {
        assert.equal(tinfoilCalls.length, 3);
        assert.ok(
          tinfoilCalls.every(
            (call) => call.apiKey === "tk-tinfoil" && call.signal instanceof AbortSignal
          )
        );
      } else if (provider === "corti") {
        assert.equal(cortiCalls.length, 3);
        assert.ok(
          cortiCalls.every(
            (call) => call.clientId === "corti-id" && call.signal instanceof AbortSignal
          )
        );
      } else {
        assert.equal(fetches.length, 3);
        assert.equal(result.text, "text 0 text 1 text 2");
        const expectedHost = {
          openai: "api.openai.com",
          groq: "api.groq.com",
          mistral: "api.mistral.ai",
          xai: "api.x.ai",
          custom: "stt.example.com",
          gemini: "generativelanguage.googleapis.com",
        }[provider];
        for (const request of fetches) {
          assert.equal(new URL(request.url).hostname, expectedHost);
          assert.ok(request.init.signal instanceof AbortSignal);
          const header =
            provider === "mistral"
              ? "x-api-key"
              : provider === "gemini"
                ? "x-goog-api-key"
                : "Authorization";
          assert.equal(
            request.init.headers[header],
            header === "Authorization" ? "Bearer provider-key" : "provider-key"
          );
        }
        if (["openai", "groq", "mistral"].includes(provider)) {
          assert.deepEqual(
            result.segments.map((s) => s.start),
            [1, 241, 481]
          );
        }
      }
    });
  }
});

test("large BYOK uploads can be cancelled through the existing IPC channel", async (t) => {
  const fixture = chunkedUploadFixture(t, 26 * 1024 * 1024, 8);
  const started = Promise.withResolvers();
  fetchResponse = (_, init) => {
    started.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => reject(init.signal.reason);
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort, { once: true });
    });
  };
  const pending = fixture.invoke({ provider: "openai" });
  await started.promise;
  assert.deepEqual(await handlers.get("cancel-upload-transcription")({}, "large-upload"), {
    success: true,
  });
  const result = await pending;
  assert.equal(result.code, "UPLOAD_CANCELLED");
  assert.equal(result.success, false);
  assert.ok(fetches.length <= 5);
});

test("large BYOK uploads preserve authentication errors instead of replacing them with a chunk-loss error", async (t) => {
  const fixture = chunkedUploadFixture(t, 26 * 1024 * 1024, 8);
  fetchResponse = () => ({
    status: 401,
    text: async () => JSON.stringify({ error: "unauthorized" }),
  });
  const result = await fixture.invoke({ provider: "openai" });
  assert.equal(result.code, "PROVIDER_AUTH_FAILED");
  assert.ok(fetches.length <= 5);
});

test("cloud imports still use the same chunk pipeline, cloud endpoint and isolated session", async (t) => {
  const fixture = chunkedUploadFixture(t, 5 * 1024 * 1024);
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.example";
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });
  t.mock.method(require("../../src/helpers/tokenStore"), "get", () => "cloud-token");
  const partitions = [];
  t.mock.method(electronStub.session, "fromPartition", (partition) => {
    partitions.push(partition);
    return {
      fetch: electronStub.net.fetch,
      webRequest: { onBeforeSendHeaders() {} },
      async closeAllConnections() {},
    };
  });
  fetchResponse = (_, init) => {
    const index = init.body.toString().match(/part-(\d)/)[1];
    return { status: 200, text: async () => JSON.stringify({ text: `cloud ${index}` }) };
  };
  const result = await handlers.get("transcribe-audio-file-cloud")(
    { sender: { send: (_, payload) => fixture.progress.push(payload) } },
    fixture.filePath,
    { requestId: "large-upload" }
  );
  assert.equal(result.success, true, result.error);
  assert.equal(result.text, "cloud 0 cloud 1 cloud 2");
  assert.deepEqual(partitions, ["ow-cloud-chunk-uploads"]);
  assert.equal(fetches.length, 3);
  for (const { url, init } of fetches) {
    assert.equal(url, "https://api.openwhispr.example/api/transcribe");
    assert.equal(init.headers.Authorization, "Bearer cloud-token");
    assert.match(init.body.toString(), /file_upload/);
  }
  assert.equal(fixture.progress.at(-1).requestId, "large-upload");
});

test("large Custom Azure imports retain deployment URLs and api-key authentication", async (t) => {
  const fixture = chunkedUploadFixture(t, 26 * 1024 * 1024);
  const result = await fixture.invoke({
    provider: "custom",
    baseUrl: "https://tenant.openai.azure.com",
    model: "my-whisper-deployment",
  });
  assert.equal(result.success, true, result.error);
  assert.equal(fetches.length, 3);
  for (const { url, init } of fetches) {
    assert.match(
      url,
      /tenant\.openai\.azure\.com\/openai\/deployments\/my-whisper-deployment\/audio\/transcriptions/
    );
    assert.equal(init.headers["api-key"], "provider-key");
    assert.equal(init.headers.Authorization, undefined);
  }
});

test("large self-hosted imports never fall through to a stale BYOK provider", async (t) => {
  const fixture = chunkedUploadFixture(t, 26 * 1024 * 1024);
  const result = await fixture.invoke({
    provider: "gemini",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://127.0.0.1:8080/v1",
    remoteTranscriptionModel: "local-whisper",
  });
  assert.equal(result.success, true, result.error);
  assert.equal(fetches.length, 3);
  assert.ok(fetches.every(({ url }) => url === "http://127.0.0.1:8080/v1/audio/transcriptions"));
});
