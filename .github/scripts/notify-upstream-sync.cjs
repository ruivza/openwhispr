const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const REPOSITORY = "ruivza/openwhispr";
const UPSTREAM_REPOSITORY = "OpenWhispr/openwhispr";
const ISSUE_MARKER = "<!-- openwhispr-upstream-sync -->";
const ISSUE_TITLE = "上游自动同步需要处理";
const SUCCESS = new Set(["synced", "up_to_date"]);
const ATTENTION = new Set(["conflict", "blocked", "failed"]);

function clean(value, limit = 6000) {
  return String(value ?? "")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
    .slice(0, limit);
}

function notificationKey(result) {
  if (/^[a-f0-9]{40}$/i.test(result.upstreamSha || "")) return result.upstreamSha.toLowerCase();
  return `unknown-${createHash("sha256").update(clean(result.summary)).digest("hex")}`;
}

function keyMarker(result) {
  return `<!-- openwhispr-upstream-sync:${notificationKey(result)} -->`;
}

function issueBody(result, runUrl) {
  const lines = [
    ISSUE_MARKER,
    keyMarker(result),
    "@ruivza，上游自动同步需要处理；main 未因这次失败更新。",
    "",
    `状态：${clean(result.status)}`,
    "",
    clean(result.summary || "同步未完成，请查看工作流日志。"),
  ];
  if (/^[a-f0-9]{40}$/i.test(result.upstreamSha || "")) {
    lines.push(
      "",
      `上游：[${result.upstreamSha}](https://github.com/${UPSTREAM_REPOSITORY}/commit/${result.upstreamSha})`
    );
  }
  if (/^[a-f0-9]{40}$/i.test(result.baseSha || "")) lines.push(`原 fork 提交：${result.baseSha}`);
  if (typeof result.version === "string") lines.push(`保留的 fork 版本：${clean(result.version)}`);
  if (Array.isArray(result.conflicts) && result.conflicts.length) {
    lines.push(
      "",
      "冲突文件：",
      ...result.conflicts.slice(0, 100).map((file) => `- ${clean(file, 300)}`)
    );
  }
  if (Array.isArray(result.details) && result.details.length) {
    lines.push(
      "",
      "详情：",
      ...result.details.slice(0, 30).map((detail) => `- ${clean(detail, 500)}`)
    );
  }
  if (runUrl) lines.push("", `[工作流日志](${runUrl})`);
  return lines.join("\n");
}

async function findIssue(api) {
  for (let page = 1; ; page++) {
    const issues = await api(
      "GET",
      `/repos/${REPOSITORY}/issues?state=all&per_page=100&page=${page}`
    );
    if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid issue list.");
    const issue = issues.find((item) => !item.pull_request && item.body?.includes(ISSUE_MARKER));
    if (issue) return issue;
    if (issues.length < 100) return null;
  }
}

async function hasComment(api, number, marker) {
  for (let page = 1; ; page++) {
    const comments = await api(
      "GET",
      `/repos/${REPOSITORY}/issues/${number}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(comments)) throw new Error("GitHub returned an invalid comment list.");
    if (comments.some((comment) => comment.body?.includes(marker))) return true;
    if (comments.length < 100) return false;
  }
}

async function notifySyncResult(result, { api, runUrl = "" }) {
  if (!SUCCESS.has(result.status) && !ATTENTION.has(result.status)) {
    throw new Error(`Unknown synchronization status: ${clean(result.status, 100)}`);
  }
  if (result.dryRun) return "dry_run";
  const issue = await findIssue(api);
  if (SUCCESS.has(result.status)) {
    if (issue?.state === "open") {
      await api("PATCH", `/repos/${REPOSITORY}/issues/${issue.number}`, { state: "closed" });
      return "closed";
    }
    return "unchanged";
  }

  const body = issueBody(result, runUrl);
  if (!issue) {
    await api("POST", `/repos/${REPOSITORY}/issues`, {
      title: ISSUE_TITLE,
      body,
      assignees: ["ruivza"],
    });
    return "created";
  }
  const marker = keyMarker(result);
  if (issue.body.includes(marker)) {
    if (issue.state === "closed") {
      await api("PATCH", `/repos/${REPOSITORY}/issues/${issue.number}`, {
        body,
        state: "open",
        assignees: ["ruivza"],
      });
      return "reopened";
    }
    return "duplicate";
  }

  // Write the comment first. On a partial API failure, its marker prevents a
  // duplicate notification while the next run repairs the issue body/state.
  if (!(await hasComment(api, issue.number, marker))) {
    await api("POST", `/repos/${REPOSITORY}/issues/${issue.number}/comments`, { body });
  }
  await api("PATCH", `/repos/${REPOSITORY}/issues/${issue.number}`, {
    title: ISSUE_TITLE,
    body,
    state: "open",
    assignees: ["ruivza"],
  });
  return "updated";
}

function githubApi(token, fetchImpl = fetch) {
  if (!token) throw new Error("GH_TOKEN is required for synchronization issue notifications.");
  return async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub issue notification failed (HTTP ${response.status}). Check that repository Issues are enabled and GITHUB_TOKEN has issues:write.`
      );
    }
    return response.status === 204 ? null : response.json();
  };
}

async function main(env = process.env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Synchronization notifications only run on ruivza/openwhispr main.");
  }
  if (!env.UPSTREAM_SYNC_RESULT_PATH) throw new Error("UPSTREAM_SYNC_RESULT_PATH is required.");
  const result = JSON.parse(readFileSync(env.UPSTREAM_SYNC_RESULT_PATH, "utf8"));
  const runUrl = /^\d+$/.test(env.GITHUB_RUN_ID || "")
    ? `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : "";
  const action = await notifySyncResult(result, { api: githubApi(env.GH_TOKEN), runUrl });
  console.log(`Upstream synchronization issue: ${action}`);
}

module.exports = { ISSUE_MARKER, githubApi, issueBody, keyMarker, notifySyncResult };
if (require.main === module) {
  main().catch((error) => {
    console.error(clean(error.message));
    process.exitCode = 1;
  });
}
