import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../paths.js";
import { SYNC_IGNORE_NAME, syncIgnoreAllows } from "../sync/sync-ignore.js";
import { snapshotTarget } from "./snapshot.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import { snapshotPathImage } from "./snapshot-transaction.js";
import type { Snapshot, SnapshotApplyPlan, SnapshotOptions } from "./snapshot-types.js";

/** Bind ignore-mode mutations to selected physical preimages, including complete replacement trees. */
export async function selectedSnapshotPreimages(
  root: string,
  plan: SnapshotApplyPlan,
  current: Snapshot,
  options: SnapshotOptions,
) {
  const expected = new Map<string, string>();
  const syncIgnore = options.syncIgnore;
  if (syncIgnore === undefined) return expected;
  const sessions = sessionStorageRoot(root, options.sessionDir);
  const hashes = new Map(
    current.files.map((file) => [snapshotTarget(root, file.path, options.sessionDir), file.sha256]),
  );
  const check = () => {
    options.signal?.throwIfAborted();
    options.validateMutation?.();
  };
  const visit = async (target: string) => {
    check();
    for (const name of await fs.readdir(target)) {
      check();
      const child = path.join(target, name);
      const stat = await fs.lstat(child);
      check();
      if (stat.isDirectory()) {
        const relative = isPathInside(sessions, child)
          ? `sessions/${path.relative(sessions, child).split(path.sep).join("/")}`
          : path.relative(root, child).split(path.sep).join("/");
        if (!syncIgnoreAllows(syncIgnore, relative, true))
          throw new Error("Directory replacement contains ignored or unselected descendants; no files were changed.");
        await visit(child);
      } else if (!stat.isFile() || stat.nlink !== 1 || !hashes.has(child)) {
        throw new Error("Directory replacement contains ignored or unselected descendants; no files were changed.");
      } else {
        const image = await snapshotPathImage(child);
        check();
        if (image !== `file:${hashes.get(child)}`) throw new Error("Selected directory content changed before apply.");
      }
    }
    check();
  };
  for (const target of new Set([...plan.deletes, ...plan.writes.map((item) => item.target)])) {
    check();
    const before = await snapshotPathImage(target);
    check();
    if (before.startsWith("directory:")) {
      await visit(target);
      check();
      if (before !== (await snapshotPathImage(target)))
        throw new Error("Selected directory content changed before apply.");
      check();
      expected.set(target, before);
    } else {
      // The empty policy can be represented in snapshots even while its file is absent.
      const missingPolicy =
        target === path.join(root, SYNC_IGNORE_NAME) && options.syncIgnore === "" && before === "missing";
      const hash = hashes.get(target);
      expected.set(target, !missingPolicy && hash !== undefined ? `file:${hash}` : "missing");
    }
  }
  return expected;
}
