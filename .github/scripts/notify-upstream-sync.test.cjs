const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ISSUE_MARKER,
  githubApi,
  keyMarker,
  notifySyncResult,
} = require("./notify-upstream-sync.cjs");

const result = {
  status: "conflict",
  upstreamSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  summary: "Merge conflict; main was preserved.",
  conflicts: ["package.json"],
};

function apiMock(responses) {
  const calls = [];
  return {
    calls,
    api: async (...args) => {
      calls.push(args);
      assert.ok(responses.length, `Unexpected API call: ${args[0]} ${args[1]}`);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("first failure creates one assigned issue and mentions its owner", async () => {
  const mock = apiMock([[], { number: 1 }]);
  assert.equal(await notifySyncResult(result, mock), "created");
  const [method, path, body] = mock.calls[1];
  assert.equal(method, "POST");
  assert.equal(path, "/repos/ruivza/openwhispr/issues");
  assert.deepEqual(body.assignees, ["ruivza"]);
  assert.ok(body.body.includes(ISSUE_MARKER));
  assert.ok(body.body.includes("@ruivza"));
  assert.ok(body.body.includes("package.json"));
});

test("same upstream SHA keeps an open issue unchanged without another comment", async () => {
  const mock = apiMock([
    [{ number: 1, state: "open", body: `${ISSUE_MARKER}\n${keyMarker(result)}` }],
  ]);
  assert.equal(await notifySyncResult(result, mock), "duplicate");
  assert.equal(mock.calls.length, 1);
});

test("same upstream SHA failing again reopens its closed issue without another comment", async () => {
  const mock = apiMock([
    [{ number: 1, state: "closed", body: `${ISSUE_MARKER}\n${keyMarker(result)}` }],
    {},
  ]);
  assert.equal(await notifySyncResult(result, mock), "reopened");
  assert.deepEqual(
    mock.calls.map(([method]) => method),
    ["GET", "PATCH"]
  );
  assert.equal(mock.calls[1][2].state, "open");
  assert.deepEqual(mock.calls[1][2].assignees, ["ruivza"]);
});

test("new upstream SHA comments once and updates the existing issue", async () => {
  const mock = apiMock([[{ number: 1, state: "closed", body: ISSUE_MARKER }], [], {}, {}]);
  assert.equal(await notifySyncResult(result, mock), "updated");
  assert.deepEqual(
    mock.calls.map(([method]) => method),
    ["GET", "GET", "POST", "PATCH"]
  );
  assert.equal(mock.calls[3][2].state, "open");
  assert.deepEqual(mock.calls[3][2].assignees, ["ruivza"]);
});

test("partial notification retries repair the issue without a duplicate comment", async () => {
  const mock = apiMock([
    [{ number: 1, state: "open", body: ISSUE_MARKER }],
    [{ body: keyMarker(result) }],
    {},
  ]);
  assert.equal(await notifySyncResult(result, mock), "updated");
  assert.deepEqual(
    mock.calls.map(([method]) => method),
    ["GET", "GET", "PATCH"]
  );
});

test("successful sync or up-to-date state closes an old issue without a comment", async () => {
  for (const status of ["synced", "up_to_date"]) {
    const mock = apiMock([[{ number: 1, state: "open", body: ISSUE_MARKER }], {}]);
    assert.equal(await notifySyncResult({ ...result, status }, mock), "closed");
    assert.deepEqual(mock.calls[1][2], { state: "closed" });
  }
});

test("no old issue or an already closed issue causes no write on success", async () => {
  for (const issues of [[], [{ number: 1, state: "closed", body: ISSUE_MARKER }]]) {
    const mock = apiMock([issues]);
    assert.equal(await notifySyncResult({ ...result, status: "synced" }, mock), "unchanged");
    assert.equal(mock.calls.length, 1);
  }
});

test("dry runs do not read or write issues", async () => {
  const mock = apiMock([]);
  assert.equal(await notifySyncResult({ ...result, dryRun: true }, mock), "dry_run");
  assert.equal(mock.calls.length, 0);
});

test("unknown result statuses fail before making API calls", async () => {
  const mock = apiMock([]);
  await assert.rejects(notifySyncResult({ ...result, status: "unexpected" }, mock), /Unknown/);
  assert.equal(mock.calls.length, 0);
});

test("GitHub API client uses authenticated fetch and never leaks the token on an error", async () => {
  const token = "ghp_mock_secret";
  const api = githubApi(token, async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/ruivza/openwhispr/issues");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(options.body), { title: "test" });
    return { ok: false, status: 410 };
  });
  await assert.rejects(
    api("POST", "/repos/ruivza/openwhispr/issues", { title: "test" }),
    (error) => {
      assert.match(error.message, /Issues are enabled/);
      assert.ok(!error.message.includes(token));
      return true;
    }
  );
});

test("notification state machine works through mocked fetch responses without network access", async () => {
  const calls = [];
  const responses = [
    { ok: true, status: 200, json: async () => [] },
    { ok: true, status: 201, json: async () => ({ number: 1 }) },
  ];
  const api = githubApi("ghp_mock_secret", async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length);
    return responses.shift();
  });
  assert.equal(
    await notifySyncResult(
      { ...result, status: "blocked", details: ["Token ghp_secret_should_be_redacted"] },
      { api }
    ),
    "created"
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "POST");
  const body = JSON.parse(calls[1].options.body);
  assert.match(body.body, /blocked/);
  assert.ok(!body.body.includes("ghp_secret_should_be_redacted"));
});

test("issue lookup ignores pull requests and follows pagination", async () => {
  const firstPage = Array.from({ length: 100 }, (_, number) => ({
    number,
    body: ISSUE_MARKER,
    pull_request: {},
  }));
  const mock = apiMock([
    firstPage,
    [{ number: 101, state: "open", body: `${ISSUE_MARKER}\n${keyMarker(result)}` }],
  ]);
  assert.equal(await notifySyncResult(result, mock), "duplicate");
  assert.match(mock.calls[1][1], /page=2$/);
});
