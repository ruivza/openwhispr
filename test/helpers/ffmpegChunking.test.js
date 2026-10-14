const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadWithMockLogger } = require("./harness/mockDebugLogger");
const { getFFmpegPath, splitAudioFile, convertToWav, parseWavFormat } = loadWithMockLogger(
  require.resolve("../../src/helpers/ffmpegUtils")
);
const ffmpeg = getFFmpegPath();

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-split-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test(
  "real FFmpeg splits long audio into four-minute mono MP3s below the request cap",
  { skip: !ffmpeg },
  async (t) => {
    const dir = fixtureDir(t);
    const input = path.join(dir, "source.wav");
    const output = path.join(dir, "chunks");
    fs.mkdirSync(output);
    execFileSync(
      ffmpeg,
      [
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=500",
        "-ar",
        "16000",
        "-ac",
        "1",
        input,
      ],
      { windowsHide: true }
    );
    const { chunkPaths, durationSeconds } = await splitAudioFile(input, output, {
      segmentDuration: 240,
    });
    assert.equal(chunkPaths.length, 3);
    assert.equal(durationSeconds, 500);
    let decodedSeconds = 0;
    for (const [index, chunk] of chunkPaths.entries()) {
      assert.ok(fs.statSync(chunk).size < 4 * 1024 * 1024);
      const wav = path.join(dir, `decoded-${index}.wav`);
      await convertToWav(chunk, wav, { sampleRate: 16000, channels: 1 });
      const format = parseWavFormat(fs.readFileSync(wav));
      assert.equal(format.channels, 1);
      assert.equal(format.sampleRate, 16000);
      decodedSeconds += (fs.statSync(wav).size - 44) / 32000;
    }
    assert.ok(Math.abs(decodedSeconds - 500) < 0.5, `decoded ${decodedSeconds}s`);
    assert.ok(fs.existsSync(input));
  }
);

test("video splitting strips the video stream", { skip: !ffmpeg }, async (t) => {
  const dir = fixtureDir(t);
  const input = path.join(dir, "source.mp4");
  const output = path.join(dir, "chunks");
  fs.mkdirSync(output);
  execFileSync(
    ffmpeg,
    [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=5:size=64x64:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      "-shortest",
      input,
    ],
    { windowsHide: true }
  );
  const { chunkPaths } = await splitAudioFile(input, output, { segmentDuration: 2 });
  assert.equal(chunkPaths.length, 3);
  assert.ok(chunkPaths.every((file) => path.extname(file) === ".mp3"));
});

test(
  "cancelling FFmpeg waits for exit before callers remove its output directory",
  { skip: !ffmpeg },
  async (t) => {
    const dir = fixtureDir(t);
    const input = path.join(dir, "source.wav");
    const output = path.join(dir, "chunks");
    fs.mkdirSync(output);
    execFileSync(
      ffmpeg,
      [
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=100",
        "-ar",
        "16000",
        "-ac",
        "1",
        input,
      ],
      { windowsHide: true }
    );
    const controller = new AbortController();
    const result = splitAudioFile(input, output, { segmentDuration: 2, signal: controller.signal });
    let settled = false;
    result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    controller.abort();
    await Promise.resolve();
    assert.equal(settled, false, "abort must wait for the process close event");
    await assert.rejects(result, { name: "AbortError" });
    fs.rmSync(output, { recursive: true });
    assert.equal(fs.existsSync(output), false);
  }
);
