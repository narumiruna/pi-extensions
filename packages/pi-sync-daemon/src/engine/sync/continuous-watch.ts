import { type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getEngineRoot as getAgentDir } from "../host.js";
import { isDeniedPath, toPosix } from "../paths.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { sessionStorageRoot } from "../snapshot/snapshot-paths.js";
import { compileSyncExclude } from "./exclude-policy.js";
import { compileSyncPolicyTraversal, configuredSnapshotPathMatcher, syncSessionsSelected } from "./sync-policy.js";

function relativeWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : toPosix(relative);
}

/** Hints only. The scheduler's periodic snapshot scan remains required. */
export async function watchContinuous(
  config: AnySyncConfig,
  changed: (settings: boolean) => void,
  options: { sessionDir?: string; signal?: AbortSignal } = {},
): Promise<() => void> {
  const root = getAgentDir();
  const watchers: FSWatcher[] = [];
  const excluded = compileSyncExclude(config.exclude);
  const selected = config.include.map((item) => path.resolve(root, item));
  const scoped = config.scope === "agent-directory";
  const sessionRoot = sessionStorageRoot(root, options.sessionDir);
  const managed = configuredSnapshotPathMatcher(config);
  const traverse = compileSyncPolicyTraversal(config);
  const scopedPath = (target: string) => {
    const sessionPath = relativeWithin(sessionRoot, target);
    if (sessionPath !== undefined) return sessionPath ? `sessions/${sessionPath}` : "sessions";
    const relative = relativeWithin(root, target);
    return relative && !/^sessions(?:\/|$)/iu.test(relative) ? relative : undefined;
  };
  const relevant = (target: string) =>
    selected.some(
      (item) => target === item || target.startsWith(`${item}${path.sep}`) || item.startsWith(`${target}${path.sep}`),
    );
  let closed = false;
  const add = (directory: string, recursive: boolean) => {
    try {
      const watcher = watch(directory, { recursive, persistent: false }, (event, file) => {
        // Unknown names can be our own private writes. Periodic scans cover them.
        if (!file || closed || options.signal?.aborted) return;
        const target = path.resolve(directory, String(file));
        if (!relativeWithin(directory, target)) return;
        if (target === path.join(root, "pi-sync.json")) changed(true);
        else if (scoped) {
          const relative = scopedPath(target);
          if (relative && (managed(relative) || (event === "rename" && traverse(relative)))) changed(false);
        } else if (
          !isDeniedPath(path.relative(root, target)) &&
          !excluded(toPosix(path.relative(root, target))) &&
          relevant(target)
        ) {
          changed(false);
        }
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      /* Periodic scans cover unavailable or unsupported watchers. */
    }
  };
  const directories = new Set<string>([root]);
  const close = () => {
    if (closed) return;
    closed = true;
    for (const watcher of watchers) watcher.close();
  };
  try {
    options.signal?.throwIfAborted();
    add(root, false);
    if (scoped) {
      const pending = [root];
      if (syncSessionsSelected(config) && traverse("sessions")) pending.push(sessionRoot);
      const scheduled = new Set(pending);
      for (let index = 0; index < pending.length && index < 512; index++) {
        const directory = pending[index];
        if (!directory) continue;
        options.signal?.throwIfAborted();
        try {
          const stat = await fs.lstat(directory);
          options.signal?.throwIfAborted();
          if (!stat.isDirectory()) continue;
          if (directory !== root) add(directory, false);
          const entries = await fs.readdir(directory, { withFileTypes: true });
          options.signal?.throwIfAborted();
          for (const entry of entries) {
            if (pending.length >= 512) break;
            if (!entry.isDirectory()) continue;
            const target = path.join(directory, entry.name);
            const relative = scopedPath(target);
            if (relative && traverse(relative) && !scheduled.has(target)) {
              scheduled.add(target);
              pending.push(target);
            }
          }
        } catch {
          options.signal?.throwIfAborted();
        }
      }
      return close;
    }
    for (const target of selected) {
      try {
        const stat = await fs.lstat(target);
        options.signal?.throwIfAborted();
        if (stat.isSymbolicLink()) continue;
        const directory = stat.isDirectory() ? target : path.dirname(target);
        if (directory === root || directories.has(directory)) continue;
        directories.add(directory);
        add(directory, stat.isDirectory());
      } catch (error) {
        options.signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        // Missing targets are found by the parent hint or the next periodic scan.
      }
    }
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
