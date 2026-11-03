import assert from "node:assert/strict";
import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { normalizeConfig } from "../src/config.js";
import {
  type ReadGitSnapshotOptions,
  readGitSnapshot,
  readGitStatus,
  readGitWorktree,
} from "../src/modules/git/runtime.js";
import * as workspaceCommand from "../src/runtime/command.js";
import { queryGithubPr } from "../src/runtime/github-pr.js";
import { runBounded } from "../src/runtime/helpers.js";
import type { CollectorContext, WorkspaceExec, WorkspaceExecResult } from "../src/runtime/types.js";

const GIT_CAP = 64 * 1024;
const WORKSPACE_CAP = 64 * 1024;
const PR_CAP = 128 * 1024;
const CWD = "/work/feature";
const HASH = "0123456789abcdef";
const STATUS = `# branch.oid ${HASH}\n# branch.head main\n? new.ts\n`;
const METADATA = `${CWD}\n/work/main/.git\n/work/main/.git/worktrees/feature\n`;
const METRICS = " 1 file changed, 8 insertions(+), 2 deletions(-)\n";
const PR = JSON.stringify({
  number: 123,
  isDraft: false,
  url: "https://github.com/o/r/pull/123",
  state: "OPEN",
  closedAt: null,
  mergedAt: null,
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ state: "SUCCESS" }],
});

const success = (stdout: string): WorkspaceExecResult => ({
  stdout,
  stderr: "",
  code: 0,
  killed: false,
  truncated: false,
});

function gitOutput(args: string[]): WorkspaceExecResult {
  if (args.includes("status")) return success(STATUS);
  if (args.includes("--is-bare-repository")) return success("true\n");
  if (args.includes("symbolic-ref")) return success("main\n");
  if (args.includes("--verify")) return success(`${HASH}\n`);
  if (args.includes("for-each-ref")) return success("refs/heads/main\0origin/main\n");
  if (args.includes("diff")) return success(METRICS);
  if (args.includes("describe")) return success("v1.0.0\n");
  return success(METADATA);
}

type GitExecution = "native" | "injected";
type GitResponse = (args: string[]) => WorkspaceExecResult | Promise<WorkspaceExecResult>;
type ExecCall = { command: string; args: string[]; options: ExecOptions & { maxOutputBytes?: number } };

function gitFixture(execution: GitExecution, response: GitResponse = gitOutput) {
  const mock = createMockPi();
  const calls: ExecCall[] = [];
  const native: ExtensionAPI["exec"] = async (command, args, options) => {
    calls.push({ command, args, options: options ?? {} });
    return response(args);
  };
  Object.assign(mock.rawPi, { exec: native });
  const exec: WorkspaceExec | undefined =
    execution === "injected"
      ? async (command, args, options) => {
          calls.push({ command, args, options });
          return response(args);
        }
      : undefined;
  return {
    pi: mock.pi,
    calls,
    read: (options: Partial<ReadGitSnapshotOptions> = {}) =>
      readGitSnapshot(mock.pi, CWD, { includeMetrics: true, includeTag: true, exec, ...options }),
  };
}

afterEach(() => vi.restoreAllMocks());

test.each(["native", "injected"] as const)(
  "%s Git caps complete successful queries and preserves their values",
  async (execution) => {
    const fixture = gitFixture(execution);
    const controller = new AbortController();
    const snapshot = await fixture.read({ signal: controller.signal });
    assert.equal(snapshot?.branch?.name, "main");
    assert.equal(snapshot?.status.untracked, 1);
    assert.equal(snapshot?.root, CWD);
    assert.equal(snapshot?.worktree?.name, "feature");
    assert.deepEqual(snapshot?.commit, { hash: HASH, detached: false, tag: "v1.0.0" });
    assert.deepEqual(snapshot?.metrics, { added: 8, deleted: 2 });
    assert.equal(fixture.calls.length, 4);
    for (const { command, options } of fixture.calls) {
      assert.equal(command, "git");
      assert.equal(options.cwd, CWD);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.timeout, 3_000);
      assert.equal(execution === "native" ? options.maxBuffer : options.maxOutputBytes, GIT_CAP);
    }
  },
);

test.each(["native", "injected"] as const)(
  "%s Git rejects truncated porcelain before bare fallback, including code zero",
  async (execution) => {
    const fallback = vi.spyOn(workspaceCommand, "execWorkspaceCommand").mockResolvedValue(success("true\n"));
    for (const flags of [
      { code: 0, killed: false },
      { code: 1, killed: true },
    ]) {
      const fixture = gitFixture(execution, (args) =>
        args.includes("status")
          ? { ...success(`${STATUS}1 .M N... partial`), ...flags, truncated: true }
          : gitOutput(args),
      );
      assert.equal(await fixture.read({ inspectBare: true }), undefined);
      assert.equal(fixture.calls.length, 4);
      assert.equal(fallback.mock.calls.length, 0);
    }
  },
);

test.each(["native", "injected"] as const)(
  "%s Git omits incomplete paths, metrics, and tags without parsing their valid prefixes",
  async (execution) => {
    const fixture = gitFixture(execution, (args) => ({ ...gitOutput(args), truncated: !args.includes("status") }));
    const snapshot = await fixture.read();
    assert.equal(snapshot?.branch?.name, "main");
    assert.equal(snapshot?.status.untracked, 1);
    assert.deepEqual(snapshot?.commit, { hash: HASH, detached: false });
    assert.equal(snapshot?.root, undefined);
    assert.equal(snapshot?.worktree, undefined);
    assert.equal(snapshot?.state, undefined);
    assert.equal(snapshot?.metrics, undefined);
  },
);

test("standalone native Git readers cap output and reject truncated status and paths", async () => {
  for (const truncated of [false, true]) {
    const fixture = gitFixture("native", (args) => ({ ...gitOutput(args), truncated }));
    const status = await readGitStatus(fixture.pi, CWD);
    const worktree = await readGitWorktree(fixture.pi, CWD);
    assert.equal(status?.untracked, truncated ? undefined : 1);
    assert.equal(worktree?.name, truncated ? undefined : "feature");
    assert.equal(fixture.calls.length, 2);
    assert.ok(fixture.calls.every(({ options }) => options.maxBuffer === GIT_CAP && options.timeout === 3_000));
  }
});

test.each(["--is-bare-repository", "symbolic-ref", "--verify", "for-each-ref"])(
  "bare Git rejects truncated %s before using a partial reference",
  async (operation) => {
    const fixture = gitFixture("injected", (args) => {
      if (args.includes("status")) return { ...success(""), code: 128, stderr: "not a worktree" };
      return { ...gitOutput(args), truncated: args.includes(operation) };
    });
    const snapshot = await fixture.read({ inspectBare: true });
    if (operation === "for-each-ref") {
      assert.equal(snapshot?.branch?.name, "main");
      assert.equal(snapshot?.branch?.bare, true);
      assert.equal(snapshot?.branch?.remoteName, undefined);
      assert.equal(snapshot?.branch?.remoteBranch, undefined);
      assert.equal(snapshot?.commit?.hash, HASH);
    } else assert.equal(snapshot, undefined);
    assert.equal(fixture.calls.length, operation === "--is-bare-repository" ? 5 : operation === "for-each-ref" ? 8 : 7);
    assert.ok(fixture.calls.every(({ options }) => options.maxOutputBytes === GIT_CAP));
  },
);

test("native Git bare fallback retains the bounded workspace executor and cancellation signal", async () => {
  const calls: Parameters<WorkspaceExec>[] = [];
  vi.spyOn(workspaceCommand, "execWorkspaceCommand").mockImplementation(async (...args) => {
    calls.push(args);
    return gitOutput(args[1]);
  });
  const fixture = gitFixture("native", (args) =>
    args.includes("status") ? { ...success(""), code: 128, stderr: "not a worktree" } : gitOutput(args),
  );
  const controller = new AbortController();
  const snapshot = await fixture.read({ inspectBare: true, signal: controller.signal });
  assert.equal(snapshot?.branch?.bare, true);
  assert.equal(snapshot?.branch?.remoteName, "origin");
  assert.equal(snapshot?.commit?.tag, "v1.0.0");
  assert.equal(fixture.calls.length, 4);
  assert.equal(calls.length, 4);
  for (const [command, , options] of calls) {
    assert.equal(command, "git");
    assert.equal(options.cwd, CWD);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.maxOutputBytes, GIT_CAP);
    assert.equal(options.timeout, 3_000);
    assert.equal(options.environment, process.env);
  }
});

test.each(["native", "injected"] as const)(
  "%s Git preserves timeout, failure, spawn-error, and cancellation outcomes",
  async (execution) => {
    for (const result of [
      { ...success(STATUS), killed: true },
      { ...success(STATUS), code: 128, stderr: "not a repository" },
      new Error("spawn git ENOENT"),
    ]) {
      const fixture = gitFixture(execution, () => {
        if (result instanceof Error) throw result;
        return result;
      });
      assert.equal(await fixture.read(), undefined);
    }
    const controller = new AbortController();
    const fixture = gitFixture(execution, async (args) => {
      await Promise.resolve();
      controller.abort();
      return gitOutput(args);
    });
    assert.equal(await fixture.read({ inspectBare: true, signal: controller.signal }), undefined);
    assert.equal(fixture.calls.length, 4);
    const before = fixture.calls.length;
    assert.equal(await fixture.read({ signal: controller.signal }), undefined);
    assert.equal(fixture.calls.length, before);
  },
);

function collector(exec: WorkspaceExec, signal?: AbortSignal): CollectorContext {
  return {
    input: {
      cwd: CWD,
      config: normalizeConfig({ format: "$nodejs" }).config,
      environment: { PATH: "/bin" },
      homeDir: "/home/user",
      platform: "linux",
      hostname: "host",
      username: "user",
      exec,
      signal,
    },
    fs: { readFile: async () => undefined, readDirectory: async () => [], fileExists: async () => false },
    requirements: new Map(),
    entries: async () => [],
    options: () => ({}),
    needs: () => false,
  };
}

test("workspace helper keeps its cap and complete stdout/stderr selection", async () => {
  const calls: Parameters<WorkspaceExec>[] = [];
  const controller = new AbortController();
  const context = collector(async (...args) => {
    calls.push(args);
    return success("v22.1.0\n");
  }, controller.signal);
  assert.equal(await runBounded(context, "node", ["--version"]), "v22.1.0\n");
  assert.deepEqual(calls, [
    [
      "node",
      ["--version"],
      {
        cwd: CWD,
        timeout: 2_000,
        maxOutputBytes: WORKSPACE_CAP,
        signal: controller.signal,
        environment: context.input.environment,
      },
    ],
  ]);
  assert.equal(
    await runBounded(
      collector(async () => ({ ...success(""), stderr: "Python 3.13.2" })),
      "python",
      ["--version"],
    ),
    "Python 3.13.2",
  );
});

test.each([
  { ...success("v22.1.0"), truncated: true },
  { ...success('{"state":{"foundRC":{"path":"/work/.envrc","allowed":0}}}'), truncated: true },
  { ...success('current.change_id = "valid-prefix"\n'), code: 1, killed: true, truncated: true },
  { ...success("v22.1.0"), stderr: "x".repeat(WORKSPACE_CAP) },
  { ...success("v22.1.0"), killed: true },
  { ...success("v22.1.0"), code: 1, stderr: "spawn node ENOENT" },
  new Error("spawn node ENOENT"),
])("workspace helper rejects incomplete or failed metadata %#", async (result) => {
  const context = collector(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  assert.equal(await runBounded(context, "node", ["--version"]), undefined);
});

test("workspace helper stops before execution and after a delayed abort", async () => {
  const controller = new AbortController();
  const exec = vi.fn<WorkspaceExec>(async () => {
    await Promise.resolve();
    controller.abort();
    return success("v22.1.0");
  });
  const context = collector(exec, controller.signal);
  assert.equal(await runBounded(context, "node", ["--version"]), undefined);
  assert.equal(exec.mock.calls.length, 1);
  assert.equal(await runBounded(context, "node", ["--version"]), undefined);
  assert.equal(exec.mock.calls.length, 1);
});

test.each([
  { ...success(PR), truncated: true },
  { ...success(`${PR.slice(0, -1)},"partial":`), truncated: true },
  { ...success(PR), code: 1, killed: true, truncated: true },
  { ...success(PR), stderr: "x".repeat(PR_CAP) },
  { ...success(PR), killed: true },
  { ...success(PR), code: 1, stderr: "spawn gh ENOENT" },
  new Error("spawn gh ENOENT"),
])("PR query rejects incomplete or failed JSON without using valid prefixes %#", async (result) => {
  const exec: WorkspaceExec = async () => {
    if (result instanceof Error) throw result;
    return result;
  };
  assert.equal(await queryGithubPr(exec, CWD), undefined);
});

test("PR query retains its cap and does not parse a successful reply after cancellation", async () => {
  const controller = new AbortController();
  const exec = vi.fn<WorkspaceExec>(async () => {
    await Promise.resolve();
    controller.abort();
    return success(PR);
  });
  assert.equal(await queryGithubPr(exec, CWD, controller.signal), undefined);
  assert.equal(exec.mock.calls.length, 1);
  assert.equal(exec.mock.calls[0]?.[2].maxOutputBytes, PR_CAP);
  assert.equal(exec.mock.calls[0]?.[2].timeout, 10_000);
  assert.equal(exec.mock.calls[0]?.[2].signal, controller.signal);
  assert.equal(await queryGithubPr(exec, CWD, controller.signal), undefined);
  assert.equal(exec.mock.calls.length, 1);
  assert.equal((await queryGithubPr(async () => success(PR), CWD))?.number, "123");
});
