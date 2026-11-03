import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  addWorktree,
  administrativeHistoryOids,
  administrativePruneCandidates,
  currentWorktreePath,
  durableRefExists,
  durableRefsContaining,
  listWorktrees,
  localBranchExists,
  prunePreview,
  pruneWorktrees,
  removeWorktree,
  resolveCommit,
  symbolicBranch,
  validateBranch,
  worktreeAdministrativeDirectory,
  worktreeInventory,
} from "../src/git.js";
import { oid, porcelain, result } from "./command-test-support.js";

type Executor = Pick<ExtensionAPI, "exec">;

interface Operation {
  name: string;
  maxBuffer: number;
  timeout: number;
  run(pi: Executor, cwd: string, signal: AbortSignal): Promise<unknown>;
  stdout(cwd: string): string;
  expected(cwd: string): unknown;
}

const metadata = 64 * 1024;
const records = 8 * 1024 * 1024;
const mutation = 1024 * 1024;
const operations: Operation[] = [
  {
    name: "worktree list",
    maxBuffer: records,
    timeout: 15_000,
    run: async (pi, cwd, signal) => (await listWorktrees(pi, cwd, signal)).map((record) => record.path),
    stdout: (cwd) => porcelain([{ path: cwd, branch: "main" }]),
    expected: (cwd) => [cwd],
  },
  {
    name: "current path",
    maxBuffer: metadata,
    timeout: 15_000,
    run: currentWorktreePath,
    stdout: (cwd) => `${cwd}\n`,
    expected: (cwd) => cwd,
  },
  {
    name: "symbolic branch",
    maxBuffer: metadata,
    timeout: 15_000,
    run: symbolicBranch,
    stdout: () => "main\n",
    expected: () => "main",
  },
  {
    name: "branch validation",
    maxBuffer: metadata,
    timeout: 15_000,
    run: (pi, cwd, signal) => validateBranch(pi, cwd, "feature", signal),
    stdout: () => "feature\n",
    expected: () => "feature",
  },
  {
    name: "branch existence",
    maxBuffer: metadata,
    timeout: 15_000,
    run: (pi, cwd, signal) => localBranchExists(pi, cwd, "feature", signal),
    stdout: () => "",
    expected: () => true,
  },
  {
    name: "commit resolution",
    maxBuffer: metadata,
    timeout: 15_000,
    run: (pi, cwd, signal) => resolveCommit(pi, cwd, "main", signal),
    stdout: () => `${oid}\n`,
    expected: () => oid,
  },
  {
    name: "worktree add",
    maxBuffer: mutation,
    timeout: 60_000,
    run: (pi, cwd, signal) => addWorktree(pi, cwd, { path: join(cwd, "linked"), branch: "feature" }, signal),
    stdout: () => "Preparing worktree\n",
    expected: () => undefined,
  },
  {
    name: "worktree remove",
    maxBuffer: mutation,
    timeout: 60_000,
    run: (pi, cwd, signal) => removeWorktree(pi, cwd, join(cwd, "linked"), signal),
    stdout: () => "",
    expected: () => undefined,
  },
  {
    name: "removal inventory",
    maxBuffer: records,
    timeout: 15_000,
    run: worktreeInventory,
    stdout: () => "",
    expected: () => [],
  },
  {
    name: "administrative path",
    maxBuffer: metadata,
    timeout: 15_000,
    run: worktreeAdministrativeDirectory,
    stdout: (cwd) => `${cwd}\n`,
    expected: (cwd) => cwd,
  },
  {
    name: "administrative history refs",
    maxBuffer: records,
    timeout: 15_000,
    run: (pi, cwd, signal) => administrativeHistoryOids(pi, cwd, cwd, signal),
    stdout: () => `${oid}\n`,
    expected: () => [oid],
  },
  {
    name: "administrative common path",
    maxBuffer: metadata,
    timeout: 15_000,
    run: administrativePruneCandidates,
    stdout: (cwd) => `${cwd}\n`,
    expected: () => [],
  },
  {
    name: "durable ref existence",
    maxBuffer: metadata,
    timeout: 15_000,
    run: (pi, cwd, signal) => durableRefExists(pi, cwd, "refs/heads/main", signal),
    stdout: () => "",
    expected: () => true,
  },
  {
    name: "durable containing refs",
    maxBuffer: records,
    timeout: 15_000,
    run: (pi, cwd, signal) => durableRefsContaining(pi, cwd, oid, signal),
    stdout: () => "refs/heads/main\n",
    expected: () => ["refs/heads/main"],
  },
  {
    name: "prune preview",
    maxBuffer: records,
    timeout: 15_000,
    run: prunePreview,
    stdout: () => "Removing worktrees/stale\n",
    expected: () => "Removing worktrees/stale",
  },
  {
    name: "worktree prune",
    maxBuffer: mutation,
    timeout: 60_000,
    run: pruneWorktrees,
    stdout: () => "Removing worktrees/stale\n",
    expected: () => "Removing worktrees/stale",
  },
];

for (const operation of operations) {
  test(`${operation.name} forwards its output cap, timeout, cwd, and caller signal`, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-exec-")));
    const signal = new AbortController().signal;
    let calls = 0;
    try {
      const value = await operation.run(
        {
          exec: async (command, _args, options) => {
            calls += 1;
            assert.equal(command, "git");
            assert.deepEqual(options, { cwd, signal, timeout: operation.timeout, maxBuffer: operation.maxBuffer });
            return result(operation.stdout(cwd));
          },
        },
        cwd,
        signal,
      );
      assert.ok(calls > 0);
      assert.deepEqual(value, operation.expected(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`${operation.name} rejects truncated output before success, timeout, or fallback`, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-truncated-")));
    try {
      for (const outcome of [
        { code: 0, killed: false },
        { code: 1, killed: true },
      ]) {
        let calls = 0;
        await assert.rejects(
          operation.run(
            {
              exec: async () => {
                calls += 1;
                return { ...result(operation.stdout(cwd)), ...outcome, truncated: true };
              },
            },
            cwd,
            new AbortController().signal,
          ),
          new RegExp(`output exceeded the ${operation.maxBuffer}-byte limit`),
        );
        assert.equal(calls, 1, "no follow-up query may consume partial data");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const target of ["status", "ls-files", "submodule status", "submodule foreach", "config"]) {
  test(`removal inventory stops on truncated ${target} output`, async () => {
    const calls: string[] = [];
    await assert.rejects(
      worktreeInventory(
        {
          exec: async (_command, args, options) => {
            const key = args[0] === "submodule" ? args.slice(0, 2).join(" ") : (args[0] ?? "");
            calls.push(key);
            assert.equal(options?.maxBuffer, key === "config" ? metadata : records);
            if (key === target) return { ...result("partial", 1), killed: true, truncated: true };
            return result(key === "ls-files" && target === "config" ? "S hidden.txt\0" : "");
          },
        },
        "/repo",
      ),
      /output exceeded/i,
    );
    assert.equal(calls.at(-1), target);
  });
}

test("administrative index checks reject truncated quiet-diff results instead of classifying them", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-worktree-index-exec-"));
  const administrative = join(cwd, "worktrees", "stale");
  mkdirSync(administrative, { recursive: true });
  writeFileSync(join(administrative, "HEAD"), "ref: refs/heads/main\n");
  try {
    for (const code of [0, 1]) {
      await assert.rejects(
        administrativePruneCandidates(
          {
            exec: async (_command, args, options) => {
              assert.equal(options?.maxBuffer, metadata);
              return args[0] === "rev-parse" ? result(`${cwd}\n`) : { ...result("partial", code), truncated: true };
            },
          },
          cwd,
        ),
        /output exceeded/i,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "timeout", value: { ...result(), killed: true }, expected: /timed out or was cancelled/i },
  { name: "abort", value: { ...result(), killed: true }, expected: /timed out or was cancelled/i },
  { name: "spawn result", value: result("", 1, "spawn git ENOENT"), expected: /spawn git ENOENT/ },
  { name: "Git failure", value: result("", 128, "not a git repository"), expected: /not inside a Git repository/i },
  { name: "missing executable", error: new Error("spawn git ENOENT"), expected: /Git executable was not found/i },
  { name: "spawn rejection", error: new Error("spawn EACCES"), expected: /Could not start git.*EACCES/i },
]) {
  test(`bounded Git execution preserves ${scenario.name} diagnostics`, async () => {
    const controller = new AbortController();
    await assert.rejects(
      listWorktrees(
        {
          exec: async (_command, _args, options): Promise<ExecResult> => {
            assert.equal(options?.signal, controller.signal);
            if (scenario.name === "abort") controller.abort();
            if (scenario.error) throw scenario.error;
            assert.ok(scenario.value);
            return scenario.value;
          },
        },
        "/repo",
        controller.signal,
      ),
      scenario.expected,
    );
  });
}

test("allow-failure Git queries retain their ordinary absent-ref and detached-HEAD results", async () => {
  const pi: Executor = { exec: async () => result("", 1) };
  assert.equal(await symbolicBranch(pi, "/repo"), undefined);
  assert.equal(await localBranchExists(pi, "/repo", "missing"), false);
  assert.equal(await durableRefExists(pi, "/repo", "refs/heads/missing"), false);
});
