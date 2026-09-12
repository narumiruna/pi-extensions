import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { afterAll, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import githubPr, {
  formatCompactStatus,
  formatLinkedStatus,
  ghPrViewInvocation,
  isPullRequestVisible,
  normalizeGhPrView,
  runGhPrView,
} from "../src/github-pr.js";

type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };
type ExecCall = { command: string; args: string[]; options?: ExecOptions };
type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const ambientGhHost = process.env.GH_HOST;
const ambientCapabilities = getCapabilities();
delete process.env.GH_HOST;
beforeEach(() => {
  setCapabilities({ ...ambientCapabilities, hyperlinks: true });
});
afterAll(() => {
  setCapabilities(ambientCapabilities);
  if (ambientGhHost !== undefined) process.env.GH_HOST = ambientGhHost;
});

const okResult = (stdout: unknown): ExecResult => ({
  stdout: JSON.stringify(stdout),
  stderr: "",
  code: 0,
  killed: false,
});

const textResult = (stdout: string, code = 0, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  code,
  killed: false,
});

const sampleCounts = {
  data: {
    repository: {
      pullRequest: {
        comments: { totalCount: 2 },
        reviews: { totalCount: 3 },
      },
    },
  },
};

const samplePr = {
  number: 123,
  state: "OPEN",
  closedAt: null,
  mergedAt: null,
  isDraft: false,
  url: "https://github.com/narumiruna/pi-extensions/pull/123",
  reviewDecision: "APPROVED",
  latestReviews: [
    { state: "APPROVED", author: { login: "alice" } },
    { state: "COMMENTED", author: { login: "bob" } },
  ],
  reviews: [
    { state: "COMMENTED", author: { login: "alice" } },
    { state: "APPROVED", author: { login: "alice" } },
    { state: "COMMENTED", author: { login: "bob" } },
  ],
  comments: [{}, {}],
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "FAILURE" }, { status: "IN_PROGRESS" }],
};

test("github-pr registers only passive lifecycle events", () => {
  const mock = createMockPi();
  githubPr(mock.pi);

  assert.equal(mock.commands.size, 0);
  assert.deepEqual(mock.tools, []);
  assert.deepEqual([...mock.events.keys()].sort(), ["agent_end", "session_shutdown", "session_start"]);
});

test("normalizeGhPrView summarizes approved reviews, failing checks, and comments", () => {
  const status = normalizeGhPrView(samplePr);

  assert.deepEqual(status.checks, { passed: 1, failed: 1, pending: 1, total: 3 });
  assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
  assert.deepEqual(status.review.approvedBy, ["alice"]);
  assert.equal(formatCompactStatus(status), "PR #123: checks failing (1), approved, 5 comments");
  assert.equal(
    formatLinkedStatus(status),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );
});

test("formatLinkedStatus falls back to plain text when the PR url is missing", () => {
  const status = normalizeGhPrView({ ...samplePr, url: undefined });

  assert.equal(status.url, "");
  assert.equal(formatLinkedStatus(status), formatCompactStatus(status));
});

test("formatLinkedStatus honors disabled effective hyperlink capability", () => {
  setCapabilities({ ...ambientCapabilities, hyperlinks: false });
  const status = normalizeGhPrView(samplePr);
  const rendered = formatLinkedStatus(status);

  assert.equal(rendered, "PR #123: checks failing (1), approved, 5 comments");
  assert.equal(rendered.includes("\u001b]8;;"), false);
});

test("formatLinkedStatus rejects invalid and non-http PR urls", () => {
  const status = normalizeGhPrView(samplePr);

  for (const url of ["not a url", "javascript:alert(1)"]) {
    const candidate = { ...status, url };
    assert.equal(formatLinkedStatus(candidate), formatCompactStatus(candidate));
  }
});

test("formatLinkedStatus strips terminal controls from OSC 8 url and text", () => {
  const status = normalizeGhPrView({ ...samplePr, url: `${samplePr.url}\x1b` });
  const unsafeNumber = { toString: () => "12\x1b\n3" } as unknown as number;
  const rendered = formatLinkedStatus({ ...status, number: unsafeNumber });

  const controls = [...rendered]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
    .join("");
  assert.equal(controls, "\x1b\x07\x1b\x07");
  assert.ok(rendered.includes("#123"));
  assert.ok(!rendered.includes("#12\x1b\n3"));
});

test("normalizeGhPrView summarizes pending, changes-requested, draft, and commented reviews", () => {
  const changesRequested = normalizeGhPrView({
    ...samplePr,
    reviewDecision: "CHANGES_REQUESTED",
    latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
    comments: undefined,
    statusCheckRollup: [{ status: "QUEUED" }],
  });
  const draft = normalizeGhPrView({
    ...samplePr,
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
    latestReviews: [],
    reviews: [],
    comments: undefined,
    statusCheckRollup: [],
  });
  const commented = normalizeGhPrView({
    ...samplePr,
    reviewDecision: "REVIEW_REQUIRED",
    latestReviews: [{ state: "COMMENTED", author: { login: "copilot" } }],
    comments: [],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  });

  assert.deepEqual(changesRequested.comments, { issue: 0, reviews: 3, total: 3 });
  assert.equal(formatCompactStatus(changesRequested), "PR #123: checks pending (1), changes requested, 3 comments");
  assert.deepEqual(draft.comments, { issue: 0, reviews: 0, total: 0 });
  assert.equal(formatCompactStatus(draft), "PR #123: no checks, draft, no comments");
  assert.equal(formatCompactStatus(commented), "PR #123: checks passing, review required, 3 comments");
});

test("terminal pull requests use their terminal state and expire after 24 hours", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const merged = normalizeGhPrView({
    ...samplePr,
    state: "MERGED",
    mergedAt: "2026-06-25T12:00:00.001Z",
  });
  const closed = normalizeGhPrView({
    ...samplePr,
    state: "CLOSED",
    closedAt: "2026-06-25T12:00:00.000Z",
  });

  assert.equal(formatCompactStatus(merged), "PR #123: merged");
  assert.equal(formatCompactStatus(closed), "PR #123: closed");
  assert.equal(isPullRequestVisible(merged, now), true);
  assert.equal(isPullRequestVisible(closed, now), false);
  assert.equal(isPullRequestVisible({ ...merged, mergedAt: undefined }, now), false);
  assert.equal(isPullRequestVisible({ ...closed, closedAt: "invalid" }, now), false);
  assert.equal(isPullRequestVisible(normalizeGhPrView(samplePr), now), true);
  assert.equal(isPullRequestVisible(normalizeGhPrView({ ...samplePr, closedAt: "invalid" }), now), true);
});

test("normalizeGhPrView accepts count-only review and comment payloads", () => {
  const status = normalizeGhPrView({
    ...samplePr,
    reviews: { totalCount: 3 },
    comments: { totalCount: 2 },
  });

  assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
});

test("gh pr view resolves the repository host on POSIX and Windows", () => {
  const args = [
    "pr",
    "view",
    "--json",
    "number,isDraft,url,state,closedAt,mergedAt,reviewDecision,latestReviews,statusCheckRollup",
  ];

  assert.deepEqual(ghPrViewInvocation(undefined, "linux"), { command: "gh", args });
  assert.deepEqual(ghPrViewInvocation("git.example.com", "darwin"), {
    command: "env",
    args: ["-u", "GH_HOST", "gh", ...args],
  });
  assert.deepEqual(ghPrViewInvocation("git.example.com", "win32", "C:\\Windows\\cmd.exe"), {
    command: "C:\\Windows\\cmd.exe",
    args: ["/d", "/s", "/c", `set "GH_HOST=" && gh ${args.join(" ")}`],
  });
});

test("runGhPrView calls gh pr view for the current branch and reports actionable failures", async () => {
  const calls: ExecCall[] = [];
  const ghHosts: Array<string | undefined> = [];
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      ghHosts.push(process.env.GH_HOST);
      if (command === "gh" && args[0] === "pr" && process.env.GH_HOST) {
        return textResult("", 1, "none of the git remotes configured for this repository correspond to GH_HOST");
      }
      return okResult(calls.length === 1 ? samplePr : sampleCounts);
    },
  } satisfies { exec: ExecFunction };
  const previousGhHost = process.env.GH_HOST;
  process.env.GH_HOST = "github.netflix.net";

  let status: Awaited<ReturnType<typeof runGhPrView>>;
  let restoredGhHost: string | undefined;
  try {
    status = await runGhPrView(pi, "/repo");
    restoredGhHost = process.env.GH_HOST;
  } finally {
    if (previousGhHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previousGhHost;
  }

  assert.equal(status.number, 123);
  assert.deepEqual(ghHosts, ["github.netflix.net", "github.netflix.net"]);
  assert.equal(restoredGhHost, "github.netflix.net");
  assert.equal(calls.length, 2);
  const prArgs = [
    "pr",
    "view",
    "--json",
    "number,isDraft,url,state,closedAt,mergedAt,reviewDecision,latestReviews,statusCheckRollup",
  ];
  assert.deepEqual(
    calls[0],
    process.platform === "win32"
      ? {
          command: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", `set "GH_HOST=" && gh ${prArgs.join(" ")}`],
          options: { cwd: "/repo", signal: undefined, timeout: 10_000 },
        }
      : {
          command: "env",
          args: ["-u", "GH_HOST", "gh", ...prArgs],
          options: { cwd: "/repo", signal: undefined, timeout: 10_000 },
        },
  );
  assert.deepEqual(calls[1]?.options, { cwd: "/repo", signal: undefined, timeout: 10_000 });
  assert.deepEqual(calls[1]?.args.slice(0, 6), ["api", "graphql", "--hostname", "github.com", "-f", calls[1]?.args[5]]);
  assert.match(calls[1]?.args[5] ?? "", /^query=\s*query PullRequestCounts/);
  assert.deepEqual(calls[1]?.args.slice(6), ["-F", "owner=narumiruna", "-F", "name=pi-extensions", "-F", "number=123"]);

  await assert.rejects(
    runGhPrView(
      {
        exec: async () => {
          throw new Error("spawn gh ENOENT");
        },
      },
      "/repo",
    ),
    /GitHub CLI not found/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => {
          throw new Error("operation aborted");
        },
      },
      "/repo",
    ),
    /gh pr view could not start: operation aborted/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => {
          throw new Error("spawn gh EACCES");
        },
      },
      "/repo",
    ),
    /gh pr view could not start: spawn gh EACCES/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({ stdout: "", stderr: "not logged in", code: 1, killed: false }),
      },
      "/repo",
    ),
    /gh auth login/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({
          stdout: "",
          stderr: "not a GitHub repository",
          code: 1,
          killed: false,
        }),
      },
      "/repo",
    ),
    /No GitHub pull request found/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({
          stdout: "",
          stderr: "no pull requests found",
          code: 1,
          killed: false,
        }),
      },
      "/repo",
    ),
    /No GitHub pull request found/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({
          stdout: "",
          stderr: "HTTP 404: Not Found",
          code: 1,
          killed: false,
        }),
      },
      "/repo",
    ),
    /gh pr view failed/,
  );
});

test("runGhPrView sends gh api graphql to the enterprise PR host", async () => {
  const calls: ExecCall[] = [];
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return okResult(
        args[0] === "pr" ? { ...samplePr, url: "https://github.example.com:8443/org/repo/pull/123" } : sampleCounts,
      );
    },
  } satisfies { exec: ExecFunction };

  await runGhPrView(pi, "/repo");

  assert.deepEqual(calls[1]?.args.slice(0, 4), ["api", "graphql", "--hostname", "github.example.com:8443"]);
  assert.deepEqual(calls[1]?.args.slice(6), ["-F", "owner=org", "-F", "name=repo", "-F", "number=123"]);
});

test("session start does not wait for initial commands before returning", async () => {
  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  let gitSignal: AbortSignal | undefined;
  installExec(mock, async (command, args, options) => {
    if (command === "git") {
      gitSignal = options?.signal;
      return gitResult.promise;
    }
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  const startupResult = sessionStart({}, context.ctx);
  try {
    assert.equal(startupResult, undefined);
    assert.ok(gitSignal);
    assert.equal(gitSignal.aborted, false);
    assert.equal(context.statuses.get("github-pr"), undefined);

    gitResult.resolve(textResult("", 128, "not a git repository"));
    await waitFor(
      () => (context.statuses.get("github-pr") ?? "").includes("#123"),
      "background initialization publishes PR status",
    );
  } finally {
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await sessionShutdown({}, context.ctx);
  }
});

test("session shutdown aborts initial refresh and blocks late publication", async () => {
  const mock = createMockPi();
  const prView = deferred<ExecResult>();
  const sessionController = new AbortController();
  const removeAbortListener = vi.spyOn(sessionController.signal, "removeEventListener");
  let initialSignal: AbortSignal | undefined;
  const calls = installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      initialSignal = options?.signal;
      return prView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: "/repo", signal: sessionController.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  sessionStart({}, context.ctx);
  await waitFor(() => initialSignal !== undefined, "initial PR refresh starts");
  assert.ok(initialSignal);
  assert.equal(initialSignal.aborted, false);

  await sessionShutdown({}, context.ctx);
  assert.equal(initialSignal.aborted, true);
  assert.equal(removeAbortListener.mock.calls.length, 1);
  prView.resolve(okResult(samplePr));
  await drainMicrotasks();

  assert.equal(removeAbortListener.mock.calls.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(context.statuses.get("github-pr"), undefined);
});

test("session cancellation aborts initial refresh and blocks late publication", async () => {
  const mock = createMockPi();
  const prView = deferred<ExecResult>();
  const sessionController = new AbortController();
  let initialSignal: AbortSignal | undefined;
  const calls = installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      initialSignal = options?.signal;
      return prView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo", signal: sessionController.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  sessionStart({}, context.ctx);
  await waitFor(() => initialSignal !== undefined, "initial refresh receives an abort signal");
  assert.ok(initialSignal);
  assert.notEqual(initialSignal, sessionController.signal);
  assert.equal(initialSignal.aborted, false);

  const reason = new Error("session cancelled");
  sessionController.abort(reason);
  assert.equal(initialSignal.aborted, true);
  assert.equal(initialSignal.reason, reason);
  prView.resolve(okResult(samplePr));
  await drainMicrotasks();

  assert.equal(calls.length, 2);
  assert.equal(context.statuses.get("github-pr"), undefined);
  await sessionShutdown({}, context.ctx);
});

test("a pre-aborted session does not start initialization commands", async () => {
  const mock = createMockPi();
  const calls = installExec(mock, async () => textResult("", 128, "not a git repository"));
  githubPr(mock.pi);
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  const context = createMockContext({ cwd: "/repo", signal: controller.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  assert.equal(sessionStart({}, context.ctx), undefined);
  await drainMicrotasks();
  assert.deepEqual(calls, []);
  await sessionShutdown({}, context.ctx);
});

test("session replacement aborts initial refresh and rejects its late result", async () => {
  const mock = createMockPi();
  const oldPrView = deferred<ExecResult>();
  let oldSignal: AbortSignal | undefined;
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr" && options?.cwd === "/repo-a") {
      oldSignal = options.signal;
      return oldPrView.promise;
    }
    if (args[0] === "pr") {
      return okResult({
        ...samplePr,
        number: 456,
        url: "https://github.com/narumiruna/pi-extensions/pull/456",
      });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const oldContext = createMockContext({ cwd: "/repo-a" });
  const currentContext = createMockContext({ cwd: "/repo-b" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  sessionStart({}, oldContext.ctx);
  await waitFor(() => oldSignal !== undefined, "old session initial refresh starts");
  sessionStart({}, currentContext.ctx);
  assert.ok(oldSignal);
  assert.equal(oldSignal.aborted, true);
  await waitFor(
    () => (currentContext.statuses.get("github-pr") ?? "").includes("#456"),
    "replacement session publishes its PR status",
  );

  oldPrView.resolve(okResult(samplePr));
  await drainMicrotasks();
  assert.match(currentContext.statuses.get("github-pr") ?? "", /#456/);
  assert.equal(oldContext.statuses.get("github-pr"), undefined);

  await sessionShutdown({}, currentContext.ctx);
});

test("lifecycle refresh sets and clears only statusline output", async () => {
  const mock = createMockPi();
  const calls = installExec(mock, async (_command, args) => okResult(args[0] === "pr" ? samplePr : sampleCounts));
  githubPr(mock.pi);
  const signal = new AbortController().signal;
  const context = createMockContext({ cwd: "/repo", signal });

  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  await sessionStart({}, context.ctx);
  await waitFor(
    () => (context.statuses.get("github-pr") ?? "").includes("#123"),
    "initial lifecycle refresh publishes status",
  );
  assert.equal(
    context.statuses.get("github-pr"),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );
  assert.equal(context.widgets.size, 0);
  assert.equal(context.notifications.length, 0);

  await agentEnd({}, context.ctx);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0]?.args, ["rev-parse", "--git-path", "HEAD"]);
  assert.ok(calls[0]?.options?.signal);
  assert.notEqual(calls[0]?.options?.signal, signal);
  assert.equal(calls[0]?.options?.signal?.aborted, false);
  assert.equal(
    context.statuses.get("github-pr"),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );

  await sessionShutdown({}, context.ctx);
  assert.equal(context.statuses.get("github-pr"), undefined);
  assert.equal(context.widgets.size, 0);
  assert.equal(context.notifications.length, 0);
});

test("an aborted agent-end preserves the current status and periodic refresh schedule", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const controller = new AbortController();
  let prViews = 0;
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (options?.signal?.aborted) {
        return { stdout: "", stderr: "", code: 1, killed: true };
      }
      return okResult(
        prViews === 1
          ? samplePr
          : {
              ...samplePr,
              reviewDecision: "CHANGES_REQUESTED",
              latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
            },
      );
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo", signal: controller.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(
      () => (context.statuses.get("github-pr") ?? "").includes("#123"),
      "initial status is visible before agent cancellation",
    );
    await drainMicrotasks();
    const visibleStatus = context.statuses.get("github-pr");
    assert.match(visibleStatus ?? "", /PR .*#123/);
    vi.advanceTimersByTime(60);

    controller.abort();
    await agentEnd({}, context.ctx);

    assert.equal(prViews, 1);
    assert.equal(context.statuses.get("github-pr"), visibleStatus);

    await vi.advanceTimersByTimeAsync(40);
    assert.equal(prViews, 2);
    assert.match(context.statuses.get("github-pr") ?? "", /changes requested/);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
});

test("a refresh aborted during agent-end preserves the current status", async () => {
  const mock = createMockPi();
  const controller = new AbortController();
  const abortedPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 2) return abortedPrView.promise;
    }
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo", signal: controller.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(
      () => (context.statuses.get("github-pr") ?? "").includes("#123"),
      "initial status is visible before agent-end refresh",
    );
    const visibleStatus = context.statuses.get("github-pr");
    const agentEndPromise = agentEnd({}, context.ctx);
    assert.equal(prViews, 2);

    controller.abort();
    abortedPrView.resolve({ stdout: "", stderr: "", code: 1, killed: true });
    await agentEndPromise;

    assert.equal(context.statuses.get("github-pr"), visibleStatus);
  } finally {
    abortedPrView.resolve({ stdout: "", stderr: "", code: 1, killed: true });
    await sessionShutdown({}, context.ctx);
  }
});

test("session shutdown aborts an in-flight agent-end refresh", async () => {
  const mock = createMockPi();
  const agentEndPrView = deferred<ExecResult>();
  const sessionController = new AbortController();
  const removeAbortListener = vi.spyOn(sessionController.signal, "removeEventListener");
  let agentEndSignal: AbortSignal | undefined;
  let prViews = 0;
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 2) {
        agentEndSignal = options?.signal;
        return agentEndPrView.promise;
      }
    }
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: "/repo", signal: sessionController.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  await sessionStart({}, context.ctx);
  await waitFor(
    () => (context.statuses.get("github-pr") ?? "").includes("#123"),
    "initial status is visible before agent-end shutdown",
  );
  const removalsBeforeAgentEnd = removeAbortListener.mock.calls.length;
  assert.equal(removalsBeforeAgentEnd, 1);
  const agentEndPromise = agentEnd({}, context.ctx);
  await waitFor(() => agentEndSignal !== undefined, "agent-end refresh starts");
  assert.ok(agentEndSignal);
  assert.equal(agentEndSignal.aborted, false);

  await sessionShutdown({}, context.ctx);
  assert.equal(agentEndSignal.aborted, true);
  assert.equal(removeAbortListener.mock.calls.length, removalsBeforeAgentEnd + 1);
  agentEndPrView.resolve(okResult(samplePr));
  await agentEndPromise;

  assert.equal(removeAbortListener.mock.calls.length, removalsBeforeAgentEnd + 1);
  assert.equal(context.statuses.get("github-pr"), undefined);
  assert.equal(prViews, 2);
});

test("rejects invalid periodic refresh intervals", () => {
  const mock = createMockPi();
  for (const refreshIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => githubPr(mock.pi, { refreshIntervalMs }), /refreshIntervalMs must be a positive finite number/);
  }
});

test("periodically refreshes PR state while the session remains open", async () => {
  const mock = createMockPi();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      return okResult(
        prViews === 1
          ? samplePr
          : {
              ...samplePr,
              reviewDecision: "CHANGES_REQUESTED",
              latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
            },
      );
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(
      () => (context.statuses.get("github-pr") ?? "").includes("approved"),
      "initial status is visible before periodic refresh",
    );
    assert.match(context.statuses.get("github-pr") ?? "", /approved/);
    await waitFor(
      () => (context.statuses.get("github-pr") ?? "").includes("changes requested"),
      "periodic refresh updates the PR state",
    );
    assert.ok(prViews >= 2);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
  const viewsAtShutdown = prViews;
  await wait(50);
  assert.equal(prViews, viewsAtShutdown);
});

test("a replaced session's late lifecycle events cannot disrupt its replacement", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const prCwds: string[] = [];
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prCwds.push(options?.cwd ?? "");
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const oldContext = createMockContext({ cwd: "/repo-a" });
  const currentContext = createMockContext({ cwd: "/repo-b" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, oldContext.ctx);
    await waitForMicrotasks(() => prCwds.length === 1, "old session initial refresh starts");
    await sessionStart({}, currentContext.ctx);
    await waitForMicrotasks(
      () => (currentContext.statuses.get("github-pr") ?? "").includes("#123"),
      "replacement initial refresh completes",
    );
    await drainMicrotasks();
    assert.deepEqual(prCwds, ["/repo-a", "/repo-b"]);

    await sessionShutdown({}, oldContext.ctx);
    await agentEnd({}, oldContext.ctx);
    assert.deepEqual(prCwds, ["/repo-a", "/repo-b"]);

    vi.advanceTimersByTime(100);
    await waitForMicrotasks(() => prCwds.length === 3, "replacement periodic refresh starts");
    assert.deepEqual(prCwds, ["/repo-a", "/repo-b", "/repo-b"]);
  } finally {
    await sessionShutdown({}, currentContext.ctx);
  }
});

test("agent-end after session shutdown cannot restart polling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prViews += 1;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  await sessionStart({}, context.ctx);
  await waitForMicrotasks(() => prViews === 1, "initial refresh starts before shutdown");
  await sessionShutdown({}, context.ctx);
  await agentEnd({}, context.ctx);
  vi.advanceTimersByTime(100);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(prViews, 1);
  assert.equal(context.statuses.get("github-pr"), undefined);
});

test("an older periodic refresh cannot overwrite a newer agent-end refresh", async () => {
  const mock = createMockPi();
  const periodicPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      if (prViews === 2) return periodicPrView.promise;
      return okResult({
        ...samplePr,
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
      });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(() => prViews === 2, "periodic refresh starts");
    await agentEnd({}, context.ctx);
    assert.equal(prViews, 3);
    assert.match(context.statuses.get("github-pr") ?? "", /changes requested/);

    periodicPrView.resolve(okResult(samplePr));
    await wait(25);
    assert.match(context.statuses.get("github-pr") ?? "", /changes requested/);
  } finally {
    periodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("an older refresh cannot postpone a newer refresh timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const oldPeriodicPrView = deferred<ExecResult>();
  const nextPeriodicPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      if (prViews === 2) return oldPeriodicPrView.promise;
      if (prViews === 3) {
        return okResult({
          ...samplePr,
          reviewDecision: "CHANGES_REQUESTED",
          latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
        });
      }
      return nextPeriodicPrView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(
      () => (context.statuses.get("github-pr") ?? "").includes("approved"),
      "initial refresh completes before polling",
    );
    await drainMicrotasks();
    vi.advanceTimersByTime(100);
    await waitForMicrotasks(() => prViews === 2, "older periodic refresh starts");
    assert.equal(prViews, 2);

    await agentEnd({}, context.ctx);
    assert.equal(prViews, 3);
    vi.advanceTimersByTime(50);
    oldPeriodicPrView.resolve(okResult(samplePr));
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(50);
    assert.equal(prViews, 4);
  } finally {
    oldPeriodicPrView.resolve(okResult(samplePr));
    nextPeriodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("session shutdown aborts an in-flight periodic refresh", async () => {
  const mock = createMockPi();
  const periodicPrView = deferred<ExecResult>();
  let prViews = 0;
  let periodicSignal: AbortSignal | undefined;
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      periodicSignal = options?.signal;
      return periodicPrView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(() => prViews === 2, "periodic refresh starts");
    assert.ok(periodicSignal, "periodic refresh receives a session-owned abort signal");
    assert.equal(periodicSignal.aborted, false);

    await sessionShutdown({}, context.ctx);
    assert.equal(periodicSignal.aborted, true);
    assert.equal(context.statuses.get("github-pr"), undefined);

    periodicPrView.resolve(
      okResult({
        ...samplePr,
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
      }),
    );
    await wait(25);
    assert.equal(context.statuses.get("github-pr"), undefined);
    assert.equal(prViews, 2);
  } finally {
    periodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("branch changes abort an in-flight periodic refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
  const gitDir = join(root, ".git");
  const headPath = join(gitDir, "HEAD");
  mkdirSync(gitDir);
  writeFileSync(headPath, "ref: refs/heads/feature\n");

  const periodicPrView = deferred<ExecResult>();
  const sessionSignal = new AbortController().signal;
  let periodicSignal: AbortSignal | undefined;
  const mock = createMockPi();
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult(".git/HEAD\n");
    if (args[0] === "pr") {
      if (options?.signal && options.signal !== sessionSignal) {
        periodicSignal = options.signal;
        return periodicPrView.promise;
      }
      return okResult(samplePr);
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: root, signal: sessionSignal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(() => periodicSignal !== undefined, "periodic refresh starts");
    assert.ok(periodicSignal, "periodic refresh receives a session-owned abort signal");
    assert.equal(periodicSignal.aborted, false);

    writeFileSync(headPath, "ref: refs/heads/main\n");
    await waitFor(() => periodicSignal?.aborted === true, "branch change aborts periodic refresh");
  } finally {
    periodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("recent terminal pull request status clears when its 24-hour lifetime expires", async () => {
  const mock = createMockPi();
  const mergedAt = new Date(Date.now() - 24 * 60 * 60 * 1000 + 1_000).toISOString();
  const calls = installExec(mock, async (_command, args) =>
    okResult(args[0] === "pr" ? { ...samplePr, state: "MERGED", mergedAt } : sampleCounts),
  );
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(
      () => (context.statuses.get("github-pr") ?? "").endsWith(": merged"),
      "recent terminal PR status is visible",
    );
    assert.match(context.statuses.get("github-pr") ?? "", /: merged$/);
    await waitFor(() => context.statuses.get("github-pr") === undefined, "terminal pull request status expires", 2_000);
    assert.equal(calls.length, 3);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
});

test("branch changes clear stale PR status and stale refreshes cannot restore it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
  const gitDir = join(root, ".git");
  const headPath = join(gitDir, "HEAD");
  mkdirSync(gitDir);
  writeFileSync(headPath, "ref: refs/heads/feature\n");

  const firstPrView = deferred<ExecResult>();
  const calls: ExecCall[] = [];
  let ghPrViews = 0;
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "git") return textResult(".git/HEAD\n");
      if (args[0] === "pr") {
        ghPrViews += 1;
        if (ghPrViews === 1) return firstPrView.promise;
        return textResult("", 1, 'no pull requests found for branch "main"');
      }
      return okResult(sampleCounts);
    },
  } satisfies { exec: ExecFunction };
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = pi.exec;
  githubPr(mock.pi);
  const context = createMockContext({ cwd: root });
  context.statuses.set("github-pr", "PR #4: checks passing, approved, no comments");

  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  const startPromise = sessionStart({}, context.ctx);
  await waitFor(() => ghPrViews === 1, "initial PR refresh starts");

  writeFileSync(headPath, "ref: refs/heads/main\n");

  await waitFor(() => context.statuses.get("github-pr") === undefined, "branch change clears stale PR status");
  await waitFor(() => ghPrViews >= 2, "branch change refreshes the current branch");

  firstPrView.resolve(okResult({ ...samplePr, number: 4, url: "https://github.com/o/r/pull/4" }));
  await startPromise;
  await wait(25);

  assert.equal(context.statuses.get("github-pr"), undefined);
  await sessionShutdown({}, context.ctx);
});

test("session shutdown disposes the branch watcher and pending refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
  const gitDir = join(root, ".git");
  const headPath = join(gitDir, "HEAD");
  mkdirSync(gitDir);
  writeFileSync(headPath, "ref: refs/heads/feature\n");

  let ghPrViews = 0;
  const mock = createMockPi();
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult(".git/HEAD\n");
    if (args[0] === "pr") {
      ghPrViews += 1;
      return okResult(samplePr);
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  await sessionStart({}, context.ctx);
  await waitFor(() => ghPrViews === 1, "initial refresh starts before watcher disposal");
  assert.equal(ghPrViews, 1);

  writeFileSync(headPath, "ref: refs/heads/main\n");
  await sessionShutdown({}, context.ctx);
  await wait(300);

  assert.equal(ghPrViews, 1);
  assert.equal(context.statuses.get("github-pr"), undefined);
});

test("queued branch refresh does not run after session shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
  const gitDir = join(root, ".git");
  const headPath = join(gitDir, "HEAD");
  mkdirSync(gitDir);
  writeFileSync(headPath, "ref: refs/heads/feature\n");

  let ghPrViews = 0;
  const mock = createMockPi();
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult(".git/HEAD\n");
    if (args[0] === "pr") {
      ghPrViews += 1;
      return okResult(samplePr);
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  await sessionStart({}, context.ctx);
  await waitFor(() => ghPrViews === 1, "initial refresh starts before queued branch refresh");
  assert.equal(ghPrViews, 1);

  const originalClearTimeout = globalThis.clearTimeout;
  try {
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
    writeFileSync(headPath, "ref: refs/heads/main\n");
    await waitFor(() => context.statuses.get("github-pr") === undefined, "branch change clears stale PR status");

    await sessionShutdown({}, context.ctx);
    await wait(300);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.equal(ghPrViews, 1);
  assert.equal(context.statuses.get("github-pr"), undefined);
});

test("branch watcher failures stay non-intrusive", async () => {
  const mock = createMockPi();
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);

  await sessionStart({}, context.ctx);
  await waitFor(
    () => (context.statuses.get("github-pr") ?? "").includes("#123"),
    "branch watcher failure still allows status refresh",
  );

  assert.equal(
    context.statuses.get("github-pr"),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );
  assert.equal(context.widgets.size, 0);
  assert.equal(context.notifications.length, 0);
});

test("ambient failures stay non-intrusive", async () => {
  const missingGh = await lifecycleStatusFor(async () => {
    throw new Error("spawn gh ENOENT");
  });
  const missingGhViaEnv = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "env: ‘gh’: No such file or directory",
    code: 127,
    killed: false,
  }));
  const missingGhViaCmd = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "'gh' is not recognized as an internal or external command",
    code: 1,
    killed: false,
  }));
  const unauthenticated = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "not logged in",
    code: 1,
    killed: false,
  }));
  const execFailure = await lifecycleStatusFor(async () => {
    throw new Error("operation aborted");
  });
  const spawnPermissionFailure = await lifecycleStatusFor(async () => {
    throw new Error("spawn gh EACCES");
  });
  const noPr = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "no pull requests found",
    code: 1,
    killed: false,
  }));
  const notFound = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "HTTP 404: Not Found",
    code: 1,
    killed: false,
  }));

  assert.equal(missingGh.statuses.get("github-pr"), "PR gh missing");
  assert.equal(missingGhViaEnv.statuses.get("github-pr"), "PR gh missing");
  assert.equal(missingGhViaCmd.statuses.get("github-pr"), "PR gh missing");
  assert.equal(unauthenticated.statuses.get("github-pr"), "PR gh auth");
  assert.equal(execFailure.statuses.get("github-pr"), undefined);
  assert.equal(spawnPermissionFailure.statuses.get("github-pr"), undefined);
  assert.equal(noPr.statuses.get("github-pr"), undefined);
  assert.equal(notFound.statuses.get("github-pr"), undefined);
  for (const context of [
    missingGh,
    missingGhViaEnv,
    missingGhViaCmd,
    unauthenticated,
    execFailure,
    spawnPermissionFailure,
    noPr,
    notFound,
  ]) {
    assert.equal(context.widgets.size, 0);
    assert.equal(context.notifications.length, 0);
  }
});

async function lifecycleStatusFor(exec: ExecFunction) {
  const mock = createMockPi();
  installExec(mock, exec);
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const handler = mock.events.get("session_start")?.[0];
  assert.ok(handler);
  await handler({}, context.ctx);
  return context;
}

function installExec(mock: ReturnType<typeof createMockPi>, exec: ExecFunction): ExecCall[] {
  const calls: ExecCall[] = [];
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return exec(command, args, options);
  };
  return calls;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainMicrotasks(iterations = 10): Promise<void> {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}

async function waitForMicrotasks(predicate: () => boolean, message: string, iterations = 20): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail(message);
}
