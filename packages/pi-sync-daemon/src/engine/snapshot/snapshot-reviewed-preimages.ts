import { createHash } from "node:crypto";
import path from "node:path";
import { snapshotTarget } from "./snapshot.js";
import type { AgentDirectoryInventory, SnapshotApplyPlan, SnapshotFile } from "./snapshot-types.js";

interface DirectoryImage {
  entries: Map<string, string | DirectoryImage>;
  unreviewed?: boolean;
}

function image(entry: string | DirectoryImage): string {
  if (entry === "unreviewed" || (typeof entry !== "string" && entry.unreviewed))
    throw new Error("Reviewed directory contains an unreviewed entry; no replacement is authorized.");
  if (typeof entry === "string") return entry;
  const rows = [...entry.entries.keys()]
    .sort()
    .map((name) => [name, image(entry.entries.get(name) as string | DirectoryImage)]);
  return `directory:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

export function reviewedSnapshotPreimages(
  root: string,
  sessionDir: string | undefined,
  reviewed: readonly SnapshotFile[],
  plan: SnapshotApplyPlan,
  inventory?: AgentDirectoryInventory,
) {
  const images = new Map<string, string | DirectoryImage>();
  function insert(target: string, entry: string | DirectoryImage) {
    const existing = images.get(target);
    if (existing) {
      if (typeof entry === "string" || typeof existing === "string")
        throw new Error("Reviewed paths conflict before apply.");
      return;
    }
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
  for (const file of reviewed) insert(snapshotTarget(root, file.path, sessionDir), `file:${file.sha256}`);
  if (inventory) {
    for (const [target, kind] of inventory.entries) {
      if (kind === "directory") insert(target, { entries: new Map() });
    }
    for (const [target, kind] of inventory.entries) {
      if (kind !== "unreviewed") continue;
      const entry = images.get(target);
      if (entry && typeof entry !== "string") entry.unreviewed = true;
      const parent = images.get(path.dirname(target));
      if (parent && typeof parent !== "string") parent.entries.set(path.basename(target), "unreviewed");
    }
  }
  const targets = new Set([...plan.deletes, ...plan.writes.map(({ target }) => target)]);
  return new Map(
    [...targets].map((target) => {
      const entry = inventory?.entries.get(target) === "unreviewed" ? "unreviewed" : images.get(target);
      return [target, entry === undefined ? "missing" : image(entry)];
    }),
  );
}
