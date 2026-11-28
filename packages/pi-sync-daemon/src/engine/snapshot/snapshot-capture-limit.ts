import { constants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export class SnapshotCaptureLimitError extends Error {
  constructor() {
    super("Snapshot exceeds the file review capture limits.");
  }
}

export interface SnapshotCaptureLimits {
  maxDepth: number;
  examineEntry(): void;
  admitFile(size: number): void;
  readEntries(directory: string, signal?: AbortSignal): Promise<Dirent[]>;
  readFile(file: string, signal?: AbortSignal): Promise<Buffer>;
}

function unsafeSource(): never {
  throw new Error("Snapshot source changed or has an unsafe filesystem layout.");
}

async function identifySource(file: string, signal?: AbortSignal): Promise<Stats> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (await fs.realpath(file)) !== file) unsafeSource();
  signal?.throwIfAborted();
  return stat;
}

function requireSameSource(before: Stats, after: Stats) {
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.nlink !== before.nlink ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    unsafeSource();
}

export function createSnapshotCaptureLimits(limits: {
  bytes: number;
  entries: number;
  files: number;
  depth: number;
}): SnapshotCaptureLimits {
  let { bytes, entries, files } = limits;
  function examineEntry() {
    if (entries < 1) throw new SnapshotCaptureLimitError();
    entries--;
  }
  function admitFile(size: number) {
    if (files < 1 || size > bytes) throw new SnapshotCaptureLimitError();
    files--;
    bytes -= size;
  }
  return {
    maxDepth: limits.depth,
    examineEntry,
    admitFile,
    async readEntries(directory, signal) {
      const absolute = path.resolve(directory);
      const stat = await identifySource(absolute, signal);
      if (!stat.isDirectory()) unsafeSource();
      const handle = await fs.opendir(absolute);
      try {
        requireSameSource(stat, await identifySource(absolute, signal));
        const result: Dirent[] = [];
        for (;;) {
          signal?.throwIfAborted();
          const entry = await handle.read();
          if (!entry) break;
          examineEntry();
          result.push(entry);
        }
        requireSameSource(stat, await identifySource(absolute, signal));
        return result;
      } finally {
        await handle.close();
      }
    },
    async readFile(file, signal) {
      signal?.throwIfAborted();
      const absolute = path.resolve(file);
      const stat = await identifySource(absolute, signal);
      if (!stat.isFile() || stat.nlink !== 1) unsafeSource();
      admitFile(stat.size);
      const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        requireSameSource(stat, await handle.stat());
        requireSameSource(stat, await identifySource(absolute, signal));
        const content = Buffer.alloc(stat.size);
        for (let offset = 0; offset < content.length; ) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
          if (bytesRead === 0) unsafeSource();
          offset += bytesRead;
        }
        requireSameSource(stat, await handle.stat());
        requireSameSource(stat, await identifySource(absolute, signal));
        return content;
      } finally {
        await handle.close();
      }
    },
  };
}
