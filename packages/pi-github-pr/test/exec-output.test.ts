import assert from "node:assert/strict";
import { watch } from "node:fs";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: vi.fn(),
}));
vi.stubEnv("GH_HOST", undefined);
vi.resetModules();
const { default: githubPr, runGhPrView } = await import("../src/github-pr.js");
afterAll(() => vi.unstubAllEnvs());

const pr = { number: 123, state: "OPEN", url: "https://github.com/owner/repo/pull/123" };
const counts = {
  data: { repository: { pullRequest: { comments: { totalCount: 2 }, reviews: { totalCount: 3 } } } },
};
const success = (payload: unknown): ExecResult => ({
  stdout: JSON.stringify(payload),
  stderr: "",
  code: 0,
  killed: false,
  truncated: false,
});
const queries = [
  { argument: "pr", command: "gh pr view", maxBuffer: 1024 * 1024, payload: pr, calls: 1 },
  { argument: "api", command: "gh api graphql", maxBuffer: 64 * 1024, payload: counts, calls: 2 },
];

for (const query of queries) {
  test.each([
    { name: "partial JSON after overflow termination", code: 1, killed: true, partial: true, stderr: "" },
    { name: "valid JSON with a success exit code", code: 0, killed: false, partial: false, stderr: "" },
    { name: "partial JSON with a success exit code", code: 0, killed: false, partial: true, stderr: "" },
    {
      name: "stderr overflow with valid stdout",
      code: 0,
      killed: false,
      partial: false,
      stderr: "spawn gh ENOENT; run gh auth login",
    },
  ])(`${query.command} rejects truncated $name before parsing or failure classification`, async (fixture) => {
    let calls = 0;
    const pi: Pick<ExtensionAPI, "exec"> = {
      exec: async (_command, args) => {
        calls += 1;
        if (args[0] !== query.argument) return success(pr);
        const stdout = JSON.stringify(query.payload);
        return {
          stdout: fixture.partial ? stdout.slice(0, -1) : stdout,
          stderr: fixture.stderr,
          code: fixture.code,
          killed: fixture.killed,
          truncated: true,
        };
      },
    };
    await assert.rejects(runGhPrView(pi, "/repo"), {
      message: `${query.command} output exceeded ${query.maxBuffer} bytes; incomplete output was discarded.`,
    });
    assert.equal(calls, query.calls);
  });

  test.each([
    {
      name: "timeout",
      result: { ...success(""), code: 1, killed: true },
      error: `${query.command} timed out or was cancelled.`,
    },
    {
      name: "Pi spawn failure",
      result: { ...success(""), code: 1, stderr: "spawn gh ENOENT" },
      error: "GitHub CLI not found. Install gh and run: gh auth login.",
    },
    {
      name: "Pi spawn permission failure",
      result: { ...success(""), code: 1, stderr: "spawn gh EACCES" },
      error: `${query.command} failed (1): spawn gh EACCES`,
    },
  ])(`${query.command} preserves $name diagnostics`, async (fixture) => {
    const pi: Pick<ExtensionAPI, "exec"> = {
      exec: async (_command, args) => (args[0] === query.argument ? fixture.result : success(pr)),
    };
    await assert.rejects(runGhPrView(pi, "/repo"), { message: fixture.error });
  });

  test(`${query.command} preserves a thrown spawn failure`, async () => {
    const pi: Pick<ExtensionAPI, "exec"> = {
      exec: async (_command, args) => {
        if (args[0] === query.argument) throw new Error("spawn gh EACCES");
        return success(pr);
      },
    };
    await assert.rejects(runGhPrView(pi, "/repo"), {
      message: `${query.command} could not start: spawn gh EACCES`,
    });
  });

  test(`${query.command} preserves abort reasons without parsing or starting another query`, async () => {
    const controller = new AbortController();
    const reason = new DOMException("query cancelled", "AbortError");
    let calls = 0;
    const pi: Pick<ExtensionAPI, "exec"> = {
      exec: async (_command, args, options) => {
        calls += 1;
        assert.equal(options?.signal, controller.signal);
        if (args[0] === query.argument) controller.abort(reason);
        return success(args[0] === "pr" ? pr : counts);
      },
    };
    await assert.rejects(runGhPrView(pi, "/repo", controller.signal), (error) => error === reason);
    assert.equal(calls, query.calls);
  });

  test(`${query.command} reports overflow before a concurrent abort`, async () => {
    const controller = new AbortController();
    const pi: Pick<ExtensionAPI, "exec"> = {
      exec: async (_command, args) => {
        if (args[0] !== query.argument) return success(pr);
        controller.abort(new DOMException("query cancelled", "AbortError"));
        return { stdout: "{", stderr: "", code: 1, killed: true, truncated: true };
      },
    };
    await assert.rejects(runGhPrView(pi, "/repo", controller.signal), {
      message: `${query.command} output exceeded ${query.maxBuffer} bytes; incomplete output was discarded.`,
    });
  });
}

test("complete PR queries retain their output, timeouts, signals, and operation-local caps", async () => {
  const options: Array<ExecOptions | undefined> = [];
  const controller = new AbortController();
  const pi: Pick<ExtensionAPI, "exec"> = {
    exec: async (_command, args, execOptions) => {
      options.push(execOptions);
      return success(args[0] === "pr" ? pr : counts);
    },
  };
  const status = await runGhPrView(pi, "/repo", controller.signal);
  assert.equal(status.number, 123);
  assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
  assert.deepEqual(options, [
    { cwd: "/repo", signal: controller.signal, timeout: 10_000, maxBuffer: 1024 * 1024 },
    { cwd: "/repo", signal: controller.signal, timeout: 10_000, maxBuffer: 64 * 1024 },
  ]);
});

test.each([
  { code: 1, killed: true },
  { code: 0, killed: false },
])("a truncated HEAD probe (%j) cannot create a watcher or stop periodic recovery", async (fixture) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(watch).mockClear();
  const mock = createMockPi();
  let prViews = 0;
  const exec: ExtensionAPI["exec"] = async (command, args, options) => {
    if (command === "git") {
      assert.equal(options?.maxBuffer, 16 * 1024);
      assert.equal(options?.timeout, 5_000);
      assert.ok(options?.signal);
      return { stdout: ".git/HEAD\n", stderr: "", ...fixture, truncated: true };
    }
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 2) return { ...success(pr), ...fixture, truncated: true };
      return success(pr);
    }
    return success(counts);
  };
  Object.assign(mock.rawPi, { exec });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const emit = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
  };
  try {
    await emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(vi.mocked(watch).mock.calls.length, 0);
    assert.match(context.statuses.get("github-pr") ?? "", /#123/);

    await vi.advanceTimersByTimeAsync(100);
    assert.equal(prViews, 2);
    assert.equal(context.statuses.get("github-pr"), undefined);
    assert.deepEqual(context.notifications, []);

    await vi.advanceTimersByTimeAsync(100);
    assert.equal(prViews, 3);
    assert.match(context.statuses.get("github-pr") ?? "", /#123/);

    await emit("session_shutdown");
    await vi.advanceTimersByTimeAsync(200);
    assert.equal(prViews, 3);
    assert.equal(context.statuses.get("github-pr"), undefined);
  } finally {
    await emit("session_shutdown");
  }
});

test("a replaced session's late truncated query cannot clear its replacement's status or polling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const mock = createMockPi();
  let finishOld!: (result: ExecResult) => void;
  const oldResult = new Promise<ExecResult>((resolve) => {
    finishOld = resolve;
  });
  let oldSignal: AbortSignal | undefined;
  let currentPrViews = 0;
  const exec: ExtensionAPI["exec"] = async (command, args, options) => {
    if (command === "git")
      return { stdout: "", stderr: "not a repository", code: 128, killed: false, truncated: false };
    if (args[0] === "pr" && options?.cwd === "/old") {
      oldSignal = options.signal;
      return oldResult;
    }
    if (args[0] === "pr") currentPrViews += 1;
    return success(args[0] === "pr" ? { ...pr, number: 456, url: "https://github.com/owner/repo/pull/456" } : counts);
  };
  Object.assign(mock.rawPi, { exec });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const oldContext = createMockContext({ cwd: "/old" });
  const currentContext = createMockContext({ cwd: "/current" });
  const emit = async (name: string, context: ReturnType<typeof createMockContext>) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
  };
  try {
    await emit("session_start", oldContext);
    await vi.advanceTimersByTimeAsync(0);
    assert.ok(oldSignal);
    await emit("session_start", currentContext);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(oldSignal.aborted, true);
    assert.match(currentContext.statuses.get("github-pr") ?? "", /#456/);

    finishOld({ stdout: "{", stderr: "", code: 0, killed: false, truncated: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.match(currentContext.statuses.get("github-pr") ?? "", /#456/);
    assert.equal(oldContext.statuses.get("github-pr"), undefined);
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(currentPrViews, 2);
  } finally {
    finishOld(success(pr));
    await emit("session_shutdown", currentContext);
  }
});
