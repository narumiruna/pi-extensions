import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface ImagegenSettings {
  toolEnabled: boolean;
  transparentBackground: boolean;
}

export function defaultSettings(): ImagegenSettings {
  return {
    toolEnabled: true,
    transparentBackground: false,
  };
}

type SaveOptions = {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  // Must be synchronous and reversible, including after a partial failure.
  apply?: (next: ImagegenSettings, previous: ImagegenSettings) => void;
};
type Document = Record<string, unknown>;
const keys = ["toolEnabled", "transparentBackground"] as const;

class SettingsError extends Error {}

function object(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(document: Document): void {
  for (const key of keys) {
    if (!Object.hasOwn(document, key)) continue;
    const value = document[key];
    if (typeof value !== "boolean")
      throw new SettingsError("Invalid image generation settings. Repair the file before saving.");
  }
}

function check(options: SaveOptions): void {
  if (options.signal?.aborted || (options.isCurrent && !options.isCurrent()))
    throw new SettingsError("Settings change cancelled.");
}

async function readDocument(path: string): Promise<{ document: Document; bytes?: Buffer }> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return { document: {} };
    throw new SettingsError("Settings cannot be read. Repair the file before saving.");
  }
  try {
    const document: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(document)) throw new Error();
    validate(document);
    return { document, bytes };
  } catch {
    throw new SettingsError("Invalid image generation settings. Repair the file before saving.");
  }
}

function applySynchronously(apply: SaveOptions["apply"], next: ImagegenSettings, previous: ImagegenSettings) {
  // Copies prevent a callback from changing the store or the rollback snapshot.
  const result: unknown = apply?.({ ...next }, { ...previous });
  if (object(result) && typeof result.then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new SettingsError("Settings application must be synchronous.");
  }
}

/** User-only settings with in-process ordering; this is not a cross-process lock. */
export class SettingsStore {
  readonly path: string;
  private current: ImagegenSettings;
  private readonly defaults: ImagegenSettings;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(agentDir: string) {
    this.path = join(agentDir, "pi-codex-imagegen.json");
    this.defaults = defaultSettings();
    this.current = { ...this.defaults };
  }

  get settings(): ImagegenSettings {
    return { ...this.current };
  }

  private effective(document: Document): ImagegenSettings {
    const next = { ...this.defaults };
    for (const key of keys) {
      if (Object.hasOwn(document, key)) Object.assign(next, { [key]: document[key] });
    }
    return next;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Register immediately: a per-instance deferred registration can reorder other stores' requests.
    const task = withFileMutationQueue(this.path, operation).catch((error: unknown) => {
      if (error instanceof SettingsError) throw error;
      throw new SettingsError("Settings operation failed. Check file permissions and available disk space.");
    });
    // A queue-registration failure can settle before an earlier transaction.
    this.tail = Promise.all([this.tail, task.catch(() => {})]);
    return task;
  }

  load(): Promise<{ settings: ImagegenSettings; warning?: string }> {
    return this.enqueue(async () => {
      try {
        const { document } = await readDocument(this.path);
        this.current = this.effective(document);
        return { settings: this.settings };
      } catch {
        // Invalid or unreadable settings must not grant model access.
        this.current = { ...this.defaults, toolEnabled: false };
        return {
          settings: this.settings,
          warning: "Image generation settings could not be loaded. Repair the file before saving.",
        };
      }
    });
  }

  save(patch: Partial<ImagegenSettings>, options: SaveOptions = {}): Promise<ImagegenSettings> {
    // Capture user action values, not a mutable object referenced by a queued task.
    const captured = { ...patch };
    return this.enqueue(async () => {
      check(options);
      if (!object(patch) || Object.keys(captured).some((key) => !keys.some((owned) => owned === key)))
        throw new SettingsError("Invalid image generation settings change.");
      validate(captured);
      const { document, bytes } = await readDocument(this.path);
      check(options);
      const previous = this.settings;
      const nextDocument = { ...document, ...captured };
      const next = this.effective(nextDocument);
      const owned = new Set<string>();
      let published = false;
      let applyAttempted = false;
      const temporary = join(dirname(this.path), `.pi-codex-imagegen-${randomUUID()}.tmp`);
      const backup = join(dirname(this.path), `.pi-codex-imagegen-${randomUUID()}.tmp`);
      const stage = async (path: string, content: string | Buffer) => {
        check(options);
        const handle = await fs.open(path, "wx", 0o600);
        owned.add(path);
        try {
          check(options);
          await handle.writeFile(content);
          check(options);
        } finally {
          await handle.close();
        }
        check(options);
      };
      try {
        await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        check(options);
        await stage(temporary, `${JSON.stringify(nextDocument, null, 2)}\n`);
        check(options);
        if (bytes !== undefined) {
          await stage(backup, bytes);
          check(options);
        }
        await fs.rename(temporary, this.path);
        published = true;
        owned.delete(temporary);
        check(options);
        applyAttempted = true;
        applySynchronously(options.apply, next, previous);
        check(options);
        // No await between runtime application and effective-state publication.
        this.current = next;
        return this.settings;
      } catch (error) {
        let rollbackFailed = false;
        if (applyAttempted) {
          try {
            applySynchronously(options.apply, previous, next);
          } catch {
            rollbackFailed = true;
          }
        }
        this.current = previous;
        // Rollback must finish even when the request no longer owns the session.
        if (published) {
          try {
            if (bytes === undefined) await fs.rm(this.path);
            else {
              await fs.rename(backup, this.path);
              owned.delete(backup);
            }
          } catch {
            rollbackFailed = true;
          }
        }
        if (rollbackFailed) throw new SettingsError("Settings rollback failed. Reload and inspect the settings file.");
        if (error instanceof SettingsError) throw error;
        throw new SettingsError("Settings were not saved. Check file permissions and runtime application.");
      } finally {
        // This cleanup does not publish state and must also run after cancellation.
        await Promise.all([...owned].map((path) => fs.rm(path, { force: true }).catch(() => {})));
      }
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}
