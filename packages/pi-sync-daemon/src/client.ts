import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonError, requestDaemon } from "./client-transport.js";
import { ForegroundStopRefusedError, stopDaemonAfterForegroundQueueFailure } from "./daemon-recovery.js";
import { isForegroundDirection, isForegroundQueueOutcome } from "./foreground-queue-outcome.js";
import { canonicalRootGuard, type RuntimePaths, readProcessBirth } from "./identity.js";
import { withCleanup } from "./lifecycle.js";
import { type MergeReviewPresenter, presentPagedReview, reviewScope } from "./paged-review.js";
import {
  type Callback,
  type ClientEvent,
  type ClientFacts,
  type ClientHandoff,
  type ClientContact as ContactState,
  type Identity,
  type JobView,
  MAX_REVIEW_BYTES,
  operationPrefix,
  REVIEW_PAGE_CHARS,
  record,
  UNKNOWN_JOB_RESULT,
} from "./protocol.js";
import { STATE_WAIT_FAILURE_LIMIT, stateWaitJobs, stateWaitResult } from "./state-wait-jobs.js";

export { DaemonError, hello, requestDaemon } from "./client-transport.js";
export {
  acquireStartupLock,
  checkUpgradeConsent,
  ensureDaemon,
  findDaemon,
  finishUpgrade,
  stopDaemon,
  waitForDaemonExit,
} from "./daemon-startup.js";

export interface QueueReleaseDelivery {
  id: string;
  job: string;
  state: "retrying" | "finished" | "unconfirmed";
  foreground: boolean;
}

interface PendingCallback {
  controller: AbortController;
  kind: string;
  job: string;
  releaseCursor?: number;
}

const MAX_COMPLETED_CALLBACKS = 4096;
const RELEASE_ATTEMPT_MS = 2_000;
const RELEASE_BUDGET_MS = 25_000;
const RELEASE_MAX_ATTEMPTS = 20;
const FOREGROUND_RPC_MS = 3_000;
const FOREGROUND_DRAIN_MS = 30_000;
const FOREGROUND_RECOVERY_MS = 45_000;
const FOREGROUND_UNKNOWN_RESULT =
  "The daemon's transfer result could not be verified. Changes may have been made; recovery evidence was retained.";
const TRANSIENT_RELEASE_ERRORS = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT", "ETIMEDOUT", "EAGAIN"]);

export interface ConnectionOptions {
  callback(callback: Callback, signal: AbortSignal): Promise<unknown>;
  mergeReview?: MergeReviewPresenter;
  event?(event: ClientEvent): void;
  error?(error: unknown): void;
  /** Each current background observation after admission, including repeated states. */
  contact?(state: ContactState): void;
  /** Observes local delivery only. Finished does not establish a job's outcome. */
  queueRelease?(event: QueueReleaseDelivery): void;
}
export class DaemonConnection {
  private cursor = 0;
  private controller = new AbortController();
  private callbacks = new Map<string, PendingCallback>();
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
  private pendingJobs = new Set<string>();
  private foregroundRecovery?: {
    job: string;
    generation: string;
    assertRoot(): void;
    birth?: string;
    attempted?: true;
    retryOnRefusal: boolean;
  };
  private observesState = false;
  private stateRevision?: string;
  private terminalJobs = new Set<string>();
  private jobWaiters = new Map<string, PromiseWithResolvers<"terminal" | "poll">>();
  private uncertain = false;
  private reportedError = false;
  private commits = new Map<string, { notify(): void; signal?: AbortSignal }>();
  private completedCallbacks = new Set<string>();
  // Keep drain answers deduplicated even after the lifetime callback ledger fills.
  // The daemon limits each peer to 64 pending callbacks. A newer snapshot retires
  // releases it no longer lists, and older snapshots cannot add them back.
  private completedReleases = new Set<string>();
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
    return this.pendingJobs.size > 0 || this.uncertain || this.foregroundRecovery !== undefined;
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
      this.options.mergeReview ? { reviewDetails: 1 } : undefined,
    );
    // Poll during attach: stopping a previous controller may need release answers
    // from this reattached participant before the attach response can complete.
    this.polling ??= this.poll();
    let admitted = false;
    try {
      const result = await request;
      admitted = true;
      this.publishContact(this.consume(result));
      this.observesState = record(result) && result.stateWait === 1;
      this.stateRevision = undefined;
      this.terminalJobs.clear();
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
  async run(
    operation: string,
    payload: unknown,
    signal?: AbortSignal,
    onCommit?: () => void,
    onSubmit?: (id: string) => void,
  ): Promise<unknown> {
    if (
      this.closed ||
      this.uncertain ||
      this.foregroundRecovery ||
      this.contactResumeState !== "idle" ||
      this.pausing ||
      this.disposing ||
      this.contactState === "expired" ||
      this.contactState === "inactive"
    )
      throw new Error("Daemon client is unavailable; confirm contact and drain work before submitting.");
    signal?.throwIfAborted();
    const { paths, identity } = this;
    const id = `${operationPrefix(identity)}${randomUUID()}`;
    const jobParams = { id, client: this.facts.id };
    const transport = this.controller.signal;
    const foreground = isForegroundDirection(operation);
    const assertRoot = foreground ? canonicalRootGuard(paths.root) : undefined;
    const generation = this.facts.generation;
    let birth: string | undefined;
    const rpc = async (method: "submit" | "poll" | "cancel", params: unknown) => {
      if (!foreground) return requestDaemon(paths, identity, method, params, transport);
      const timeout = method === "cancel" ? FOREGROUND_DRAIN_MS : FOREGROUND_RPC_MS;
      const attempt = () =>
        requestDaemon(paths, identity, method, params, AbortSignal.any([transport, AbortSignal.timeout(timeout)]));
      try {
        return await attempt();
      } catch (error) {
        if (
          transport.aborted ||
          error instanceof DaemonError ||
          method === "cancel" ||
          (method === "submit" && signal?.aborted)
        )
          throw error;
        return attempt().catch((retryError: unknown) => {
          if (method === "submit") throw new AggregateError([error, retryError], FOREGROUND_UNKNOWN_RESULT);
          throw retryError;
        });
      }
    };
    this.pendingJobs.add(id);
    const abort = () => {
      void requestDaemon(paths, identity, "cancel", jobParams, transport).catch(() => {});
    };
    let terminal = false;
    const finish = (job: JobView): unknown => {
      terminal = true;
      if (job.phase === "failed")
        throw new DaemonError(job.error ?? { name: "Error", message: "Daemon operation failed." });
      if (!foreground) signal?.throwIfAborted();
      if (assertRoot && isForegroundQueueOutcome(job.result))
        this.foregroundRecovery = {
          job: id,
          generation,
          birth,
          assertRoot,
          retryOnRefusal: job.result.foregroundQueueCleanup === "resume-adoption",
        };
      return job.result;
    };
    if (onCommit) this.commits.set(id, { notify: onCommit, signal });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return withCleanup(
      async () => {
        try {
          onSubmit?.(id);
        } catch {}
        if (foreground) {
          birth = await readProcessBirth(identity.pid);
          signal?.throwIfAborted();
          transport.throwIfAborted();
          assertRoot?.();
        }
        let lostSubmit = false;
        try {
          await rpc("submit", { ...jobParams, operation, payload });
        } catch (error) {
          if (!foreground || error instanceof DaemonError || transport.aborted) throw error;
          lostSubmit = true;
        }
        let terminalObserved = this.observesState && !lostSubmit;
        if (terminalObserved && !this.terminalJobs.has(id)) {
          const completion = Promise.withResolvers<"terminal" | "poll">();
          this.jobWaiters.set(id, completion);
          const keepAlive = setInterval(() => {}, 30_000);
          try {
            terminalObserved = (await completion.promise) === "terminal";
          } finally {
            this.jobWaiters.delete(id);
            clearInterval(keepAlive);
          }
        }
        while (!this.closed) {
          let reply: unknown;
          try {
            reply = await rpc("poll", { client: jobParams.client, cursor: this.cursor, job: id });
          } catch (error) {
            if (foreground && !transport.aborted) {
              const drained = await rpc("cancel", jobParams).catch(() => undefined);
              const job = drained as JobView | undefined;
              if (job?.id === id && (job.phase === "done" || job.phase === "failed")) return finish(job);
              this.markWorkUncertain();
              throw new Error(FOREGROUND_UNKNOWN_RESULT, { cause: error });
            }
            if (error instanceof DaemonError && error.message === UNKNOWN_JOB_RESULT) this.markWorkUncertain();
            throw error;
          }
          const job = record(reply) ? (reply.job as JobView | undefined) : undefined;
          const missing = terminalObserved && (job?.id !== id || (job.phase !== "done" && job.phase !== "failed"));
          if (missing) this.markWorkUncertain();
          this.consume(reply);
          if (missing) throw new Error(foreground ? FOREGROUND_UNKNOWN_RESULT : UNKNOWN_JOB_RESULT);
          if (job?.id === id && (job.phase === "done" || job.phase === "failed")) return finish(job);
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
            if (foreground) {
              if (!this.uncertain) await rpc("cancel", jobParams);
            } else await requestDaemon(paths, identity, "cancel", jobParams);
          } catch (error) {
            this.markWorkUncertain();
            throw new Error(
              foreground
                ? FOREGROUND_UNKNOWN_RESULT
                : "Operation outcome is uncertain; reload to reconnect and reconcile, never replay the write.",
              { cause: error },
            );
          }
        }
      },
    ).finally(() => {
      this.pendingJobs.delete(id);
    });
  }
  canRecoverForeground(job: string): boolean {
    const target = this.foregroundRecovery;
    return (
      !!target &&
      target.job === job &&
      target.generation === this.facts.generation &&
      !target.attempted &&
      this.attached &&
      !this.closed &&
      !this.admitting &&
      !this.disposing &&
      !this.pausing &&
      this.pendingJobs.size === 0 &&
      !this.uncertain &&
      this.contactResumeState === "idle"
    );
  }
  async recoverForeground(job: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const target = this.foregroundRecovery;
    if (!target || !this.canRecoverForeground(job))
      throw new Error("The current Pi session could not verify a completed transfer for daemon recovery.");
    target.assertRoot();
    target.attempted = true;
    const owned = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(FOREGROUND_RECOVERY_MS)]);
    try {
      await stopDaemonAfterForegroundQueueFailure(
        this.paths,
        this.identity,
        { ...target, client: this.facts.id },
        owned,
      );
    } catch (error) {
      if (target.retryOnRefusal && error instanceof ForegroundStopRefusedError) delete target.attempted;
      throw error;
    }
    await this.closeLocal();
    target.assertRoot();
  }
  private markWorkUncertain() {
    this.uncertain = true;
    for (const callback of this.callbacks.values()) if (callback.kind !== "queue-release") callback.controller.abort();
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
    const latest = reply.cursor >= this.cursor;
    const present = new Set((reply.callbacks as Callback[]).map((callback) => callback.id));
    if (reply.cursor > this.cursor) {
      for (const id of this.completedReleases) if (!present.has(id)) this.completedReleases.delete(id);
      this.cursor = reply.cursor;
    }
    for (const [id, pending] of this.callbacks) {
      if (pending.releaseCursor !== undefined) {
        // A job poll and the background poll can arrive out of order.
        if (!latest || reply.cursor <= pending.releaseCursor) continue;
        if (present.has(id)) {
          pending.releaseCursor = reply.cursor;
          continue;
        }
      } else if (present.has(id)) continue;
      pending.controller.abort(new DOMException("Callback is no longer current", "AbortError"));
    }
    for (const callback of reply.callbacks as Callback[]) {
      if (this.callbacks.has(callback.id) || this.completedCallbacks.has(callback.id)) continue;
      const release = callback.kind === "queue-release";
      if (release && (!latest || this.completedReleases.has(callback.id))) continue;
      if (this.completedCallbacks.size + this.callbacks.size >= MAX_COMPLETED_CALLBACKS) this.uncertain = true;
      const controller = new AbortController();
      const foreground = this.pendingJobs.has(callback.job);
      const reviewGeneration = callback.review?.offer !== undefined ? this.facts.generation : undefined;
      this.callbacks.set(callback.id, {
        controller,
        kind: callback.kind,
        job: callback.job,
        ...(release && { releaseCursor: reply.cursor }),
      });
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
        if (release) {
          if (!failed && value === true) {
            await this.deliverRelease(callback, foreground, controller.signal);
            return;
          }
          failed = true;
        }
        try {
          await requestDaemon(
            this.paths,
            this.identity,
            "answer",
            {
              client: this.facts.id,
              id: callback.id,
              ...(reviewGeneration !== undefined ? { generation: reviewGeneration } : {}),
              ...(failed || (reviewGeneration !== undefined && controller.signal.aborted)
                ? { error: "Client callback cancelled or failed." }
                : { value }),
            },
            this.callbackIO.signal,
          );
        } finally {
          if (release) this.reportRelease(callback, foreground, "unconfirmed");
        }
      })()
        .catch((error) => {
          if (!this.closed && !controller.signal.aborted) this.reportError(error);
        })
        .finally(() => {
          if (this.completedCallbacks.size < MAX_COMPLETED_CALLBACKS) this.completedCallbacks.add(callback.id);
          else if (release && !controller.signal.aborted) this.completedReleases.add(callback.id);
          this.callbacks.delete(callback.id);
          this.callbackTasks.delete(task);
        });
      this.callbackTasks.add(task);
    }
    return contact;
  }
  private reportRelease(callback: Callback, foreground: boolean, state: QueueReleaseDelivery["state"]) {
    if (this.callbackIO.signal.aborted) return;
    try {
      this.options.queueRelease?.({ id: callback.id, job: callback.job, foreground, state });
    } catch {
      // Presentation must not own a queue or a callback task.
    }
  }
  private async deliverRelease(callback: Callback, foreground: boolean, pending: AbortSignal) {
    const signal = AbortSignal.any([pending, this.callbackIO.signal]);
    const deadline = performance.now() + RELEASE_BUDGET_MS;
    let retrying = false;
    let state: QueueReleaseDelivery["state"] = "unconfirmed";
    try {
      for (let attempt = 0; attempt < RELEASE_MAX_ATTEMPTS; attempt++) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0 || signal.aborted) break;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(remaining, RELEASE_ATTEMPT_MS));
        timer.unref?.();
        try {
          await requestDaemon(
            this.paths,
            this.identity,
            "answer",
            { client: this.facts.id, id: callback.id, value: true },
            AbortSignal.any([signal, controller.signal]),
          );
          state = "finished";
          return;
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof DaemonError) {
            // The v1 server uses this reply for absent as well as foreign callbacks.
            // Do not infer whether the original release succeeded.
            if (error.message === "Stale or foreign callback response.") state = "finished";
            return;
          }
          if (
            !controller.signal.aborted &&
            (!(error instanceof Error) || !TRANSIENT_RELEASE_ERRORS.has((error as NodeJS.ErrnoException).code ?? ""))
          )
            return;
        } finally {
          clearTimeout(timer);
        }
        if (!retrying) {
          retrying = true;
          this.reportRelease(callback, foreground, "retrying");
        }
        const wait = Math.min(100 * 2 ** attempt, 2_000, deadline - performance.now());
        if (wait <= 0 || attempt + 1 >= RELEASE_MAX_ATTEMPTS) break;
        await delay(wait, undefined, { signal, ref: false }).catch(() => {});
      }
    } finally {
      if (pending.aborted && !this.callbackIO.signal.aborted) state = "finished";
      if (retrying || state === "unconfirmed") this.reportRelease(callback, foreground, state);
    }
  }
  private async performCallback(callback: Callback, signal: AbortSignal) {
    const reference = callback.review;
    if (!reference) return this.options.callback(callback, signal);
    if (reference.offer !== undefined) {
      if (!this.options.mergeReview) throw new Error("Exact review offer requires an opted-in presenter.");
      return presentPagedReview(
        reviewScope(this.identity, this.facts, callback),
        callback,
        AbortSignal.any([signal, this.callbackIO.signal]),
        this.options.mergeReview,
        (params, owned) => requestDaemon(this.paths, this.identity, "review-page", params, owned),
      );
    }
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
  private async observeState() {
    const jobs = stateWaitJobs(this.jobWaiters);
    const reply = await requestDaemon(
      this.paths,
      this.identity,
      "state-wait",
      {
        client: this.facts.id,
        generation: this.facts.generation,
        cursor: this.cursor,
        revision: this.stateRevision,
        jobs,
      },
      this.controller.signal,
      { onSocket: (socket) => socket.unref() },
    );
    return stateWaitResult(reply);
  }
  private async poll() {
    await withCleanup(
      () => this.pollUntilClosed(),
      async () => {
        for (const waiter of this.jobWaiters.values())
          waiter.reject(this.controller.signal.reason ?? new Error("Daemon client closed."));
      },
    );
  }
  private async pollUntilClosed() {
    let failures = 0;
    while (!this.closed) {
      try {
        const revision = this.contactRevision;
        const state = this.observesState && !this.admitting ? await this.observeState() : undefined;
        const reply =
          state?.reply ??
          (await requestDaemon(
            this.paths,
            this.identity,
            "poll",
            { client: this.facts.id, cursor: this.cursor },
            this.controller.signal,
          ));
        // An older poll must not undo typed update expiry or a successful resume.
        if (revision === this.contactRevision) {
          if (state?.missing.some((id) => this.jobWaiters.has(id))) this.markWorkUncertain();
          const contact = this.consume(reply);
          if (state) {
            this.stateRevision = state.version;
            this.terminalJobs = new Set(state.finished);
            for (const id of state.missing) this.jobWaiters.get(id)?.reject(new Error(UNKNOWN_JOB_RESULT));
            for (const id of state.finished) this.jobWaiters.get(id)?.resolve("terminal");
          }
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
        failures = 0;
        if (!state) await this.wait(100);
      } catch (error) {
        if (this.closed) return;
        if (++failures >= STATE_WAIT_FAILURE_LIMIT)
          for (const waiter of this.jobWaiters.values()) waiter.resolve("poll");
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
        await this.closeLocal();
      }
    })();
    return this.disposing;
  }
  private async closeLocal() {
    this.closed = true;
    this.controller.abort(new DOMException("Client disposed", "AbortError"));
    this.callbackIO.abort(new DOMException("Client callback transport disposed", "AbortError"));
    for (const { controller } of this.callbacks.values()) controller.abort();
    await Promise.allSettled([this.polling, this.updates, ...this.callbackTasks]);
  }
}
