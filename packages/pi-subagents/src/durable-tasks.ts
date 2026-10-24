import { awaitWithContext, type Context, withCancel } from "@earendil-works/chord/context";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import {
  type ConversationId,
  type DocumentObserver,
  defineTask,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { type DurableRequest, type DurableState, DurableStateDoc, type WorkOutcome } from "./durable-state.js";

export async function observeState<T>(
  owner: DocumentObserver,
  select: (state: Readonly<DurableState>) => T | undefined,
  context: Context,
): Promise<T> {
  const watch = await owner.watchDoc(DurableStateDoc, context);
  if (!watch) throw new Error("Subagent state is unavailable.");
  try {
    const initial = watch.value && select(watch.value);
    if (initial !== null && initial !== undefined) return initial;
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    watch.start(async (state) => {
      try {
        const value = state && select(state);
        if (value !== null && value !== undefined) resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    const closed = watch.closed.then(() => {
      throw new Error("Durable state observer closed before a result was available.");
    });
    return await awaitWithContext(Promise.race([result, closed]), context);
  } finally {
    await watch.stop();
  }
}

export type DurableCheckpoint = (name: string, context: Context) => Promise<void>;
const project = (text: string) => truncateHead(text, { maxBytes: 40 * 1024, maxLines: 1500 }).content;

function finish(
  state: DurableState,
  request: DurableRequest,
  outcome: WorkOutcome,
  result: string,
  error: string | null,
  answer: number | null,
): void {
  if (request.outcome !== null) return;
  request.outcome = outcome;
  request.result = project(result);
  request.error = error === null ? null : project(error);
  request.answerId = answer;
  const reportId =
    outcome === "completed" && answer !== null ? `answer:${request.conversationId}:${answer}` : `request:${request.id}`;
  request.reportId = reportId;
  state.reports[reportId] ??= {
    id: reportId,
    conversationId: String(request.conversationId),
    requestId: request.id,
    outcome,
    result: request.result,
    error: request.error,
    acknowledged: false,
    suppressed: outcome === "cancelled" || outcome === "timed_out",
  };
}

export function createDurableTasks(changed: () => void, checkpoint: DurableCheckpoint = async () => {}) {
  const anchor = defineTask<null, { phase: "done" }, null>({
    name: "pi-subagents.anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const stop = defineTask<{ conversationId: number; targets: string[] }, { phase: "stop" }, null>({
    name: "pi-subagents.stop",
    version: 1,
    initial: () => ({ phase: "stop" }),
    phases: {
      stop: async (task, runtime, context) => {
        await checkpoint("before-stop", context);
        const child = await runtime.conversation(task.input.conversationId as ConversationId, context);
        if (!child) throw new Error("Subagent conversation is unavailable.");
        await child.abort(context);
        // Dispatch can have begun before stop intent. Join captured reporters before
        // the final abort so none can submit after the child was observed idle.
        for (const id of task.input.targets) {
          const request = (await runtime.snapshot(DurableStateDoc, context))?.requests[id];
          if (request) await runtime.waitForTask(request.taskId as TaskId, context);
        }
        await child.abort(context);
        await runtime.commit(async (tx) => {
          const state = await tx.doc(DurableStateDoc);
          const agent = state.agents[String(task.input.conversationId)];
          if (agent?.stopTaskId === task.id) {
            agent.stopTaskId = null;
            agent.stopTargets = [];
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        changed();
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(DurableStateDoc);
        const agent = state.agents[String(task.input.conversationId)];
        if (agent?.stopTaskId === task.id) {
          agent.stopTaskId = null;
          agent.stopTargets = [];
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
  async function requestStop(tx: Tx, conversationId: number, timedOut?: string): Promise<number> {
    const state = await tx.doc(DurableStateDoc);
    const agent = state.agents[String(conversationId)];
    if (!agent) throw new Error("Unknown subagent conversation.");
    if (agent.stopTaskId !== null) return agent.stopTaskId;
    const targets = agent.requests.filter((id) => state.requests[id]?.outcome === null);
    for (const id of targets) {
      const request = state.requests[id];
      if (request) request.cancelOutcome = id === timedOut ? "timed_out" : "cancelled";
    }
    for (const report of Object.values(state.reports)) {
      if (report.conversationId === String(conversationId) && !report.acknowledged) report.suppressed = true;
    }
    const id = await tx.createTask(
      stop,
      { conversationId, targets },
      { ownership: { kind: "conversation" }, background: true },
    );
    agent.stopTaskId = id;
    agent.stopTargets = targets;
    return id;
  }
  const reporter = defineTask<
    { requestId: string },
    { phase: "prepare" } | { phase: "submit" } | { phase: "collect" },
    null
  >({
    name: "pi-subagents.reporter",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const request = (await tx.doc(DurableStateDoc)).requests[task.input.requestId];
          if (!request) throw new Error("Subagent request is unavailable.");
          request.startedAt ??= runtime.now();
          if (request.timeoutMs !== null) request.deadline ??= request.startedAt + request.timeoutMs;
          return { status: "running", checkpoint: { phase: "submit" } };
        }, context);
      },
      submit: async (task, runtime, context) => {
        const request = (await runtime.snapshot(DurableStateDoc, context))?.requests[task.input.requestId];
        if (!request) throw new Error("Subagent request is unavailable.");
        if (request.cancelOutcome !== null || (request.deadline !== null && request.deadline <= runtime.now())) {
          await runtime.commit(async (tx) => {
            const state = await tx.doc(DurableStateDoc);
            const current = state.requests[request.id];
            if (!current) throw new Error("Subagent request is unavailable.");
            if (!current.cancelOutcome) await requestStop(tx, current.conversationId, current.id);
            finish(
              state,
              current,
              current.cancelOutcome ?? "timed_out",
              "",
              "Subagent work stopped before dispatch.",
              null,
            );
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          changed();
          return;
        }
        const child = await runtime.conversation(request.conversationId as ConversationId, context);
        if (!child) throw new Error("Subagent conversation is unavailable.");
        const submission = await child.submit(
          { type: "input", content: request.task, requestId: request.id, whenBusy: request.whenBusy },
          context,
        );
        await checkpoint("submitted", context);
        await runtime.commit(async (tx) => {
          const current = (await tx.doc(DurableStateDoc)).requests[request.id];
          if (!current) throw new Error("Subagent request is unavailable.");
          current.submissionId = submission.id;
          return { status: "running", checkpoint: { phase: "collect" } };
        }, context);
      },
      collect: async (task, runtime, context) => {
        const request = (await runtime.snapshot(DurableStateDoc, context))?.requests[task.input.requestId];
        if (!request) throw new Error("Subagent request is unavailable.");
        if (request.cancelOutcome !== null) {
          await runtime.commit(async (tx) => {
            const state = await tx.doc(DurableStateDoc);
            const current = state.requests[request.id];
            if (!current) throw new Error("Subagent request is unavailable.");
            finish(state, current, current.cancelOutcome ?? "cancelled", "", "Subagent work stopped.", null);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          changed();
          return;
        }
        const child = await runtime.conversation(request.conversationId as ConversationId, context);
        if (!child) throw new Error("Subagent conversation is unavailable.");
        const submission = await child.submit(
          { type: "input", content: request.task, requestId: request.id, whenBusy: request.whenBusy },
          context,
        );
        const waiting = withCancel(context);
        const settlement = submission.wait(waiting.context).then((settled) => ({ kind: "answer" as const, settled }));
        const cancelled = observeState(
          runtime,
          (state) => state.requests[request.id]?.cancelOutcome ?? undefined,
          waiting.context,
        ).then(() => ({ kind: "stop" as const }));
        const expired =
          request.deadline === null
            ? new Promise<{ kind: "timeout" }>(() => {})
            : runtime.sleep(request.deadline, waiting.context).then(() => ({ kind: "timeout" as const }));
        let result: Awaited<typeof settlement> | { kind: "stop" | "timeout" };
        try {
          result = await Promise.race([settlement, cancelled, expired]);
        } finally {
          waiting.cancel();
          await Promise.allSettled([settlement, cancelled, ...(request.deadline === null ? [] : [expired])]);
        }
        if (result.kind !== "answer") {
          const timedOut = result.kind === "timeout";
          await runtime.commit(async (tx) => {
            const state = await tx.doc(DurableStateDoc);
            const current = state.requests[request.id];
            if (!current) throw new Error("Subagent request is unavailable.");
            if (timedOut) await requestStop(tx, current.conversationId, current.id);
            finish(
              state,
              current,
              current.cancelOutcome ?? (timedOut ? "timed_out" : "cancelled"),
              "",
              "Subagent work stopped.",
              null,
            );
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          changed();
          return;
        }
        const settled = result.settled;
        const transcript = await runtime.context(request.conversationId as ConversationId, context);
        const entry =
          settled.status === "done" && settled.type === "input"
            ? transcript.entries.find((entry) => entry.id === settled.answer)
            : undefined;
        const message = entry?.model?.[0];
        const output =
          message?.role === "assistant"
            ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
            : "";
        await checkpoint("settled", context);
        await runtime.commit(async (tx) => {
          const state = await tx.doc(DurableStateDoc);
          const current = state.requests[request.id];
          if (!current) throw new Error("Subagent request is unavailable.");
          const outcome = current.cancelOutcome ?? (settled.status === "done" ? "completed" : "failed");
          finish(
            state,
            current,
            outcome,
            output,
            settled.status === "unanswered" ? `Subagent input unanswered: ${settled.reason}` : null,
            entry?.id ?? null,
          );
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        changed();
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(DurableStateDoc);
        const request = state.requests[task.input.requestId];
        if (request)
          finish(state, request, request.cancelOutcome ?? "cancelled", "", "Subagent request cancelled.", null);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
      changed();
    },
  });
  return { anchor, reporter, stop, requestStop };
}
