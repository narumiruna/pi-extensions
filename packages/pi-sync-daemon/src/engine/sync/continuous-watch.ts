import { type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getEngineRoot as getAgentDir } from "../host.js";
import { isDeniedPath, toPosix } from "../paths.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { compileSyncExclude } from "./exclude-policy.js";

/** Hints only. The scheduler's periodic snapshot scan remains required. */
export async function watchContinuous(
  config: AnySyncConfig,
  changed: (settings: boolean) => void,
): Promise<() => void> {
  const root = getAgentDir();
  const watchers: FSWatcher[] = [];
  const excluded = compileSyncExclude(config.exclude);
  const selected = config.include.map((item) => path.resolve(root, item));
  const relevant = (target: string) =>
    selected.some(
      (item) => target === item || target.startsWith(`${item}${path.sep}`) || item.startsWith(`${target}${path.sep}`),
    );
  const add = (directory: string, recursive: boolean) => {
    try {
      const watcher = watch(directory, { recursive, persistent: false }, (_event, file) => {
        // Unknown names can be our own private writes. Periodic scans cover them.
        if (!file) return;
        const target = path.resolve(directory, String(file));
        if (target === path.join(root, "pi-sync.json")) changed(true);
        else if (isDeniedPath(path.relative(root, target))) return;
        else if (!excluded(toPosix(path.relative(root, target))) && relevant(target)) changed(false);
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      /* Periodic scans cover unavailable or unsupported watchers. */
    }
  };
  add(root, false);
  const directories = new Set<string>();
  try {
    for (const target of selected) {
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) continue;
        const directory = stat.isDirectory() ? target : path.dirname(target);
        if (directory === root || directories.has(directory)) continue;
        directories.add(directory);
        add(directory, stat.isDirectory());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        // Missing targets are found by the parent hint or the next periodic scan.
      }
    }
    return () => {
      for (const watcher of watchers) watcher.close();
    };
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
}
