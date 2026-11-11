import { createHash } from "node:crypto";
import { chunkTextFile } from "./chunks.js";
import type { SearchDatabase, StoredFileRecord } from "./database.js";
import { type DiscoveryResult, loadTextFile, searchFileStatus, UnsupportedSearchFileError } from "./files.js";

export interface IndexProgress {
  current: number;
  total: number;
  path: string;
}

export interface IndexUpdateResult {
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
}

const mutationQueues = new Map<string, Promise<void>>();

export function refreshIndex(
  database: SearchDatabase,
  discovery: DiscoveryResult,
  signal?: AbortSignal,
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexUpdateResult> {
  return enqueueMutation(database.path, signal, () => refreshIndexNow(database, discovery, signal, onProgress));
}

async function refreshIndexNow(
  database: SearchDatabase,
  discovery: DiscoveryResult,
  signal?: AbortSignal,
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexUpdateResult> {
  signal?.throwIfAborted();
  const existing = new Map(database.listFiles().map((file) => [file.path, file]));
  const discoveredPaths = new Set(discovery.files.map((file) => file.path));
  let indexed = 0;
  let unchanged = 0;
  let skipped = discovery.skippedFiles;
  const unavailableFiles: StoredFileRecord[] = [];

  for (let index = 0; index < discovery.files.length; index += 1) {
    signal?.throwIfAborted();
    const file = discovery.files[index];
    if (!file) continue;
    onProgress?.({ current: index + 1, total: discovery.files.length, path: file.path });
    const previous = existing.get(file.path);
    if (
      previous &&
      previous.dev === file.dev &&
      previous.ino === file.ino &&
      previous.size === file.size &&
      previous.mtimeNs === file.mtimeNs
    ) {
      unchanged += 1;
      continue;
    }

    let loaded: Awaited<ReturnType<typeof loadTextFile>>;
    try {
      loaded = await loadTextFile(file, discovery.root, signal);
    } catch (error: unknown) {
      if (signal?.aborted || isAbortError(error)) throw error;
      if (error instanceof UnsupportedSearchFileError) {
        if (previous) database.removeFilesIfUnchanged([previous]);
      } else {
        const current = database.getFile(file.path);
        if (current && (await searchFileStatus(discovery.root, current, signal)) !== "current") {
          unavailableFiles.push(current);
        }
      }
      skipped += 1;
      continue;
    }

    signal?.throwIfAborted();
    const chunked = chunkTextFile(file.path, loaded.lines);
    const hash = createHash("sha256").update(loaded.text, "utf8").digest("hex");
    database.replaceFile(
      {
        path: file.path,
        dev: file.dev,
        ino: file.ino,
        size: file.size,
        mtimeNs: file.mtimeNs,
        hash,
        title: chunked.title,
        outline: chunked.outline,
      },
      chunked.chunks,
    );
    indexed += 1;
  }

  signal?.throwIfAborted();
  const removalCandidates: StoredFileRecord[] = [];
  for (const file of existing.values()) {
    if (discoveredPaths.has(file.path)) continue;
    const status = await searchFileStatus(discovery.root, file, signal);
    if (status === "current") continue;
    if (status === "unavailable") {
      unavailableFiles.push(file);
      continue;
    }
    removalCandidates.push(file);
  }
  signal?.throwIfAborted();
  const removed = database.removeFilesIfUnchanged(removalCandidates);
  database.setUnavailableFiles(unavailableFiles);
  await database.secureArtifacts();
  signal?.throwIfAborted();
  return { indexed, unchanged, removed, skipped };
}

function enqueueMutation<T>(path: string, signal: AbortSignal | undefined, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let started = false;
  const reserved = previous.then(async () => {
    signal?.throwIfAborted();
    started = true;
    return await mutation();
  });
  const settled = reserved.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(path, settled);
  void settled.finally(() => {
    if (mutationQueues.get(path) === settled) mutationQueues.delete(path);
  });
  return signal ? waitForQueuedPromise(reserved, signal, () => started) : reserved;
}

function waitForQueuedPromise<T>(promise: Promise<T>, signal: AbortSignal, hasStarted: () => boolean): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (!hasStarted()) reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}
