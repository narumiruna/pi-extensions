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
      assert.deepEqual(open.mock.calls.map(([file]) => path.relative(root, String(file))).sort(), kept);
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
    assert.equal(journal.version, 8);
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
