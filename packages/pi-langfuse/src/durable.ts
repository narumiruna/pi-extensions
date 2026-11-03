import type { Context } from "@earendil-works/chord";
import { awaitWithContext, withCancel } from "@earendil-works/chord/context";
import type {
  CommitObservation,
  ConversationId,
  ConversationView,
  Observation as DurableObservation,
  EntryId,
  Harness,
  SubmissionId,
  WatchEnd,
} from "@earendil-works/pi-durable";
import { type DurableCorrelation, DurableRecorder, type DurableRecorderOptions } from "./durable-recorder.js";
import {
  advanceDurableSnapshot,
  type DurableCommit,
  type DurableSnapshot,
  durableCommit,
  durableSnapshot,
} from "./durable-state.js";
import { getLangfuseRuntimeInternal, type LangfuseRuntime } from "./runtime-core.js";

export type { DurableCorrelation } from "./durable-recorder.js";
export {
  type CreateLangfuseRuntimeOptions,
  createLangfuseRuntime,
  type LangfuseRuntime,
  type LangfuseRuntimeConfig,
} from "./runtime-api.js";
export { createLangfuseRuntimeFromBackend } from "./runtime-core.js";
export type { Observation, ObservationAttributes, ObservationType, TraceBackend } from "./tracing.js";

export interface PiLangfuseDurableOptions extends Omit<DurableRecorderOptions, "conversationId" | "requestId"> {
  harness: Harness;
  conversationId: ConversationId;
  /** Governs observation only. Cancellation never aborts execution or resumes recovery. */
  context: Context;
}

export interface PiLangfuseDurableConversation {
  readonly active: boolean;
  /** Resolves after initialization, observer detachment, and owned delivery have joined. */
  readonly closed: Promise<void>;
  /** Read committed status without waiting for or starting agent work. Also supports late submission attachment. */
  observeSubmission(id: SubmissionId, correlation?: DurableCorrelation): Promise<void>;
  /** Detach and close observations, without flushing/shutting down the runtime or modifying durable work. */
  dispose(): Promise<void>;
}

type Delivery =
  | { kind: "commit"; commit: DurableCommit }
  | { kind: "snapshot"; snapshot: DurableSnapshot }
  | { kind: "submission"; id: SubmissionId; correlation?: DurableCorrelation; done: () => void };
const MAX_PENDING_PUBLICATIONS = 100;
const observedConversations = new WeakMap<Harness, Set<ConversationId>>();

/** Attach a fail-open, committed-only observer. The host remains the sole owner of execution. */
export async function createPiLangfuseDurableConversation(
  runtime: LangfuseRuntime,
  options: PiLangfuseDurableOptions,
): Promise<PiLangfuseDurableConversation> {
  options = { ...options };
  const { context, cancel } = withCancel(options.context);
  let view: DurableObservation<ConversationView> | undefined;
  let commits: CommitObservation | undefined;
  let latestView: DurableSnapshot | undefined;
  let committed: DurableSnapshot | undefined;
  let recorder: DurableRecorder | undefined;
  let releaseRuntime: (() => void) | undefined;
  let disposed = false;
  let ready = false;
  let sourceEnded = false;
  let sourceClosing = false;
  let sourceListenerError = false;
  let recordingFailed = false;
  let ownsConversation = false;
  let initialization: Promise<void>;
  let delivery: Promise<void> = Promise.resolve();
  let scheduled = false;
  let disposePromise: Promise<void> | undefined;
  const pending: Delivery[] = [];
  let pendingPublications = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function report(stage: string): void {
    if (recorder) recorder.report(stage);
    else {
      try {
        Promise.resolve(options.onError?.(stage)).catch(() => undefined);
      } catch {
        /* Fail open. */
      }
    }
  }

  async function readEntry(id: EntryId) {
    if (disposed) return undefined;
    const entry = await options.harness.commit((tx) => tx.entry(id), context);
    return disposed ? undefined : entry;
  }

  async function reconcile(id: SubmissionId, correlation?: DurableCorrelation): Promise<void> {
    if (disposed) return;
    try {
      const submission = await options.harness.submission(id, context);
      if (disposed || !submission) return;
      const record = await submission.status(context); // wait() would resume paused recovery.
      if (disposed) return;
      await recorder?.submission(record, readEntry, correlation, true);
    } catch {
      if (!disposed) report("submission status read");
    }
  }

  function clearPending(): void {
    for (const item of pending.splice(0)) if (item.kind === "submission") item.done();
    pendingPublications = 0;
  }

  function schedule(): void {
    if (disposed || scheduled) return;
    scheduled = true;
    // Source callbacks only record. Every exporter, callback and Session call runs after their stack unwinds.
    delivery = Promise.resolve()
      .then(drain)
      .catch(() => {
        if (!disposed) report("observer delivery");
      })
      .finally(() => {
        scheduled = false;
        if (!disposed && recorder && (pending.length || sourceEnded || recordingFailed)) schedule();
      });
  }

  function enqueue(item: Delivery): void {
    if (disposed) {
      if (item.kind === "submission") item.done();
      return;
    }
    if (item.kind !== "submission" && pendingPublications >= MAX_PENDING_PUBLICATIONS) {
      // Overflow drops source history, never explicit host requests. Keep those requests in their original order;
      // callers retain their pending promises as backpressure until reconciliation or cancellation joins them.
      let retained = 0;
      for (const queued of pending) if (queued.kind === "submission") pending[retained++] = queued;
      pending.length = retained;
      pendingPublications = 0;
      if (committed) {
        pending.push({ kind: "snapshot", snapshot: committed });
        pendingPublications += 1;
      }
      // The overflowing commit is already in the replacement baseline. Do not replay its entries.
      if (item.kind === "commit") {
        schedule();
        return;
      }
    }
    pending.push(item);
    if (item.kind !== "submission") pendingPublications += 1;
    schedule();
  }

  async function drain(): Promise<void> {
    if (!recorder || disposed) return;
    if (recordingFailed) {
      recordingFailed = false;
      report("observer recording");
      void dispose();
      return;
    }
    while (!disposed) {
      const item = pending.shift();
      if (!item) break;
      if (item.kind !== "submission") pendingPublications -= 1;
      try {
        if (item.kind === "commit") await recorder.commit(item.commit, readEntry);
        else if (item.kind === "submission") await reconcile(item.id, item.correlation);
        else {
          recorder.snapshot(item.snapshot);
          const ids = new Set([
            ...recorder.submissionIds,
            ...(item.snapshot.live.run?.inputs ?? []),
            ...item.snapshot.inbox,
          ]);
          for (const id of ids) {
            await reconcile(id);
            if (disposed) break;
          }
        }
      } catch {
        if (!disposed) report("observer delivery");
      } finally {
        if (item.kind === "submission") item.done();
      }
    }
    if (!disposed && sourceEnded) {
      // Both synchronous observers end `failed` even on normal close. Only Harness.closed distinguishes a failed
      // Session without parsing error prose. This is an observation-lifetime join, never an execution wait.
      if (sourceListenerError) report("observer closure");
      else if (sourceClosing) {
        try {
          const end = await awaitWithContext(options.harness.closed, context);
          if (disposed) return;
          if (end.kind === "failed") report("observer closure");
        } catch {
          if (!disposed) report("observer closure");
        }
      }
      if (!disposed) void dispose();
    }
  }

  function recordEnd(end: WatchEnd): void {
    sourceEnded = true;
    sourceClosing ||= end.kind === "failed";
    sourceListenerError ||= end.kind === "listener_error";
    schedule();
  }

  function observeSubmission(id: SubmissionId, correlation?: DurableCorrelation): Promise<void> {
    return new Promise((done) => enqueue({ kind: "submission", id, correlation, done }));
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    // Publish the join before cancellation/exporter callbacks can reenter this method.
    disposePromise = Promise.resolve().then(async () => {
      await initialization;
      await delivery;
      if (ownsConversation) {
        observedConversations.get(options.harness)?.delete(options.conversationId);
        ownsConversation = false;
      }
      releaseRuntime?.();
      releaseRuntime = undefined;
      resolveClosed();
    });
    disposed = true;
    ready = false;
    cancel();
    context.abortSignal?.removeEventListener("abort", onAbort);
    clearPending();
    try {
      commits?.detach();
    } catch {
      report("observer stop");
    }
    try {
      view?.detach();
    } catch {
      report("observer stop");
    }
    recorder?.dispose();
    latestView = undefined;
    committed = undefined;
    return disposePromise;
  }
  function onAbort(): void {
    void dispose();
  }

  const controller: PiLangfuseDurableConversation = {
    get active() {
      return !disposed && !runtime.closed && ready;
    },
    closed,
    observeSubmission,
    dispose,
  };

  async function initialize(): Promise<void> {
    try {
      context.abortSignal?.throwIfAborted();
      const conversations = observedConversations.get(options.harness) ?? new Set<ConversationId>();
      if (conversations.has(options.conversationId)) throw new Error("Conversation already observed.");
      conversations.add(options.conversationId);
      observedConversations.set(options.harness, conversations);
      ownsConversation = true;
      const internal = getLangfuseRuntimeInternal(runtime);
      releaseRuntime = internal.registerSession(dispose);
      context.abortSignal?.addEventListener("abort", onAbort, { once: true });
      commits = options.harness.observeCommits({
        advance(publication) {
          if (disposed || !ready || !committed) return;
          try {
            const commit = durableCommit(publication, options.conversationId);
            if (
              !commit.live &&
              !commit.inbox &&
              !commit.entries.length &&
              !commit.tasks.length &&
              !commit.submissions.length
            )
              return;
            committed = advanceDurableSnapshot(committed, commit);
            enqueue({ kind: "commit", commit });
          } catch {
            recordingFailed = true;
            schedule();
          }
        },
        end: recordEnd,
      });
      const attached = await options.harness.observeConversation(
        options.conversationId,
        {
          advance(call) {
            if (disposed || ready || call.kind !== "value") return;
            try {
              latestView = durableSnapshot(call.value);
            } catch {
              recordingFailed = true;
            }
          },
          end: recordEnd,
        },
        context,
      );
      view = attached;
      if (disposed || runtime.closed) {
        attached.detach();
        void dispose();
        return;
      }
      const initial = durableSnapshot(attached.value);
      // The OUTER read-only commit promise joins earlier outcomes/publications; a table read alone does not.
      // No await separates choosing this baseline and enabling stored delivery. Work before it is snapshot history,
      // including callbacks made before observeConversation's attaching promise resolved.
      await options.harness.commit((tx) => tx.conversation(options.conversationId), context);
      if (disposed || runtime.closed) {
        void dispose();
        return;
      }
      if (sourceEnded || recordingFailed) throw new Error("Observation ended while attaching.");
      const baseline = latestView ?? initial;
      committed = baseline;
      ready = true;
      recorder = new DurableRecorder(internal.backend, { ...options, metadata: { ...options.metadata } });
      if (disposed || runtime.closed) {
        recorder.dispose();
        void dispose();
        return;
      }
      recorder.snapshot(baseline, true);
      latestView = undefined;
      const ids = new Set([...(baseline.live.run?.inputs ?? []), ...baseline.inbox]);
      // No asynchronous publication can interleave with this synchronous trace acquisition.
      const baselineReads = [...ids].map((id) => observeSubmission(id));
      schedule();
      await Promise.all(baselineReads);
    } catch {
      if (!disposed) report("observer initialization");
      void dispose();
    }
  }
  initialization = Promise.resolve().then(initialize);
  await initialization;
  if (disposed) await dispose();
  return controller;
}
