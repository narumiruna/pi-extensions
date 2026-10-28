import { Database } from "@tursodatabase/database";
import { type FileSystem, Filesystem } from "agentfs-sdk";
import { AgentFsWrapper } from "agentfs-sdk/just-bash";
import type { IFileSystem } from "just-bash";
import { validateDatabasePath, virtualPath } from "./paths.js";

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Add missing just-bash methods and preserve storage failures instead of treating them as absence. */
class VirtualFileSystem extends AgentFsWrapper implements IFileSystem {
  constructor(private readonly filesystem: FileSystem) {
    super({ fs: { fs: filesystem } });
  }

  override async exists(path: string): Promise<boolean> {
    try {
      await this.filesystem.access(virtualPath(path));
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return false;
    }
  }

  override async appendFile(...[path, content, options]: Parameters<AgentFsWrapper["appendFile"]>): Promise<void> {
    const normalized = virtualPath(path);
    let previous: Buffer;
    try {
      previous = Buffer.from(await this.filesystem.readFile(normalized));
    } catch (error) {
      // The upstream wrapper treats every read failure as an absent file, which can truncate
      // existing data after an I/O error. Only the SDK's explicit ENOENT means an empty file.
      if (!isMissing(error)) throw error;
      previous = Buffer.alloc(0);
    }
    const encoding = typeof options === "string" ? options : options?.encoding;
    const bytes = typeof content === "string" ? Buffer.from(content, encoding) : Buffer.from(content);
    await this.filesystem.writeFile(normalized, Buffer.concat([previous, bytes]));
  }

  async realpath(path: string): Promise<string> {
    const normalized = virtualPath(path);
    let current = "";
    for (const part of normalized.split("/").filter(Boolean)) {
      current += `/${part}`;
      const stat = await this.lstat(current);
      if (stat.isSymbolicLink) throw new Error("Symbolic links are not supported.");
    }
    return normalized;
  }

  async utimes(): Promise<void> {
    throw new Error("File timestamp changes are not supported.");
  }

  override async symlink(): Promise<void> {
    throw new Error("Symbolic links are not supported.");
  }

  override async link(): Promise<void> {
    throw new Error("Hard links are not supported.");
  }
}

/** One session owns one connection and one queue covering complete shell and file operations. */
export class Workspace {
  private state: "new" | "opening" | "ready" | "failed" | "closing" | "closed" = "new";
  private database?: Database;
  private filesystem?: FileSystem;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private databaseClosing?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private active?: AbortController;

  constructor(private readonly path: string) {
    validateDatabasePath(path);
  }

  open(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "opening") return this.opening as Promise<void>;
    if (this.state !== "new") return Promise.reject(new Error("AgentFS workspace is not available."));
    this.state = "opening";
    this.opening = this.initialize();
    return this.opening;
  }

  private async initialize(): Promise<void> {
    try {
      // Own the connection before initialization. Initialize only the public filesystem API:
      // AgentFS.openWith() starts unrelated schema branches in Promise.all and can reject before
      // sibling initialization work drains, making immediate failure cleanup unsafe.
      this.database = new Database(this.path);
      await this.database.connect();
      this.assertOpening();
      this.filesystem = await Filesystem.fromDatabase(this.database);
      this.assertOpening();
      this.state = "ready";
    } catch {
      if (this.state === "opening") this.state = "failed";
      await this.closeDatabase();
      throw new Error("AgentFS workspace initialization failed; no host fallback is available.");
    }
  }

  private assertOpening(): void {
    if (this.state !== "opening") throw new Error("AgentFS workspace was closed during initialization.");
  }

  private closeDatabase(): Promise<void> {
    this.databaseClosing ??= this.database?.close() ?? Promise.resolve();
    return this.databaseClosing;
  }

  run<T>(signal: AbortSignal | undefined, callback: (fs: IFileSystem, signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      if (this.state !== "ready" || !this.filesystem) throw new Error("AgentFS workspace is not ready or is closed.");
      const controller = new AbortController();
      this.active = controller;
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let valid = true;
      const pending = new Set<Promise<unknown>>();
      const check = () => {
        if (!valid || combined.aborted || this.state !== "ready") throw new Error("AgentFS operation aborted.");
      };
      // Track the actual database operations, not just the interpreter promise. Cancellation may
      // revoke an interpreter while a database operation is still completing. Drain before close.
      const guarded = new Proxy(this.filesystem, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            check();
            const work = Promise.resolve(Reflect.apply(value, target, args)).then((result) => {
              check();
              return result;
            });
            pending.add(work);
            void work.then(
              () => pending.delete(work),
              () => pending.delete(work),
            );
            return work;
          };
        },
      }) as FileSystem;
      try {
        check();
        const result = await callback(new VirtualFileSystem(guarded), combined);
        check();
        return result;
      } finally {
        valid = false;
        while (pending.size) await Promise.allSettled([...pending]);
        if (this.active === controller) this.active = undefined;
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closing";
    this.active?.abort();
    this.closing = (async () => {
      await this.opening?.catch(() => undefined);
      await this.tail;
      try {
        await this.closeDatabase();
      } finally {
        this.filesystem = undefined;
        this.state = "closed";
      }
    })();
    return this.closing;
  }
}
