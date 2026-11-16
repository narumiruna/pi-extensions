import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
  daemonPaths,
  privateDirectory,
  processExists,
  type RuntimePaths,
  readIdentity,
  readJsonBody,
  runtimePaths,
} from "./identity.js";
import { withCleanup } from "./lifecycle.js";
import {
  type Callback,
  type ClientEvent,
  type ClientFacts,
  type ClientHandoff,
  type Identity,
  type JobView,
  MAX_MESSAGE_BYTES,
  MAX_REVIEW_BYTES,
  operationPrefix,
  REVIEW_PAGE_CHARS,
  type RemoteError,
  record,
} from "./protocol.js";

export class DaemonError extends Error {
  readonly remote: RemoteError;
  constructor(remote: RemoteError) {
    super(remote.message);
    this.name = remote.name;
    this.remote = remote;
  }
}
export async function requestDaemon(
  paths: RuntimePaths,
  identity: Identity,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const body = JSON.stringify({
    version: 1,
    root: paths.root,
    instance: identity.instance,
    token: identity.token,
    method,
    params,
  });
  if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw new Error("Daemon request exceeds its byte limit.");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: daemonPaths(paths, identity.instance).endpoint,
        path: "/v1",
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        void readJsonBody(response)
          .then((value) => {
            if (!record(value)) throw new Error("Invalid daemon response.");
            if (record(value.error) && typeof value.error.message === "string")
              throw new DaemonError(value.error as unknown as RemoteError);
            if (response.statusCode !== 200 || !Object.hasOwn(value, "result"))
              throw new Error("Invalid daemon response.");
            resolve(value.result);
          })
          .catch(reject);
      },
    );
    // Attach can wait behind a complete apply. Its connection-owned signal/dispose
    // cancels that wait; an idle timeout must not let startup escape the admission fence.
    request.setTimeout(method === "attach" ? 0 : 30_000, () => request.destroy(new Error("Daemon request timed out.")));
    request.once("error", reject);
    request.end(body);
  });
}
async function hello(paths: RuntimePaths, identity: Identity) {
  const value = await requestDaemon(paths, identity, "hello", {});
  if (
    !record(value) ||
    value.version !== 1 ||
    value.root !== paths.root ||
    value.instance !== identity.instance ||
    value.pid !== identity.pid
  )
    throw new Error("Daemon handshake mismatch.");
}
/** Explicit startup only: callers decide whether configuration or a user action authorizes it. */
export async function ensureDaemon(root: string, signal?: AbortSignal) {
  const paths = await runtimePaths(root);
  signal?.throwIfAborted();
  await privateDirectory(paths.directory);
  signal?.throwIfAborted();
  const release = await lockfile.lock(paths.directory, {
    realpath: false,
    lockfilePath: paths.startup,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
  });
  try {
    signal?.throwIfAborted();
    const existing = await readIdentity(paths);
    if (existing) {
      try {
        await hello(paths, existing);
        signal?.throwIfAborted();
        return { paths: daemonPaths(paths, existing.instance), identity: existing };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (processExists(existing.pid))
          throw new Error(
            "A daemon owner is alive but unavailable; use diagnostics instead of starting a second owner.",
            { cause: error },
          );
      }
    }
    const executable = process.versions.bun ? "node" : process.execPath;
    const child = spawn(
      executable,
      [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve", "--root", paths.root],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    const ready = await new Promise<Identity>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.off("message", message);
        child.off("error", failed);
        child.off("exit", exited);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (code: number | null) =>
        failed(new Error(`Daemon startup exited (${code}); private state was retained.`));
      const message = (value: unknown) => {
        if (!record(value)) return;
        if (value.type === "booting") {
          timer = setTimeout(() => failed(new Error("Daemon readiness timed out.")), 15_000);
          timer.unref?.();
        }
        if (value.type === "error")
          failed(new Error(typeof value.message === "string" ? value.message : "Daemon startup failed."));
        if (value.type === "ready" && record(value.identity)) {
          cleanup();
          resolve(value.identity as unknown as Identity);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.on("message", message);
      child.once("error", failed);
      child.once("exit", exited);
      if (signal?.aborted) abort();
    }).finally(() => {
      if (child.connected) child.disconnect();
      child.unref();
    });
    // Never kill a published shared daemon on caller cancellation.
    await hello(paths, ready);
    signal?.throwIfAborted();
    return { paths: daemonPaths(paths, ready.instance), identity: ready };
  } finally {
    await release();
  }
}

/** Inspect an existing compatible owner without starting one. */
export async function findDaemon(root: string) {
  let paths: RuntimePaths;
  try {
    paths = await runtimePaths(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const identity = await readIdentity(paths);
  if (!identity || !processExists(identity.pid)) return undefined;
  await hello(paths, identity);
  return { paths: daemonPaths(paths, identity.instance), identity };
}

/** Gracefully stop an existing compatible owner without creating a new service. */
export async function stopDaemon(root: string): Promise<boolean> {
  const paths = await runtimePaths(root);
  const identity = await readIdentity(paths);
  if (!identity) return false;
  // The authenticated stop response is itself instance/root/version bound, even
  // when a changed agent root makes ordinary health checks fail closed.
  await requestDaemon(paths, identity, "stop", {});
  const deadline = Date.now() + 30_000;
  for (;;) {
    const current = await readIdentity(paths);
    if (!current || current.instance !== identity.instance) return true;
    if (Date.now() >= deadline) throw new Error("Daemon did not drain; no replacement was attempted.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export interface ConnectionOptions {
  callback(callback: Callback, signal: AbortSignal): Promise<unknown>;
  event?(event: ClientEvent): void;
  error?(error: unknown): void;
}
export class DaemonConnection {
  private cursor = 0;
  private controller = new AbortController();
  private callbacks = new Map<string, { controller: AbortController; kind: string; job: string }>();
  private callbackIO = new AbortController();
  private callbackTasks = new Set<Promise<void>>();
  private updates = Promise.resolve();
  private attached = false;
  private uncertain = false;
  private reportedError = false;
  private commits = new Map<string, { notify(): void; signal?: AbortSignal }>();
  private completedCallbacks = new Set<string>();
  private disposing: Promise<void> | undefined;
  private polling: Promise<void> | undefined;
  private closed = false;
  constructor(
    readonly paths: RuntimePaths,
    readonly identity: Identity,
    readonly facts: ClientFacts,
    private readonly options: ConnectionOptions,
  ) {}
  async attach() {
    if (this.closed || this.uncertain) throw new Error("Daemon client is unavailable; reconnect after draining work.");
    const request = requestDaemon(this.paths, this.identity, "attach", this.facts, this.controller.signal);
    // Poll during attach: stopping a previous controller may need release answers
    // from this reattached participant before the attach response can complete.
    this.polling ??= this.poll();
    try {
      const result = await request;
      this.consume(result);
      this.attached = true;
      return this;
    } catch (error) {
      return withCleanup(
        async () => {
          throw error;
        },
        () => this.dispose(),
      );
    }
  }
  update(facts: ClientFacts) {
    const update = this.updates.then(async () => {
      if (this.closed || this.uncertain)
        throw new Error("Daemon client is unavailable; reconnect after draining work.");
      const result = await requestDaemon(this.paths, this.identity, "update", { facts }, this.controller.signal);
      if (this.closed) throw new Error("Daemon client closed during update.");
      Object.assign(this.facts, facts);
      this.consume(result);
    });
    this.updates = update.catch(() => {});
    return update;
  }
  async run(operation: string, payload: unknown, signal?: AbortSignal, onCommit?: () => void): Promise<unknown> {
    if (this.closed || this.uncertain) throw new Error("Daemon client is unavailable; reconnect after draining work.");
    signal?.throwIfAborted();
    const id = `${operationPrefix(this.identity)}${randomUUID()}`;
    const abort = () => {
      void requestDaemon(
        this.paths,
        this.identity,
        "cancel",
        { id, client: this.facts.id },
        this.controller.signal,
      ).catch(() => {});
    };
    let terminal = false;
    if (onCommit) this.commits.set(id, { notify: onCommit, signal });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return withCleanup(
      async () => {
        await requestDaemon(
          this.paths,
          this.identity,
          "submit",
          { id, client: this.facts.id, operation, payload },
          this.controller.signal,
        );
        while (!this.closed) {
          const reply = await requestDaemon(
            this.paths,
            this.identity,
            "poll",
            { client: this.facts.id, cursor: this.cursor, job: id },
            this.controller.signal,
          );
          this.consume(reply);
          const job = record(reply) ? (reply.job as JobView | undefined) : undefined;
          if (job?.phase === "failed") {
            terminal = true;
            throw new DaemonError(job.error ?? { name: "Error", message: "Daemon operation failed." });
          }
          if (job?.phase === "done") {
            terminal = true;
            signal?.throwIfAborted();
            return job.result;
          }
          await this.wait(25, true);
        }
        throw new Error("Daemon client closed before operation completed.");
      },
      async () => {
        signal?.removeEventListener("abort", abort);
        this.commits.delete(id);
        if (!terminal && !this.closed) {
          for (const callback of this.callbacks.values())
            if (callback.job === id && !callback.kind.startsWith("queue-")) callback.controller.abort();
          try {
            await requestDaemon(this.paths, this.identity, "cancel", { id, client: this.facts.id });
          } catch (error) {
            this.uncertain = true;
            for (const callback of this.callbacks.values())
              if (callback.kind !== "queue-release") callback.controller.abort();
            throw new Error(
              "Operation outcome is uncertain; reload to reconnect and reconcile, never replay the write.",
              { cause: error },
            );
          }
        }
      },
    );
  }
  private consume(reply: unknown) {
    if (
      !record(reply) ||
      typeof reply.cursor !== "number" ||
      !Number.isSafeInteger(reply.cursor) ||
      reply.cursor < 0 ||
      !Array.isArray(reply.callbacks) ||
      !Array.isArray(reply.events)
    )
      throw new Error("Invalid daemon poll response.");
    if (reply.cursor < this.cursor) return;
    for (const event of reply.events as ClientEvent[])
      if (event.id > this.cursor) {
        if (event.kind === "commit" && record(event.payload) && typeof event.payload.job === "string") {
          const current = this.commits.get(event.payload.job);
          this.commits.delete(event.payload.job);
          if (current && !current.signal?.aborted) current.notify();
        }
        this.options.event?.(event);
      }
    this.cursor = Math.max(this.cursor, reply.cursor);
    const present = new Set((reply.callbacks as Callback[]).map((callback) => callback.id));
    for (const [id, { controller }] of this.callbacks)
      if (!present.has(id)) controller.abort(new DOMException("Callback is no longer current", "AbortError"));
    for (const callback of reply.callbacks as Callback[]) {
      if (this.callbacks.has(callback.id) || this.completedCallbacks.has(callback.id)) continue;
      if (this.completedCallbacks.size >= 4096) this.uncertain = true;
      const controller = new AbortController();
      this.callbacks.set(callback.id, { controller, kind: callback.kind, job: callback.job });
      const task = (async () => {
        let value: unknown;
        let failed = false;
        try {
          if (this.uncertain && callback.kind !== "queue-release")
            throw new Error("Client is draining uncertain work.");
          value = await this.performCallback(callback, controller.signal);
        } catch {
          failed = true;
        }
        await requestDaemon(
          this.paths,
          this.identity,
          "answer",
          {
            client: this.facts.id,
            id: callback.id,
            ...(failed ? { error: "Client callback cancelled or failed." } : { value }),
          },
          this.callbackIO.signal,
        );
      })()
        .catch((error) => {
          if (!this.closed && !controller.signal.aborted) this.reportError(error);
        })
        .finally(() => {
          if (this.completedCallbacks.size < 4096) this.completedCallbacks.add(callback.id);
          this.callbacks.delete(callback.id);
          this.callbackTasks.delete(task);
        });
      this.callbackTasks.add(task);
    }
  }
  private async performCallback(callback: Callback, signal: AbortSignal) {
    const reference = callback.review;
    if (!reference) return this.options.callback(callback, signal);
    if (
      callback.kind !== "merge-review" ||
      !record(callback.payload) ||
      !Number.isSafeInteger(reference.pages) ||
      reference.pages < 1 ||
      reference.pages > Math.ceil(MAX_REVIEW_BYTES / REVIEW_PAGE_CHARS) ||
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes > MAX_REVIEW_BYTES ||
      reference.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(reference.sha256)
    )
      throw new Error("Invalid exact-review reference.");
    const ownedSignal = AbortSignal.any([signal, this.callbackIO.signal]);
    const pages: string[] = [];
    for (let index = 0; index < reference.pages; index++) {
      ownedSignal.throwIfAborted();
      const page = await requestDaemon(
        this.paths,
        this.identity,
        "review-page",
        { client: this.facts.id, id: callback.id, index },
        ownedSignal,
      );
      ownedSignal.throwIfAborted();
      if (
        !record(page) ||
        page.id !== callback.id ||
        page.index !== index ||
        typeof page.content !== "string" ||
        page.content.length > REVIEW_PAGE_CHARS
      )
        throw new Error("Invalid exact-review page.");
      pages.push(page.content);
    }
    const content = pages.join("");
    if (
      Buffer.byteLength(content) !== reference.bytes ||
      createHash("sha256").update(content).digest("hex") !== reference.sha256
    )
      throw new Error("Exact-review contents changed; approval was refused.");
    ownedSignal.throwIfAborted();
    return this.options.callback({ ...callback, review: undefined, payload: { ...callback.payload, content } }, signal);
  }
  private async wait(ms: number, keepAlive = false) {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, ms);
      if (!keepAlive) timer.unref?.();
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      function done() {
        signal.removeEventListener("abort", abort);
        resolve();
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private reportError(error: unknown) {
    if (this.reportedError) return;
    this.reportedError = true;
    try {
      this.options.error?.(error);
    } catch {
      /* Error presentation must not own a task. */
    }
  }
  private async poll() {
    while (!this.closed) {
      try {
        const reply = await requestDaemon(
          this.paths,
          this.identity,
          "poll",
          { client: this.facts.id, cursor: this.cursor },
          this.controller.signal,
        );
        this.consume(reply);
        this.reportedError = false;
        await this.wait(100);
      } catch (error) {
        if (this.closed) return;
        if (this.attached) this.reportError(error);
        try {
          await this.wait(100);
        } catch {
          return;
        }
      }
    }
  }
  async pause() {
    if (this.closed) throw new Error("Daemon client is closed.");
    const reply = await requestDaemon(this.paths, this.identity, "pause", { client: this.facts.id });
    this.consume(reply);
  }
  async dispose(handoff?: ClientHandoff) {
    if (this.disposing) return this.disposing;
    if (this.closed) return;
    this.disposing = (async () => {
      this.polling ??= this.poll();
      // Cancel UI before drain, but keep polling for acknowledged queue-release callbacks.
      for (const { controller, kind } of this.callbacks.values()) if (!kind.startsWith("queue-")) controller.abort();
      try {
        const reply = await requestDaemon(this.paths, this.identity, handoff ? "handoff" : "detach", {
          client: this.facts.id,
          generation: this.facts.generation,
          pid: this.facts.pid,
          handoff,
        });
        this.consume(reply);
      } finally {
        this.closed = true;
        this.controller.abort(new DOMException("Client disposed", "AbortError"));
        this.callbackIO.abort(new DOMException("Client callback transport disposed", "AbortError"));
        for (const { controller } of this.callbacks.values()) controller.abort();
        await Promise.allSettled([this.polling, this.updates, ...this.callbackTasks]);
      }
    })();
    return this.disposing;
  }
}
