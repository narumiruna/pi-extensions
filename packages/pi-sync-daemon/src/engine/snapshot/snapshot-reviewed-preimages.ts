import { createHash } from "node:crypto";
import path from "node:path";
import { snapshotTarget } from "./snapshot.js";
import type { SnapshotApplyPlan, SnapshotFile } from "./snapshot-types.js";

interface DirectoryImage {
  entries: Map<string, string | DirectoryImage>;
}

function image(entry: string | DirectoryImage): string {
  if (typeof entry === "string") return entry;
  const rows = [...entry.entries.keys()]
    .sort()
    .map((name) => [name, image(entry.entries.get(name) as string | DirectoryImage)]);
  return `directory:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

/** Bind the plan to the reviewed bytes. Vacant and directory targets need preimages too. */
export function reviewedSnapshotPreimages(
  root: string,
  sessionDir: string | undefined,
  reviewed: readonly SnapshotFile[],
  plan: SnapshotApplyPlan,
) {
  const images = new Map<string, string | DirectoryImage>();
  for (const file of reviewed) {
    let target = snapshotTarget(root, file.path, sessionDir);
    let entry: string | DirectoryImage = `file:${file.sha256}`;
    images.set(target, entry);
    for (let parent = path.dirname(target); parent !== target; parent = path.dirname(target)) {
      const existing = images.get(parent);
      if (typeof existing === "string") throw new Error("Reviewed paths conflict before apply.");
      const directory = existing ?? { entries: new Map() };
      directory.entries.set(path.basename(target), entry);
      if (existing) break;
      images.set(parent, directory);
      target = parent;
      entry = directory;
    }
  }
  const targets = new Set([...plan.deletes, ...plan.writes.map(({ target }) => target)]);
  return new Map(
    [...targets].map((target) => {
      const entry = images.get(target);
      return [target, entry === undefined ? "missing" : image(entry)];
    }),
  );
}
