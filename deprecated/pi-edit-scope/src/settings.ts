import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface ScopeSettings {
  showHiddenFiles: boolean;
}

// Keep one lexical key across first creation and atomic replacement. A file-identity
// queue can change keys when a missing file appears through a parent symlink.
// In-process ordering only, shared by stores with the same absolute lexical path.
// This is not a cross-process lock and does not merge aliases of parent symlinks.
const queues = new Map<string, Promise<void>>();

function enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const result = (queues.get(path) ?? Promise.resolve()).then(operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return result;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function validateDocument(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Scope settings at ${JSON.stringify(path)}: expected a JSON object.`);
  }
  const document = value as Record<string, unknown>;
  if (Object.hasOwn(document, "showHiddenFiles") && typeof document.showHiddenFiles !== "boolean") {
    throw new Error(`Invalid Scope settings at ${JSON.stringify(path)}: showHiddenFiles must be a boolean.`);
  }
  return document;
}

async function readDocument(path: string): Promise<{ document: Record<string, unknown>; mode: number }> {
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return { document: {}, mode: 0o600 };
    throw error;
  }
  // Atomic rename would replace a settings symlink instead of its referent.
  // Reject it explicitly, including dangling links, rather than surprise the user.
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Scope settings must be a regular file, not a symlink: ${JSON.stringify(path)}.`);
  }
  const text = await fs.readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid Scope settings JSON at ${JSON.stringify(path)}. Repair the file before saving.`, {
      cause: error,
    });
  }
  return { document: validateDocument(parsed, path), mode: Number(stats.mode) & 0o777 };
}

export class ScopeSettingsStore {
  readonly #filePath: string;
  #current: ScopeSettings = { showHiddenFiles: false };

  constructor(filePath: string) {
    this.#filePath = resolve(filePath);
  }

  get current(): ScopeSettings {
    return { ...this.#current };
  }

  /** Side-effect-free load; a failed read leaves the last effective value intact. */
  load(): Promise<ScopeSettings> {
    return enqueue(this.#filePath, async () => {
      const { document } = await readDocument(this.#filePath);
      this.#current = { showHiddenFiles: (document.showHiddenFiles as boolean | undefined) ?? false };
      return this.current;
    });
  }

  /** Read the latest valid document and change only the owned field. */
  saveShowHiddenFiles(value: boolean): Promise<ScopeSettings> {
    return enqueue(this.#filePath, async () => {
      if (typeof value !== "boolean") throw new Error("showHiddenFiles must be a boolean.");
      const { document, mode } = await readDocument(this.#filePath);
      const directory = dirname(this.#filePath);
      await fs.mkdir(directory, { recursive: true });
      const temporary = join(directory, `.${basename(this.#filePath)}.${process.pid}.${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let ownedTemporary = false;
      try {
        handle = await fs.open(temporary, "wx", mode);
        ownedTemporary = true;
        await handle.writeFile(`${JSON.stringify({ ...document, showHiddenFiles: value }, null, 2)}\n`, "utf8");
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, this.#filePath);
        ownedTemporary = false;
      } catch (error) {
        const failures: unknown[] = [error];
        if (handle) {
          try {
            await handle.close();
          } catch (closeError) {
            failures.push(closeError);
          }
        }
        if (ownedTemporary) {
          try {
            await fs.unlink(temporary);
          } catch (cleanupError) {
            if (!isMissing(cleanupError)) failures.push(cleanupError);
          }
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, `Scope settings save and cleanup failed at ${JSON.stringify(temporary)}.`);
        }
        throw error;
      }
      // Publish runtime state only after the complete file was renamed successfully.
      this.#current = { showHiddenFiles: value };
      return this.current;
    });
  }

  /** Drain prior operations; load/save promises carry their own errors to the caller. */
  flush(): Promise<void> {
    return enqueue(this.#filePath, async () => {});
  }
}
