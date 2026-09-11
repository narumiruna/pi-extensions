import { randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SettledRun } from "../types.js";
import { AnalyticsStorageFormatError, decodeStoredRun, encodeStoredRun, MAX_STORED_RUN_BYTES } from "./format.js";

const GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_WRITE_TIMEOUT_MS = 5_000;
const YIELD_EVERY_RECORDS = 100;

export interface ClearAnalyticsResult {
  cleanupIncomplete: boolean;
}

export class AnalyticsGenerationChangedError extends Error {
  constructor() {
    super("The active analytics generation changed during the read.");
    this.name = "AnalyticsGenerationChangedError";
  }
}

export class AnalyticsRunFiles {
  private readonly createId: () => string;
  private readonly writeTimeoutMs: number;
  private readonly beforeAppend?: (generation: string, signal: AbortSignal) => Promise<void>;
  private readonly beforeCleanupEntry?: (signal?: AbortSignal) => Promise<void>;
  private readonly beforeReadFile?: (signal?: AbortSignal) => Promise<void>;
  private writerId: string;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly lifecycle = new AbortController();
  private closed = false;

  constructor(
    readonly path: string,
    options: {
      createId?: () => string;
      writeTimeoutMs?: number;
      beforeAppend?: (generation: string, signal: AbortSignal) => Promise<void>;
      beforeCleanupEntry?: (signal?: AbortSignal) => Promise<void>;
      beforeReadFile?: (signal?: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.beforeAppend = options.beforeAppend;
    this.beforeCleanupEntry = options.beforeCleanupEntry;
    this.beforeReadFile = options.beforeReadFile;
    this.writerId = validCreatedId(this.createId());
  }

  append(run: SettledRun, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Analytics storage is closed."));
    const frame = encodeStoredRun(run);
    return this.enqueueMutation(() =>
      withDeadline(signal, this.lifecycle.signal, this.writeTimeoutMs, (operationSignal) =>
        this.appendFrame(frame, operationSignal),
      ),
    );
  }

  async *read(signal?: AbortSignal): AsyncIterable<SettledRun> {
    throwIfAborted(signal);
    const generation = await this.readOrCreateGeneration(signal);
    const directory = this.generationPath(generation);
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.assertGenerationUnchanged(generation, signal);
        throw new AnalyticsGenerationChangedError();
      }
      throw error;
    }
    let count = 0;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      throwIfAborted(signal);
      if (!entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(directory, entry.name);
      try {
        await this.beforeReadFile?.(signal);
        throwIfAborted(signal);
        await assertPrivateRegularFile(filePath);
        for await (const run of readFrames(filePath, signal)) {
          yield run;
          count += 1;
          if (count % YIELD_EVERY_RECORDS === 0) await yieldToEventLoop(signal);
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          await this.assertGenerationUnchanged(generation, signal);
          throw new AnalyticsGenerationChangedError();
        }
        throw error;
      }
    }
    await this.assertGenerationUnchanged(generation, signal);
  }

  clear(signal?: AbortSignal): Promise<ClearAnalyticsResult> {
    if (this.closed) return Promise.reject(new Error("Analytics storage is closed."));
    let result: ClearAnalyticsResult = { cleanupIncomplete: false };
    return this.enqueueMutation(() =>
      withLinkedSignals(signal, this.lifecycle.signal, async (operationSignal) => {
        throwIfAborted(operationSignal);
        await this.readOrCreateGeneration(operationSignal);
        const next = validCreatedId(this.createId());
        await this.publishGeneration(next);
        this.writerId = validCreatedId(this.createId());
        const current = await readGenerationMarker(path.join(this.path, "current"));
        await ensurePrivateDirectory(this.generationPath(current));
        if (!(await this.cleanupObsoleteGenerations(operationSignal))) {
          result = { cleanupIncomplete: true };
        }
      }),
    ).then(() => result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort(new DOMException("Analytics storage closed", "AbortError"));
    await this.mutationTail.catch(() => undefined);
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.catch(() => undefined);
    return result;
  }

  private async appendFrame(frame: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let obsoleteDirectory: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = await this.readOrCreateGeneration(signal);
      const directory = this.generationPath(generation);
      await ensurePrivateDirectory(directory);
      const filePath = path.join(directory, `${this.writerId}.jsonl`);
      await assertOptionalPrivateRegularFile(filePath);
      throwIfAborted(signal);
      await this.beforeAppend?.(generation, signal);
      throwIfAborted(signal);
      try {
        await writeFile(filePath, frame, {
          encoding: "utf8",
          flag: "a",
          mode: 0o600,
          signal,
        });
        if (process.platform !== "win32") await chmod(filePath, 0o600);
        const current = await readGenerationMarker(path.join(this.path, "current"), signal);
        if (current === generation) {
          if (obsoleteDirectory) {
            await cleanupGeneration(obsoleteDirectory, signal).catch(() => undefined);
          }
          return;
        }
        obsoleteDirectory = directory;
      } catch (error) {
        this.writerId = validCreatedId(this.createId());
        throwIfAborted(signal);
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
    throw new AnalyticsGenerationChangedError();
  }

  private async readOrCreateGeneration(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    await ensurePrivateDirectory(this.path);
    await ensurePrivateDirectory(path.join(this.path, "generations"));
    const markerPath = path.join(this.path, "current");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let generation: string;
      try {
        generation = await readGenerationMarker(markerPath, signal);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        generation = validCreatedId(this.createId());
        throwIfAborted(signal);
        try {
          await createPrivateFile(markerPath, `${generation}\n`);
        } catch (createError) {
          if (!isNodeError(createError) || createError.code !== "EEXIST") throw createError;
          generation = await readGenerationMarker(markerPath, signal);
        }
      }
      await ensurePrivateDirectory(this.generationPath(generation));
      const current = await readGenerationMarker(markerPath, signal);
      if (current === generation) return generation;
    }
    throw new AnalyticsGenerationChangedError();
  }

  private async publishGeneration(generation: string): Promise<void> {
    const markerPath = path.join(this.path, "current");
    const temporaryPath = path.join(this.path, `.current.${validCreatedId(this.createId())}.tmp`);
    await createPrivateFile(temporaryPath, `${generation}\n`);
    try {
      await rename(temporaryPath, markerPath);
      if (process.platform !== "win32") await chmod(markerPath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async cleanupObsoleteGenerations(signal?: AbortSignal): Promise<boolean> {
    let complete = true;
    const root = path.join(this.path, "generations");
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const active = await readGenerationMarker(path.join(this.path, "current"));
      if (entry.name === active) continue;
      if (!entry.isDirectory() || !GENERATION_PATTERN.test(entry.name)) {
        complete = false;
        continue;
      }
      try {
        await cleanupGeneration(path.join(root, entry.name), signal, this.beforeCleanupEntry);
      } catch {
        complete = false;
        if (signal?.aborted) break;
      }
    }
    const active = await readGenerationMarker(path.join(this.path, "current"));
    const remaining = await readdir(root, { withFileTypes: true });
    return complete && remaining.every((entry) => entry.isDirectory() && entry.name === active);
  }

  private async assertGenerationUnchanged(generation: string, signal?: AbortSignal): Promise<void> {
    const current = await readGenerationMarker(path.join(this.path, "current"), signal);
    if (current !== generation) throw new AnalyticsGenerationChangedError();
  }

  private generationPath(generation: string): string {
    return path.join(this.path, "generations", generation);
  }
}

async function* readFrames(filePath: string, signal?: AbortSignal): AsyncIterable<SettledRun> {
  let pending = "";
  const stream = createReadStream(filePath, { encoding: "utf8", signal });
  for await (const chunk of stream) {
    throwIfAborted(signal);
    pending += String(chunk);
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      yield decodeStoredRun(line);
    }
    if (Buffer.byteLength(pending) > MAX_STORED_RUN_BYTES) {
      throw new AnalyticsStorageFormatError("Analytics record is too large to read safely.");
    }
  }
  // A writer always terminates complete frames with a newline. An unterminated tail is a
  // crash residue and is ignored; this writer file will not be reused after its process exits.
}

async function readGenerationMarker(markerPath: string, signal?: AbortSignal): Promise<string> {
  await assertPrivateRegularFile(markerPath);
  throwIfAborted(signal);
  const value = (await readFile(markerPath, { encoding: "utf8", signal })).trim();
  if (!GENERATION_PATTERN.test(value)) {
    throw new AnalyticsStorageFormatError("Analytics generation marker is invalid.");
  }
  return value;
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  try {
    const metadata = await lstat(directoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Analytics storage paths must be regular directories, not links.");
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Analytics storage paths must be regular directories, not links.");
    }
  }
  if (process.platform !== "win32") await chmod(directoryPath, 0o700);
}

async function assertOptionalPrivateRegularFile(filePath: string): Promise<void> {
  try {
    await assertPrivateRegularFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function assertPrivateRegularFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Analytics storage files must be regular files, not links.");
  }
  if (process.platform !== "win32") await chmod(filePath, 0o600);
}

async function createPrivateFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupGeneration(
  directoryPath: string,
  signal?: AbortSignal,
  beforeEntry?: (signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  throwIfAborted(signal);
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    throwIfAborted(signal);
    await beforeEntry?.(signal);
    throwIfAborted(signal);
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      throw new Error("Analytics generation contains an unexpected storage entry.");
    }
    await unlink(path.join(directoryPath, entry.name));
  }
  throwIfAborted(signal);
  await rmdir(directoryPath);
}

async function withLinkedSignals<T>(
  callerSignal: AbortSignal | undefined,
  lifecycleSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(callerSignal);
  throwIfAborted(lifecycleSignal);
  const controller = new AbortController();
  const abort = (signal: AbortSignal) =>
    controller.abort(signal.reason ?? new DOMException("Analytics operation aborted", "AbortError"));
  const callerAbort = () => callerSignal && abort(callerSignal);
  const lifecycleAbort = () => abort(lifecycleSignal);
  callerSignal?.addEventListener("abort", callerAbort, { once: true });
  lifecycleSignal.addEventListener("abort", lifecycleAbort, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    callerSignal?.removeEventListener("abort", callerAbort);
    lifecycleSignal.removeEventListener("abort", lifecycleAbort);
  }
}

async function withDeadline<T>(
  callerSignal: AbortSignal | undefined,
  lifecycleSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(callerSignal);
  throwIfAborted(lifecycleSignal);
  const controller = new AbortController();
  const abort = (signal: AbortSignal) =>
    controller.abort(signal.reason ?? new DOMException("Analytics operation aborted", "AbortError"));
  const callerAbort = () => callerSignal && abort(callerSignal);
  const lifecycleAbort = () => abort(lifecycleSignal);
  callerSignal?.addEventListener("abort", callerAbort, { once: true });
  lifecycleSignal.addEventListener("abort", lifecycleAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Analytics write timed out", "TimeoutError")),
    Math.max(1, timeoutMs),
  );
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (
      controller.signal.aborted &&
      error instanceof Error &&
      error.name === "AbortError" &&
      error.cause === controller.signal.reason
    ) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", callerAbort);
    lifecycleSignal.removeEventListener("abort", lifecycleAbort);
  }
}

async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

function validCreatedId(value: string): string {
  if (!GENERATION_PATTERN.test(value)) throw new Error("Analytics storage received an invalid ID.");
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Analytics operation aborted", "AbortError");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
