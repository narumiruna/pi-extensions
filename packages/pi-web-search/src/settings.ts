import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const EXPOSURES = ["codemode", "direct", "deferred", "model-only", "hidden"] as const;
export interface Settings {
  accountId: string;
  apiToken: string;
  gatewayId: string;
  exposure: (typeof EXPOSURES)[number];
  limit: number;
  timeoutMs: number;
  byokAlias: string;
}
export const DEFAULTS: Readonly<Settings> = {
  accountId: "",
  apiToken: "",
  gatewayId: "default",
  exposure: "codemode",
  limit: 5,
  timeoutMs: 30_000,
  byokAlias: "",
};
const MAX_FILE_BYTES = 64 * 1024;
export function settingsFilePath() {
  return join(getAgentDir(), "pi-web-search.json");
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSettings(document: unknown): Settings {
  if (!isObject(document)) throw new Error("Settings must be a JSON object.");
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (Object.hasOwn(document, key)) Object.assign(settings, { [key]: document[key] });
  }
  if (
    typeof settings.accountId !== "string" ||
    (settings.accountId !== "" && !/^[a-f0-9]{32}$/i.test(settings.accountId))
  )
    throw new Error("Invalid accountId: expected a 32-character hexadecimal account ID.");
  if (typeof settings.apiToken !== "string" || !/^[\x21-\x7e]{0,4096}$/.test(settings.apiToken))
    throw new Error("Invalid apiToken: expected a printable ASCII token without whitespace.");
  if (typeof settings.gatewayId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(settings.gatewayId))
    throw new Error("Invalid gatewayId: expected 1–64 letters, digits, underscores or hyphens.");
  if (!EXPOSURES.includes(settings.exposure)) throw new Error("Invalid exposure.");
  if (!Number.isInteger(settings.limit) || settings.limit < 1 || settings.limit > 10)
    throw new Error("Invalid limit: expected 1–10.");
  if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 120_000)
    throw new Error("Invalid timeoutMs: expected 1000–120000.");
  if (
    typeof settings.byokAlias !== "string" ||
    (settings.byokAlias !== "" && !/^[A-Za-z0-9_-]{1,64}$/.test(settings.byokAlias))
  )
    throw new Error("Invalid byokAlias: expected 1–64 letters, digits, underscores or hyphens, or empty.");
  return settings;
}

async function readDocument(path: string): Promise<Record<string, unknown>> {
  let handle: FileHandle | undefined;
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error("unsafe");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > MAX_FILE_BYTES)
      throw new Error("unsafe");
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) throw new Error("permissions");
    // Read from the checked inode, with a bound even if another process grows it.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error("oversized");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    normalizeSettings(value);
    return value as Record<string, unknown>;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return {};
    // Never surface JSON parser excerpts, filesystem error paths or token values.
    throw new Error(
      "Cannot read pi-web-search.json: repair its JSON/values and use a regular file (maximum 64 KB, POSIX permissions 0600).",
    );
  } finally {
    await handle?.close();
  }
}

async function ensurePrivateDirectory(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isObject(error) && error.code === "EEXIST") {
      if (!(await stat(path)).isDirectory()) throw error;
      return; // Existing directory permissions belong to the user.
    }
    if (!isObject(error) || error.code !== "ENOENT" || dirname(path) === path) throw error;
    // Create and fix each ancestor before descending; recursive mkdir can strand
    // an inaccessible ancestor under umasks that mask owner permissions.
    await ensurePrivateDirectory(dirname(path), signal);
    return ensurePrivateDirectory(path, signal);
  }
  // Finish making a directory we created usable even if cancellation just arrived.
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  private readonly publish: typeof rename;
  constructor(path = settingsFilePath(), publish = rename) {
    this.path = path;
    this.publish = publish;
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Register immediately so every store observes invocation order. Keep flush
    // waiting for earlier work even if a later queue registration fails early.
    const result = withFileMutationQueue(this.path, task);
    this.queue = Promise.allSettled([this.queue, result]).then(() => undefined);
    return result;
  }
  load(): Promise<Settings> {
    return this.enqueue(async () => normalizeSettings(await readDocument(this.path)));
  }
  async flush(): Promise<void> {
    await this.queue;
  }
  save(patch: Partial<Settings>, signal?: AbortSignal): Promise<Settings> {
    // Snapshot caller-owned data before entering the queue.
    const changes = { ...patch };
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const current = await readDocument(this.path);
      signal?.throwIfAborted();
      const document = { ...current, ...changes };
      const settings = normalizeSettings(document);
      const data = `${JSON.stringify(document, null, 2)}\n`;
      if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error("Settings exceed 64 KB.");
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await ensurePrivateDirectory(dirname(this.path), signal);
        signal?.throwIfAborted();
        const handle = await open(temporary, "wx", 0o600);
        try {
          // open's mode is filtered by umask; publish the exact mode we require on reads.
          if (process.platform !== "win32") await handle.chmod(0o600);
          await handle.writeFile(data, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal?.throwIfAborted();
        await this.publish(temporary, this.path);
        // Rename is the commit boundary; a cancellation after it cannot undo a save.
        return settings;
      } catch {
        throw new Error("Could not save pi-web-search.json; previous settings were kept.");
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }
}
