import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureEngineHost, engineHost } from "@narumitw/pi-sync-daemon/engine/host";
import { test } from "vitest";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { applySnapshot } from "../src/snapshot/snapshot-apply.js";
import { snapshot, withTempHome } from "./helpers.js";

const scope = { scope: "agent-directory" as const };

function remote(...paths: string[]) {
  return snapshot(paths.map((path) => ({ path, content: Buffer.from("remote") })));
}

test("directory apply never deletes files created after the reviewed inventory", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "known.md"), "reviewed");
    const reviewedLocal = await createSnapshot("home", scope);
    await fs.writeFile(path.join(root, "draft.md"), "new draft");
    await assert.rejects(
      applySnapshot(remote("known.md"), new Set(), { ...scope, reviewedLocal }),
      /Reviewed local files changed/,
    );
    assert.equal(await fs.readFile(path.join(root, "known.md"), "utf8"), "reviewed");
    assert.equal(await fs.readFile(path.join(root, "draft.md"), "utf8"), "new draft");
  }));

for (const mutation of ["changed file", "new file", "new child", "unchanged tree"] as const) {
  test(`directory apply binds queued preimages: ${mutation}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(path.join(root, "tree"), { recursive: true });
      const existing = path.join(root, "known.md");
      const added = path.join(root, "new.md");
      const child = path.join(root, "tree", "draft.md");
      await fs.writeFile(existing, "reviewed");
      await fs.writeFile(path.join(root, "tree", "reviewed.md"), "reviewed child");
      const reviewedLocal = await createSnapshot("home", scope);
      const originalHost = engineHost();
      let entered = false;
      configureEngineHost({
        ...originalHost,
        mutate: async (target, action) => {
          if (!entered) {
            entered = true;
            if (mutation === "changed file") await fs.writeFile(existing, "new edit");
            if (mutation === "new file") await fs.writeFile(added, "new draft");
            if (mutation === "new child") await fs.writeFile(child, "new child");
          }
          return originalHost.mutate(target, action);
        },
      });
      try {
        const apply = applySnapshot(remote("known.md", "new.md", "tree"), new Set(), { ...scope, reviewedLocal });
        if (mutation === "unchanged tree") {
          await apply;
          assert.equal(await fs.readFile(path.join(root, "tree"), "utf8"), "remote");
        } else {
          await assert.rejects(
            apply,
            mutation === "new file" ? /target appeared during queue acquisition/ : /preimage changed/,
          );
          assert.equal(await fs.readFile(existing, "utf8"), mutation === "changed file" ? "new edit" : "reviewed");
          assert.equal(await fs.readFile(path.join(root, "tree", "reviewed.md"), "utf8"), "reviewed child");
          if (mutation === "new file") assert.equal(await fs.readFile(added, "utf8"), "new draft");
          if (mutation === "new child") assert.equal(await fs.readFile(child, "utf8"), "new child");
        }
        assert.equal(entered, true);
      } finally {
        configureEngineHost(originalHost);
      }
    }));
}

test("directory apply counts retained active session bytes together with incoming files", async () =>
  withTempHome(async (root) => {
    const relative = "sessions/current.jsonl";
    const session = path.join(root, relative);
    await fs.mkdir(path.dirname(session), { recursive: true });
    await fs.writeFile(session, "fixture");
    await fs.truncate(session, 2 * 1024 * 1024);
    const base = snapshot([{ path: "placeholder", content: Buffer.alloc(1024 * 1024) }]);
    const incoming = {
      ...base,
      files: Array.from({ length: 63 }, (_, index) => ({ ...base.files[0], path: `file-${index}` })),
    };
    const options = { ...scope, include: ["sessions"] };
    const reviewedLocal = await createSnapshot("home", options);
    await assert.rejects(
      applySnapshot(incoming, new Set([relative]), { ...options, reviewedLocal }),
      /Projected agent directory exceeds the 64 MiB scan byte bound/,
    );
    assert.equal((await fs.stat(session)).size, 2 * 1024 * 1024);
    await assert.rejects(fs.stat(path.join(root, "file-0")), { code: "ENOENT" });
  }));
