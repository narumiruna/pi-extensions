import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { type LoadedStarshipConfig, loadStarshipConfig } from "../src/config.js";
import { createSettingsDraft } from "../src/settings-draft.js";
import { settingsSnapshots } from "../src/settings-snapshots.js";

const packageRoot = resolve(import.meta.dirname, "..");
function fixture(baseline: Buffer | undefined = Buffer.from("# retained\nformat = '$model'\nunknown_field = 42\n")) {
  const root = mkdtempSync(join(tmpdir(), "starship-draft-test-"));
  const settingsPath = join(root, "pi-starship.toml");
  if (baseline) writeFileSync(settingsPath, baseline);
  const previews: LoadedStarshipConfig[] = [];
  let current = true;
  const draft = createSettingsDraft({
    settingsPath,
    baseline,
    packageRoot,
    snapshots: settingsSnapshots(loadStarshipConfig(settingsPath), settingsPath, undefined),
    isCurrent: () => current,
    onPreview: (loaded) => previews.push(loaded),
  });
  const [read, write, edit] = draft.tools;
  return {
    root,
    settingsPath,
    draft,
    read,
    write,
    edit,
    previews,
    stale() {
      current = false;
    },
    dispose() {
      draft.dispose();
      rmSync(root, { force: true, recursive: true });
    },
  };
}

test("tools retain core editing semantics and preview only validated private drafts", async () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.draft.tools.map((tool) => tool.name),
      ["read", "write", "edit"],
    );
    if (process.platform !== "win32") assert.equal(statSync(f.draft.path).mode & 0o777, 0o600);
    const original = readFileSync(f.settingsPath, "utf8");
    const result = await f.edit.execute("edit", {
      path: f.draft.path,
      edits: [{ oldText: "$model", newText: "$directory" }],
    });
    assert.ok(result.content.some((part) => part.type === "text" && /Preview updated|warning/u.test(part.text)));
    assert.match(f.draft.rawDocument, /# retained/u);
    assert.match(f.draft.rawDocument, /unknown_field = 42/u);
    assert.match(f.draft.candidate?.rawDocument ?? "", /\$directory/u);
    assert.equal(readFileSync(f.settingsPath, "utf8"), original);
    await assert.rejects(
      f.edit.execute("edit", { path: f.draft.path, edits: [{ oldText: "absent", newText: "x" }] }),
      /not find|Could not|not found/iu,
    );
    const lastPreview = f.previews.at(-1);
    await assert.rejects(f.write.execute("write", { path: f.draft.path, content: "format = [" }), /preview rejected/u);
    assert.equal(f.draft.rawDocument, "format = [");
    assert.equal(f.draft.candidate, undefined);
    assert.equal(f.previews.at(-1), lastPreview);
    await f.write.execute("write", { path: f.draft.path, content: "format = '$model'\n" });
    assert.ok(f.draft.candidate);
    const revision = f.draft.revision;
    f.draft.assertRevision(revision);
    await f.write.execute("write", { path: f.draft.path, content: "format = '$directory'\n" });
    assert.throws(() => f.draft.assertRevision(revision), /changed after review/u);
  } finally {
    f.dispose();
  }
});

test("read sees immutable active bytes and only approved bundled documents", async () => {
  const f = fixture();
  try {
    const snapshot = readFileSync(f.settingsPath, "utf8");
    writeFileSync(f.settingsPath, "changed externally");
    const read = await f.read.execute("read", { path: f.settingsPath });
    assert.equal(read.content[0]?.type === "text" && read.content[0].text, snapshot);
    for (const path of [
      join(packageRoot, "skills/configure-pi-starship/SKILL.md"),
      join(packageRoot, "src/config.ts"),
    ]) {
      const result = await f.read.execute("read", { path, limit: 3 });
      assert.ok(result.content.length);
    }
    const secret = join(f.root, "secret");
    writeFileSync(secret, "secret");
    await assert.rejects(f.read.execute("read", { path: secret }), /limited/u);
    const alias = join(f.draft.directory, "alias");
    symlinkSync(secret, alias);
    await assert.rejects(f.read.execute("read", { path: alias }), /limited/u);
    for (const target of [
      f.settingsPath,
      secret,
      alias,
      join(f.draft.directory, "../secret"),
      join(f.draft.directory, "sub", "other"),
    ]) {
      await assert.rejects(f.write.execute("write", { path: target, content: "bad" }));
      await assert.rejects(f.edit.execute("edit", { path: target, edits: [{ oldText: "secret", newText: "bad" }] }));
    }
    assert.equal(readFileSync(secret, "utf8"), "secret");
    unlinkSync(f.draft.path);
    symlinkSync(secret, f.draft.path);
    await assert.rejects(f.write.execute("write", { path: f.draft.path, content: "bad" }), /owned/u);
    assert.equal(readFileSync(secret, "utf8"), "secret");
  } finally {
    f.dispose();
  }
});

test("hard-linked drafts cannot change another file", async () => {
  const f = fixture();
  try {
    const secret = join(f.root, "secret");
    writeFileSync(secret, "secret");
    unlinkSync(f.draft.path);
    linkSync(secret, f.draft.path);
    await assert.rejects(f.read.execute("read", { path: f.draft.path }), /private regular/u);
    await assert.rejects(f.write.execute("write", { path: f.draft.path, content: "bad" }), /private regular/u);
    assert.equal(readFileSync(secret, "utf8"), "secret");
  } finally {
    f.dispose();
  }
});

test("missing and malformed originals remain untouched; cancellation and disposal reject tools", async () => {
  for (const baseline of [undefined, Buffer.from("format = [")]) {
    const root = mkdtempSync(join(tmpdir(), "starship-original-test-"));
    const settingsPath = join(root, "pi-starship.toml");
    if (baseline) writeFileSync(settingsPath, baseline);
    let current = true;
    const draft = createSettingsDraft({
      settingsPath,
      baseline,
      packageRoot,
      isCurrent: () => current,
      onPreview() {},
    });
    try {
      assert.equal(existsSync(settingsPath), baseline !== undefined);
      if (baseline) assert.equal(draft.rawDocument, baseline.toString());
      current = false;
      await assert.rejects(
        draft.tools[1].execute("write", { path: draft.path, content: "format = '$model'" }),
        /owner/u,
      );
      draft.dispose();
      draft.dispose();
      assert.equal(existsSync(draft.directory), false);
      assert.equal(existsSync(settingsPath), baseline !== undefined);
    } finally {
      draft.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "cleanup failure disables tools and can be retried after permissions recover",
  async () => {
    const f = fixture();
    try {
      const active = readFileSync(f.settingsPath);
      const revision = f.draft.revision;
      chmodSync(f.draft.directory, 0o500);
      // Recursive removal can report a child permission error or ENOTEMPTY on
      // its parent. The contract is an observable failure, not a specific errno.
      assert.throws(() => f.draft.dispose(), Error);
      assert.equal(existsSync(f.draft.directory), true);
      assert.equal(existsSync(f.draft.path), true);
      await assert.rejects(f.read.execute("closed", { path: f.draft.path }), /owner/u);
      await assert.rejects(f.write.execute("closed", { path: f.draft.path, content: "bad" }), /owner/u);
      await assert.rejects(
        f.edit.execute("closed", { path: f.draft.path, edits: [{ oldText: "$model", newText: "$directory" }] }),
        /owner/u,
      );
      assert.throws(() => f.draft.rawDocument, /owner/u);
      assert.throws(() => f.draft.assertRevision(revision), /owner/u);
      assert.deepEqual(readFileSync(f.settingsPath), active);
      chmodSync(f.draft.directory, 0o700);
      f.draft.dispose();
      f.draft.dispose();
      assert.equal(existsSync(f.draft.directory), false);
      await assert.rejects(f.read.execute("removed", { path: f.draft.path }), /owner/u);
    } finally {
      if (existsSync(f.draft.directory)) chmodSync(f.draft.directory, 0o700);
      f.dispose();
    }
  },
);

test("active snapshots stay immutable, read-only, and session-owned across draft edits", async () => {
  const f = fixture();
  const readText = async (path: string) => {
    const result = await f.read.execute("snapshot", { path });
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  };
  try {
    assert.equal(f.draft.snapshotPaths.length, 4);
    const initial = await Promise.all(f.draft.snapshotPaths.map(readText));
    assert.match(initial[0], /# retained.*unknown_field = 42/su);
    assert.match(initial[1], /\[brand\]/u);
    assert.doesNotMatch(initial[1], /# retained|unknown_field/u);
    assert.equal(JSON.parse(initial[2]).path, f.settingsPath);
    assert.equal(JSON.parse(initial[3]).available, false);
    assert.match(JSON.parse(initial[3]).reason, /unavailable/u);
    writeFileSync(f.settingsPath, "external change");
    await f.write.execute("draft", { path: f.draft.path, content: "format = '$directory'\n" });
    assert.deepEqual(await Promise.all(f.draft.snapshotPaths.map(readText)), initial);
    for (const path of f.draft.snapshotPaths) {
      await assert.rejects(f.write.execute("bad", { path, content: "bad" }));
      await assert.rejects(f.edit.execute("bad", { path, edits: [{ oldText: "model", newText: "bad" }] }));
      assert.equal(existsSync(path), false);
    }
    f.stale();
    await assert.rejects(readText(f.draft.snapshotPaths[0]), /owner/u);
    f.draft.dispose();
    await assert.rejects(readText(f.draft.snapshotPaths[1]), /owner/u);
  } finally {
    f.dispose();
  }
});

test("oversized initial settings are rejected before creating a draft", () => {
  assert.throws(
    () =>
      createSettingsDraft({
        settingsPath: "/unused/pi-starship.toml",
        baseline: Buffer.alloc(64 * 1024 + 1),
        packageRoot,
        isCurrent: () => true,
        onPreview() {
          assert.fail();
        },
      }),
    /64 KiB/u,
  );
});

test("concurrent mutations, subsequent reads, warning diagnostics, and aborts preserve ordering", async () => {
  const f = fixture();
  try {
    const first = f.write.execute("one", { path: f.draft.path, content: "format = '$directory'\n" });
    const second = f.edit.execute("two", { path: f.draft.path, edits: [{ oldText: "$directory", newText: "$model" }] });
    const read = f.read.execute("three", { path: f.draft.path });
    await Promise.all([first, second, read]);
    assert.match(f.draft.rawDocument, /\$model/u);
    assert.equal(f.draft.revision, 2);
    const warnings = await f.write.execute("warning", {
      path: f.draft.path,
      content: "format = '$model'\n[model]\nstyle = 5\n",
    });
    assert.match(JSON.stringify(warnings.content), /warning/u);
    const [warned, clean] = await Promise.all([
      f.write.execute("ordered-warning", { path: f.draft.path, content: "format = '$model'\n[model]\nstyle = 5\n" }),
      f.write.execute("ordered-clean", { path: f.draft.path, content: "format = '$model'\n" }),
    ]);
    assert.match(JSON.stringify(warned.content), /warning/u);
    assert.doesNotMatch(JSON.stringify(clean.content), /warning/u);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.write.execute("abort", { path: f.draft.path, content: "x" }, controller.signal), /aborted/u);
    await assert.rejects(
      f.write.execute("large", { path: f.draft.path, content: "x".repeat(64 * 1024 + 1) }),
      /64 KiB/u,
    );
    assert.notEqual(f.draft.rawDocument, "x");
    await f.write.execute("recover", { path: f.draft.path, content: "format = '$model'\n" });
  } finally {
    f.dispose();
  }
});
