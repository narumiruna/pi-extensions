import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { createGitContext } from "../src/git-context.js";

const execFileAsync = promisify(execFile);

async function withGitProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-file-context-git-test-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "tracked.ts"), "one\ntwo\nthree\n");
    await writeFile(join(root, "staged.ts"), "initial\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial snapshot");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

test("captures deterministic repository identity and staged, unstaged, and untracked status", async () => {
  await withGitProject(async (root) => {
    await writeFile(join(root, "tracked.ts"), "one\nchanged\nthree\n");
    await writeFile(join(root, "staged.ts"), "staged change\n");
    await git(root, "add", "staged.ts");
    await writeFile(join(root, "untracked.ts"), "new\n");
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, "ignored.ts"), "ignored\n");

    const context = await createGitContext(root);
    assert.ok(context);
    assert.equal(context.project.branch, "main");
    assert.match(context.project.head, /^[0-9a-f]{40}$/);
    assert.equal(context.project.dirty, true);
    assert.deepEqual(context.statuses.get("tracked.ts"), {
      code: " M",
      label: "modified (unstaged)",
      staged: false,
      unstaged: true,
      untracked: false,
      ignored: false,
      conflicted: false,
    });
    assert.equal(context.statuses.get("staged.ts")?.label, "modified (staged)");
    assert.equal(context.statuses.get("untracked.ts")?.label, "untracked");
    assert.equal(context.statuses.get("ignored.ts")?.label, "ignored");
    const fileContext = await context.getFileContext("tracked.ts");
    assert.equal(fileContext.hunks.length, 1);
    assert.deepEqual(fileContext.hunks[0]?.changedLines, [2]);
    assert.ok(fileContext.hunks[0]?.lines.includes("+changed"));
  });
});

test("refreshes file and repository status when a preview is reloaded", async () => {
  await withGitProject(async (root) => {
    const context = await createGitContext(root);
    assert.ok(context);
    assert.equal(context.project.dirty, false);
    assert.equal(context.statuses.get("tracked.ts"), undefined);
    await writeFile(join(root, "tracked.ts"), "edited\ntwo\nthree\n");
    const fileContext = await context.refreshFileContext("tracked.ts");
    assert.equal(fileContext.status?.label, "modified (unstaged)");
    assert.equal(context.statuses.get("tracked.ts")?.label, "modified (unstaged)");
    assert.equal(context.project.dirty, true);
  });
});

test("reports ignored files without marking an otherwise clean repository dirty", async () => {
  await withGitProject(async (root) => {
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-m", "ignore generated file");
    await writeFile(join(root, "ignored.ts"), "generated\n");
    const context = await createGitContext(root);
    assert.ok(context);
    assert.equal(context.statuses.get("ignored.ts")?.label, "ignored");
    assert.equal(context.project.dirty, false);
  });
});

test("loads current-line blame and bounded file history without author email", async () => {
  await withGitProject(async (root) => {
    await writeFile(join(root, "tracked.ts"), "one\nupdated\nthree\n");
    await git(root, "add", "tracked.ts");
    await git(root, "commit", "-m", "update tracked line");

    const context = await createGitContext(root);
    assert.ok(context);
    const blame = await context.getBlame("tracked.ts", 2);
    assert.equal(blame?.author, "Test User");
    assert.equal(blame?.summary, "update tracked line");
    assert.equal(blame?.committed, true);
    assert.equal(JSON.stringify(blame).includes("test@example.com"), false);
    const history = await context.getHistory("tracked.ts");
    assert.deepEqual(
      history.map((entry) => entry.summary),
      ["update tracked line", "initial snapshot"],
    );
  });
});

test("resolves commit and branch revisions before loading bounded file content", async () => {
  await withGitProject(async (root) => {
    const context = await createGitContext(root);
    assert.ok(context);
    const revision = await context.loadRevision("tracked.ts", "main");
    assert.equal(revision.revision, "main");
    assert.match(revision.commit, /^[0-9a-f]{40}$/);
    assert.match(revision.blob ?? "", /^[0-9a-f]{40}$/);
    assert.deepEqual(revision.lines, ["one", "two", "three"]);
    await assert.rejects(context.loadRevision("tracked.ts", "--help"), /Unknown Git revision/);
    await assert.rejects(context.loadRevision("tracked.ts", "missing"), /Unknown Git revision/);
  });
});

test("keeps status, diff, and revision paths relative to a nested project root", async () => {
  await withGitProject(async (root) => {
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    await writeFile(join(root, "packages", "demo", "nested.ts"), "before\n");
    await git(root, "add", "packages/demo/nested.ts");
    await git(root, "commit", "-m", "add nested project");
    await writeFile(join(root, "packages", "demo", "nested.ts"), "after\n");

    const context = await createGitContext(join(root, "packages", "demo"));
    assert.ok(context);
    assert.equal(context.project.projectPrefix, "packages/demo/");
    assert.deepEqual([...context.statuses.keys()], ["nested.ts"]);
    assert.equal(context.statuses.get("nested.ts")?.label, "modified (unstaged)");
    assert.deepEqual((await context.getFileContext("nested.ts")).hunks[0]?.changedLines, [1]);
    assert.deepEqual((await context.loadRevision("nested.ts", "HEAD")).lines, ["before"]);
  });
});

test("does not advance hunk lines for Git no-newline metadata", async () => {
  await withGitProject(async (root) => {
    await writeFile(join(root, "single.txt"), "old");
    await git(root, "add", "single.txt");
    await git(root, "commit", "-m", "add single line");
    await writeFile(join(root, "single.txt"), "new\n");
    const context = await createGitContext(root);
    assert.ok(context);
    const hunk = (await context.getFileContext("single.txt")).hunks[0];
    assert.ok(hunk?.lines.includes("\\ No newline at end of file"));
    assert.deepEqual(hunk?.changedLines, [1]);
  });
});

test("reports children of ignored directories with per-file status", async () => {
  await withGitProject(async (root) => {
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-m", "ignore generated directory");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated", "a.ts"), "generated\n");
    const context = await createGitContext(root);
    assert.ok(context);
    assert.equal(context.statuses.get("generated/a.ts")?.label, "ignored");
  });
});

test("retains followed historical paths when a file was renamed", async () => {
  await withGitProject(async (root) => {
    await writeFile(join(root, "old-name.ts"), "before rename\n");
    await git(root, "add", "old-name.ts");
    await git(root, "commit", "-m", "add old path");
    await git(root, "mv", "old-name.ts", "new-name.ts");
    await git(root, "commit", "-m", "rename path");
    const context = await createGitContext(root);
    assert.ok(context);
    const history = await context.getHistory("new-name.ts");
    const oldEntry = history.find((entry) => entry.summary === "add old path");
    assert.equal(oldEntry?.path, "old-name.ts");
    const revision = await context.loadRevision("new-name.ts", oldEntry?.commit ?? "", oldEntry?.path);
    assert.equal(revision.path, "old-name.ts");
    assert.deepEqual(revision.lines, ["before rename"]);
  });
});

test("returns undefined outside a Git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-file-context-no-git-test-"));
  try {
    assert.equal(await createGitContext(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
