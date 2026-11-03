import assert from "node:assert/strict";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { resolveGitMetadata } from "../src/git.js";

function result(stdout: string, overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false, truncated: false, ...overrides };
}

test.each([
  { truncated: true },
  { truncated: true, killed: true, code: 1 },
  { truncated: true, code: 1 },
  { killed: true },
  { code: 1, killed: true },
  { code: 128, stderr: "spawn git ENOENT" },
])("Git metadata omits an incomplete or failed branch: %j", async (failure) => {
  const metadata = await resolveGitMetadata(
    async (_command, args) => (args[0] === "symbolic-ref" ? result("main\n", failure) : result("0123456789ab\n")),
    "/workspace",
  );
  assert.equal(metadata, undefined);
});

test.each([
  { truncated: true },
  { truncated: true, killed: true, code: 1 },
  { killed: true },
  { code: 1, stderr: "spawn git ENOENT" },
])("Git metadata omits an incomplete or failed commit: %j", async (failure) => {
  for (const detached of [false, true]) {
    const metadata = await resolveGitMetadata(
      async (_command, args) =>
        args[0] === "symbolic-ref"
          ? detached
            ? result("", { code: 1 })
            : result("main\n")
          : result("0123456789ab\n", failure),
      "/workspace",
    );
    assert.deepEqual(metadata, detached ? undefined : { branch: "main", detached: false });
  }
});
