import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { pendingTransactionEntries, transactionRoot } from "../src/snapshot/snapshot-transaction-directory.js";
import { startSession } from "../src/sync/automatic-sync.js";
import { withTempHome } from "./helpers.js";
import { deferred } from "./startup-check-helpers.js";

for (const state of ["missing", "empty", "file", "directory symlink"] as const) {
  test(`startup with ${state} transaction entries uses only the lightweight probe`, async () => {
    await withTempHome(async (agentDir) => {
      const root = transactionRoot();
      if (state !== "missing") await fs.mkdir(root, { recursive: true });
      if (state === "file") await fs.writeFile(path.join(root, "unrelated"), "retain");
      if (state === "directory symlink") {
        const outside = path.join(agentDir, "unrelated");
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(root, "unrelated"), "dir");
      }
      const read = fs.readdir.bind(fs);
      let probes = 0;
      const spy = vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof read>) => {
        if (args[0] === root) probes++;
        return read(...args);
      }) as typeof fs.readdir);
      try {
        await startSession(createMockContext({ mode: "rpc" }).ctx, new AbortController().signal);
        assert.equal(probes, 1, "no second probe from the full recovery implementation");
        await assert.rejects(fs.access(path.join(agentDir, "pi-sync.json")), { code: "ENOENT" });
        if (state === "missing") await assert.rejects(fs.access(agentDir), { code: "ENOENT" });
        if (state === "file") assert.equal(await fs.readFile(path.join(root, "unrelated"), "utf8"), "retain");
        if (state === "directory symlink")
          assert.equal((await fs.lstat(path.join(root, "unrelated"))).isSymbolicLink(), true);
      } finally {
        spy.mockRestore();
      }
    });
  });
}

for (const directory of ["pi-sync", ".pisync"]) {
  test(`startup still loads recovery and retains invalid evidence in ${directory}`, async () => {
    await withTempHome(async (agentDir) => {
      const journal = path.join(agentDir, directory, "transactions/interrupted/journal.json");
      await fs.mkdir(path.dirname(journal), { recursive: true });
      await fs.writeFile(journal, "{broken");
      await assert.rejects(
        startSession(createMockContext({ mode: "rpc" }).ctx, new AbortController().signal),
        /Cannot recover malformed pi-sync transaction/u,
      );
      assert.equal(await fs.readFile(journal, "utf8"), "{broken");
    });
  });
}

for (const code of ["EACCES", "ENOTDIR", "EIO"]) {
  test(`startup does not mistake a ${code} probe failure for an empty recovery directory`, async () => {
    await withTempHome(async () => {
      const failure = Object.assign(new Error("probe failed"), { code });
      const spy = vi.spyOn(fs, "readdir").mockRejectedValue(failure);
      try {
        await assert.rejects(
          startSession(createMockContext({ mode: "rpc" }).ctx, new AbortController().signal),
          (error) => error === failure,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });
}

test("the lightweight transaction probe retains conflicting-root protection", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(path.join(agentDir, "pi-sync"), { recursive: true });
    await fs.mkdir(path.join(agentDir, ".pisync"));
    await assert.rejects(pendingTransactionEntries(), /Both legacy .* and canonical/u);
  });
});

for (const boundary of ["abort", "session mutation"] as const) {
  test(`startup rechecks ownership after loading recovery: ${boundary}`, async () => {
    await withTempHome(async () => {
      await fs.mkdir(path.join(transactionRoot(), "interrupted"), { recursive: true });
      const entered = deferred();
      const release = deferred();
      const controller = new AbortController();
      const context = createMockContext({ mode: "rpc" });
      let recoveries = 0;
      vi.doMock("../src/snapshot/snapshot-transaction.js", async () => {
        entered.resolve();
        await release.promise;
        return {
          recoverSnapshotTransactionsOnStartup: async () => {
            recoveries++;
          },
        };
      });
      const pending = startSession(context.ctx, controller.signal);
      const rejected = assert.rejects(pending, boundary === "abort" ? { name: "AbortError" } : /Session changed/u);
      try {
        await entered.promise;
        if (boundary === "abort") controller.abort();
        else (context.ctx as ExtensionContext).sessionManager.getSessionId = () => "replaced-session";
        release.resolve();
        await rejected;
        assert.equal(recoveries, 0);
        assert.deepEqual(context.notifications, []);
      } finally {
        release.resolve();
        await pending.catch(() => {});
        vi.doUnmock("../src/snapshot/snapshot-transaction.js");
      }
    });
  });

  test(`startup rechecks ownership after its directory probe: ${boundary}`, async () => {
    await withTempHome(async () => {
      const entered = deferred();
      const release = deferred();
      const controller = new AbortController();
      const context = createMockContext({ mode: "rpc" });
      const spy = vi.spyOn(fs, "readdir").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return [];
      });
      const pending = startSession(context.ctx, controller.signal);
      const rejected = assert.rejects(pending, boundary === "abort" ? { name: "AbortError" } : /Session changed/u);
      try {
        await entered.promise;
        if (boundary === "abort") controller.abort();
        else (context.ctx as ExtensionContext).sessionManager.getSessionId = () => "replaced-session";
        release.resolve();
        await rejected;
        assert.deepEqual(context.notifications, []);
      } finally {
        release.resolve();
        await pending.catch(() => {});
        spy.mockRestore();
      }
    });
  });
}
