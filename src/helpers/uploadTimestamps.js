// Which extra multipart fields ask a BYOK transcription provider for
// segment-level timestamps, and how its verbose response maps back to
// segments. Gated per provider/model because unsupported combinations
// (gpt-4o-transcribe rejects verbose_json; custom/self-hosted servers may
// 400 on unknown fields) must keep the plain-text request untouched — a
// missing timestamp is a degraded export, never a failed upload.
function timestampRequestFields(provider, model) {
  if (provider === "openai" && model === "whisper-1") {
    return { response_format: "verbose_json" };
  }
  if (provider === "groq") {
    return { response_format: "verbose_json" };
  }
  if (provider === "mistral") {
    return { timestamp_granularities: "segment" };
  }
  return null;
}

// verbose_json (OpenAI/Groq) and Mistral's segment granularity both carry
// `segments: [{ text, start, end }]`. Null when the response has nothing
// usable, so callers fall back to the plain transcript.
function mapVerboseSegments(responseData) {
  const segments = responseData?.segments;
  if (!Array.isArray(segments)) return null;

  const mapped = [];
  for (const seg of segments) {
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!text || !Number.isFinite(seg.start)) continue;
    const start = Math.max(0, seg.start);
    const rawEnd = Number.isFinite(seg.end) ? seg.end : start;
    const end = Math.max(start, rawEnd);
    mapped.push({
      text,
      start,
      end,
    });
  }
  return mapped.length ? mapped : null;
}

// Each request starts its timestamps and speaker identities at zero. Offset
// timings by the ORIGINAL chunk index (including missing/silent chunks), and
// keep independently inferred speakers distinct across requests.
function mergeChunkResponses(results, segmentDuration) {
  const { formatTimestamp } = require("./speakerMerge");
  const { i18nMain } = require("./i18nMain");
  const segments = [];
  let nextSpeaker = 1;
  let diarized = false;
  let plainResponses = false;
  let completeTimestamps = true;
  const shifted = results.map((response, index) => {
    if (!response || typeof response !== "object") return response;
    const speakers = new Map();
    const chunkSegments = (Array.isArray(response.segments) ? response.segments : []).map((seg) => {
      const shiftedSegment = {
        ...seg,
        start: seg.start + index * segmentDuration,
        end: seg.end + index * segmentDuration,
      };
      if (response.diarized && seg.speaker) {
        if (!speakers.has(seg.speaker)) {
          speakers.set(seg.speaker, i18nMain.t("notes.speaker.label", { n: nextSpeaker++ }));
        }
        shiftedSegment.speaker = speakers.get(seg.speaker);
      }
      return shiftedSegment;
    });
    if (!chunkSegments.length && response.text?.trim()) completeTimestamps = false;
    segments.push(...chunkSegments);
    if (!response.diarized || !chunkSegments.length) {
      plainResponses = true;
      return response;
    }
    diarized = true;
    return {
      ...response,
      text: chunkSegments
        .map(
          (seg) =>
            `[${seg.speaker}] ${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}\n${seg.text}`
        )
        .join("\n\n"),
    };
  });
  return {
    results: shifted,
    diarized,
    metadata: {
      // A partial timestamp list would make the Transcript tab and exports
      // silently omit successfully transcribed chunks. Keep the full note text.
      ...(completeTimestamps && segments.length ? { segments } : {}),
      ...(diarized ? { diarized: true, diarizationWarning: plainResponses } : {}),
    },
  };
}

module.exports = { timestampRequestFields, mapVerboseSegments, mergeChunkResponses };
