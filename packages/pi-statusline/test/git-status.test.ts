import assert from "node:assert/strict";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { readGitStatus } from "../src/git-status.js";

const completeStatus = "## main...origin/main [ahead 2, behind 1]\n M changed.ts\n";
const summary = { ahead: 2, behind: 1, staged: 0, modified: 1, untracked: 0, conflicts: 0 };
const success = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false, truncated: false });

function piWithExec(exec: ExtensionAPI["exec"]) {
  const mock = createMockPi();
  Object.assign(mock.rawPi, { exec });
  return mock.pi;
}

test("complete status and root probes preserve stdout, timeouts, and cancellation with local combined caps", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
  const controller = new AbortController();
  const pi = piWithExec(async (command, args, options) => {
    calls.push({ command, args, options });
    return success(args[0] === "rev-parse" ? "/workspace/repo\n" : completeStatus);
  });
  assert.deepEqual(await readGitStatus(pi, "/workspace/repo", controller.signal), {
    ...summary,
    root: "/workspace/repo",
  });
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
      options: { cwd: "/workspace/repo", timeout: 3_000, maxBuffer: 1024 * 1024, signal: controller.signal },
    },
    {
      command: "git",
      args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      options: { cwd: "/workspace/repo", timeout: 3_000, maxBuffer: 16 * 1024, signal: controller.signal },
    },
  ]);
});

for (const target of ["status", "root"]) {
  test.each([
    { name: "partial stdout after termination", code: 1, killed: true, partial: true, stderr: "" },
    { name: "partial stdout with a success code", code: 0, killed: false, partial: true, stderr: "" },
    { name: "complete stdout with a success code", code: 0, killed: false, partial: false, stderr: "" },
    {
      name: "stderr overflow with complete stdout",
      code: 0,
      killed: false,
      partial: false,
      stderr: "warning: incomplete diagnostics",
    },
  ])(`truncated Git ${target} $name is not parsed`, async (fixture) => {
    const pi = piWithExec(async (_command, args) => {
      const isRoot = args[0] === "rev-parse";
      const stdout = isRoot ? "/workspace/repo\n" : completeStatus;
      if (isRoot !== (target === "root")) return success(stdout);
      return {
        stdout: fixture.partial ? (isRoot ? "/workspace/re" : `${completeStatus} M partial`) : stdout,
        stderr: fixture.stderr,
        code: fixture.code,
        killed: fixture.killed,
        truncated: true,
      };
    });
    assert.deepEqual(await readGitStatus(pi, "/workspace/repo"), target === "status" ? undefined : summary);
  });

  test.each([
    { name: "timeout", result: { ...success(""), code: 1, killed: true } },
    { name: "spawn failure", result: { ...success(""), code: 1, stderr: "spawn git ENOENT" } },
    { name: "nonzero exit", result: { ...success(""), code: 128, stderr: "not a repository" } },
  ])(`Git ${target} $name remains passive and cannot supply parsed data`, async (fixture) => {
    const pi = piWithExec(async (_command, args) => {
      const isRoot = args[0] === "rev-parse";
      if (isRoot === (target === "root")) return fixture.result;
      return success(isRoot ? "/workspace/repo\n" : completeStatus);
    });
    assert.deepEqual(await readGitStatus(pi, "/workspace/repo"), target === "status" ? undefined : summary);
  });
}

test("a thrown status spawn error remains observable to the owning refresh", async () => {
  const error = new Error("spawn git EACCES");
  const pi = piWithExec(async (_command, args) => {
    if (args[0] !== "rev-parse") throw error;
    return success("/workspace/repo\n");
  });
  await assert.rejects(readGitStatus(pi, "/workspace/repo"), (actual) => actual === error);
});

test("a thrown root spawn error does not discard a complete Git status", async () => {
  const pi = piWithExec(async (_command, args) => {
    if (args[0] === "rev-parse") throw new Error("spawn git EACCES");
    return success(completeStatus);
  });
  assert.deepEqual(await readGitStatus(pi, "/workspace/repo"), summary);
});

test("both Git probes retain the owner's abort signal and return no aborted status", async () => {
  const controller = new AbortController();
  const reason = new DOMException("footer disposed", "AbortError");
  let calls = 0;
  const pi = piWithExec(async (_command, _args, options) => {
    calls += 1;
    assert.equal(options?.signal, controller.signal);
    controller.abort(reason);
    return { stdout: "", stderr: "", code: 1, killed: true, truncated: false };
  });
  assert.equal(await readGitStatus(pi, "/workspace/repo", controller.signal), undefined);
  assert.equal(controller.signal.reason, reason);
  assert.equal(calls, 2);
});
