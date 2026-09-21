import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  MAX_DISCOVERED_FILES,
  MAX_MARKDOWN_BYTES,
  MAX_MARKDOWN_LINES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_ERRORS,
  MAX_SESSION_FILES_PER_NOTE,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
} from "../src/constants.js";
import { NotesStorage, normalizeRelativeMarkdownPath } from "../src/storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: ConstructorParameters<typeof NotesStorage>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-notes-storage-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const storage = new NotesStorage(agentDir, options);
  await storage.initialize();
  return { root, agentDir, storage };
}

test("initialization honors the supplied agent directory, preserves content, and recovers from partial setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-notes-init-"));
  roots.push(root);
  const agentDir = join(root, "custom-agent");
  const storage = new NotesStorage(agentDir);
  await storage.initialize();
  await writeFile(join(storage.paths.notes, "kept.md"), "keep", "utf8");
  await writeFile(join(storage.paths.templates, "kept.md"), "template", "utf8");
  await storage.initialize();
  assert.equal(await readFile(join(storage.paths.notes, "kept.md"), "utf8"), "keep");
  assert.equal(await readFile(join(storage.paths.templates, "kept.md"), "utf8"), "template");
  assert.equal(storage.paths.root, join(agentDir, "pi-notes"));

  const partialRoot = join(root, "partial-agent", "pi-notes");
  await mkdir(partialRoot, { recursive: true });
  await writeFile(join(partialRoot, "templates"), "blocking file", "utf8");
  const partial = new NotesStorage(join(root, "partial-agent"));
  await assert.rejects(partial.initialize(), /templates|directory/iu);
  assert.equal((await lstat(join(partialRoot, "notes"))).isDirectory(), true);
  await rm(join(partialRoot, "templates"));
  await partial.initialize();
  assert.equal((await lstat(join(partialRoot, "sessions"))).isDirectory(), true);

  const linkedAgent = join(root, "linked-agent");
  const redirectedRoot = join(root, "redirected-root");
  await mkdir(linkedAgent);
  await mkdir(redirectedRoot);
  await symlink(redirectedRoot, join(linkedAgent, "pi-notes"), "dir");
  await assert.rejects(new NotesStorage(linkedAgent).initialize(), /regular directory/iu);
});

test("discovery keeps raw identities separate from terminal-safe labels and reports invalid entries", async () => {
  const { storage, root } = await fixture();
  await mkdir(join(storage.paths.notes, "nested"));
  await writeFile(join(storage.paths.notes, "nested", "日本語.md"), "# Unicode", "utf8");
  await writeFile(join(storage.paths.notes, "unsafe\u001b]52;c;QQ==\u0007.md"), "safe body", "utf8");
  await writeFile(join(storage.paths.notes, "ignored.txt"), "ignored", "utf8");
  await symlink(join(root, "outside.md"), join(storage.paths.notes, "escape.md"));
  await writeFile(join(root, "outside.md"), "outside", "utf8");
  await writeFile(join(storage.paths.notes, "too-many-lines.md"), "x\n".repeat(MAX_MARKDOWN_LINES), "utf8");

  const result = await storage.discoverNotes();
  assert.deepEqual(
    result.entries.map(({ relativePath }) => relativePath),
    ["nested/日本語.md", "unsafe\u001b]52;c;QQ==\u0007.md"],
  );
  const unsafe = result.entries.find(({ relativePath }) => relativePath.startsWith("unsafe"));
  assert.ok(unsafe);
  assert.equal(unsafe.relativePath.includes("\u001b"), true);
  assert.equal(unsafe.displayPath.includes("\u001b"), false);
  assert.equal((await storage.readNote(unsafe.relativePath)).content, "safe body");
  assert.match(
    result.errors.map(({ relativePath, message }) => `${relativePath}: ${message}`).join("\n"),
    /escape.*symbolic/iu,
  );
  assert.match(
    result.errors.map(({ relativePath, message }) => `${relativePath}: ${message}`).join("\n"),
    /too-many-lines.*line limit/iu,
  );
});

test("operations reject a managed root replaced by a symbolic link after initialization", async () => {
  const { storage, root } = await fixture();
  const outside = join(root, "replacement-root");
  await mkdir(outside);
  await rm(storage.paths.notes, { recursive: true });
  await symlink(outside, storage.paths.notes, "dir");
  await assert.rejects(storage.discoverNotes(), /regular directory/iu);
  await assert.rejects(storage.createNote("escape.md"), /regular directory/iu);
  await assert.rejects(readFile(join(outside, "escape.md")), /ENOENT/u);
});

test("shared limits stay finite and below Pi model-output ceilings", () => {
  assert.ok(MAX_MARKDOWN_BYTES < 50_000);
  assert.ok(MAX_MARKDOWN_LINES < 2_000);
  assert.ok(MAX_DISCOVERED_FILES > 0 && MAX_DISCOVERED_FILES <= 1_000);
  assert.ok(MAX_SCAN_DEPTH > 0 && MAX_SCAN_DEPTH <= 16);
  assert.ok(MAX_SCAN_ERRORS > 0 && MAX_SCAN_ERRORS <= 100);
  assert.ok(MAX_SESSION_FILES_PER_NOTE > 0 && MAX_SESSION_FILES_PER_NOTE <= 100);
  assert.ok(MAX_TRANSCRIPT_MESSAGES > 0 && MAX_TRANSCRIPT_MESSAGES <= 200);
  assert.ok(MAX_TRANSCRIPT_CHARS > 0 && MAX_TRANSCRIPT_CHARS <= 50_000);
});

test("templates are copied exactly and rescanned after add, edit, rename, and removal", async () => {
  const { storage } = await fixture();
  assert.deepEqual((await storage.discoverTemplates()).entries, []);
  await writeFile(join(storage.paths.templates, "draft.md"), "# Draft\n\n{{literal}}\n", "utf8");
  assert.deepEqual(
    (await storage.discoverTemplates()).entries.map(({ relativePath }) => relativePath),
    ["draft.md"],
  );

  const first = await storage.createNote("topics/first.md", { templatePath: "draft.md" });
  assert.equal(first.content, "# Draft\n\n{{literal}}\n");
  await writeFile(join(storage.paths.templates, "draft.md"), "changed", "utf8");
  assert.equal(await storage.readTemplate("draft.md"), "changed");
  await rename(join(storage.paths.templates, "draft.md"), join(storage.paths.templates, "renamed.md"));
  assert.deepEqual(
    (await storage.discoverTemplates()).entries.map(({ relativePath }) => relativePath),
    ["renamed.md"],
  );
  await rm(join(storage.paths.templates, "renamed.md"));
  assert.deepEqual((await storage.discoverTemplates()).entries, []);
  assert.equal((await storage.readNote("topics/first.md")).content, "# Draft\n\n{{literal}}\n");
});

test("safe creation supports Blank and refuses overwrite, traversal, absolute, non-Markdown, and symlink parents", async () => {
  const { storage, root } = await fixture();
  const blank = await storage.createNote("blank.md");
  assert.equal(blank.content, "");
  assert.equal((await lstat(join(storage.paths.notes, "blank.md"))).mode & 0o777, 0o600);
  await assert.rejects(storage.createNote("blank.md"), /already exists/iu);

  for (const invalid of ["../escape.md", "/absolute.md", "C:\\absolute.md", "plain.txt", "a//b.md", "x\u0007.md"]) {
    assert.throws(() => normalizeRelativeMarkdownPath(invalid));
  }

  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(storage.paths.notes, "linked"));
  await assert.rejects(storage.createNote("linked/escape.md"), /symbolic|canonical|escapes/iu);
  await assert.rejects(readFile(join(outside, "escape.md")), /ENOENT/u);
});

test("note edits require current revisions and unique exact text", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.notes, "edit.md"), "one two one\n", "utf8");
  const initial = await storage.readNote("edit.md");
  await assert.rejects(storage.editNote("edit.md", initial.revision, "one", "ONE"), /not unique/iu);
  const edited = await storage.editNote("edit.md", initial.revision, "two", "TWO");
  assert.equal(edited.content, "one TWO one\n");
  await assert.rejects(storage.replaceNote("edit.md", initial.revision, "stale"), /stale/iu);
  assert.equal((await storage.readNote("edit.md")).content, "one TWO one\n");
});

test("same-process concurrent writes serialize and only one stale revision publishes", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.notes, "race.md"), "base", "utf8");
  const initial = await storage.readNote("race.md");
  const results = await Promise.allSettled([
    storage.replaceNote("race.md", initial.revision, "first"),
    storage.replaceNote("race.md", initial.revision, "second"),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.match((await storage.readNote("race.md")).content, /^(first|second)$/u);
});

test("failed atomic publication preserves prior content and removes temporary files", async () => {
  const base = await fixture();
  await writeFile(join(base.storage.paths.notes, "kept.md"), "old", "utf8");
  const failing = new NotesStorage(base.agentDir, {
    beforePublish: () => {
      throw new Error("publish failed");
    },
  });
  await failing.initialize();
  const current = await failing.readNote("kept.md");
  await assert.rejects(failing.replaceNote("kept.md", current.revision, "new"), /publish failed/iu);
  assert.equal((await failing.readNote("kept.md")).content, "old");
  await assert.rejects(failing.createNote("never.md"), /publish failed/iu);
  await assert.rejects(readFile(join(failing.paths.notes, "never.md")), /ENOENT/u);
  assert.equal(
    (await readdir(failing.paths.notes)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("content and cancellation limits fail before publication", async () => {
  const { storage } = await fixture();
  await assert.rejects(storage.createNote("oversized.md", { templatePath: "missing.md" }), /ENOENT|no such/iu);
  await writeFile(join(storage.paths.notes, "limit.md"), "ok", "utf8");
  const note = await storage.readNote("limit.md");
  await assert.rejects(
    storage.replaceNote("limit.md", note.revision, "x".repeat(MAX_MARKDOWN_BYTES + 1)),
    /byte limit/iu,
  );
  await assert.rejects(
    storage.replaceNote("limit.md", note.revision, "x\n".repeat(MAX_MARKDOWN_LINES)),
    /line limit/iu,
  );

  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(storage.createNote("cancelled.md", { signal: controller.signal }), /cancelled|aborted/iu);
  await assert.rejects(readFile(join(storage.paths.notes, "cancelled.md")), /ENOENT/u);
  assert.equal((await storage.readNote("limit.md")).content, "ok");
});
