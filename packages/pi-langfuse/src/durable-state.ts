import {
  type CommitPublication,
  type ConversationId,
  type ConversationView,
  type EntryRecord,
  InboxDoc,
  type InboxState,
  type JsonObject,
  LiveDoc,
  type LiveState,
  type SubmissionId,
  type SubmissionRecord,
  type TaskId,
  type ToolTaskCheckpoint,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";

export interface DurableLive {
  run?: { taskId: TaskId; inputs: readonly SubmissionId[]; afterRun: boolean };
  tools: readonly { taskId?: TaskId; callId: string; name: string; status: "pending" | "running" | "done" }[];
}
export interface DurableSnapshot {
  entries: readonly EntryRecord[];
  live: DurableLive;
  inbox: readonly SubmissionId[];
}
export interface DurableTask {
  id: TaskId;
  kind: string;
  failed: boolean;
  terminal: boolean;
  phase?: string;
  attempt?: number;
  cutoff?: number;
  callId?: string;
  name?: string;
  arguments?: JsonObject;
}
export interface DurableCommit {
  entries: readonly EntryRecord[];
  submissions: readonly SubmissionRecord[];
  tasks: readonly DurableTask[];
  live?: DurableLive;
  inbox?: readonly SubmissionId[];
}

function liveProjection(live: LiveState = {}): DurableLive {
  return {
    ...(live.run
      ? { run: { taskId: live.run.taskId, inputs: live.run.inputs, afterRun: live.run.afterRun !== undefined } }
      : {}),
    tools: [...(live.tools ?? []), ...(live.nestedTools ?? [])].map(({ taskId, callId, name, status }) => ({
      taskId,
      callId,
      name,
      status,
    })),
  };
}

/** The view is a baseline only: never retain partial messages, running output, provider state or diagnostics. */
export function durableSnapshot(view: ConversationView): DurableSnapshot {
  return {
    entries: view.entries,
    live: liveProjection(view.docs[LiveDoc.definition.kind] as LiveState | undefined),
    inbox: ((view.docs[InboxDoc.definition.kind] as InboxState | undefined)?.items ?? []).map(({ id }) => id),
  };
}

/** Record only the public committed fields tracing needs; never inspect request options or raw failure bodies. */
export function durableCommit(publication: CommitPublication, conversationId: ConversationId): DurableCommit {
  const entries: EntryRecord[] = [];
  const submissions: SubmissionRecord[] = [];
  const tasks: DurableTask[] = [];
  let live: DurableLive | undefined;
  let inbox: readonly SubmissionId[] | undefined;
  for (const change of publication.changes) {
    if (change.type === "document") {
      if (change.conversationId !== conversationId || change.record.key !== undefined) continue;
      if (change.record.kind === LiveDoc.definition.kind)
        live = liveProjection(change.kind === "change" ? (change.value as LiveState) : undefined);
      else if (change.record.kind === InboxDoc.definition.kind)
        inbox = change.kind === "change" ? (change.value as InboxState).items.map(({ id }) => id) : [];
    } else if (
      change.type !== "document.copy" &&
      change.type !== "conversation" &&
      change.value.conversationId === conversationId
    ) {
      if (change.type === "entry") entries.push(change.value);
      else if (change.type === "submission") submissions.push(change.value);
      else if (change.type === "task") {
        const task = change.value;
        const terminal = task.state.status === "terminal" || task.state.status === "completing";
        const failed =
          terminal && (task.state.outcome?.status === "faulted" || task.state.outcome?.status === "orphaned");
        if (task.kind !== "pi.tool" && task.kind !== "pi.generation") {
          if (failed) tasks.push({ id: task.id, kind: "other", terminal, failed });
          continue;
        }
        const checkpoint = task.state.checkpoint;
        const record: DurableTask = {
          id: task.id,
          kind: task.kind,
          terminal,
          failed,
          ...(checkpoint && typeof checkpoint === "object" && "phase" in checkpoint
            ? { phase: String(checkpoint.phase) }
            : {}),
        };
        if (task.kind === "pi.tool") {
          const input = task.input as ToolTaskInput;
          record.callId = input.kind === "nested" ? input.call.id : input.callId;
          if (input.kind === "nested") record.name = input.call.name;
          const intent = checkpoint as ToolTaskCheckpoint | undefined;
          if (intent?.phase === "execute") record.arguments = intent.arguments;
        } else if (checkpoint && typeof checkpoint === "object" && "attempt" in checkpoint) {
          const attempt = checkpoint.attempt;
          if (typeof attempt === "number" && Number.isFinite(attempt)) record.attempt = attempt;
          if ("cutoff" in checkpoint && typeof checkpoint.cutoff === "number") record.cutoff = checkpoint.cutoff;
        }
        tasks.push(record);
      }
    }
  }
  return { entries, submissions, tasks, ...(live ? { live } : {}), ...(inbox ? { inbox } : {}) };
}

export function advanceDurableSnapshot(snapshot: DurableSnapshot, commit: DurableCommit): DurableSnapshot {
  return {
    // This is only the bounded overflow baseline, not a second transcript or a historical replay buffer.
    entries: [...snapshot.entries, ...commit.entries].slice(-100),
    live: commit.live ?? snapshot.live,
    inbox: commit.inbox ?? snapshot.inbox,
  };
}
