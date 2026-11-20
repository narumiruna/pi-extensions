import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { posix, resolve } from "node:path";

const refreshIntervalMs = 5_000;

async function scanFiles(root: string, signal: AbortSignal): Promise<Set<string>> {
  const paths = new Set<string>();
  const directories = [""];
  for (const directory of directories) {
    if (signal.aborted) return paths;
    let entries: Dirent[];
    try {
      entries = await readdir(resolve(root, directory), { withFileTypes: true });
    } catch {
      // A directory can disappear during a scan. Retry it in the next snapshot.
      continue;
    }
    if (signal.aborted) return paths;
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile()) {
        paths.add(path);
      }
    }
  }
  return paths;
}

interface FileMatch {
  path?: string;
  /** Markdown matches for an ambiguous bare filename, including the root file if present. */
  sources?: readonly string[];
}

interface FileIndex {
  find(target: string): FileMatch | undefined;
  dispose(): void;
}

function samePaths(previous: Set<string>, next: Set<string>): boolean {
  if (previous.size !== next.size) return false;
  for (const path of next) {
    if (!previous.has(path)) return false;
  }
  return true;
}

/** Indexes checkout files on first lookup and refreshes until disposed. */
export function createFileIndex(root: string, onChange: () => void): FileIndex {
  const controller = new AbortController();
  let paths = new Set<string>();
  let names = new Map<string, string[]>();
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh(): Promise<void> {
    const next = await scanFiles(root, controller.signal);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => void refresh(), refreshIntervalMs).unref();
    if (samePaths(paths, next)) return;

    paths = next;
    names = new Map();
    for (const path of [...paths].sort()) {
      const name = posix.basename(path);
      const matches = names.get(name);
      if (!matches) names.set(name, [path]);
      else if (name === path) matches.unshift(path);
      else matches.push(path);
    }
    onChange();
  }

  return {
    find(target) {
      const path = target.replace(/^\.\//, "");
      if (controller.signal.aborted || !path || /[\\\p{Cc}]/u.test(path)) return undefined;
      if (!started) {
        started = true;
        void refresh();
      }
      const note = `${path}.md`;
      const exact = paths.has(path) ? path : paths.has(note) ? note : undefined;
      if (target.includes("/")) return exact ? { path: exact } : undefined;

      const literal = names.get(path);
      const name = exact ?? (literal && (literal.length === 1 || /\.md$/i.test(path)) ? path : note);
      const matches = names.get(name);
      if (!matches) return undefined;
      const primary = exact ?? (matches.length === 1 ? matches[0] : undefined);
      if (matches.length > 1 && /\.md$/i.test(name)) return { path: primary, sources: matches };
      return primary ? { path: primary } : undefined;
    },
    dispose() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
