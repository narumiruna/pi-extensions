import assert from "node:assert/strict";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { afterAll, beforeEach, test } from "vitest";
import { BUILT_IN_CONFIG } from "../src/config.js";
import { parseFormat } from "../src/format/formatter.js";
import { githubPrModule } from "../src/modules/github-pr.js";
import { renderStatusline, type StarshipRuntimeSnapshot } from "../src/modules/index.js";
import {
  buildGithubPrSnapshot,
  ghPrViewInvocation,
  githubPrEnvironment,
  queryGithubPr,
  TERMINAL_PR_LIFETIME_MS,
} from "../src/runtime/github-pr.js";
import type { WorkspaceExec, WorkspaceExecResult } from "../src/runtime/workspace.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const GH_FIELDS = "number,isDraft,url,state,closedAt,mergedAt,reviewDecision,statusCheckRollup";
const ambientCapabilities = getCapabilities();

beforeEach(() => {
  setCapabilities({ ...ambientCapabilities, hyperlinks: true });
});

afterAll(() => {
  setCapabilities(ambientCapabilities);
});

function rawPr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 123,
    isDraft: false,
    url: "https://github.com/o/r/pull/123",
    state: "OPEN",
    closedAt: null,
    mergedAt: null,
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

function runtime(githubPr: NonNullable<StarshipRuntimeSnapshot["githubPr"]>): StarshipRuntimeSnapshot {
  return {
    cwd: "/work/repo",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: "feature",
    githubPr,
    extensionStatuses: new Map(),
    now: new Date(NOW),
  };
}

function stripSgr(value: string): string {
  const escapeSequence = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeSequence}\\[[0-9;]*m`, "gu"), "");
}

test("github_pr exposes compact checks, review, and prioritized status", () => {
  const snapshot = buildGithubPrSnapshot(
    rawPr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "COMPLETED", conclusion: "TIMED_OUT" },
        { status: "IN_PROGRESS", conclusion: null },
      ],
    }),
    NOW,
  );
  assert.ok(snapshot);
  assert.deepEqual(
    {
      number: snapshot.number,
      state: snapshot.state,
      checks: snapshot.checks,
      review: snapshot.review,
      status: snapshot.status,
    },
    {
      number: "123",
      state: "open",
      checks: "✓1 ×2 …1",
      review: "R×",
      status: "×2",
    },
  );

  const config = structuredClone(BUILT_IN_CONFIG);
  config.format = "$github_pr";
  config.formatAst = parseFormat(config.format);
  config.modules.github_pr.format = "$number|$link|$state|$checks|$review|$status";
  config.modules.github_pr.formatAst = parseFormat(config.modules.github_pr.format);
  const rendered = stripSgr(renderStatusline(config, runtime(snapshot)).ansi);
  assert.equal(rendered, `123|\u001b]8;;https://github.com/o/r/pull/123\u0007#123\u001b]8;;\u0007|open|✓1 ×2 …1|R×|×2`);

  const cases: [Record<string, unknown>, string][] = [
    [
      {
        state: "MERGED",
        mergedAt: new Date(NOW - 1_000).toISOString(),
      },
      "M",
    ],
    [
      {
        state: "CLOSED",
        closedAt: new Date(NOW - 1_000).toISOString(),
      },
      "C",
    ],
    [{ isDraft: true }, "D"],
    [{ statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }, "×1"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "R×"],
    [{ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] }, "…1"],
    [{ reviewDecision: "APPROVED" }, "R✓"],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "R?"],
    [
      {
        reviewDecision: "",
        statusCheckRollup: [
          { state: "SUCCESS" },
          { status: "COMPLETED", conclusion: "SKIPPED" },
          { status: "COMPLETED", conclusion: "NEUTRAL" },
        ],
      },
      "✓3",
    ],
    [{ reviewDecision: "", statusCheckRollup: [] }, "-"],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(buildGithubPrSnapshot(rawPr(overrides), NOW)?.status, expected);
  }
});

test("compact PR values omit zero check categories and cover bounded decisions", () => {
  const checkCases: [unknown[], string][] = [
    [[{ status: "COMPLETED", conclusion: "SUCCESS" }], "✓1"],
    [[{ status: "COMPLETED", conclusion: "FAILURE" }], "×1"],
    [[{ status: "IN_PROGRESS", conclusion: null }], "…1"],
    [
      [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "IN_PROGRESS", conclusion: null },
      ],
      "✓1 ×1 …1",
    ],
    [[], "-"],
    [Array.from({ length: 1_000 }, () => ({ state: "SUCCESS" })), "✓1000"],
  ];
  for (const [statusCheckRollup, expected] of checkCases) {
    assert.equal(buildGithubPrSnapshot(rawPr({ statusCheckRollup }), NOW)?.checks, expected);
  }

  const reviewCases: [unknown, string][] = [
    ["APPROVED", "R✓"],
    ["CHANGES_REQUESTED", "R×"],
    ["REVIEW_REQUIRED", "R?"],
    ["UNKNOWN", ""],
  ];
  for (const [reviewDecision, expected] of reviewCases) {
    assert.equal(buildGithubPrSnapshot(rawPr({ reviewDecision }), NOW)?.review, expected);
  }
});

test("github_pr keeps its established variables and default format", () => {
  assert.deepEqual(githubPrModule.variables, ["symbol", "number", "link", "state", "checks", "review", "status"]);
  assert.equal(githubPrModule.defaults.format, "[ $symbol$link( · $status) ]($style)");
});

test("terminal pull requests expire at the exact 24-hour boundary", () => {
  const terminalAt = NOW - TERMINAL_PR_LIFETIME_MS;
  const merged = rawPr({ state: "MERGED", mergedAt: new Date(terminalAt).toISOString() });
  assert.ok(buildGithubPrSnapshot(merged, NOW - 1));
  assert.equal(buildGithubPrSnapshot(merged, NOW), undefined);

  const closed = rawPr({ state: "CLOSED", closedAt: new Date(terminalAt).toISOString() });
  assert.ok(buildGithubPrSnapshot(closed, NOW - 1));
  assert.equal(buildGithubPrSnapshot(closed, NOW), undefined);
  assert.equal(buildGithubPrSnapshot(rawPr({ state: "CLOSED", closedAt: null }), NOW), undefined);
});

test("terminal pull requests require GitHub-style RFC3339 timestamps", () => {
  for (const mergedAt of [
    "Sat, 01 Aug 2026 11:59:59 GMT",
    "2026-08-01",
    "2026-02-30T11:59:59Z",
    "2026-08-01T11:59:59+24:00",
  ]) {
    assert.equal(buildGithubPrSnapshot(rawPr({ state: "MERGED", mergedAt }), NOW), undefined);
  }
  assert.ok(buildGithubPrSnapshot(rawPr({ state: "MERGED", mergedAt: "2026-08-01T13:59:59+02:00" }), NOW));
});

test("github_pr creates terminal-safe GitHub Enterprise links and falls back to plain text", () => {
  const enterprise = buildGithubPrSnapshot(rawPr({ url: "https://github.enterprise.test:8443/o/r/pull/123" }), NOW);
  assert.equal(
    enterprise?.link,
    "\u001b]8;;https://github.enterprise.test:8443/o/r/pull/123\u0007#123\u001b]8;;\u0007",
  );
  for (const url of [
    "javascript:alert(1)",
    "https://user:secret@github.test/o/r/pull/123",
    "https://github.test/o/r/pull/123\u001b]8;;https://evil.test\u0007",
    "https://github.test/o/r/pull/123\u009d8;;https://evil.test\u009c",
  ]) {
    const snapshot = buildGithubPrSnapshot(rawPr({ url }), NOW);
    assert.equal(snapshot?.link, "#123");
  }
});

test("github_pr honors disabled effective hyperlink capability", () => {
  setCapabilities({ ...ambientCapabilities, hyperlinks: false });
  const snapshot = buildGithubPrSnapshot(rawPr(), NOW);

  assert.equal(snapshot?.link, "#123");
  assert.equal(snapshot?.link.includes("\u001b]8;;"), false);
});

test("gh invocation is direct on POSIX and Windows and strips repository overrides", () => {
  assert.deepEqual(ghPrViewInvocation("linux"), {
    command: "gh",
    args: ["pr", "view", "--json", GH_FIELDS],
  });
  assert.deepEqual(ghPrViewInvocation("win32"), {
    command: "gh.exe",
    args: ["pr", "view", "--json", GH_FIELDS],
  });
  const source = {
    PATH: "/bin",
    GH_HOST: "github.enterprise.test",
    gh_repo: "other/repository",
    KEEP: "value",
  };
  assert.deepEqual({ ...githubPrEnvironment(source) }, { PATH: "/bin", KEEP: "value" });
  assert.equal(source.GH_HOST, "github.enterprise.test");
  assert.equal(source.gh_repo, "other/repository");
});

test("queryGithubPr executes one direct cancellable bounded gh query", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const controller = new AbortController();
  const exec: WorkspaceExec = async (command, args, options) => {
    calls.push({
      command,
      args,
      options: { ...options, environment: { ...options.environment } },
    });
    return { stdout: JSON.stringify(rawPr()), stderr: "", code: 0, killed: false };
  };
  const snapshot = await queryGithubPr(exec, "/work/repo", controller.signal, NOW, {
    platform: "linux",
    environment: { PATH: "/bin", GH_HOST: "wrong", GH_REPO: "wrong/repo" },
  });
  assert.equal(snapshot?.number, "123");
  assert.deepEqual(calls, [
    {
      command: "gh",
      args: ["pr", "view", "--json", GH_FIELDS],
      options: {
        cwd: "/work/repo",
        signal: controller.signal,
        timeout: 10_000,
        maxOutputBytes: 128 * 1024,
        environment: { PATH: "/bin" },
      },
    },
  ]);
});

test("no PR, missing gh or auth, timeout, malformed, and oversized output degrade empty", async () => {
  const results: unknown[] = [
    { stdout: "", stderr: "no pull requests found", code: 1, killed: false },
    { stdout: "", stderr: "run gh auth login", code: 1, killed: false },
    { stdout: "", stderr: "", code: 1, killed: true },
    { stdout: "{", stderr: "", code: 0, killed: false },
    { stdout: JSON.stringify(rawPr({ number: -1 })), stderr: "", code: 0, killed: false },
    {
      stdout: JSON.stringify(rawPr({ url: `https://github.test/${"x".repeat(4_096)}` })),
      stderr: "",
      code: 0,
      killed: false,
    },
    {
      stdout: JSON.stringify(rawPr({ statusCheckRollup: Array.from({ length: 1_001 }, () => ({})) })),
      stderr: "",
      code: 0,
      killed: false,
    },
    {
      stdout: JSON.stringify(rawPr({ statusCheckRollup: [null] })),
      stderr: "",
      code: 0,
      killed: false,
    },
    {
      stdout: JSON.stringify(rawPr({ statusCheckRollup: [{ status: "x".repeat(129), conclusion: null }] })),
      stderr: "",
      code: 0,
      killed: false,
    },
    { stdout: "x".repeat(256 * 1024), stderr: "", code: 0, killed: false },
    Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
  ];
  for (const result of results) {
    const exec: WorkspaceExec = async () => {
      if (result instanceof Error) throw result;
      return result as WorkspaceExecResult;
    };
    assert.equal(
      await queryGithubPr(exec, "/work/repo", undefined, NOW, {
        platform: "linux",
        environment: {},
      }),
      undefined,
    );
  }
});
