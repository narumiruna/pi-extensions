import assert from "node:assert/strict";
import type { Dir } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import {
  createSnapshot,
  filterSnapshotForConfigPolicy,
  mergeRemotePreservedFiles,
  mergeRemoteSessionFiles,
  snapshotIncludesSessions,
  snapshotWithoutSessions,
} from "../src/snapshot/snapshot.js";
import { applySnapshot } from "../src/snapshot/snapshot-apply.js";
import { assertUnexcludedTargets } from "../src/snapshot/snapshot-exclude-safety.js";
import { applySnapshotTransaction, recoverPendingSnapshotTransactions } from "../src/snapshot/snapshot-transaction.js";
import { transactionRoot } from "../src/snapshot/snapshot-transaction-directory.js";
import { snapshot, withTempHome } from "./helpers.js";

const directory: { scope: "agent-directory"; include: string[] } = { scope: "agent-directory", include: [] };
const alwaysLocal = ["auth.json", "auth.json.lock", "trust.json", "trust.json.lock", "pi-sync.json"];

async function put(root: string, files: string[], data = "local") {
  for (const relative of files) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
}

function image(...files: string[]) {
  return snapshot(files.map((name) => ({ path: name, content: Buffer.from("remote") })));
}

function names(snapshot: ReturnType<typeof image>) {
  return snapshot.files.map((file) => file.path);
}

test("directory scope scans custom paths and re-included descendants without opening excluded siblings or locks", async () =>
  withTempHome(async (root) => {
    const kept = ["custom/new/item.txt", "nested/show/item.txt"];
    const blocked = [
      ...alwaysLocal,
      "AUTH.JSON",
      "nested/hidden/item.txt",
      "nested/other.txt",
      "pi-sync/state.json",
      "sessions/global/private.jsonl",
      "node_modules/a/index.js",
    ];
    await put(root, [...kept, ...blocked]);
    const open = vi.spyOn(fs, "open");
    const opendir = vi.spyOn(fs, "opendir");
    const readFile = vi.spyOn(fs, "readFile");
    try {
      const result = await createSnapshot("home", {
        ...directory,
        exclude: ["nested"],
        reinclude: ["nested/show", ...alwaysLocal, "sessions", "pi-sync", "node_modules"],
      });
      assert.equal(result.version, 5);
      assert.equal(result.selection?.version, 3);
      assert.deepEqual(names(result), kept);
      assert.equal(snapshotIncludesSessions(result), false);
      assert.deepEqual(
        open.mock.calls.map(([file]) => path.relative(root, String(file)).split(path.sep).join("/")).sort(),
        kept,
      );
      assert.deepEqual(readFile.mock.calls, []);
      for (const forbidden of ["nested/hidden", "pi-sync", "sessions", "node_modules"]) {
        assert.ok(!opendir.mock.calls.some(([file]) => file === path.join(root, forbidden)), forbidden);
      }
    } finally {
      open.mockRestore();
      opendir.mockRestore();
      readFile.mockRestore();
    }
  }));

test("a custom session directory is only scanned through the explicitly enabled virtual session root", async () =>
  withTempHome(async (root) => {
    await put(root, [
      "custom/conversations/project/keep.jsonl",
      "custom/conversations/project/skip.jsonl",
      "custom/conversations/project/index.txt",
      "custom/keep.txt",
      "sessions/old.jsonl",
    ]);
    const sessionDir = path.join(root, "custom/conversations");
    const sessionRules = { ...directory, sessionDir, exclude: ["sessions"], reinclude: ["sessions/**/keep.jsonl"] };
    const off = await createSnapshot("home", sessionRules);
    assert.deepEqual(names(off), ["custom/keep.txt"]);
    const on = await createSnapshot("home", { ...sessionRules, include: ["sessions"] });
    assert.deepEqual(names(on), ["custom/keep.txt", "sessions/project/keep.jsonl"]);
    assert.equal(snapshotIncludesSessions(on), true);
    const stripped = snapshotWithoutSessions(on);
    assert.deepEqual(stripped.selection, { ...on.selection, include: [] });
    assert.deepEqual(names(stripped), ["custom/keep.txt"]);
    assert.deepEqual(mergeRemoteSessionFiles(off, on), off);
  }));

test("a case variant of the custom session store is ordinary only when it is physically distinct", async () =>
  withTempHome(async (root) => {
    await put(root, ["Store/chat.jsonl"]);
    const sessionDir = path.join(root, "Store");
    const ordinaryDir = path.join(root, "store");
    let distinct = true;
    try {
      await fs.mkdir(ordinaryDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      distinct = false;
    }
    const ordinaryFile = "store/notes.md";
    await put(root, [ordinaryFile]);
    const options = { ...directory, include: ["sessions"], sessionDir };
    assert.deepEqual(names(await createSnapshot("home", options)), [
      "sessions/chat.jsonl",
      ...(distinct ? [ordinaryFile] : []),
    ]);
    const incoming = image(ordinaryFile);
    assert.deepEqual(
      names(filterSnapshotForConfigPolicy(incoming, options, { sessionDir })),
      distinct ? [ordinaryFile] : [],
    );
    await applySnapshot(incoming, new Set(), { ...options, include: [] });
    assert.equal(await fs.readFile(path.join(root, ordinaryFile), "utf8"), distinct ? "remote" : "local");
    assert.equal(await fs.readFile(path.join(sessionDir, "chat.jsonl"), "utf8"), "local");

    const missingChild = "store/missing/other.md";
    const nested = filterSnapshotForConfigPolicy(image(missingChild), options, {
      sessionDir: path.join(sessionDir, "missing"),
    });
    assert.deepEqual(names(nested), distinct ? [missingChild] : []);
  }));

test("excluded Pi settings still bind the physical session root as metadata without entering the payload", async () =>
  withTempHome(async (root) => {
    const sessionDir = path.join(root, "custom/conversations");
    await put(root, ["custom/conversations/project/keep.jsonl", "custom/keep.txt"]);
    await put(root, ["settings.json"], JSON.stringify({ sessionDir }));
    const options = { ...directory, exclude: ["settings.json"] };
    assert.deepEqual(names(await createSnapshot("home", options)), ["custom/keep.txt"]);
    assert.deepEqual(names(await createSnapshot("home", { ...options, include: ["sessions"] })), [
      "custom/keep.txt",
      "sessions/project/keep.jsonl",
    ]);
    await applySnapshot(image("custom/conversations/project/keep.jsonl"), new Set(), options);
    assert.equal(await fs.readFile(path.join(sessionDir, "project/keep.jsonl"), "utf8"), "local");
    assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), JSON.stringify({ sessionDir }));
  }));

test("Pi settings with a UTF-8 BOM route sessions and retain original bytes through collection and apply", async () =>
  withTempHome(async (root) => {
    const sessionDir = path.join(root, "Store");
    const before = Buffer.from(`\uFEFF${JSON.stringify({ sessionDir })}`);
    const after = Buffer.from(`\uFEFF${JSON.stringify({ sessionDir, theme: "dark" })}`);
    const settings = path.join(root, "settings.json");
    await put(root, ["Store/chat.jsonl"]);
    await fs.writeFile(settings, before);
    const collected = await createSnapshot("home", { ...directory, include: ["sessions"] });
    assert.deepEqual(names(collected), ["sessions/chat.jsonl", "settings.json"]);
    assert.equal(
      collected.files.find((file) => file.path === "settings.json")?.contentBase64,
      before.toString("base64"),
    );
    await applySnapshotTransaction({ writes: [{ target: settings, content: after }], deletes: [] }, directory);
    assert.deepEqual(await fs.readFile(settings), after);
  }));

test("settings size is bounded in bytes for collection, fallback metadata, and transaction images", async () =>
  withTempHome(async (root) => {
    const bound = 1024 * 1024;
    const sessionDir = path.join(root, "sessions");
    const settings = path.join(root, "settings.json");
    const exact = Buffer.from(`{"text":"${"é".repeat((bound - 12) / 2)}"} `);
    assert.equal(exact.length, bound);
    const oversized = Buffer.concat([exact, Buffer.from(" ")]);
    const plan = (content: Buffer) => ({ writes: [{ target: settings, content }], deletes: [] });
    await put(root, ["settings.json"], "{}");
    await applySnapshotTransaction(plan(exact), directory);
    const backup = vi.spyOn(fs, "copyFile");
    try {
      await assert.rejects(applySnapshotTransaction(plan(oversized), directory), /1 MiB/);
      assert.deepEqual(await fs.readFile(settings), exact);
      assert.deepEqual(backup.mock.calls, []);
      await fs.writeFile(settings, oversized);
      await assert.rejects(applySnapshotTransaction(plan(exact), { ...directory, sessionDir }), /1 MiB/);
      await assert.rejects(createSnapshot("home", directory), /1 MiB/);
      await assert.rejects(createSnapshot("home", { ...directory, sessionDir }), /1 MiB/);
      assert.deepEqual(
        names(await createSnapshot("home", { ...directory, sessionDir, exclude: ["settings.json"] })),
        [],
      );
      assert.deepEqual(await fs.readFile(settings), oversized);
      assert.deepEqual(backup.mock.calls, []);
    } finally {
      backup.mockRestore();
    }
  }));

test("directory inventory is bounded before any payload bytes are opened", async () =>
  withTempHome(async (root) => {
    await put(root, ["first.txt", "nested/sparse"]);
    await fs.truncate(path.join(root, "nested/sparse"), 64 * 1024 * 1024);
    const open = vi.spyOn(fs, "open");
    try {
      await assert.rejects(createSnapshot("home", directory), /scan byte bound/);
      assert.deepEqual(open.mock.calls, []);
    } finally {
      open.mockRestore();
    }
  }));

test("a scan over the file-count bound never opens the candidate payloads", async () =>
  withTempHome(async (root) => {
    await put(root, ["fixture.txt"]);
    const [sample] = await fs.readdir(root, { withFileTypes: true });
    assert.ok(sample);
    const samples = 16_385;
    const files = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < samples; i++)
          yield { name: `candidate-${i}`, isDirectory: () => false, isFile: () => true };
      },
    } as unknown as Dir;
    const actualOpendir = fs.opendir.bind(fs);
    const actualStat = fs.lstat.bind(fs);
    const actualRealpath = fs.realpath.bind(fs);
    const metadata = await fs.lstat(path.join(root, sample.name));
    const canonicalRoot = await fs.realpath(root);
    const candidate = (target: string) =>
      path.dirname(target) === root && path.basename(target).startsWith("candidate-");
    const list = vi
      .spyOn(fs, "opendir")
      .mockImplementation((target, options) =>
        target === root ? Promise.resolve(files) : actualOpendir(target, options),
      );
    const stat = vi
      .spyOn(fs, "lstat")
      .mockImplementation((target, options) =>
        candidate(String(target)) ? Promise.resolve(metadata) : actualStat(target, options),
      );
    const realpath = vi
      .spyOn(fs, "realpath")
      .mockImplementation((target, options) =>
        candidate(String(target))
          ? Promise.resolve(path.join(canonicalRoot, path.basename(String(target))))
          : actualRealpath(target, options),
      );
    const open = vi.spyOn(fs, "open");
    try {
      await assert.rejects(createSnapshot("home", directory), /scan file bound/);
      assert.deepEqual(open.mock.calls, []);
    } finally {
      realpath.mockRestore();
      stat.mockRestore();
      list.mockRestore();
      open.mockRestore();
    }
  }));

test("an unreadable eligible subtree rejects the whole scan before any payload reads", async () =>
  withTempHome(async (root) => {
    await put(root, ["first.txt", "nested/hidden-by-error.txt"]);
    const actualOpendir = fs.opendir.bind(fs);
    const list = vi.spyOn(fs, "opendir").mockImplementation((target, options) => {
      if (target === path.join(root, "nested")) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return actualOpendir(target, options);
    });
    const open = vi.spyOn(fs, "open");
    try {
      await assert.rejects(createSnapshot("home", directory), { code: "EACCES" });
      assert.deepEqual(open.mock.calls, []);
    } finally {
      list.mockRestore();
      open.mockRestore();
    }
  }));

test("snapshot collection and replacement preflight close each iterator before opening a child", async () =>
  withTempHome(async (root) => {
    const leaf = "nested/a/b/c/item.txt";
    await put(root, [leaf]);
    let openIterators = 0;
    const actualOpendir = fs.opendir.bind(fs);
    const list = vi.spyOn(fs, "opendir").mockImplementation(async (target, options) => {
      assert.equal(openIterators, 0, `parent iterator still open while opening ${target}`);
      const handle = await actualOpendir(target, options);
      openIterators++;
      return {
        async *[Symbol.asyncIterator]() {
          try {
            yield* handle;
          } finally {
            openIterators--;
          }
        },
      } as unknown as Dir;
    });
    try {
      assert.deepEqual(names(await createSnapshot("home", directory)), [leaf]);
      await assertUnexcludedTargets(root, [path.join(root, "nested")], directory);
      assert.equal(openIterators, 0);
    } finally {
      list.mockRestore();
    }
  }));

test("snapshot collection rejects a file edited after its descriptor check", async () =>
  withTempHome(async (root) => {
    await put(root, ["race.txt"]);
    const target = path.join(root, "race.txt");
    const actualOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (args[0] === target) {
        const actualClose = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
          await actualClose();
          await fs.appendFile(target, " newer");
        });
      }
      return handle;
    });
    try {
      await assert.rejects(createSnapshot("home", directory), /changed or has an unsafe filesystem layout/);
      assert.equal(await fs.readFile(target, "utf8"), "local newer");
    } finally {
      open.mockRestore();
    }
  }));

test.skipIf(process.platform === "win32")(
  "static symlinks are never traversed and candidate swaps are rejected",
  async () =>
    withTempHome(async (root) => {
      const outside = path.join(path.dirname(root), "outside");
      await put(outside, ["private.txt"]);
      await put(root, ["safe.txt"]);
      await fs.symlink(outside, path.join(root, "alias"), "dir");
      await fs.symlink(path.join(outside, "private.txt"), path.join(root, "link.txt"), "file");
      assert.deepEqual(names(await createSnapshot("home", directory)), ["safe.txt"]);
      await assert.rejects(
        createSnapshot("home", { ...directory, sessionDir: path.join(root, "alias") }),
        /unsafe filesystem layout/,
      );
      const safe = path.join(root, "safe.txt");
      const actualOpen = fs.open.bind(fs);
      const open = vi.spyOn(fs, "open").mockImplementation(async (target, ...args) => {
        if (target === safe) {
          await fs.unlink(safe);
          await fs.symlink(path.join(outside, "private.txt"), safe, "file");
        }
        return actualOpen(target, ...args);
      });
      try {
        await assert.rejects(createSnapshot("home", directory));
      } finally {
        open.mockRestore();
      }
    }),
);

test("remote projection and publication do not carry protected, excluded, or physical session paths", async () =>
  withTempHome(async (root) => {
    const selection = { ...directory, exclude: ["custom"], reinclude: ["custom/show", ...alwaysLocal, "sessions"] };
    const sessionDir = path.join(root, "physical");
    const remote = image(
      ...alwaysLocal,
      "custom/show",
      "custom/hide",
      "physical/p.jsonl",
      "sessions/p.jsonl",
      "only-remote.toml",
    );
    const filtered = filterSnapshotForConfigPolicy(remote, selection, { sessionDir });
    assert.equal(filtered.version, 5);
    assert.deepEqual(names(filtered), ["custom/show", "only-remote.toml"]);
    const published = mergeRemotePreservedFiles(image("custom/show", "custom/hide"), remote, selection, { sessionDir });
    assert.equal(published.version, 5);
    assert.deepEqual(names(published), ["custom/show"]);
  }));

test("historical projection rejects retained portable layout conflicts after filtering", () => {
  for (const conflicts of [
    ["skills/Foo/a.md", "skills/foo/b.md"],
    ["skills/a.md", "skills/A.MD"],
    ["skills/café/a.md", "skills/cafe\u0301/b.md"],
    ["skills/foo", "skills/foo/a.md"],
    ["skills/foo", "skills/foo"],
  ]) {
    assert.throws(() => filterSnapshotForConfigPolicy(image(...conflicts), directory), /conflicting portable paths/);
  }
  assert.deepEqual(
    names(
      filterSnapshotForConfigPolicy(image("skills/Foo/a.md", "skills/foo/b.md"), {
        ...directory,
        exclude: ["skills/Foo/a.md"],
      }),
    ),
    ["skills/foo/b.md"],
  );
});

test("apply leaves excluded siblings, denied paths and sessions unchanged", async () =>
  withTempHome(async (root) => {
    const blocked = [...alwaysLocal, "nested/private.txt", "physical/saved.jsonl", "sessions/default.jsonl"];
    await put(root, [...blocked, "obsolete.txt"]);
    const hashes = await applySnapshot(image(...blocked, "nested/public.txt"), new Set(), {
      ...directory,
      exclude: ["nested"],
      reinclude: ["nested/public.txt", ...alwaysLocal, "sessions"],
      sessionDir: path.join(root, "physical"),
    });
    assert.deepEqual(Object.keys(hashes), ["nested/public.txt"]);
    assert.equal(await fs.readFile(path.join(root, "nested/public.txt"), "utf8"), "remote");
    for (const item of blocked) assert.equal(await fs.readFile(path.join(root, item), "utf8"), "local");
    await assert.rejects(fs.stat(path.join(root, "obsolete.txt")), { code: "ENOENT" });
  }));

test("apply refuses a directory replacement that would remove an excluded descendant before backing up files", async () =>
  withTempHome(async (root) => {
    await put(root, ["nested/private.txt", "nested/public.txt"]);
    const cp = vi.spyOn(fs, "cp");
    try {
      await assert.rejects(
        applySnapshot(image("nested"), new Set(), { ...directory, exclude: ["nested/private.txt"] }),
        /excluded path or directory descendant/,
      );
      assert.deepEqual(cp.mock.calls, []);
      assert.equal(await fs.readFile(path.join(root, "nested/private.txt"), "utf8"), "local");
    } finally {
      cp.mockRestore();
    }
  }));

test.each([undefined, "custom-store"])(
  "replacement keeps non-payload session descendants out of backup, for store %s",
  (customStore) =>
    withTempHome(async (root) => {
      const sessionDir = path.join(root, customStore ?? "sessions");
      const jsonl = path.join(sessionDir, "chat.jsonl", "nested", "part.jsonl");
      const sidecar = path.join(sessionDir, "chat.jsonl", "nested", "index.txt");
      const wrongCase = path.join(sessionDir, "chat.jsonl", "nested", "old.JSONL");
      await put(
        root,
        [jsonl, sidecar, wrongCase].map((file) => path.relative(root, file)),
      );
      const options = { ...directory, sessionDir, include: ["sessions"] };
      const incoming = image("sessions/chat.jsonl");
      const backup = vi.spyOn(fs, "cp");
      try {
        await assert.rejects(applySnapshot(incoming, new Set(), options), /excluded path or directory descendant/);
        assert.equal(await fs.readFile(sidecar, "utf8"), "local");
        await fs.unlink(sidecar);
        await assert.rejects(applySnapshot(incoming, new Set(), options), /excluded path or directory descendant/);
        assert.equal(await fs.readFile(wrongCase, "utf8"), "local");
        assert.equal(await fs.readFile(jsonl, "utf8"), "local");
        assert.deepEqual(backup.mock.calls, []);
        await fs.unlink(wrongCase);
        await applySnapshot(incoming, new Set(), options);
        assert.equal(await fs.readFile(path.join(sessionDir, "chat.jsonl"), "utf8"), "remote");
      } finally {
        backup.mockRestore();
      }
    }),
);

test("direct transaction apply refuses a Pi session root transition even with sessions disabled", async () =>
  withTempHome(async (root) => {
    const before = JSON.stringify({ sessionDir: path.join(root, "before") });
    await put(root, ["settings.json"], before);
    await assert.rejects(
      applySnapshotTransaction(
        {
          writes: [
            {
              target: path.join(root, "settings.json"),
              content: Buffer.from(JSON.stringify({ sessionDir: path.join(root, "after") })),
            },
          ],
          deletes: [],
        },
        directory,
      ),
      /cannot change Pi session storage/,
    );
    assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), before);
  }));

test("new recovery journals require the recorded scope, rules, session opt-in, and physical session root", async () =>
  withTempHome(async (root) => {
    await put(root, ["nested/public.txt"]);
    const target = path.join(root, "nested/public.txt");
    const options = {
      ...directory,
      exclude: ["nested"],
      reinclude: ["nested/public.txt"],
      sessionDir: path.join(root, "custom"),
    };
    const controller = new AbortController();
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === target && String(from).endsWith(".apply")) controller.abort();
    });
    try {
      await assert.rejects(
        applySnapshotTransaction(
          { writes: [{ target, content: Buffer.from("remote") }], deletes: [] },
          { ...options, signal: controller.signal },
        ),
        /cancelled/,
      );
    } finally {
      spy.mockRestore();
    }
    const [pending] = await fs.readdir(transactionRoot());
    assert.ok(pending);
    const journal = JSON.parse(await fs.readFile(path.join(transactionRoot(), pending, "journal.json"), "utf8"));
    assert.equal(journal.version, 10);
    assert.deepEqual(journal.selection, {
      version: 3,
      scope: "agent-directory",
      include: [],
      exclude: ["nested"],
      reinclude: ["nested/public.txt"],
    });
    for (const changed of [{}, { ...options, reinclude: [] }, { ...options, include: ["sessions"] }]) {
      await assert.rejects(recoverPendingSnapshotTransactions(changed), /different exclude policy or directory scope/);
    }
    await assert.rejects(
      recoverPendingSnapshotTransactions({ ...options, sessionDir: undefined }),
      /session root is not owned/,
    );
    assert.equal(await fs.readFile(target, "utf8"), "remote");
    await recoverPendingSnapshotTransactions({ ...options, reinclude: ["NESTED/public.txt"] });
    assert.equal(await fs.readFile(target, "utf8"), "local");
    assert.deepEqual(await fs.readdir(transactionRoot()), []);
  }));
