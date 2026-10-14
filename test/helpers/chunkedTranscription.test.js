const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");
const policy = require("../../src/helpers/cloudChunkPolicy");
const { changeLanguage } = require("../../src/helpers/i18nMain");
const { createAbortError } = require("../../src/helpers/abortError");
const providerPolicy = require("../../src/helpers/providerChunkPolicy");

const modulePath = require.resolve("../../src/helpers/chunkedTranscription");
const originalLoad = Module._load;
let split;
let retryDelayMs = 1;
// Mock only process/transport boundaries. Exercise the real scheduler, merge,
// cancellation and filesystem cleanup; shorten retry waits and upload timeout.
Module._load = function (request, parent, isMain) {
  if (parent?.filename === modulePath) {
    if (request === "./debugLogger") return { warn() {} };
    if (request === "./ffmpegUtils") return { splitAudioFile: (...args) => split(...args) };
    if (request === "./cloudChunkPolicy") {
      return { ...policy, chunkRetryDelayMs: () => retryDelayMs, CLOUD_UPLOAD_TIMEOUT_MS: 200 };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { chunkedTranscribe } = require(modulePath);
test.after(() => {
  Module._load = originalLoad;
});
test.beforeEach(() => {
  changeLanguage("en");
  retryDelayMs = 1;
});

function fixture(t, count, duration = count * 240) {
  const directories = [];
  split = async (inputPath, dir, { signal, segmentDuration }) => {
    signal.throwIfAborted();
    assert.equal(segmentDuration, 240);
    directories.push(dir);
    const chunkPaths = Array.from({ length: count }, (_, index) => {
      const chunkPath = path.join(dir, `chunk-${index}.mp3`);
      fs.writeFileSync(chunkPath, String(index));
      return chunkPath;
    });
    return { chunkPaths, durationSeconds: duration };
  };
  t.after(() => {
    for (const dir of directories)
      assert.equal(fs.existsSync(dir), false, "temporary chunks cleaned");
  });
  return { filePath: "source.mp3" };
}

test("parallel jobs share five slots and merge out-of-order replies in source order", async (t) => {
  const options = fixture(t, 8);
  let active = 0;
  let peak = 0;
  const progress = [];
  const transcribe = async (_, { index }) => {
    peak = Math.max(peak, ++active);
    await delay(index % 2 ? 1 : 10);
    active--;
    return { text: String(index), segments: [{ text: String(index), start: 1, end: 2 }] };
  };
  const results = await Promise.all([
    chunkedTranscribe({
      ...options,
      mergeSegments: true,
      transcribe,
      onProgress: (p) => progress.push(p),
    }),
    chunkedTranscribe({ ...options, mergeSegments: true, transcribe }),
  ]);
  assert.equal(peak, 5);
  for (const result of results) {
    assert.equal(result.text, "0 1 2 3 4 5 6 7");
    assert.deepEqual(
      result.segments.map((s) => s.start),
      [1, 241, 481, 721, 961, 1201, 1441, 1681]
    );
    assert.equal(result.durationSeconds, 1920);
  }
  assert.deepEqual(progress.at(-1), { stage: "transcribing", chunksTotal: 8, chunksCompleted: 8 });
});

test("provider 429/5xx retry, deterministic errors leave marked gaps without shifting timestamps", async (t) => {
  const options = fixture(t, 3);
  const attempts = [0, 0, 0];
  const progress = [];
  const result = await chunkedTranscribe({
    ...options,
    mergeSegments: true,
    isTransientError: providerPolicy.isTransientProviderChunkError,
    onProgress: (p) => progress.push(p),
    transcribe: async (_, { index }) => {
      attempts[index]++;
      if (index === 0 && attempts[index] < 3)
        throw Object.assign(new Error("retry"), { status: attempts[index] === 1 ? 429 : 503 });
      if (index === 1) throw Object.assign(new Error("bad request"), { status: 400 });
      return { text: `part ${index}`, segments: [{ text: "words", start: 2, end: 3 }] };
    },
  });
  assert.deepEqual(attempts, [3, 1, 1]);
  assert.equal(result.failedChunks, 1);
  assert.equal(result.totalChunks, 3);
  assert.match(result.text, /part 0.*4:00.*8:00.*part 2/);
  assert.deepEqual(
    result.segments.map((s) => s.start),
    [2, 482]
  );
  assert.equal(progress.at(-1).chunksCompleted, 3);
});

test("cloud assembly preserves server text and ignores provider-only metadata", async (t) => {
  const options = fixture(t, 2);
  const result = await chunkedTranscribe({
    ...options,
    transcribe: async (_, { index }) => ({
      text: `cloud\n ${index}`,
      diarized: true,
      segments: "opaque server metadata",
    }),
  });
  assert.equal(result.text, "cloud 0 cloud 1");
  assert.equal(result.segments, undefined);
  assert.equal(result.diarized, undefined);
  assert.equal(result.responses.length, 2);
  assert.equal(result.lastResponse, result.responses[1]);
});

test("a closed progress listener cannot clean up chunks while siblings are still uploading", async (t) => {
  const options = fixture(t, 3);
  const result = await chunkedTranscribe({
    ...options,
    onProgress: () => {
      throw new Error("Object has been destroyed");
    },
    transcribe: async (file, { index }) => {
      await delay(index * 10);
      assert.ok(fs.existsSync(file), "chunk remains until its upload settles");
      return { text: `part ${index}` };
    },
  });
  assert.equal(result.text, "part 0 part 1 part 2");
  assert.equal(result.warning, undefined);
});

test("cloud pool recovery still refunds collateral failures without changing retry limits", async (t) => {
  const options = fixture(t, 2);
  let generation = 0;
  const recovered = Promise.withResolvers();
  const attempts = [0, 0];
  const recoveries = [];
  const result = await chunkedTranscribe({
    ...options,
    connectionPool: {
      generation: () => generation,
      recover: async (force) => {
        recoveries.push(force);
        generation++;
        recovered.resolve();
      },
    },
    transcribe: async (_, { index }) => {
      const attempt = ++attempts[index];
      if (index === 0 && attempt === 1) throw new Error("net::ERR_HTTP2_PROTOCOL_ERROR");
      if (index === 1) {
        if (attempt === 1) {
          await recovered.promise;
          throw new Error("net::ERR_ABORTED");
        }
        if (attempt <= 3) throw Object.assign(new Error("server busy"), { statusCode: 503 });
      }
      return { text: `cloud ${index}` };
    },
  });
  assert.equal(result.text, "cloud 0 cloud 1");
  assert.deepEqual(attempts, [2, 4], "collateral retry does not consume a server retry");
  assert.deepEqual(recoveries, [true], "only the poisoned connection resets the cloud pool");
});

test("cancelling during retry backoff starts no further upload", async (t) => {
  const options = fixture(t, 1);
  retryDelayMs = 1000;
  const controller = new AbortController();
  let attempts = 0;
  const result = chunkedTranscribe({
    ...options,
    signal: controller.signal,
    transcribe: async () => {
      attempts++;
      setImmediate(() => controller.abort());
      throw Object.assign(new Error("server busy"), { statusCode: 503 });
    },
  });
  await assert.rejects(result, { code: "UPLOAD_CANCELLED" });
  assert.equal(attempts, 1);
});

test("a per-attempt timeout retries a chunk without cancelling the whole job", async (t) => {
  const options = fixture(t, 1);
  let attempts = 0;
  const result = await chunkedTranscribe({
    ...options,
    transcribe: async (_, { signal }) => {
      if (++attempts === 1) await delay(1000, undefined, { signal });
      return { text: "recovered" };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.text, "recovered");
});

test("auth failures stop queued chunks and abort in-flight siblings", async (t) => {
  const options = fixture(t, 12);
  let started = 0;
  const error = Object.assign(new Error("bad key"), { code: "PROVIDER_AUTH_FAILED" });
  await assert.rejects(
    chunkedTranscribe({
      ...options,
      isFatalError: providerPolicy.isFatalProviderChunkError,
      transcribe: async (_, { index, signal }) => {
        started++;
        if (index === 0) throw error;
        await delay(1000, undefined, { signal });
        return { text: "must not complete" };
      },
    }),
    (err) => err === error
  );
  assert.ok(started <= 5);
});

test("cloud quota errors remain fatal instead of being treated as provider rate limits", async (t) => {
  const options = fixture(t, 8);
  const error = Object.assign(new Error("quota"), { code: "LIMIT_REACHED" });
  await assert.rejects(
    chunkedTranscribe({
      ...options,
      transcribe: async () => {
        throw error;
      },
    }),
    (err) => err === error
  );
});

test("more than half lost fails; silence does not count as loss", async (t) => {
  const options = fixture(t, 3);
  await assert.rejects(
    chunkedTranscribe({
      ...options,
      transcribe: async (_, { index }) => {
        if (index < 2) throw Object.assign(new Error("bad chunk"), { statusCode: 400 });
        return { text: "survivor" };
      },
    }),
    { code: "CHUNK_LOSS_EXCEEDED" }
  );
  const result = await chunkedTranscribe({
    ...options,
    transcribe: async (_, { index }) => {
      if (index < 2) throw Object.assign(new Error("silent"), { code: "NO_SPEECH_DETECTED" });
      return { text: "survivor" };
    },
  });
  assert.equal(result.text, "survivor");
  assert.equal(result.warning, undefined);
});

test("all-silent and all-failed jobs cannot return a successful empty note", async (t) => {
  const options = fixture(t, 2);
  await assert.rejects(
    chunkedTranscribe({
      ...options,
      transcribe: async () => {
        throw Object.assign(new Error("silent"), { code: "NO_SPEECH_DETECTED" });
      },
    }),
    { code: "NO_SPEECH_DETECTED" }
  );
  await assert.rejects(
    chunkedTranscribe({
      ...options,
      transcribe: async () => {
        throw Object.assign(new Error("failed"), { statusCode: 400 });
      },
    }),
    /All chunks failed/
  );
});

test("cancel aborts active uploads, stops queued requests and removes temporary audio", async (t) => {
  const options = fixture(t, 10);
  const controller = new AbortController();
  let started = 0;
  const result = chunkedTranscribe({
    ...options,
    signal: controller.signal,
    transcribe: async (_, { signal }) => {
      if (++started === 5) controller.abort();
      await delay(1000, undefined, { signal });
      return { text: "late" };
    },
  });
  await assert.rejects(result, { code: "UPLOAD_CANCELLED" });
  assert.equal(started, 5);
});

test("split failures remove even partially written chunks and temporary buffer input", async () => {
  let directory;
  let temporaryInput;
  split = async (input, dir, { signal }) => {
    directory = dir;
    temporaryInput = input;
    fs.writeFileSync(path.join(dir, "partial.mp3"), "partial");
    if (signal.aborted) throw createAbortError();
    throw new Error("ffmpeg failed");
  };
  await assert.rejects(
    chunkedTranscribe({ buffer: Buffer.from("audio"), transcribe: async () => assert.fail() }),
    /ffmpeg failed/
  );
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(temporaryInput), false);
});

test("cancellation during splitting cleans up without starting uploads", async () => {
  const controller = new AbortController();
  let directory;
  split = async (_, dir, { signal }) => {
    directory = dir;
    fs.writeFileSync(path.join(dir, "partial.mp3"), "partial");
    controller.abort();
    signal.throwIfAborted();
  };
  await assert.rejects(
    chunkedTranscribe({
      filePath: "audio.mp3",
      signal: controller.signal,
      transcribe: async () => assert.fail("cancelled split must not upload"),
    }),
    { name: "AbortError" }
  );
  assert.equal(fs.existsSync(directory), false);
});
