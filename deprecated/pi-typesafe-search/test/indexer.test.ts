import assert from "node:assert/strict";
import { mkdtemp, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { openSearchDatabase } from "../src/database.js";
import { discoverSearchFiles } from "../src/files.js";
import { refreshIndex } from "../src/indexer.js";
import { ftsExpression } from "../src/text-normalization.js";

async function withFixture(fn: (workspace: string, agentDirectory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-jev-indexer-"));
  const workspace = path.join(root, "workspace");
  const agentDirectory = path.join(root, "agent");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(workspace), mkdir(agentDirectory)]));
  try {
    await fn(workspace, agentDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("indexer handles cold, warm, changed, binary, and deleted files incrementally", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const sourcePath = path.join(workspace, "search.md");
    await writeFile(sourcePath, "# Search\nfirst content\n");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
    const database = await openSearchDatabase(workspace, agentDirectory);

    const cold = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.deepEqual(cold, { indexed: 1, unchanged: 0, removed: 0, skipped: 1 });
    assert.equal(database.listFiles().length, 1);

    const warm = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.deepEqual(warm, { indexed: 0, unchanged: 1, removed: 0, skipped: 1 });

    await writeFile(sourcePath, "# Search\nchanged content with more bytes\n");
    const changed = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(changed.indexed, 1);
    assert.match(database.representativeChunks("search.md", 1)[0]?.body ?? "", /changed content/);

    await unlink(sourcePath);
    const removed = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(removed.removed, 1);
    assert.equal(database.listFiles().length, 0);
    database.close();
  });
});

test("renamed and newly excluded files replace stale index rows", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const originalPath = path.join(workspace, "original.txt");
    const renamedPath = path.join(workspace, "renamed.txt");
    await writeFile(originalPath, "searchable content\n");
    const database = await openSearchDatabase(workspace, agentDirectory);
    await refreshIndex(database, await discoverSearchFiles(workspace, "."));

    await rename(originalPath, renamedPath);
    const renamed = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.deepEqual(renamed, { indexed: 1, unchanged: 0, removed: 1, skipped: 0 });
    assert.deepEqual(
      database.listFiles().map((file) => file.path),
      ["renamed.txt"],
    );

    await rename(renamedPath, path.join(workspace, ".env.local"));
    const excluded = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(excluded.removed, 1);
    assert.deepEqual(database.listFiles(), []);
    database.close();
  });
});

test("database mutation failures abort refresh instead of looking like skipped source files", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    await writeFile(path.join(workspace, "source.txt"), "searchable source\n");
    const database = await openSearchDatabase(workspace, agentDirectory);
    const failure = vi.spyOn(database, "replaceFile").mockImplementation(() => {
      throw new Error("simulated database write failure");
    });

    await assert.rejects(
      refreshIndex(database, await discoverSearchFiles(workspace, ".")),
      /simulated database write failure/,
    );
    assert.equal(database.listFiles().length, 0);
    failure.mockRestore();
    database.close();
  });
});

test("queued refresh cancellation returns before the active mutation and preserves queue order", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    await writeFile(path.join(workspace, "source.txt"), "queued source\n");
    const database = await openSearchDatabase(workspace, agentDirectory);
    const discovery = await discoverSearchFiles(workspace, ".");
    const originalSecureArtifacts = database.secureArtifacts.bind(database);
    let markBlocked: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secureCalls = 0;
    const secure = vi.spyOn(database, "secureArtifacts").mockImplementation(async () => {
      await originalSecureArtifacts();
      secureCalls += 1;
      if (secureCalls === 1) {
        markBlocked();
        await gate;
      }
    });

    const first = refreshIndex(database, discovery);
    await blocked;
    const controller = new AbortController();
    const cancelled = refreshIndex(database, discovery, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => Boolean(error instanceof Error && error.name === "AbortError"));

    let thirdSettled = false;
    const third = refreshIndex(database, discovery).finally(() => {
      thirdSettled = true;
    });
    await Promise.resolve();
    assert.equal(thirdSettled, false);
    release();
    await Promise.all([first, third]);
    assert.equal(secureCalls, 2);
    secure.mockRestore();
    database.close();
  });
});

test("stale discovery snapshots do not delete files indexed by another handle", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const staleDiscovery = await discoverSearchFiles(workspace, ".");
    const staleHandle = await openSearchDatabase(workspace, agentDirectory);
    const freshHandle = await openSearchDatabase(workspace, agentDirectory);
    await writeFile(path.join(workspace, "new.txt"), "newly indexed content\n");
    await refreshIndex(freshHandle, await discoverSearchFiles(workspace, "."));

    const staleRefresh = await refreshIndex(staleHandle, staleDiscovery);
    assert.equal(staleRefresh.removed, 0);
    assert.equal(staleHandle.getFile("new.txt")?.path, "new.txt");
    assert.match(staleHandle.representativeChunks("new.txt", 1)[0]?.body ?? "", /newly indexed/);

    await writeFile(path.join(workspace, "new.txt"), "changed after the fresh index was published\n");
    await utimes(path.join(workspace, "new.txt"), new Date(), new Date(Date.now() + 1_000));
    const changedRefresh = await refreshIndex(staleHandle, staleDiscovery);
    assert.equal(changedRefresh.removed, 1);
    assert.equal(staleHandle.getFile("new.txt"), undefined);
    assert.deepEqual(staleHandle.representativeChunks("new.txt", 1), []);
    freshHandle.close();
    staleHandle.close();
  });
});

test("normalized POSIX paths preserve backslashes that are filename characters", async () => {
  if (process.platform === "win32") return;
  await withFixture(async (workspace, agentDirectory) => {
    const staleDiscovery = await discoverSearchFiles(workspace, ".");
    const staleHandle = await openSearchDatabase(workspace, agentDirectory);
    const freshHandle = await openSearchDatabase(workspace, agentDirectory);
    const filePath = String.raw`notes\node_modules\guide.md`;
    await writeFile(path.join(workspace, filePath), "backslash filename content\n");
    await refreshIndex(freshHandle, await discoverSearchFiles(workspace, "."));

    const staleRefresh = await refreshIndex(staleHandle, staleDiscovery);
    assert.equal(staleRefresh.removed, 0);
    assert.equal(staleHandle.getFile(filePath)?.path, filePath);
    assert.match(staleHandle.representativeChunks(filePath, 1)[0]?.body ?? "", /backslash filename/);
    freshHandle.close();
    staleHandle.close();
  });
});

test("failed stale loads preserve a concurrently indexed current row", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const sourcePath = path.join(workspace, "concurrent.txt");
    await writeFile(sourcePath, "version one\n");
    const staleDiscovery = await discoverSearchFiles(workspace, ".");
    const staleHandle = await openSearchDatabase(workspace, agentDirectory);
    const freshHandle = await openSearchDatabase(workspace, agentDirectory);
    await refreshIndex(freshHandle, staleDiscovery);

    await writeFile(sourcePath, "version two\n");
    await utimes(sourcePath, new Date(), new Date(Date.now() + 1_000));
    const freshDiscovery = await discoverSearchFiles(workspace, ".");
    assert.equal(freshDiscovery.files[0]?.ino, staleDiscovery.files[0]?.ino);
    assert.equal(freshDiscovery.files[0]?.size, staleDiscovery.files[0]?.size);
    assert.notEqual(freshDiscovery.files[0]?.mtimeNs, staleDiscovery.files[0]?.mtimeNs);
    await refreshIndex(freshHandle, freshDiscovery);
    const currentHash = freshHandle.getFile("concurrent.txt")?.hash;

    const staleRefresh = await refreshIndex(staleHandle, staleDiscovery);
    assert.equal(staleRefresh.skipped, 1);
    assert.equal(staleHandle.getFile("concurrent.txt")?.hash, currentHash);
    assert.match(staleHandle.representativeChunks("concurrent.txt", 1)[0]?.body ?? "", /version two/);
    freshHandle.close();
    staleHandle.close();
  });
});

test("filesystem revalidation errors preserve but hide indexed rows", async () => {
  if (process.platform === "win32") return;
  await withFixture(async (workspace, agentDirectory) => {
    const database = await openSearchDatabase(workspace, agentDirectory);
    const inaccessiblePath = "a".repeat(300);
    database.replaceFile(
      {
        path: inaccessiblePath,
        dev: "1",
        ino: "2",
        size: 10,
        mtimeNs: "3",
        hash: "stale-hash",
        title: "Stale",
        outline: "Stale",
      },
      [
        {
          sequence: 0,
          startLine: 1,
          endLine: 1,
          heading: "Stale",
          body: "stale content",
          hash: "stale-chunk",
        },
      ],
    );

    const refresh = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(refresh.removed, 0);
    assert.equal(database.getFile(inaccessiblePath)?.path, inaccessiblePath);
    assert.deepEqual(database.representativeChunks(inaccessiblePath, 1), []);
    database.close();
  });
});

test("failed or cancelled refreshes keep complete prior file versions and queues recover", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const sourcePath = path.join(workspace, "source.txt");
    await writeFile(sourcePath, "previous version\n");
    const database = await openSearchDatabase(workspace, agentDirectory);
    await refreshIndex(database, await discoverSearchFiles(workspace, "."));

    await writeFile(sourcePath, "next version with changed size\n");
    const discovery = await discoverSearchFiles(workspace, ".");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(refreshIndex(database, discovery, controller.signal), (error: unknown) =>
      Boolean(error instanceof Error && error.name === "AbortError"),
    );
    assert.match(database.representativeChunks("source.txt", 1)[0]?.body ?? "", /previous version/);

    const [first, second] = await Promise.all([refreshIndex(database, discovery), refreshIndex(database, discovery)]);
    assert.equal(first.indexed + second.indexed, 1);
    assert.match(database.representativeChunks("source.txt", 1)[0]?.body ?? "", /next version/);

    const retainedHash = database.getFile("source.txt")?.hash;
    await writeFile(sourcePath, "third version discovered before another change\n");
    const failedDiscovery = await discoverSearchFiles(workspace, ".");
    await writeFile(sourcePath, "fourth version changes size before loading and must hide stale content\n");
    const failed = await refreshIndex(database, failedDiscovery);
    assert.equal(failed.skipped, 1);
    assert.equal(database.getFile("source.txt")?.hash, retainedHash);
    assert.deepEqual(database.representativeChunks("source.txt", 1), []);
    assert.deepEqual(database.listFileMaps(10), []);
    assert.deepEqual(database.searchFts(ftsExpression("next version") ?? "", 10), []);

    const recovered = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(recovered.indexed, 1);
    assert.match(database.representativeChunks("source.txt", 1)[0]?.body ?? "", /fourth version/);
    database.close();
  });
});
