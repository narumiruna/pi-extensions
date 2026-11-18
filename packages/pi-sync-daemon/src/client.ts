import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { lt, valid } from "semver";
import { DAEMON_BUILD_VERSION } from "./build-version.js";
import {
  canonicalRootGuard,
  clearUpgradeOwner,
  daemonPaths,
  privateDirectory,
  processExists,
  processExited,
  type RuntimePaths,
  readIdentity,
  readJsonBody,
  readProcessBirth,
  readUpgradeOwner,
  recordUpgradeOwner,
  runtimePaths,
  type UpgradeOwner,
  upgradeRepairStarted,
} from "./identity.js";
import { withCleanup } from "./lifecycle.js";
import {
  type Callback,
  type ClientEvent,
  type ClientFacts,
  type ClientHandoff,
  type ClientContact as ContactState,
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
    // Admission can wait behind a complete apply. The request owner's signal
    // cancels that wait; an idle timeout must not let admission escape the fence.
    request.setTimeout(method === "attach" || method === "resume-contact" ? 0 : 30_000, () =>
      request.destroy(new Error("Daemon request timed out.")),
    );
    request.once("error", reject);
    request.end(body);
  });
}
async function hello(paths: RuntimePaths, identity: Identity, signal?: AbortSignal) {
  const value = await requestDaemon(paths, identity, "hello", {}, signal);
  if (
    !record(value) ||
    value.version !== 1 ||
    value.root !== paths.root ||
    value.instance !== identity.instance ||
    value.pid !== identity.pid
  )
    throw new Error("Daemon handshake mismatch.");
  const version = value.buildVersion;
  if (Object.hasOwn(value, "buildVersion") && (typeof version !== "string" || valid(version) !== version))
    throw new Error("Invalid daemon build version.");
  // The old @narumitw/sync-daemon used the same wire protocol without a build version.
  return { needsUpgrade: typeof version !== "string" || lt(version, DAEMON_BUILD_VERSION) };
}

async function checkUpgradeConsent(paths: RuntimePaths, assertRoot: () => void, signal?: AbortSignal) {
  const { readConsent } = await import("./consent.js");
  const { withStateDirectoryGuardForRoot } = await import("./engine/state/state-directory.js");
  signal?.throwIfAborted();
  await withStateDirectoryGuardForRoot(paths.root, () => {
    signal?.throwIfAborted();
    assertRoot();
    // An older owner cannot report an in-memory revocation failure.
    const consent = readConsent(paths.root);
    if (consent && Object.values(consent.setups).some((setup) => setup.afterExit))
      throw new Error("Review or revoke unattended Pi Sync permission before restarting the older daemon.");
  });
  signal?.throwIfAborted();
  assertRoot();
}

async function finishUpgrade(paths: RuntimePaths, owner: UpgradeOwner, assertRoot: () => void, signal?: AbortSignal) {
  await waitForProcessExit(owner, signal);
  if ((await readIdentity(paths))?.instance === owner.instance)
    throw new Error("The daemon exited without releasing its identity.");
  await checkUpgradeConsent(paths, assertRoot, signal);
  await clearUpgradeOwner(paths);
  signal?.throwIfAborted();
  assertRoot();
}

async function drainForUpgrade(
  paths: RuntimePaths,
  owner: Identity,
  { recorded, birth }: { recorded?: UpgradeOwner; birth?: string },
  assertRoot: () => void,
  signal?: AbortSignal,
) {
  await checkUpgradeConsent(paths, assertRoot, signal);
  const barrier = recorded ?? { ...owner, birth };
  try {
    // Publish this before stop can remove the identity. A retry keeps the original evidence.
    if (!recorded) await recordUpgradeOwner(paths, barrier);
    assertRoot();
    const reply = await requestDaemon(paths, owner, "stop", {}, signal);
    if (!record(reply) || reply.stopping !== true) throw new Error("Daemon did not acknowledge stop.");
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      "Pi Sync could not upgrade the older daemon safely. Check `pi-sync-daemon status --root <agent-directory>`. Do not force a second owner or remove recovery files.",
      { cause: error },
    );
  }
  await finishUpgrade(paths, barrier, assertRoot, signal);
}

export async function acquireStartupLock(paths: RuntimePaths, signal?: AbortSignal) {
  // Include the handshake, stop, exit wait, boot, and final handshake budgets.
  const deadline = performance.now() + 150_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await lockfile.lock(paths.directory, {
        realpath: false,
        lockfilePath: paths.startup,
        stale: 30_000,
        update: 5_000,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (performance.now() >= deadline)
        throw new Error("Timed out waiting to start the Pi Sync daemon.", { cause: error });
      await delay(50, undefined, { signal });
    }
  }
}

/** Explicit startup only: callers decide whether configuration or a user action authorizes it. */
export async function ensureDaemon(root: string, signal?: AbortSignal) {
  const paths = await runtimePaths(root);
  const assertRoot = canonicalRootGuard(paths.root);
  signal?.throwIfAborted();
  await privateDirectory(paths.directory);
  signal?.throwIfAborted();
  const release = await acquireStartupLock(paths, signal);
  try {
    signal?.throwIfAborted();
    let waited = false;
    let upgraded = false;
    for (;;) {
      signal?.throwIfAborted();
      const upgrade = await readUpgradeOwner(paths);
      if (upgrade && (await upgradeRepairStarted(paths, upgrade)))
        throw new Error("A daemon upgrade repair is incomplete. Run `pi-sync-daemon repair-upgrade` for this root.");
      const existing = await readIdentity(paths);
      if (upgrade && existing?.instance === upgrade.instance && existing.pid !== upgrade.pid)
        throw new Error("The recorded upgrade owner changed; private state was retained.");
      if (upgrade && (existing?.instance !== upgrade.instance || (await processExited(upgrade)))) {
        await finishUpgrade(paths, upgrade, assertRoot, signal);
        upgraded = true;
        continue;
      }
      if (!existing) break;
      // A sample taken only after hello could describe an unrelated process reusing the PID.
      const beforeHello = upgrade ? undefined : await readProcessBirth(existing.pid);
      let status: Awaited<ReturnType<typeof hello>>;
      try {
        status = await hello(paths, existing, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (upgrade) {
          // The stop may have been accepted even if the old endpoint no longer replies.
          await finishUpgrade(paths, upgrade, assertRoot, signal);
          upgraded = true;
          continue;
        }
        if (error instanceof DaemonError && error.remote.name === "DaemonStoppingError" && !waited) {
          waited = true;
          await waitForDaemonExit(existing, signal);
          continue;
        }
        if (processExists(existing.pid))
          throw new Error(
            "A daemon owner is alive but unavailable; use diagnostics instead of starting a second owner.",
            { cause: error },
          );
        break;
      }
      signal?.throwIfAborted();
      assertRoot();
      if (!status.needsUpgrade) {
        if (upgrade) throw new Error("The recorded upgrade owner changed; private state was retained.");
        return { paths: daemonPaths(paths, existing.instance), identity: existing, ...status };
      }
      if (upgraded)
        throw new Error("An older Pi Sync daemon started again. Close or upgrade other Pi sessions, then use /reload.");
      const birth = beforeHello === undefined ? undefined : await readProcessBirth(existing.pid);
      if (birth !== undefined && birth !== beforeHello)
        throw new Error("The daemon process changed during authentication; private state was retained.");
      await drainForUpgrade(paths, existing, { recorded: upgrade, birth }, assertRoot, signal);
      upgraded = true;
    }
    signal?.throwIfAborted();
    assertRoot();
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
    const status = await hello(paths, ready, signal);
    signal?.throwIfAborted();
    assertRoot();
    if (status.needsUpgrade) throw new Error("The daemon installation changed during startup. Use /reload to retry.");
    return { paths: daemonPaths(paths, ready.instance), identity: ready, ...status };
  } finally {
    await release();
  }
}

/** Wait only for a previously authenticated owner; never kill it or infer exit from lost contact. */
export async function waitForDaemonExit({ pid }: Pick<Identity, "pid">, signal?: AbortSignal) {
  await waitForProcessExit({ pid }, signal);
}

async function waitForProcessExit(owner: Parameters<typeof processExited>[0], signal?: AbortSignal) {
  const deadline = Date.now() + 30_000;
  signal?.throwIfAborted();
  while (!(await processExited(owner))) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Closing daemon is still alive; replacement was not attempted.");
    await delay(25, undefined, { signal });
  }
  signal?.throwIfAborted();
}

/** Inspect an existing protocol-compatible owner without starting or replacing it. */
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
  try {
    const status = await hello(paths, identity);
    return { paths: daemonPaths(paths, identity.instance), identity, ...status };
  } catch (error) {
    if (error instanceof DaemonError && error.remote.name === "DaemonStoppingError") return undefined;
    throw error;
  }
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
  /** Each current background observation after admission, including repeated states. */
  contact?(state: ContactState): void;
}
export class DaemonConnection {
  private cursor = 0;
  private controller = new AbortController();
  private callbacks = new Map<string, { controller: AbortController; kind: string; job: string }>();
  private callbackIO = new AbortController();
  private callbackTasks = new Set<Promise<void>>();
  private updates = Promise.resolve();
  private attached = false;
  private admitting = false;
  private observedContact: ContactState | undefined;
  private contactRevision = 0;
  private lifecycleRevision = 0;
  private resuming: AbortController | undefined;
  private resumeUncertain = false;
  private pendingJobs = 0;
  private uncertain = false;
  private reportedError = false;
  private commits = new Map<string, { notify(): void; signal?: AbortSignal }>();
  private completedCallbacks = new Set<string>();
  private pausing: Promise<void> | undefined;
  private disposing: Promise<void> | undefined;
  private polling: Promise<void> | undefined;
  private closed = false;
  constructor(
    readonly paths: RuntimePaths,
    readonly identity: Identity,
    readonly facts: ClientFacts,
    private readonly options: ConnectionOptions,
  ) {}
  /** Latest owner observation, or undefined if contact is unsupported or not observed. */
  get contactState(): ContactState | undefined {
    return this.observedContact;
  }
  /** An uncertain attempt must not be retried or turned into a new attach. */
  get contactResumeState(): "idle" | "running" | "uncertain" {
    return this.resumeUncertain ? "uncertain" : this.resuming ? "running" : "idle";
  }
  /** Original submitted jobs must finish (or be reconciled) before repairing contact. */
  get hasPendingWork(): boolean {
    return this.pendingJobs > 0 || this.uncertain;
  }
  async attach(signal?: AbortSignal) {
    if (
      this.closed ||
      this.hasPendingWork ||
      this.contactResumeState !== "idle" ||
      this.admitting ||
      this.pausing ||
      this.disposing
    )
      throw new Error("Daemon client is unavailable; reconnect after draining work.");
    this.admitting = true;
    this.lifecycleRevision++;
    this.contactRevision++;
    const request = requestDaemon(
      this.paths,
      this.identity,
      "attach",
      this.facts,
      signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal,
    );
    // Poll during attach: stopping a previous controller may need release answers
    // from this reattached participant before the attach response can complete.
    this.polling ??= this.poll();
    let admitted = false;
    try {
      const result = await request;
      admitted = true;
      this.publishContact(this.consume(result));
      this.attached = true;
      return this;
    } catch (error) {
      return withCleanup(
        async () => {
          throw error;
        },
        async () => {
          try {
            await this.dispose();
          } catch (cleanupError) {
            if (
              !admitted &&
              !this.attached &&
              this.closed &&
              !this.callbacks.size &&
              !this.callbackTasks.size &&
              !this.completedCallbacks.size &&
              error instanceof DaemonError &&
              error.remote.name === "DaemonStoppingError"
            ) {
              // The fenced first attach owned no grants, and local tasks have drained.
              // Keep its retry marker even if the owner closes the cleanup transport.
              error.cause = cleanupError;
              return;
            }
            throw cleanupError;
          }
        },
      );
    } finally {
      this.admitting = false;
    }
  }
  async update(facts: ClientFacts) {
    const lifecycle = this.lifecycleRevision;
    if (this.admitting || this.pausing || this.disposing)
      throw new Error("Daemon client is changing; wait before updating facts.");
    const update = this.updates.then(async () => {
      if (this.closed || this.uncertain || this.resumeUncertain || lifecycle !== this.lifecycleRevision)
        throw new Error("Daemon client is unavailable; reconnect after draining work.");
      const revision = this.contactRevision;
      let result: unknown;
      try {
        result = await requestDaemon(this.paths, this.identity, "update", { facts }, this.controller.signal);
      } catch (error) {
        if (
          this.attached &&
          revision === this.contactRevision &&
          this.sameClient(facts) &&
          error instanceof DaemonError &&
          error.remote.name === "ClientContactExpiredError"
        )
          this.publishContact("expired");
        throw error;
      }
      if (this.closed) throw new Error("Daemon client closed during update.");
      if (revision !== this.contactRevision) throw new Error("Daemon client changed during update.");
      const contact = this.consume(result);
      if (revision !== this.contactRevision) throw new Error("Daemon client changed during update.");
      Object.assign(this.facts, facts);
      this.publishContact(contact);
    });
    this.updates = update.catch(() => {});
    return update;
  }
  /** Resume this participant without replacing its callbacks, jobs, or polling. */
  async resumeContact(facts: ClientFacts, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.contactResumeState !== "idle") throw new Error("Daemon contact resume is running or uncertain.");
    const check = () => {
      if (!this.attached || this.admitting || this.pausing || this.disposing || this.closed || this.hasPendingWork)
        throw new Error("Daemon client is unavailable; reconnect after draining work.");
      if (!this.sameClient(facts) || this.contactState !== "expired")
        throw new Error("No confirmed contact expiry for this daemon client.");
    };
    facts = structuredClone(facts);
    check();
    const resume = new AbortController();
    this.resuming = resume;
    const ownedSignal = signal ? AbortSignal.any([signal, resume.signal]) : resume.signal;
    let sent = false;
    const attempt = this.updates.then(async () => {
      ownedSignal.throwIfAborted();
      check();
      sent = true;
      const reply = await requestDaemon(this.paths, this.identity, "resume-contact", facts, ownedSignal);
      ownedSignal.throwIfAborted();
      const contact = this.consume(reply);
      ownedSignal.throwIfAborted();
      if (contact !== "active") throw new Error("Daemon did not confirm resumed contact.");
      Object.assign(this.facts, facts);
      this.publishContact(contact);
    });
    this.updates = attempt.catch(() => {});
    // Reject a queued repair on cancellation even if the earlier update has not finished.
    const cancellation = Promise.withResolvers<never>();
    const abort = () => cancellation.reject(ownedSignal.reason);
    ownedSignal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([attempt, cancellation.promise]);
    } catch (error) {
      if (sent) {
        // The protocol does not distinguish definite pre-publication refusal from a lost acknowledgement.
        this.resumeUncertain = true;
        for (const { controller, kind } of this.callbacks.values()) if (kind !== "queue-release") controller.abort();
      }
      throw error;
    } finally {
      this.resuming = undefined;
      ownedSignal.removeEventListener("abort", abort);
    }
  }
  private sameClient(facts: ClientFacts) {
    return facts.id === this.facts.id && facts.pid === this.facts.pid && facts.generation === this.facts.generation;
  }
  async run(operation: string, payload: unknown, signal?: AbortSignal, onCommit?: () => void): Promise<unknown> {
    if (
      this.closed ||
      this.uncertain ||
      this.contactResumeState !== "idle" ||
      this.pausing ||
      this.disposing ||
      this.contactState === "expired" ||
      this.contactState === "inactive"
    )
      throw new Error("Daemon client is unavailable; confirm contact and drain work before submitting.");
    signal?.throwIfAborted();
    this.pendingJobs++;
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
          if (job?.id === id && job.phase === "failed") {
            terminal = true;
            throw new DaemonError(job.error ?? { name: "Error", message: "Daemon operation failed." });
          }
          if (job?.id === id && job.phase === "done") {
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
    ).finally(() => this.pendingJobs--);
  }
  private publishContact(contact: ContactState | undefined) {
    this.contactRevision++;
    this.observedContact = contact;
  }
  private consume(reply: unknown): ContactState | undefined {
    if (
      !record(reply) ||
      typeof reply.cursor !== "number" ||
      !Number.isSafeInteger(reply.cursor) ||
      reply.cursor < 0 ||
      !Array.isArray(reply.callbacks) ||
      !Array.isArray(reply.events)
    )
      throw new Error("Invalid daemon poll response.");
    const { contact } = reply;
    if (contact !== undefined && contact !== "active" && contact !== "expired" && contact !== "inactive")
      throw new Error("Invalid daemon contact state.");
    if (reply.cursor < this.cursor) return contact;
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
          if ((this.uncertain || this.resumeUncertain) && callback.kind !== "queue-release")
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
    return contact;
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
        const revision = this.contactRevision;
        const reply = await requestDaemon(
          this.paths,
          this.identity,
          "poll",
          { client: this.facts.id, cursor: this.cursor },
          this.controller.signal,
        );
        // An older poll must not undo typed update expiry or a successful resume.
        if (revision === this.contactRevision) {
          const contact = this.consume(reply);
          this.reportedError = false;
          if (
            revision === this.contactRevision &&
            this.attached &&
            !this.admitting &&
            !this.pausing &&
            !this.disposing &&
            !this.closed
          ) {
            // A new observation fences older facts replies; identical polls do not.
            if (contact !== this.observedContact) this.publishContact(contact);
            if (contact !== undefined) this.options.contact?.(contact);
          }
        }
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
    if (this.closed || this.disposing) throw new Error("Daemon client is closed.");
    if (this.pausing) return this.pausing;
    this.resuming?.abort(new DOMException("Client paused", "AbortError"));
    this.lifecycleRevision++;
    this.contactRevision++;
    this.pausing = (async () => {
      const reply = await requestDaemon(this.paths, this.identity, "pause", { client: this.facts.id });
      const contact = this.consume(reply);
      if (!this.disposing) this.publishContact(contact);
    })().finally(() => {
      this.pausing = undefined;
    });
    return this.pausing;
  }
  async dispose(handoff?: ClientHandoff) {
    if (this.disposing) return this.disposing;
    if (this.closed) return;
    this.resuming?.abort(new DOMException("Client disposed", "AbortError"));
    this.lifecycleRevision++;
    this.contactRevision++;
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
