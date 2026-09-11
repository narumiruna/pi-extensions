import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseGitBlobBatch, readGitBlobs, runGit } from "../src/backends/git/git-runner.js";

test("Git runner strips inherited Git control variables and closes stdin", async () => {
  const previous = process.env.GIT_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-git-env-"));
  process.env.GIT_DIR = "/credential-bearing/untrusted/repository";
  try {
    const variableNames = ["GIT_DIR", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_ASKPASS", "SSH_ASKPASS"];
    const format = variableNames.map((name) => `${name}=%s`).join("\\n");
    const expansionStart = "$" + "{";
    const shellArguments = variableNames.map((name) => `"${expansionStart}${name}-}"`).join(" ");
    const dumpEnvironment = `!printf '${format}\\n' ${shellArguments}`;
    const result = await runGit(["-c", `alias.dump=${dumpEnvironment}`, "dump"], {
      cwd: root,
      env: {
        GIT_DIR: "/another/untrusted/repository",
        GIT_TERMINAL_PROMPT: "1",
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_ASKPASS: "evil",
      },
    });
    assert.equal(
      result.stdout.toString("utf8"),
      ["GIT_DIR=", "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_ASKPASS=", "SSH_ASKPASS=", ""].join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test("Git runner reports a missing executable without hanging", async () => {
  await assert.rejects(runGit(["--version"], { env: { PATH: "" } }), /ENOENT|spawn git/i);
});

test("Git runner bounds time and honors caller cancellation", async () => {
  await assert.rejects(runGit(["-c", "alias.wait=!sleep 10", "wait"], { timeoutMs: 20 }), /timed out/i);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 20);
  await assert.rejects(
    runGit(["-c", "alias.wait=!sleep 10", "wait"], { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("Git runner parses bounded binary cat-file batches", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-git-batch-"));
  const gitDir = path.join(root, "repository.git");
  try {
    execFileSync("git", ["init", "--bare", gitDir], { stdio: "ignore" });
    const first = execFileSync("git", ["--git-dir", gitDir, "hash-object", "-w", "--stdin"], {
      input: Buffer.from("one\nline\n"),
      encoding: "utf8",
    }).trim();
    const second = execFileSync("git", ["--git-dir", gitDir, "hash-object", "-w", "--stdin"], {
      input: Buffer.from([0, 1, 2, 10, 255]),
      encoding: "utf8",
    }).trim();
    assert.deepEqual(await readGitBlobs([first, second], { gitDir, maxOutputBytes: 1024 }), [
      Buffer.from("one\nline\n"),
      Buffer.from([0, 1, 2, 10, 255]),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git batch parser rejects missing, malformed, truncated, extra, and oversized data", () => {
  assert.throws(() => parseGitBlobBatch(Buffer.from("deadbeef missing\n"), 1, 1024), /missing/i);
  assert.throws(() => parseGitBlobBatch(Buffer.from("bad header\n"), 1, 1024), /malformed/i);
  assert.throws(() => parseGitBlobBatch(Buffer.from(`${"a".repeat(40)} blob 5\nabc\n`), 1, 1024), /truncated/i);
  assert.throws(() => parseGitBlobBatch(Buffer.from(`${"a".repeat(40)} blob 1\na\nextra`), 1, 1024), /trailing/i);
  assert.throws(() => parseGitBlobBatch(Buffer.from(`${"a".repeat(40)} blob 2\nab\n`), 1, 1), /exceeds/i);
});

test("Git runner rejects output beyond its configured bound", async () => {
  if (process.platform === "win32") return;
  await assert.rejects(runGit(["-c", "alias.spam=!yes pi-sync", "spam"], { maxOutputBytes: 128 }), /output exceeds/i);
});
