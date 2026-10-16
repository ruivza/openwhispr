const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  deriveNextVersion,
  parseOfficialVersion,
  setVersionMetadata,
} = require("./upstream-version.cjs");

const REPOSITORY = "ruivza/openwhispr";
const UPSTREAM = "OpenWhispr/openwhispr";

function redact(value) {
  let text = String(value || "");
  for (const token of [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(Boolean)) {
    text = text.split(token).join("[REDACTED]");
    text = text.split(Buffer.from(`x-access-token:${token}`).toString("base64")).join("[REDACTED]");
  }
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]");
}

function command(program, args, cwd, env = process.env, allowedFailure = false) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowedFailure && (result.error || result.status !== 0)) {
    throw new Error(
      redact(result.stderr || result.stdout || result.error?.message || `${program} failed`)
    );
  }
  return result;
}

function validationEnvironment() {
  const env = { ...process.env, CI: "true", ELECTRON_OVERRIDE_DIST_PATH: os.tmpdir() };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|^GIT_CONFIG_/i.test(key)) delete env[key];
  }
  return env;
}

async function verifyCandidate(root, { git, originalSha }) {
  const env = validationEnvironment();
  // Install locked test dependencies only. No lifecycle scripts, native app
  // builds, model downloads, signing, tags, releases or workflow dispatches.
  command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root, env);
  command(
    process.execPath,
    [path.join(__dirname, "validate-upstream-candidate.cjs"), root],
    root,
    env
  );
  const tests = [
    "test/helpers/forkServiceConfig.test.js",
    "test/helpers/forkLocalStartup.test.js",
    "test/services/analyticsService.test.js",
    "test/helpers/settingsStoreTelemetryDisabled.test.js",
    "test/helpers/updater.test.js",
    "test/helpers/forkProductHelpIpc.test.js",
    "test/scripts/verifyPackagedStartup.test.js",
  ];
  if (git(["diff", "--name-only", originalSha, "--", "openwhispr-mobile/"]).stdout.trim()) {
    tests.push(
      "openwhispr-mobile/scripts/__tests__/local-build.test.js",
      "openwhispr-mobile/scripts/__tests__/telemetry-disabled.test.js",
      "openwhispr-mobile/scripts/__tests__/unsigned-ios-config.test.js"
    );
  }
  command(process.execPath, ["--test", ...tests], root, env);
  for (const [directory, pattern] of [
    [".github/scripts", "test_publish_packages.py"],
    ["test/scripts", "macos_release_test.py"],
  ]) {
    command("python3", ["-m", "unittest", "discover", "-s", directory, "-p", pattern], root, env);
  }
}

function removeTemporaryCheckout(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("openwhispr-sync-")
  ) {
    throw new Error("Refusing to remove an unexpected temporary checkout");
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
}

async function syncUpstream(options = {}) {
  const {
    originUrl = `https://github.com/${REPOSITORY}.git`,
    upstreamUrl = `https://github.com/${UPSTREAM}.git`,
    dryRun = false,
    validate = verifyCandidate,
    beforePush,
    resultPath = process.env.UPSTREAM_SYNC_RESULT_PATH,
    token = process.env.GH_TOKEN,
  } = options;
  const result = { status: "failed", summary: "同步未完成，main 保持不变。", dryRun };
  let temporary;
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-sync-"));
    const hooks = path.join(temporary, "hooks");
    fs.mkdirSync(hooks);
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_CONFIG_COUNT: token ? "3" : "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooks,
      GIT_CONFIG_KEY_1: "commit.gpgsign",
      GIT_CONFIG_VALUE_1: "false",
    };
    if (token) {
      env.GIT_CONFIG_KEY_2 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_2 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    }
    const checkout = path.join(temporary, "checkout");
    // Upstream-only blobs must not be fetched lazily from the fork's promisor remote.
    command(
      "git",
      [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        "--single-branch",
        "--branch",
        "main",
        originUrl,
        checkout,
      ],
      temporary,
      env
    );
    const git = (args, allowFailure = false) => command("git", args, checkout, env, allowFailure);
    git(["checkout", "main"]);
    git(["config", "user.name", "github-actions[bot]"]);
    git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    const originalSha = git(["rev-parse", "HEAD"]).stdout.trim();
    result.baseSha = originalSha;
    git(["fetch", "--no-tags", upstreamUrl, "+refs/heads/main:refs/remotes/upstream/main"]);
    const upstreamSha = git(["rev-parse", "refs/remotes/upstream/main"]).stdout.trim();
    result.upstreamSha = upstreamSha;
    const alreadyMerged = git(["merge-base", "--is-ancestor", upstreamSha, originalSha], true);
    if (alreadyMerged.status === 0) {
      result.status = "up_to_date";
      result.summary = "官方 main 没有尚未同步的提交。";
      return result;
    }
    if (alreadyMerged.status !== 1) throw new Error("Unable to compare upstream history");
    const bases = git(["merge-base", "--all", originalSha, upstreamSha]).stdout.trim().split(/\s+/);
    if (bases.length !== 1 || !/^[a-f0-9]{40}$/.test(bases[0]))
      throw new Error("A unique common merge base is required");
    const readAt = (sha, file) => JSON.parse(git(["show", `${sha}:${file}`]).stdout);
    const forkVersion = readAt(originalSha, "package.json").version;
    const upstreamVersion = readAt(upstreamSha, "package.json").version;
    const baseVersion = readAt(bases[0], "package.json").version;
    parseOfficialVersion(baseVersion);
    const version = deriveNextVersion(forkVersion, upstreamVersion);
    result.version = version;

    // Normalize only version fields so an official version bump does not create
    // a mechanical conflict. This temporary commit never enters main's history.
    const normalized = setVersionMetadata(checkout, baseVersion);
    if (normalized.changedFiles.length) {
      git(["add", "--", ...normalized.changedFiles]);
      git(["commit", "-m", "Temporary version normalization"]);
    }
    const merged = git(["merge", "--no-commit", "--no-ff", upstreamSha], true);
    if (merged.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U", "-z"])
        .stdout.split("\0")
        .filter(Boolean);
      if (!conflicts.length) throw new Error(redact(merged.stderr || merged.stdout));
      result.status = "conflict";
      result.summary = "上游合并存在冲突，未修改 main。";
      result.conflicts = conflicts;
      return result;
    }
    if (git(["rev-parse", "MERGE_HEAD"]).stdout.trim() !== upstreamSha)
      throw new Error("Unexpected merge state");
    setVersionMetadata(checkout, version);
    const mobileChanges = git([
      "diff",
      "--name-only",
      originalSha,
      "--",
      "openwhispr-mobile/",
    ]).stdout.trim();
    if (mobileChanges) {
      const helper = require("./upstream-version.cjs");
      if (helper.deriveMobileVersion && helper.setMobileVersionMetadata) {
        const previous = readAt(originalSha, "openwhispr-mobile/config/fork-version.json");
        const official = readAt(upstreamSha, "openwhispr-mobile/app.base.json").expo.version;
        const next = helper.deriveMobileVersion(previous, official);
        helper.setMobileVersionMetadata(checkout, next.upstreamVersion, next.revision);
      } else {
        throw new Error("Mobile fork version safeguards are unavailable");
      }
    }
    // Upstream additions are already staged by merge. Stage tracked version
    // edits only; never publish dependency installs or generated test files.
    git(["add", "-u"]);
    const tree = git(["write-tree"]).stdout.trim();
    await validate(checkout, { git, originalSha, upstreamSha });
    if (git(["diff", "--quiet"], true).status !== 0 || git(["write-tree"]).stdout.trim() !== tree) {
      throw new Error("Candidate checks changed tracked files or the merge index");
    }
    // Only the original fork and real upstream commits are parents. The fork's
    // commits remain ancestors; no reset, squash, rebase, force push or tag.
    const message = `chore: sync official main ${upstreamSha.slice(0, 12)} (${version}) [skip ci]`;
    const commit = git([
      "commit-tree",
      tree,
      "-p",
      originalSha,
      "-p",
      upstreamSha,
      "-m",
      message,
    ]).stdout.trim();
    result.commit = commit;
    if (!dryRun) {
      if (beforePush) await beforePush({ checkout, git, result });
      const latest = git(["ls-remote", "--heads", "origin", "refs/heads/main"]).stdout.split(
        /\s+/
      )[0];
      if (latest !== originalSha) {
        result.status = "blocked";
        result.summary = "同步期间 main 已有新提交；保留它们并等待下一次同步。";
        return result;
      }
      const pushed = git(["push", "origin", `${commit}:refs/heads/main`], true);
      if (pushed.status !== 0) {
        result.status = "blocked";
        result.summary = "GitHub 拒绝同步推送，main 未被覆盖。请检查仓库保护或工作流写入权限。";
        result.details = redact(pushed.stderr || pushed.stdout)
          .trim()
          .split("\n")
          .slice(-12);
        return result;
      }
    }
    result.status = "synced";
    result.summary = dryRun
      ? "候选合并和检查通过；预览模式没有推送。"
      : "已合并官方 main，保留 fork 修改和版本规则，跳过自动打包发布。";
    return result;
  } catch (error) {
    result.status = "failed";
    result.details = [redact(error.message).slice(-10000)];
    return result;
  } finally {
    if (temporary) {
      try {
        removeTemporaryCheckout(temporary);
      } catch (error) {
        // A cleanup error must never obscure whether main was already updated.
        result.details = [
          ...(result.details || []),
          redact(`Temporary checkout cleanup: ${error.message}`),
        ];
      }
    }
    if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run"))
    throw new Error("Usage: node sync-upstream.cjs [--dry-run]");
  const dryRun = args.includes("--dry-run");
  if (
    !dryRun &&
    (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== "refs/heads/main")
  ) {
    throw new Error("Automatic synchronization is restricted to ruivza/openwhispr main");
  }
  const result = await syncUpstream({ dryRun });
  console.log(JSON.stringify(result));
  if (!["synced", "up_to_date"].includes(result.status)) process.exitCode = 1;
}

if (require.main === module)
  main().catch((error) => {
    console.error(redact(error.message));
    process.exitCode = 1;
  });
module.exports = { syncUpstream, verifyCandidate, redact };
