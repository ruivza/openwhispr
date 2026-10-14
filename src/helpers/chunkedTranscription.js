const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { createAbortError } = require("./abortError");
const { mergeChunkResponses } = require("./uploadTimestamps");
const {
  CLOUD_UPLOAD_TIMEOUT_MS,
  CLOUD_CHUNK_MAX_ATTEMPTS,
  CLOUD_CHUNK_GLOBAL_CONCURRENCY,
  CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS,
  CLOUD_CHUNK_MAX_LOSS_RATIO,
  SILENT_CHUNK,
  FATAL_CHUNK_CODES,
  isTransientChunkError,
  isNetworkLevelFailure,
  isConnectionPoisoningFailure,
  isTeardownCollateral,
  summarizeChunkResults,
  assembleChunkTranscript,
  chunkRetryDelayMs,
  abortableSleep,
  createUploadSlots,
} = require("./cloudChunkPolicy");

// Shared across cloud and provider jobs; retries never hold a slot during backoff.
const uploadSlots = createUploadSlots(CLOUD_CHUNK_GLOBAL_CONCURRENCY);

// The caller owns the endpoint/authentication; this pipeline owns splitting,
// bounded parallelism, retries, ordered assembly, cancellation and cleanup.
async function chunkedTranscribe({
  buffer = null,
  filePath = null,
  transcribe,
  isTransientError = isTransientChunkError,
  isFatalError = (err) => FATAL_CHUNK_CODES.has(err.code),
  connectionPool = null,
  mergeSegments = false,
  onProgress,
  signal,
  segmentDuration = 240,
}) {
  const { splitAudioFile } = require("./ffmpegUtils");

  // Aborted by the caller cancelling or by the first fatal chunk error, so a
  // doomed job stops uploading its remaining chunks immediately.
  const jobController = new AbortController();
  const { signal: jobSignal } = jobController;
  const abortJob = () => jobController.abort();
  signal?.addEventListener("abort", abortJob, { once: true });
  if (signal?.aborted) abortJob();

  const jobId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const chunkDir = path.join(os.tmpdir(), `ow-chunks-${jobId}`);
  let tmpInputPath = null;
  const reportProgress = (progress) => {
    try {
      onProgress?.(progress);
    } catch (error) {
      // A closed renderer must not reject Promise.all early and remove files
      // while sibling uploads still own them.
      debugLogger.warn("Unable to report chunk progress", { error: error.message });
    }
  };

  try {
    jobSignal.throwIfAborted();
    let inputPath = filePath;
    if (!inputPath && buffer) {
      tmpInputPath = path.join(os.tmpdir(), `ow-audio-${jobId}.webm`);
      fs.writeFileSync(tmpInputPath, buffer);
      inputPath = tmpInputPath;
    }
    fs.mkdirSync(chunkDir, { recursive: true });
    reportProgress({ stage: "splitting", chunksTotal: 0, chunksCompleted: 0 });

    const { chunkPaths, durationSeconds } = await splitAudioFile(inputPath, chunkDir, {
      segmentDuration,
      signal: jobSignal,
    });
    const totalChunks = chunkPaths.length;

    reportProgress({ stage: "transcribing", chunksTotal: totalChunks, chunksCompleted: 0 });

    const results = new Array(totalChunks).fill(null);
    let fatalError = null;
    let completedCount = 0;

    const transcribeChunk = async (index) => {
      let attempt = 1;
      let teardownRefunds = CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS;
      while (true) {
        if (jobSignal.aborted) throw createAbortError();

        // Held only while a body is on the wire, so the backoff below never
        // occupies a slot and queue time never eats the upload timeout.
        const releaseSlot = await uploadSlots.acquire(jobSignal);
        const timeoutSignal = AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS);
        const teardownsAtStart = connectionPool?.generation() ?? 0;
        let failure = null;
        let timedOut = false;
        let collateral = false;
        try {
          try {
            jobSignal.throwIfAborted();
            results[index] = await transcribe(chunkPaths[index], {
              signal: AbortSignal.any([jobSignal, timeoutSignal]),
              index,
            });
          } catch (err) {
            failure = err;
            // Abort before releasing the slot, so queued siblings cannot
            // start another billable request after an auth/quota failure.
            if (isFatalError(err)) {
              fatalError ??= err;
              abortJob();
            }
            timedOut = timeoutSignal.aborted;
            collateral = isTeardownCollateral(err, {
              timedOut,
              teardownsDuringAttempt: (connectionPool?.generation() ?? 0) - teardownsAtStart,
            });
            // Drop the pool while still holding the slot — released first, a
            // queued sibling is admitted onto the pool microseconds before
            // closeAllConnections() kills it and burns an attempt it never
            // owned. A fatal TLS/protocol alert proves the pool is poisoned,
            // so that drop is forced through the cooldown gate.
            if (connectionPool && !jobSignal.aborted && !collateral) {
              const poisoned = isConnectionPoisoningFailure(err);
              if (poisoned || isNetworkLevelFailure(err, { timedOut })) {
                await connectionPool.recover(poisoned);
              }
            }
          }
        } finally {
          releaseSlot();
        }
        if (!failure) break;

        if (failure.code === "NO_SPEECH_DETECTED") {
          results[index] = SILENT_CHUNK;
          break;
        }

        if (jobSignal.aborted) throw createAbortError();
        if (collateral && teardownRefunds > 0) {
          teardownRefunds--;
          debugLogger.warn(`Chunk ${index} attempt ${attempt} killed by pool teardown, refunded`, {
            error: failure.message,
          });
          await abortableSleep(chunkRetryDelayMs(1), jobSignal);
          continue;
        }
        if (attempt >= CLOUD_CHUNK_MAX_ATTEMPTS || !(timedOut || isTransientError(failure))) {
          throw failure;
        }
        debugLogger.warn(`Chunk ${index} attempt ${attempt} failed, retrying`, {
          error: failure.message,
          timedOut,
        });
        await abortableSleep(chunkRetryDelayMs(attempt), jobSignal);
        attempt++;
      }
    };

    await Promise.all(
      chunkPaths.map((_, index) =>
        transcribeChunk(index)
          .catch((err) => {
            // Only aborts the job itself caused, reported once below. A chunk's
            // own upload timeout also aborts, and that is a real failure.
            if (jobSignal.aborted && err.name === "AbortError") return;
            if (isFatalError(err)) {
              fatalError ??= err;
              abortJob();
              return;
            }
            debugLogger.warn(`Chunk ${index} failed`, { error: err.message, code: err.code });
          })
          .finally(() => {
            if (jobSignal.aborted) return;
            completedCount++;
            reportProgress({
              stage: "transcribing",
              chunksTotal: totalChunks,
              chunksCompleted: completedCount,
            });
          })
      )
    );

    if (signal?.aborted) {
      throw Object.assign(createAbortError("Upload cancelled"), { code: "UPLOAD_CANCELLED" });
    }
    if (fatalError) throw fatalError;

    const { responses, failedChunks: failed, silentChunks } = summarizeChunkResults(results);
    if (responses.length === 0) {
      if (silentChunks === totalChunks) {
        throw Object.assign(new Error("No speech detected in audio"), {
          code: "NO_SPEECH_DETECTED",
        });
      }
      throw new Error("All chunks failed to transcribe");
    }

    if (failed / totalChunks > CLOUD_CHUNK_MAX_LOSS_RATIO) {
      throw Object.assign(new Error(`${failed} of ${totalChunks} audio segments were lost`), {
        code: "CHUNK_LOSS_EXCEEDED",
      });
    }

    // Cloud keeps its original text-only assembly. Provider metadata is opt-in.
    const merged = mergeSegments
      ? mergeChunkResponses(results, segmentDuration)
      : { results, metadata: {}, diarized: false };
    const text = assembleChunkTranscript(merged.results, segmentDuration, durationSeconds, {
      preserveFormatting: merged.diarized,
    });
    return {
      text,
      ...merged.metadata,
      durationSeconds,
      responses,
      lastResponse: responses[responses.length - 1],
      ...(failed > 0
        ? {
            warning: `${failed} of ${totalChunks} chunks failed`,
            failedChunks: failed,
            totalChunks,
          }
        : {}),
    };
  } finally {
    signal?.removeEventListener("abort", abortJob);
    if (tmpInputPath) {
      try {
        fs.unlinkSync(tmpInputPath);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      debugLogger.warn("Failed to cleanup chunk dir", { error: cleanupErr.message });
    }
  }
}

module.exports = { chunkedTranscribe };
