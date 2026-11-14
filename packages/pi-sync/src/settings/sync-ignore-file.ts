import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { syncDirectory } from "../state/json-file.js";
import { DEFAULT_SYNC_IGNORE, normalizeSyncIgnore, SYNC_IGNORE_NAME } from "../sync/sync-ignore.js";

let afterPublication = async () => {};

export async function withSyncIgnorePublicationHookForTest<T>(hook: () => Promise<void>, run: () => Promise<T>) {
  const previous = afterPublication;
  afterPublication = hook;
  try {
    return await run();
  } finally {
    afterPublication = previous;
  }
}

export function syncIgnorePath() {
  return path.join(getAgentDir(), SYNC_IGNORE_NAME);
}

/** No directory or file is created by a read; symlinks and invalid UTF-8 fail closed. */
export async function readSyncIgnoreFile(): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(path.dirname(syncIgnorePath()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (names.some((name) => name.startsWith(".syncignore.tmp-") && name.endsWith(".previous")))
    throw new Error(
      "Pending .syncignore recovery evidence; preserve .syncignore.tmp-*.previous files and review before syncing.",
    );
  return readSyncIgnoreText();
}

async function readSyncIgnoreText(): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  let initial: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    initial = await fs.lstat(syncIgnorePath());
    if (!initial.isFile()) throw new Error(".syncignore must be a regular file, not a symlink or directory.");
    handle = await fs.open(syncIgnorePath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > 256 * 1_024)
      throw new Error(".syncignore must be a regular UTF-8 file at most 256 KiB.");
    const bytes = await handle.readFile();
    return normalizeSyncIgnore(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } finally {
    await handle.close();
  }
}

/** Caller holds the settings cross-process lock; Pi file queues also serialize snapshot apply. */
export async function publishSyncIgnore(text: string, expected: string | undefined, signal?: AbortSignal) {
  normalizeSyncIgnore(text);
  return withFileMutationQueue(syncIgnorePath(), async () => {
    signal?.throwIfAborted();
    if ((await readSyncIgnoreFile()) !== expected)
      throw new Error(".syncignore changed; reopen and review the current rules.");
    const destination = syncIgnorePath();
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    const recovery = `${temporary}.previous`;
    let installed: { dev: number; ino: number } | undefined;
    let published = false;
    let retainRecovery = false;
    try {
      const previous = await fs.open(recovery, "wx", 0o600);
      try {
        await previous.writeFile(expected ?? "", "utf8");
        await previous.sync();
      } finally {
        await previous.close();
      }
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
        installed = await handle.stat();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      if ((await readSyncIgnoreText()) !== expected) throw new Error(".syncignore changed; no rules were replaced.");
      await fs.rename(temporary, destination);
      published = true;
      await afterPublication();
      await syncDirectory(path.dirname(destination));
    } catch (error) {
      if (published) {
        try {
          const current = await fs.lstat(destination);
          if (
            !current.isFile() ||
            current.dev !== installed?.dev ||
            current.ino !== installed.ino ||
            (await readSyncIgnoreText()) !== text
          )
            throw new Error(
              ".syncignore changed after publication; preserve recovery evidence and review the current file.",
            );
          if (expected === undefined) await fs.unlink(destination);
          else await fs.rename(recovery, destination);
          await syncDirectory(path.dirname(destination));
        } catch (rollbackError) {
          retainRecovery = true;
          throw new Error(
            ".syncignore publication failed and could not be safely restored; preserve .syncignore.tmp-* recovery files and review before syncing.",
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
      }
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
      if (!retainRecovery) await fs.rm(recovery, { force: true });
    }
  });
}

export async function initializeSyncIgnore(signal?: AbortSignal) {
  const existing = await readSyncIgnoreFile();
  if (existing === undefined) await publishSyncIgnore(DEFAULT_SYNC_IGNORE, undefined, signal);
  return existing ?? DEFAULT_SYNC_IGNORE;
}
