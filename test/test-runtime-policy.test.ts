import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import vitestConfig from "../vitest.config.js";
import { assertTestTasksWithinCap, assertTestTimeoutWithinCap, maximumTestTimeoutMs } from "./test-timeout-policy.js";

const root = path.resolve(import.meta.dirname, "..");

test("Vitest keeps every test within the repository timeout cap", (context) => {
  const config = readFileSync(path.join(root, "vitest.config.ts"), "utf8");
  assert.match(config, /testTimeout:\s*5_000/u);
  assertTestTimeoutWithinCap(context.task.timeout, context.task.name);
});

test("default integration concurrency uses at most four fork workers", () => {
  assert.equal(vitestConfig.test?.maxWorkers, Math.min(4, os.availableParallelism()));
});

for (const available of [1, 2, 3, 4, 8, 32]) {
  test(`fork concurrency stays within ${available} available CPUs`, async () => {
    vi.resetModules();
    vi.doMock("node:os", () => ({ availableParallelism: () => available }));
    try {
      const { default: config } = await import("../vitest.config.js");
      assert.equal(config.test?.maxWorkers, Math.min(4, available));
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });
}

test("the runtime timeout guard rejects disabled and upward overrides", () => {
  for (const timeout of [1, 4_000, maximumTestTimeoutMs]) {
    assert.doesNotThrow(() => assertTestTimeoutWithinCap(timeout, "bounded"));
  }
  assert.throws(
    () => assertTestTimeoutWithinCap(5_001, "too slow"),
    /"too slow" has a 5001 ms timeout; the maximum is 5000 ms/u,
  );
  assert.throws(
    () => assertTestTimeoutWithinCap(0, "disabled"),
    /"disabled" has a 0 ms timeout; the maximum is 5000 ms/u,
  );
  assert.throws(
    () =>
      assertTestTasksWithinCap([
        {
          name: "skipped suite",
          type: "suite",
          tasks: [{ name: "skipped override", type: "test", timeout: 6_000 }],
        },
      ]),
    /"skipped override" has a 6000 ms timeout; the maximum is 5000 ms/u,
  );
});

test("Vitest fixture commits use command-scoped unsigned Git configuration", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "pi-test-git-policy-"));
  try {
    git(fixture, ["init", "-q"]);
    git(fixture, ["config", "user.name", "Test"]);
    git(fixture, ["config", "user.email", "test@example.invalid"]);
    const origin = git(fixture, ["config", "--show-origin", "--get", "--bool", "commit.gpgsign"]);
    assert.match(origin, /^command line:\s+false$/u);

    writeFileSync(path.join(fixture, "fixture.txt"), "fixture\n");
    git(fixture, ["add", "fixture.txt"]);
    git(fixture, ["commit", "-qm", "unsigned fixture"]);
    assert.doesNotMatch(git(fixture, ["cat-file", "commit", "HEAD"]), /^gpgsig /mu);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
