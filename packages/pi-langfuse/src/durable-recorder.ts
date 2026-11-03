import type { EntryId, EntryRecord, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
import { durableAttributes, durableContent, durableDiagnosticCount, durableUsage } from "./durable-projection.js";
import type { DurableCommit, DurableLive, DurableSnapshot, DurableTask } from "./durable-state.js";
import { sanitizeTraceValue } from "./sanitizer.js";
import type { Observation, ObservationAttributes, ObservationType, TraceBackend } from "./tracing.js";

export interface DurableCorrelation {
  requestId?: string;
  userId?: string;
  applicationId?: string;
}

export interface DurableRecorderOptions extends DurableCorrelation {
  conversationId: number;
  sessionId?: string;
  traceName?: string;
  captureContent?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
  submissionCorrelation?: (record: SubmissionRecord) => DurableCorrelation;
  onTraceId?: (traceId: string) => void | Promise<void>;
  onError?: (stage: string) => void | Promise<void>;
}

const SAFE_UNANSWERED_REASONS = new Set([
  "aborted",
  "model_error",
  "no_model",
  "reset",
  "stale",
  "faulted",
  "missing_task",
  "task_too_old",
  "migration_failed",
  "orphaned",
  "interrupted",
  "restart_limit",
  "nothing_to_answer",
  "turn_limit",
  "run_failed",
]);

interface Span {
  observation?: Observation;
  ended: boolean;
}
interface SubmissionSpan {
  span: Span;
  correlation: DurableCorrelation;
  terminal: boolean;
}
interface RunSpan {
  span: Span;
  primary?: SubmissionId;
  identity: string;
  inputs: readonly SubmissionId[];
  correlation: DurableCorrelation;
  round: number;
  generation?: Span;
  generationKey?: string;
  tools: Map<string, Span>;
  completedTools: Set<string>;
}

/** Durable state machine using the same trace backend, ownership and capture core as the Pi adapter. */
export class DurableRecorder {
  private readonly root: Span;
  private run?: RunSpan;
  private readonly submissions = new Map<SubmissionId, SubmissionSpan>();
  private readonly pendingSubmissions = new Set<SubmissionId>();
  private readonly entries = new Set<number>();
  private readonly completedRuns = new Set<string>();
  private readonly completedGenerations = new Set<string>();
  private live: DurableLive = { tools: [] };
  private baselineEntry = 0;
  private disposed = false;
  private gaps = 0;

  constructor(
    private readonly backend: TraceBackend,
    private readonly options: DurableRecorderOptions,
  ) {
    this.root = this.start(options.traceName ?? "pi.durable.conversation", "agent", undefined, {
      metadata: {
        ...this.customMetadata(),
        "pi.runtime": "durable",
        "pi.durable.schema_version": "1",
        "pi.durable.conversation_id": options.conversationId,
        ...(options.applicationId ? { "pi.application.id": options.applicationId } : {}),
      },
    });
    this.safe(() => {
      this.root.observation?.updateTrace?.(
        durableAttributes({
          name: options.traceName ?? "pi.durable.conversation",
          sessionId: options.sessionId ?? String(options.conversationId),
          ...(options.userId ? { userId: options.userId } : {}),
          metadata: this.customMetadata(),
          version: "durable-1",
        }),
      );
    });
    const traceId = this.root.observation?.traceId;
    if (traceId) this.callback("trace-id callback", () => options.onTraceId?.(traceId));
  }

  get submissionIds(): readonly SubmissionId[] {
    return [...this.pendingSubmissions];
  }

  report(stage: string): void {
    this.callback("error callback", () => this.options.onError?.(stage), false);
  }

  private callback(stage: string, action: () => void | Promise<void>, report = true): void {
    try {
      Promise.resolve(action()).catch(() => {
        if (report) this.report(stage);
      });
    } catch {
      if (report) this.report(stage);
    }
  }

  private customMetadata(): Record<string, unknown> {
    const value = sanitizeTraceValue(this.options.metadata, true);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("pi.")));
  }

  private safe(action: () => void): void {
    try {
      action();
    } catch {
      this.report("exporter observation");
    }
  }

  private start(name: string, type: ObservationType, parent?: Span, attributes: ObservationAttributes = {}): Span {
    if (this.disposed || (parent && (parent.ended || !parent.observation))) return { ended: true };
    const span: Span = { ended: false };
    const inherited = parent === this.run?.span ? this.correlationAttributes(this.run?.correlation ?? {}) : {};
    this.safe(() => {
      span.observation = this.backend.start(
        String(sanitizeTraceValue(name, true)),
        durableAttributes({
          version: "durable-1",
          sessionId: this.options.sessionId ?? String(this.options.conversationId),
          ...(this.options.userId ? { userId: this.options.userId } : {}),
          ...inherited,
          ...attributes,
          metadata: { ...inherited.metadata, ...attributes.metadata },
        }),
        { asType: type, parent: parent?.observation },
      );
    });
    // A missing parent handle must never become a new exporter root for descendants.
    if (!span.observation) span.ended = true;
    if (this.disposed) this.interrupted(span, "Observer disposed during exporter start.");
    return span;
  }

  private update(span: Span, attributes: ObservationAttributes): void {
    if (!span.ended)
      this.safe(() => {
        span.observation?.update(durableAttributes(attributes));
      });
  }

  private end(span: Span | undefined, attributes: ObservationAttributes = {}): void {
    if (!span || span.ended) return;
    span.ended = true;
    const observation = span.observation;
    // Release ended SDK handles/payloads, and claim the end before any callback can reenter disposal.
    span.observation = undefined;
    this.safe(() => {
      observation?.update(durableAttributes(attributes));
    });
    this.safe(() => {
      observation?.end();
    });
  }

  private interrupted(span: Span | undefined, reason: string): void {
    this.end(span, {
      level: "WARNING",
      statusMessage: reason,
      metadata: { "pi.durable.outcome": "observation_interrupted" },
    });
  }

  private correlationAttributes(correlation: DurableCorrelation): ObservationAttributes {
    return {
      metadata: {
        ...(correlation.userId ? { "pi.user.id": correlation.userId } : {}),
        ...(correlation.requestId ? { "pi.request.id": correlation.requestId } : {}),
        ...(correlation.applicationId ? { "pi.application.id": correlation.applicationId } : {}),
      },
    };
  }

  async submission(
    record: SubmissionRecord,
    readEntry: (id: EntryId) => Promise<EntryRecord | undefined>,
    correlation?: DurableCorrelation,
    snapshot = false,
  ): Promise<void> {
    if (this.disposed || record.conversationId !== this.options.conversationId) return;
    let state = this.submissions.get(record.id);
    if (!state) {
      let host: DurableCorrelation = {};
      try {
        host = this.options.submissionCorrelation?.(record) ?? {};
      } catch {
        this.report("submission correlation");
      }
      if (this.disposed) return;
      const ids = sanitizeTraceValue(
        {
          requestId: record.requestId,
          userId: this.options.userId,
          applicationId: this.options.applicationId,
          ...host,
          ...correlation,
        },
        true,
      ) as DurableCorrelation;
      state = {
        span: this.start("pi.durable.submission", "span", this.root, {
          ...this.correlationAttributes(ids),
          metadata: {
            ...this.correlationAttributes(ids).metadata,
            "pi.durable.submission_id": record.id,
            "pi.durable.submission_type": record.type,
            "pi.durable.snapshot_observation": snapshot,
          },
        }),
        correlation: ids,
        terminal: false,
      };
      if (this.disposed) return;
      this.submissions.set(record.id, state);
      this.pendingSubmissions.add(record.id);
    }
    if (state.terminal) return;
    if (correlation) {
      state.correlation = sanitizeTraceValue({ ...state.correlation, ...correlation }, true) as DurableCorrelation;
      this.update(state.span, this.correlationAttributes(state.correlation));
    }
    const run = this.run;
    if (run?.primary === record.id) {
      run.correlation = state.correlation;
      const attributes = this.correlationAttributes(state.correlation);
      this.update(run.span, attributes);
      if (run.generation) this.update(run.generation, attributes);
      for (const tool of run.tools.values()) this.update(tool, attributes);
    }
    this.update(state.span, { metadata: { "pi.durable.submission_status": record.status } });
    if (record.entry !== undefined && record.type === "input") {
      const entry = await readEntry(record.entry);
      if (this.disposed || state.terminal) return;
      this.update(state.span, { input: durableContent(entry?.model, this.options.captureContent ?? true) });
    }
    if (record.status === "done" || record.status === "unanswered") {
      let output: unknown;
      if (record.status === "done" && record.type !== "write") {
        const entry = await readEntry(record.answer);
        if (this.disposed || state.terminal) return;
        // The answer ID is authoritative; no streamed fragments or last intermediate assistant inference.
        output = durableContent(entry?.model, this.options.captureContent ?? true);
      }
      const reason =
        record.status === "unanswered" && SAFE_UNANSWERED_REASONS.has(record.reason) ? record.reason : undefined;
      state.terminal = true;
      this.pendingSubmissions.delete(record.id);
      this.end(state.span, {
        ...(output !== undefined ? { output } : {}),
        level:
          record.status === "done"
            ? "DEFAULT"
            : reason === "model_error" || reason === "no_model" || reason === "faulted"
              ? "ERROR"
              : "WARNING",
        // Only known structural reason codes are safe; arbitrary reason/detail can contain provider secrets.
        metadata: {
          "pi.durable.submission_status": record.status,
          "pi.durable.answer_entry_id": record.answer,
          ...(record.status === "unanswered" ? { "pi.durable.unanswered_reason": reason ?? "unknown" } : {}),
        },
      });
    }
  }

  snapshot(snapshot: DurableSnapshot, initial = false): void {
    if (this.disposed) return;
    for (const entry of snapshot.entries) this.baselineEntry = Math.max(this.baselineEntry, entry.id);
    if (!initial) {
      this.gaps += 1;
      this.update(this.root, {
        metadata: { "pi.durable.resync_count": this.gaps, "pi.durable.history_complete": false },
      });
    } else
      this.update(this.root, {
        metadata: { "pi.durable.history_complete": false, "pi.durable.attachment": "snapshot" },
      });
    if (this.run && !this.sameRun(snapshot.live.run))
      this.closeRun("Run boundary not observed; snapshot replaced the observation.");
    if (this.run) this.closeRound("Snapshot replaced generation/tool observation; activity may have been missed.");
    this.live = snapshot.live;
    if (snapshot.live.run) {
      this.beginRun(snapshot.live.run, true);
      // A snapshot never turns transcript, partial messages or running slots into historical starts.
      if (this.run) this.update(this.run.span, { metadata: { "pi.durable.observation_incomplete": true } });
    }
  }

  private sameRun(run: DurableLive["run"]): boolean {
    if (!run || !this.run) return false;
    // afterRun settles the inputs before its tasks finish; an empty inputs list is not a run boundary.
    return (
      (this.run.primary !== undefined && run.inputs[0] === this.run.primary) ||
      (run.afterRun && this.live.run?.taskId === run.taskId)
    );
  }

  private beginRun(live: NonNullable<DurableLive["run"]>, snapshot = false): void {
    if (this.disposed) return;
    const primary = live.inputs[0];
    if (this.sameRun(live)) {
      if (!this.run) return;
      this.run.inputs = [...live.inputs];
      this.update(this.run.span, { metadata: { "pi.durable.inputs": this.run.inputs } });
      return;
    }
    const identity = primary === undefined ? `task:${live.taskId}` : `submission:${primary}`;
    if (this.completedRuns.has(identity)) return;
    if (this.run) this.closeRun("Unexpected run replacement.");
    const correlation = (primary === undefined ? undefined : this.submissions.get(primary)?.correlation) ?? {};
    this.run = {
      span: this.start("pi.durable.run", "agent", this.root, {
        ...this.correlationAttributes(correlation),
        metadata: {
          ...this.correlationAttributes(correlation).metadata,
          ...(primary === undefined ? {} : { "pi.durable.primary_submission_id": primary }),
          "pi.durable.inputs": [...live.inputs],
          "pi.durable.snapshot_observation": snapshot,
        },
      }),
      primary,
      identity,
      inputs: [...live.inputs],
      correlation,
      round: 0,
      tools: new Map(),
      completedTools: new Set(),
    };
  }

  private closeRound(reason: string): void {
    const run = this.run;
    if (!run) return;
    this.interrupted(run.generation, reason);
    run.generation = undefined;
    for (const tool of run.tools.values()) this.interrupted(tool, reason);
    run.tools.clear();
  }

  private closeRun(reason?: string): void {
    const run = this.run;
    if (!run) return;
    this.closeRound(reason ?? "Run ended without an observed descendant completion.");
    this.end(
      run.span,
      reason
        ? { level: "WARNING", statusMessage: reason, metadata: { "pi.durable.observation_incomplete": true } }
        : {},
    );
    this.completedRuns.add(run.identity);
    this.run = undefined;
  }

  private generation(key?: string): Span | undefined {
    const run = this.run;
    if (this.disposed || !run || (key && this.completedGenerations.has(key))) return undefined;
    if (run.generation && key && run.generationKey !== key) {
      this.interrupted(run.generation, "Generation boundary was not observed.");
      run.generation = undefined;
    }
    if (!run.generation) {
      run.round += 1;
      run.generationKey = key;
      run.generation = this.start("pi.durable.llm", "generation", run.span, {
        metadata: { "pi.durable.observed_generation_index": run.round },
      });
    }
    return run.generation;
  }

  private entry(entry: EntryRecord, retryAttempt?: number): void {
    if (this.disposed || entry.id <= this.baselineEntry || this.entries.has(entry.id)) return;
    this.entries.add(entry.id);
    const message = entry.model?.[0];
    const run = this.run;
    if (!run) return;
    if (message?.role === "assistant") {
      const generation = this.generation();
      if (!generation) return;
      const usage = durableUsage(message);
      this.end(generation, {
        output: durableContent(entry.model, this.options.captureContent ?? true),
        model: message.model,
        ...usage,
        level: message.stopReason === "error" ? "ERROR" : message.stopReason === "aborted" ? "WARNING" : "DEFAULT",
        metadata: {
          ...usage.metadata,
          "pi.durable.entry_id": entry.id,
          "pi.durable.task_id": entry.byTaskId,
          "pi.durable.stop_reason": message.stopReason,
          "pi.durable.provider": message.provider,
          ...(retryAttempt === undefined ? {} : { "pi.durable.retry_attempt": retryAttempt }),
        },
      });
      if (run.generationKey) this.completedGenerations.add(run.generationKey);
      run.generation = undefined;
    } else if (message?.role === "toolResult") {
      const key = entry.byTaskId === undefined ? `entry:${entry.id}` : `task:${entry.byTaskId}`;
      this.finishTool(key, message.toolCallId, entry);
    }
  }

  private finishTool(key: string, callId: string, entry?: EntryRecord): void {
    const run = this.run;
    if (!run || run.completedTools.has(key)) return;
    run.completedTools.add(key);
    const tool =
      run.tools.get(key) ??
      this.start("pi.durable.tool", "tool", run.span, {
        metadata: { "pi.durable.start_not_observed": true, "pi.durable.tool_call_id": callId },
      });
    const message = entry?.model?.[0];
    const usage = message ? durableUsage(message) : {};
    this.end(tool, {
      ...(entry
        ? { output: durableContent(entry.model, this.options.captureContent ?? true, durableDiagnosticCount(entry)) }
        : {}),
      ...usage,
      level: message?.role === "toolResult" && message.isError ? "ERROR" : entry ? "DEFAULT" : "WARNING",
      metadata: {
        ...usage.metadata,
        "pi.durable.result_entry_id": entry?.id,
        "pi.durable.result_missing": !entry,
      },
    });
    run.tools.delete(key);
  }

  private task(task: DurableTask, live: DurableLive): void {
    const run = this.run;
    if (this.disposed || !run) return;
    if (task.failed) this.update(run.span, { level: "ERROR", metadata: { "pi.durable.failed_task_id": task.id } });
    if (task.kind === "pi.generation") {
      if (task.phase === "request" || task.phase === "poll")
        // Overflow compaction can repeat an attempt with a newer context cutoff; repeated polls keep that cutoff.
        this.generation(`${task.id}:${task.attempt ?? 0}:${task.cutoff ?? "unknown"}`);
      else if (task.phase === "retry") {
        this.end(run.generation, {
          level: "ERROR",
          statusMessage: "Provider attempt will retry.",
          metadata: { "pi.durable.retry_attempt": task.attempt },
        });
        if (run.generationKey) this.completedGenerations.add(run.generationKey);
        run.generation = undefined;
      }
      return;
    }
    if (task.kind !== "pi.tool" || task.callId === undefined) return;
    const key = `task:${task.id}`;
    if (run.completedTools.has(key)) return;
    if (task.arguments !== undefined && !run.tools.has(key)) {
      const slot = live.tools.find((slot) => slot.taskId === task.id);
      run.tools.set(
        key,
        this.start("pi.durable.tool", "tool", run.span, {
          input:
            this.options.captureContent === false
              ? "[content capture disabled]"
              : sanitizeTraceValue(task.arguments, true),
          metadata: {
            "pi.durable.tool_call_id": task.callId,
            "pi.durable.tool_name": slot?.name ?? task.name,
            "pi.durable.task_id": task.id,
            "pi.durable.observed_generation_index": run.round,
          },
        }),
      );
    }
    if (task.terminal) this.finishTool(key, task.callId);
  }

  async commit(commit: DurableCommit, readEntry: (id: EntryId) => Promise<EntryRecord | undefined>): Promise<void> {
    if (this.disposed) return;
    // Resolve correlation before creating run children. One failed read cannot discard the rest of a publication.
    for (const record of [...commit.submissions].sort((a, b) => a.id - b.id)) {
      try {
        await this.submission(record, readEntry);
      } catch {
        if (!this.disposed) this.report("observer delivery");
      }
      if (this.disposed) return;
    }
    const next = commit.live ?? this.live;
    if (!this.run && next.run) this.beginRun(next.run);
    // Starts precede completions, but a terminal task cannot hide its result entry in the same publication.
    for (const task of commit.tasks) if (!task.terminal && task.phase !== "retry") this.task(task, next);
    for (const entry of [...commit.entries].sort((a, b) => a.id - b.id)) {
      const retry = commit.tasks.find((task) => task.id === entry.byTaskId && task.phase === "retry");
      this.entry(entry, retry?.attempt);
    }
    for (const task of commit.tasks) if (task.terminal || task.phase === "retry") this.task(task, next);
    if (this.disposed) return;
    if (commit.live) {
      if (this.run && !this.sameRun(next.run)) this.closeRun();
      if (next.run) this.beginRun(next.run);
      this.live = next;
    }
  }

  dispose(reason = "Tracing observer disposed; execution outcome is unknown."): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeRun(reason);
    for (const state of this.submissions.values()) if (!state.terminal) this.interrupted(state.span, reason);
    this.end(this.root, { metadata: { "pi.durable.resync_count": this.gaps } });
    this.submissions.clear();
    this.pendingSubmissions.clear();
    this.entries.clear();
    this.completedRuns.clear();
    this.completedGenerations.clear();
  }
}
