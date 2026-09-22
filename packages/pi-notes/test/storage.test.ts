import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
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
import { NotesStorage, normalizeRelativeMarkdownPath, noteSessionKey } from "../src/storage.js";

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

test("canonical note paths resolve exactly and reject missing, traversal, special, and symbolic-link entries", async () => {
  const { storage, root } = await fixture();
  const notePath = join(storage.paths.notes, "nested", "note.md");
  await mkdir(join(storage.paths.notes, "nested"));
  await writeFile(notePath, "# Note", "utf8");
  assert.equal(await storage.resolveCanonicalNotePath("nested/note.md"), await realpath(notePath));

  await mkdir(join(storage.paths.notes, "directory.md"));
  const outside = join(root, "outside.md");
  await writeFile(outside, "outside", "utf8");
  await symlink(outside, join(storage.paths.notes, "linked.md"));

  await assert.rejects(storage.resolveCanonicalNotePath("missing.md"), /ENOENT|no such/iu);
  await assert.rejects(storage.resolveCanonicalNotePath("../outside.md"), /relative|segments/iu);
  await assert.rejects(storage.resolveCanonicalNotePath(outside), /relative/iu);
  await assert.rejects(storage.resolveCanonicalNotePath("directory.md"), /regular file/iu);
  await assert.rejects(storage.resolveCanonicalNotePath("linked.md"), /symbolic link/iu);
});

test("note deletion requires the current revision and rejects cancellation, traversal, and symbolic links", async () => {
  const { storage, root } = await fixture();
  const notePath = join(storage.paths.notes, "delete.md");
  await writeFile(notePath, "original", "utf8");
  const original = await storage.readNote("delete.md");

  await writeFile(notePath, "external", "utf8");
  await assert.rejects(storage.deleteNote("delete.md", original.revision), /stale|changed/iu);
  assert.equal((await storage.readNote("delete.md")).content, "external");

  const current = await storage.readNote("delete.md");
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled deletion", "AbortError"));
  await assert.rejects(storage.deleteNote("delete.md", current.revision, controller.signal), /cancelled deletion/iu);
  await assert.rejects(storage.deleteNote("../outside.md", current.revision), /relative|segments/iu);

  const outside = join(root, "outside-delete.md");
  await writeFile(outside, "outside", "utf8");
  await symlink(outside, join(storage.paths.notes, "linked-delete.md"));
  await assert.rejects(storage.deleteNote("linked-delete.md", current.revision), /symbolic link/iu);
  assert.equal(await readFile(outside, "utf8"), "outside");

  await storage.deleteNote("delete.md", current.revision);
  await assert.rejects(storage.readNote("delete.md"), /ENOENT|no such/iu);
});

test("concurrent note deletion and replacement serialize without deleting a newer revision", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.notes, "race-delete.md"), "base", "utf8");
  const initial = await storage.readNote("race-delete.md");

  const results = await Promise.allSettled([
    storage.deleteNote("race-delete.md", initial.revision),
    storage.replaceNote("race-delete.md", initial.revision, "replacement"),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  try {
    assert.equal((await storage.readNote("race-delete.md")).content, "replacement");
  } catch (error) {
    assert.match(String(error), /ENOENT|no such/iu);
  }
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
  assert.equal((await storage.readTemplate("draft.md")).content, "changed");
  await rename(join(storage.paths.templates, "draft.md"), join(storage.paths.templates, "renamed.md"));
  assert.deepEqual(
    (await storage.discoverTemplates()).entries.map(({ relativePath }) => relativePath),
    ["renamed.md"],
  );
  await rm(join(storage.paths.templates, "renamed.md"));
  assert.deepEqual((await storage.discoverTemplates()).entries, []);
  assert.equal((await storage.readNote("topics/first.md")).content, "# Draft\n\n{{literal}}\n");
});

test("template snapshots preserve exact content and replacement rejects stale concurrent writes", async () => {
  const { storage } = await fixture();
  const templatePath = join(storage.paths.templates, "nested", "draft.md");
  const initialContent = "# Draft\n\n  keep whitespace  \n{{literal}}\n";
  await mkdir(join(storage.paths.templates, "nested"));
  await writeFile(templatePath, initialContent, "utf8");

  const initial = await storage.readTemplate("nested/draft.md");
  assert.equal(initial.relativePath, "nested/draft.md");
  assert.equal(initial.content, initialContent);
  assert.equal(initial.size, Buffer.byteLength(initialContent, "utf8"));
  const results = await Promise.allSettled([
    storage.replaceTemplate(initial.relativePath, initial.revision, "first replacement\n"),
    storage.replaceTemplate(initial.relativePath, initial.revision, "second replacement\n"),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.match((await storage.readTemplate(initial.relativePath)).content, /^(first|second) replacement\n$/u);
});

test("template replacement rejects cancellation, limits, traversal, special files, and symbolic links", async () => {
  const { storage, root, agentDir } = await fixture();
  await writeFile(join(storage.paths.templates, "kept.md"), "kept", "utf8");
  const kept = await storage.readTemplate("kept.md");
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(
    storage.replaceTemplate("kept.md", kept.revision, "cancelled", controller.signal),
    /cancelled|aborted/iu,
  );

  const publicationController = new AbortController();
  const cancelling = new NotesStorage(agentDir, {
    beforePublish: () => publicationController.abort(new DOMException("cancelled publication", "AbortError")),
  });
  await cancelling.initialize();
  await assert.rejects(
    cancelling.replaceTemplate("kept.md", kept.revision, "cancelled", publicationController.signal),
    /cancelled publication/iu,
  );
  assert.equal((await cancelling.readTemplate("kept.md")).content, "kept");
  assert.equal(
    (await readdir(cancelling.paths.templates)).some((name) => name.endsWith(".tmp")),
    false,
  );

  await assert.rejects(
    storage.replaceTemplate("kept.md", kept.revision, "x".repeat(MAX_MARKDOWN_BYTES + 1)),
    /byte limit/iu,
  );
  await assert.rejects(storage.readTemplate("../escape.md"), /relative|segments/iu);
  await assert.rejects(storage.replaceTemplate("/absolute.md", kept.revision, "escape"), /relative/iu);

  await mkdir(join(storage.paths.templates, "directory.md"));
  const outside = join(root, "outside-template.md");
  await writeFile(outside, "outside", "utf8");
  await symlink(outside, join(storage.paths.templates, "linked.md"));
  await assert.rejects(storage.readTemplate("directory.md"), /regular file/iu);
  await assert.rejects(storage.readTemplate("linked.md"), /symbolic link/iu);
  assert.equal((await storage.readTemplate("kept.md")).content, "kept");
  assert.equal(
    (await readdir(storage.paths.templates)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("failed or stale template publication preserves external content and removes temporary files", async () => {
  const base = await fixture();
  const templatePath = join(base.storage.paths.templates, "kept.md");
  await writeFile(templatePath, "old", "utf8");
  const failing = new NotesStorage(base.agentDir, {
    beforePublish: () => {
      throw new Error("publish failed");
    },
  });
  await failing.initialize();
  const current = await failing.readTemplate("kept.md");
  await assert.rejects(failing.replaceTemplate("kept.md", current.revision, "new"), /publish failed/iu);
  assert.equal((await failing.readTemplate("kept.md")).content, "old");
  assert.equal(
    (await readdir(failing.paths.templates)).some((name) => name.endsWith(".tmp")),
    false,
  );

  const racing = new NotesStorage(base.agentDir, {
    beforePublish: async () => {
      await writeFile(templatePath, "external", "utf8");
    },
  });
  await racing.initialize();
  const beforeRace = await racing.readTemplate("kept.md");
  await assert.rejects(
    racing.replaceTemplate("kept.md", beforeRace.revision, "replacement"),
    /changed before publication/iu,
  );
  assert.equal((await racing.readTemplate("kept.md")).content, "external");
  assert.equal(
    (await readdir(racing.paths.templates)).some((name) => name.endsWith(".tmp")),
    false,
  );
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

test("automatic creation chooses collision-safe temporary names without prompting for a path", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.notes, "untitled.md"), "existing", "utf8");
  await mkdir(join(storage.paths.sessions, noteSessionKey("untitled-2.md")));
  await writeFile(join(storage.paths.templates, "draft.md"), "# Draft\n", "utf8");

  const created = await Promise.all([
    storage.createAutomaticNote(),
    storage.createAutomaticNote({ templatePath: "draft.md" }),
  ]);

  assert.deepEqual(created.map(({ relativePath }) => relativePath).sort(), ["untitled-3.md", "untitled-4.md"]);
  assert.deepEqual(created.map(({ content }) => content).sort(), ["", "# Draft\n"]);
  assert.equal(await readFile(join(storage.paths.notes, "untitled.md"), "utf8"), "existing");
});

test("automatic creation uses a generated fallback after every numbered path has history", async () => {
  const { storage } = await fixture();
  await Promise.all(
    Array.from({ length: MAX_DISCOVERED_FILES + 1 }, (_, offset) => {
      const index = offset + 1;
      const relativePath = index === 1 ? "untitled.md" : `untitled-${index}.md`;
      return mkdir(join(storage.paths.sessions, noteSessionKey(relativePath)));
    }),
  );

  const created = await storage.createAutomaticNote();

  assert.match(
    created.relativePath,
    /^untitled-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/u,
  );
  assert.equal((await storage.readNote(created.relativePath)).content, "");
});

test("same-process concurrent creation publishes once without overwriting the winner", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.templates, "first.md"), "first", "utf8");
  await writeFile(join(storage.paths.templates, "second.md"), "second", "utf8");

  const results = await Promise.allSettled([
    storage.createNote("nested/race.md", { templatePath: "first.md" }),
    storage.createNote("nested/race.md", { templatePath: "second.md" }),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.match((await storage.readNote("nested/race.md")).content, /^(first|second)$/u);
});

test("concurrent differently cased destination aliases serialize before publication", async () => {
  let activePublications = 0;
  let maximumActivePublications = 0;
  const { storage } = await fixture({
    beforePublish: async () => {
      activePublications += 1;
      maximumActivePublications = Math.max(maximumActivePublications, activePublications);
      try {
        for (let turn = 0; turn < 50; turn += 1) await waitForImmediate();
      } finally {
        activePublications -= 1;
      }
    },
  });
  await writeFile(join(storage.paths.templates, "first.md"), "first", "utf8");
  await writeFile(join(storage.paths.templates, "second.md"), "second", "utf8");

  const results = await Promise.allSettled([
    storage.createNote("Case.md", { templatePath: "first.md" }),
    storage.createNote("case.md", { templatePath: "second.md" }),
  ]);

  assert.equal(maximumActivePublications, 1);
  assert.ok(results.some(({ status }) => status === "fulfilled"));
  for (const result of results) {
    if (result.status === "rejected") assert.match(String(result.reason), /already exists/iu);
  }
});

test("concurrent creation revalidates a shared parent directory after mkdir races", async () => {
  const { storage } = await fixture();
  const paths = Array.from({ length: 20 }, (_, index) => `shared/note-${index}.md`);

  await Promise.all(paths.map((relativePath) => storage.createNote(relativePath)));

  assert.deepEqual(
    (await storage.discoverNotes()).entries.map(({ relativePath }) => relativePath),
    paths.sort(),
  );
});

test("creation rechecks the destination before rename without overwriting an external file", async () => {
  const base = await fixture();
  const racing = new NotesStorage(base.agentDir, {
    beforePublish: async (targetPath) => {
      await writeFile(targetPath, "external", "utf8");
    },
  });
  await racing.initialize();

  await assert.rejects(racing.createNote("race.md"), /already exists/iu);
  assert.equal(await readFile(join(racing.paths.notes, "race.md"), "utf8"), "external");
  assert.equal(
    (await readdir(racing.paths.notes)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("note rename preserves content and rejects stale, conflicting, unsafe, and cancelled destinations", async () => {
  const { storage, root } = await fixture();
  await writeFile(join(storage.paths.notes, "source.md"), "# Source\n", "utf8");
  await writeFile(join(storage.paths.notes, "existing.md"), "# Existing\n", "utf8");
  const source = await storage.readNote("source.md");

  await assert.rejects(storage.renameNote("source.md", "stale", "stale.md"), /stale/iu);
  await assert.rejects(storage.renameNote("source.md", source.revision, "existing.md"), /already exists/iu);
  await assert.rejects(storage.renameNote("source.md", source.revision, "../escape.md"), /relative|segments/iu);

  const outside = join(root, "rename-outside");
  await mkdir(outside);
  await symlink(outside, join(storage.paths.notes, "linked-rename"), "dir");
  await assert.rejects(
    storage.renameNote("source.md", source.revision, "linked-rename/escape.md"),
    /symbolic|canonical|escapes/iu,
  );

  const controller = new AbortController();
  controller.abort(new DOMException("cancelled rename", "AbortError"));
  await assert.rejects(
    storage.renameNote("source.md", source.revision, "cancelled.md", controller.signal),
    /cancelled rename/iu,
  );

  const renamed = await storage.renameNote("source.md", source.revision, "topics/descriptive.md");
  assert.equal(renamed.relativePath, "topics/descriptive.md");
  assert.equal(renamed.content, "# Source\n");
  await assert.rejects(storage.readNote("source.md"), /ENOENT|no such/iu);
  assert.equal((await storage.readNote("topics/descriptive.md")).content, "# Source\n");
  assert.equal((await storage.readNote("existing.md")).content, "# Existing\n");
  await assert.rejects(
    storage.renameNote("topics/descriptive.md", renamed.revision, "topics/descriptive.md"),
    /already named/iu,
  );
});

test("note rename accepts the discovery depth boundary and rejects deeper destinations", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.notes, "visible-source.md"), "visible", "utf8");
  const visibleSource = await storage.readNote("visible-source.md");
  const visiblePath = `${Array.from({ length: MAX_SCAN_DEPTH }, (_, index) => `level-${index}`).join("/")}/visible.md`;

  const renamed = await storage.renameNote("visible-source.md", visibleSource.revision, visiblePath);
  assert.equal(renamed.relativePath, visiblePath);
  assert.deepEqual(
    (await storage.discoverNotes()).entries.map(({ relativePath }) => relativePath),
    [visiblePath],
  );

  await writeFile(join(storage.paths.notes, "hidden-source.md"), "hidden", "utf8");
  const hiddenSource = await storage.readNote("hidden-source.md");
  const hiddenPath = `${Array.from({ length: MAX_SCAN_DEPTH + 1 }, (_, index) => `too-deep-${index}`).join("/")}/hidden.md`;

  await assert.rejects(
    storage.renameNote("hidden-source.md", hiddenSource.revision, hiddenPath),
    new RegExp(`at most ${MAX_SCAN_DEPTH} parent directories`, "iu"),
  );
  assert.equal((await storage.readNote("hidden-source.md")).content, "hidden");
});

test("concurrent note renames publish one destination without duplicating or overwriting content", async () => {
  const { storage } = await fixture();
  await writeFile(join(storage.paths.notes, "source.md"), "source", "utf8");
  const source = await storage.readNote("source.md");

  const results = await Promise.allSettled([
    storage.renameNote("source.md", source.revision, "first.md"),
    storage.renameNote("source.md", source.revision, "second.md"),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  const discovered = await storage.discoverNotes();
  assert.deepEqual(
    discovered.entries.map(({ relativePath }) => relativePath),
    [results[0]?.status === "fulfilled" ? "first.md" : "second.md"],
  );
  assert.equal((await storage.readNote(discovered.entries[0]?.relativePath ?? "missing.md")).content, "source");
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

test("all existing-note mutations share the canonical root queue before publication", async () => {
  let activePublications = 0;
  let maximumActivePublications = 0;
  const { storage } = await fixture({
    beforePublish: async () => {
      activePublications += 1;
      maximumActivePublications = Math.max(maximumActivePublications, activePublications);
      try {
        for (let turn = 0; turn < 50; turn += 1) await waitForImmediate();
      } finally {
        activePublications -= 1;
      }
    },
  });
  await writeFile(join(storage.paths.notes, "first.md"), "first", "utf8");
  await writeFile(join(storage.paths.notes, "second.md"), "second", "utf8");
  const first = await storage.readNote("first.md");
  const second = await storage.readNote("second.md");

  await Promise.all([
    storage.editNote("first.md", first.revision, "first", "edited"),
    storage.replaceNote("second.md", second.revision, "replaced"),
  ]);

  assert.equal(maximumActivePublications, 1);
  assert.equal((await storage.readNote("first.md")).content, "edited");
  assert.equal((await storage.readNote("second.md")).content, "replaced");
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
  await assert.rejects(storage.createAutomaticNote({ signal: controller.signal }), /cancelled|aborted/iu);
  await assert.rejects(readFile(join(storage.paths.notes, "cancelled.md")), /ENOENT/u);
  assert.equal((await storage.readNote("limit.md")).content, "ok");
});
