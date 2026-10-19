import type { Context } from "@earendil-works/chord";
import { awaitWithContext, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import {
  type AnyTask,
  type Conversation,
  ConversationBusy,
  type ConversationId,
  defineTask,
  type Harness,
  InboxDoc,
  LiveDoc,
  SessionFailed,
  type SubmissionId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { matchesPlanInput, matchesQueuedPlanInput } from "./durable-input.js";
import { applyHostMutation, fingerprint, validateState, viewOf, WorkflowDoc } from "./durable-state.js";
import type {
  DurablePlanAnswers,
  DurablePlanController,
  DurablePlanDelivery,
  DurablePlanMutation,
  DurablePlanOperation,
  DurablePlanOptions,
  DurablePlanRevision,
  DurablePlanStart,
  DurablePlanState,
  DurablePlanWithdrawal,
} from "./durable-types.js";

type DeliveryInput = { workflowId: string; revision: number; operationId: string };
type DeliveryResult = { status: "delivered" | "stale" | "failed" };
const TASK_NAME = "plan-mode.delivery";

/** Native delivery is independent of inspection and starts only at an explicit progress boundary. */
export function createControllerRuntime(options: DurablePlanOptions): {
  task: AnyTask;
  bind(harness: Harness): DurablePlanController;
  getHarness(): Harness | undefined;
} {
  let harness: Harness | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const mutations = new Set<Promise<unknown>>();
  const lockTails = new Map<ConversationId, Promise<void>>();
  const shutdown = new AbortController();

  async function serialized<T>(id: ConversationId, context: Context, operation: () => Promise<T>): Promise<T> {
    active(context);
    const previous = lockTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A cancelled waiter releases its turn, but cannot let successors pass its predecessor.
    const tail = previous.then(() => turn);
    lockTails.set(id, tail);
    void tail.then(() => {
      if (lockTails.get(id) === tail) lockTails.delete(id);
    });
    try {
      await awaitWithContext(previous, withAbortSignal(shutdown.signal, context));
      active(context);
      return await operation();
    } finally {
      release();
    }
  }

  async function deliverySubmission(
    tx: Tx,
    id: ConversationId,
    delivery: Pick<DurablePlanDelivery, "requestId" | "content" | "revision" | "operationId">,
    workflowId: string,
    context: Context,
  ) {
    if (!delivery.requestId || delivery.content === undefined) throw new Error("Invalid Plan Mode delivery intent");
    const record = await tx.submissionByRequest(id, delivery.requestId);
    context.abortSignal?.throwIfAborted();
    const marker = { workflowId, revision: delivery.revision, operationId: delivery.operationId };
    if (record?.type !== "input" || record.status === "unanswered") return { record, exact: false };
    if (record.status === "queued") {
      const inbox = await tx.doc(InboxDoc, id);
      context.abortSignal?.throwIfAborted();
      const item = inbox.items.find((input) => input.id === record.id);
      return { record, exact: matchesQueuedPlanInput(item, marker, delivery.content) };
    }
    const entry = await tx.entry(record.entry);
    context.abortSignal?.throwIfAborted();
    return { record, exact: matchesPlanInput(entry, id, marker, delivery.content) };
  }

  async function completeWithdrawal(id: ConversationId, intent: DurablePlanWithdrawal, context: Context) {
    // This intent was verified and persisted with discard. Finish it after cancellation or restart.
    const bound = harness;
    if (!bound) throw new Error("Bind the Plan Mode controller before withdrawal");
    const cleanup = withoutAbortSignal(context);
    const result = await bound.abortSubmission(intent.submissionId, cleanup, id);
    await bound.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, id);
      validateState(state);
      const delivery = state.delivery;
      if (
        state.owner !== id ||
        state.workflowId !== intent.workflowId ||
        delivery?.kind !== "discard" ||
        !delivery.withdrawal ||
        fingerprint(delivery.withdrawal) !== fingerprint(intent)
      )
        return;
      const superseded = state.receipts.find(
        (item) => item.operationId === intent.operationId && item.revision === intent.revision,
      );
      if (!superseded) throw new Error("Missing superseded Plan withdrawal receipt");
      const { record, exact } = await deliverySubmission(tx, id, intent, intent.workflowId, cleanup);
      if (exact && record && (record.status === "placed" || record.status === "done")) {
        superseded.status = "done";
        superseded.submissionId = record.id;
        delete superseded.error;
      } else {
        superseded.status = "failed";
        superseded.error =
          result === "aborted" || (record?.status === "unanswered" && record.reason === "aborted")
            ? "Superseded by discard; queued input aborted"
            : "Superseded by discard; input was not delivered";
      }
      delete delivery.withdrawal;
    }, cleanup);
  }

  function active(context: Context) {
    context.abortSignal?.throwIfAborted();
    if (disposed) throw new Error("Plan Mode controller is disposed");
    if (!harness) throw new Error("Bind the Plan Mode controller before resuming the Harness");
    return harness;
  }

  const task = defineTask<DeliveryInput, { phase: "deliver" }, DeliveryResult>({
    name: TASK_NAME,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (current, runtime, context) => {
        // Recovery must bind the controller before scheduling this phase.
        const matches = (state: DurablePlanState) => {
          const delivery = state.delivery;
          const receipt = state.receipts.find((item) => item.operationId === current.input.operationId);
          return (
            state.owner === runtime.conversationId &&
            state.workflowId === current.input.workflowId &&
            state.revision === current.input.revision &&
            delivery?.revision === current.input.revision &&
            delivery.operationId === current.input.operationId &&
            delivery.taskId === current.id &&
            receipt?.taskId === current.id &&
            receipt.revision === current.input.revision &&
            receipt.status === "pending"
          );
        };
        type Decision =
          | { kind: "terminal" | "busy" }
          | { kind: "submit"; requestId: string; content: string }
          | { kind: "withdraw"; intent: DurablePlanWithdrawal }
          | { kind: "existing"; submissionId: SubmissionId };
        const check = async (idleBoundary: boolean): Promise<Decision> => {
          let decision: Decision = { kind: "busy" };
          await runtime.commit(async (tx) => {
            active(context);
            const state = await tx.doc(WorkflowDoc, runtime.conversationId);
            active(context);
            validateState(state);
            if (!matches(state)) {
              decision = { kind: "terminal" };
              return { status: "terminal", outcome: { status: "completed", result: { status: "stale" } } };
            }
            const delivery = state.delivery;
            const receipt = state.receipts.find((item) => item.operationId === current.input.operationId);
            if (!delivery || !receipt) throw new Error("Missing Plan Mode delivery receipt");
            if (delivery.kind === "discard") {
              if (delivery.withdrawal) {
                decision = { kind: "withdraw", intent: { ...delivery.withdrawal } };
                return undefined;
              }
              if (idleBoundary) {
                const live = await tx.doc(LiveDoc, runtime.conversationId);
                active(context);
                if (!live.run) {
                  receipt.status = "done";
                  delete receipt.error;
                  delete state.closing;
                  delete state.delivery;
                  decision = { kind: "terminal" };
                  return { status: "terminal", outcome: { status: "completed", result: { status: "delivered" } } };
                }
              }
              return undefined;
            }
            if (!delivery.requestId || delivery.content === undefined)
              throw new Error("Invalid Plan Mode delivery intent");
            // Read the durable admission BEFORE waiting for idle: replay may already own the active run.
            const { record: placed, exact } = await deliverySubmission(
              tx,
              runtime.conversationId,
              delivery,
              current.input.workflowId,
              context,
            );
            active(context);
            if (placed) {
              if (placed.type !== "input" || placed.status === "unanswered") {
                throw new Error("Plan Mode input was not delivered");
              }
              if (!exact) throw new Error("Plan Mode request ID identifies different input");
              if (placed.status === "placed" || placed.status === "done") {
                const live = await tx.doc(LiveDoc, runtime.conversationId);
                active(context);
                if (placed.status === "done" || live.run?.inputs.includes(placed.id)) {
                  receipt.submissionId = placed.id;
                  receipt.status = "done";
                  delete receipt.error;
                  if (delivery.kind === "approve") {
                    if (!state.approval || state.approval.requestId !== delivery.requestId)
                      throw new Error("Stale Plan Mode approval");
                    state.approval.submissionId = placed.id;
                    state.phase = "implementing";
                  }
                  delete state.delivery;
                  decision = { kind: "terminal" };
                  return { status: "terminal", outcome: { status: "completed", result: { status: "delivered" } } };
                }
              }
              decision = { kind: "existing", submissionId: placed.id };
            } else if (idleBoundary) {
              const live = await tx.doc(LiveDoc, runtime.conversationId);
              active(context);
              if (!live.run) decision = { kind: "submit", requestId: delivery.requestId, content: delivery.content };
            }
            return undefined;
          }, context);
          active(context);
          return decision;
        };
        try {
          active(context);
          const conversation = await runtime.conversation(runtime.conversationId, context);
          active(context);
          if (!conversation) throw new Error("Plan Mode conversation no longer exists");
          for (;;) {
            let decision: Decision = await serialized(runtime.conversationId, context, async () => {
              const checked = await check(false);
              if (checked.kind !== "withdraw") return checked;
              await completeWithdrawal(runtime.conversationId, checked.intent, context);
              active(context);
              return { kind: "busy" } as const;
            });
            active(context);
            if (decision.kind === "terminal") return;
            if (decision.kind !== "existing") {
              // Never hold the lock across idle waits: discard must be able to revoke this intent.
              await conversation.waitForIdle(context);
              active(context);
              decision = await serialized(runtime.conversationId, context, async () => {
                const checked = await check(true);
                active(context);
                if (checked.kind !== "submit") return checked;
                try {
                  await conversation.submit(
                    {
                      type: "input",
                      content: checked.content,
                      requestId: checked.requestId,
                      whenBusy: "reject",
                      entry: {
                        kind: "plan-mode.input",
                        data: {
                          workflowId: current.input.workflowId,
                          revision: current.input.revision,
                          operationId: current.input.operationId,
                        },
                      },
                    },
                    context,
                  );
                  active(context);
                  // Publish actual placement before a host mutation can supersede this delivery.
                  return await check(false);
                } catch (error) {
                  active(context);
                  if (!(error instanceof ConversationBusy)) throw error;
                  return { kind: "busy" } as const;
                }
              });
              active(context);
              if (decision.kind === "terminal") return;
            }
            if (decision.kind === "existing") {
              const admitted = await active(context).submission(decision.submissionId, context);
              active(context);
              if (!admitted) throw new Error("Plan Mode submission no longer exists");
              // Recovery can own the active run or an inbox item. Wait outside the critical region.
              await admitted.wait(context);
              active(context);
            }
          }
        } catch (error) {
          // Close/abort/disposal leaves the intent intact for explicit recovery.
          if (runtime.signal.aborted || context.abortSignal?.aborted) throw error;
          if (disposed) {
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
            return;
          }
          await runtime.commit(async (tx) => {
            active(context);
            const state = await tx.doc(WorkflowDoc, runtime.conversationId);
            active(context);
            if (matches(state)) {
              const receipt = state.receipts.find((item) => item.operationId === current.input.operationId);
              if (receipt) {
                receipt.status = "failed";
                receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
              }
            }
            return { status: "terminal", outcome: { status: "completed", result: { status: "failed" } } };
          }, context);
        }
      },
    },
    abort: async (_current, runtime, context) => {
      // Aborting the delivery does not revoke guards or discard the reviewable plan.
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  function track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    mutations.add(pending);
    void pending.then(
      () => mutations.delete(pending),
      () => mutations.delete(pending),
    );
    return pending;
  }

  async function localConversation(conversation: Conversation, context: Context) {
    // Conversation handles supply IDs scoped to this bound Harness, never a foreign mutation line.
    const bound = active(context);
    const local = await bound.conversation(conversation.id, context);
    active(context);
    if (!local) throw new Error("Conversation does not exist in the bound Plan Mode Harness");
    return local;
  }

  async function inspect(conversation: Conversation, context: Context) {
    const bound = active(context);
    const local = await localConversation(conversation, context);
    active(context);
    const state = await bound.snapshot(WorkflowDoc, local.id, context);
    active(context);
    return viewOf(state, local.id);
  }

  async function stop(id: TaskId, context: Context) {
    const bound = harness;
    if (!bound) return;
    await bound.abortTask(id, context);
    await bound.waitForTask(id, context);
  }

  function mutate(
    conversation: Conversation,
    kind: DurablePlanOperation,
    input: DurablePlanMutation | DurablePlanStart | DurablePlanAnswers | DurablePlanRevision,
    context: Context,
  ) {
    return track(async () => {
      const request = structuredClone(input);
      const bound = active(context);
      const local = await localConversation(conversation, context);
      active(context);
      const previous = await serialized(local.id, context, async () => {
        const committed = await local.commit(async (tx) => {
          active(context);
          const state = await tx.doc(WorkflowDoc, local.id);
          active(context);
          const oldDelivery = state.owner === local.id && state.delivery ? { ...state.delivery } : undefined;
          const oldWorkflowId = state.workflowId;
          const oldTask = oldDelivery?.taskId;
          const { receipt, duplicate } = applyHostMutation(state, local.id, kind, request, options);
          let withdrawal: DurablePlanWithdrawal | undefined;
          if (!duplicate && kind === "discard" && oldDelivery && oldWorkflowId) {
            const superseded = state.receipts.find((item) => item.operationId === oldDelivery.operationId);
            if (superseded && superseded.status !== "done") {
              superseded.status = "failed";
              superseded.error = "Superseded by discard before input placement";
              if (oldDelivery.requestId) {
                const { record, exact } = await deliverySubmission(tx, local.id, oldDelivery, oldWorkflowId, context);
                active(context);
                if (exact && record) {
                  if (record.status === "placed" || record.status === "done") {
                    superseded.status = "done";
                    superseded.submissionId = record.id;
                    delete superseded.error;
                  } else if (record.status === "queued") {
                    if (!oldDelivery.requestId || oldDelivery.content === undefined || !state.delivery)
                      throw new Error("Missing Plan withdrawal intent");
                    withdrawal = {
                      workflowId: oldWorkflowId,
                      operationId: oldDelivery.operationId,
                      revision: oldDelivery.revision,
                      requestId: oldDelivery.requestId,
                      content: oldDelivery.content,
                      submissionId: record.id,
                    };
                    state.delivery.withdrawal = withdrawal;
                  }
                }
              }
            }
          }
          if (!duplicate && kind === "start") {
            // An already-running Normal tool cannot acquire a retroactive execution guard.
            // Check the ordinary ownership roots on the same serialized line as activation.
            if ((await tx.doc(LiveDoc, local.id)).run) throw new ConversationBusy(local.id);
            active(context);
            let tasks = await tx.scanTasks({ conversationId: local.id }, 128);
            for (;;) {
              active(context);
              if (
                tasks.items.some(
                  (record) => record.owner === undefined && !record.background && record.state.status !== "terminal",
                )
              )
                throw new ConversationBusy(local.id);
              if (!tasks.next) break;
              tasks = await tx.scanTasks({ conversationId: local.id }, 128, tasks.next);
            }
          }
          if (!duplicate && receipt.status === "pending") {
            const delivery = state.delivery;
            const persistedReceipt = state.receipts.find((item) => item.operationId === receipt.operationId);
            if (!delivery || !persistedReceipt || !state.workflowId)
              throw new Error("Missing Plan Mode delivery intent");
            const taskId = await tx.createTask(
              task,
              {
                workflowId: state.workflowId,
                revision: state.revision,
                operationId: receipt.operationId,
              },
              { ownership: { kind: "conversation" }, background: true },
            );
            active(context);
            delivery.taskId = taskId;
            persistedReceipt.taskId = taskId;
          }
          return { previous: !duplicate && oldTask !== state.delivery?.taskId ? oldTask : undefined, withdrawal };
        }, context);
        if (committed.withdrawal) await completeWithdrawal(local.id, committed.withdrawal, context);
        return committed.previous;
      });
      active(context);
      if (previous !== undefined) {
        await stop(previous, context);
        active(context);
      }
      bound.resume();
      return inspect(local, context);
    });
  }

  function reconcile(conversation: Conversation, context: Context) {
    return track(async () => {
      const bound = active(context);
      const local = await localConversation(conversation, context);
      active(context);
      await serialized(local.id, context, () =>
        local.commit(async (tx) => {
          active(context);
          const state = await tx.doc(WorkflowDoc, local.id);
          active(context);
          validateState(state);
          if (state.owner !== local.id && state.workflowId !== null)
            throw new Error("Activate the fork with a new workflow identity before reconciliation");
          const delivery = state.delivery;
          if (!delivery) return;
          const receipt = state.receipts.find((item) => item.operationId === delivery.operationId);
          if (
            !receipt ||
            receipt.revision !== state.revision ||
            delivery.revision !== state.revision ||
            !state.workflowId
          ) {
            throw new Error("Invalid Plan Mode delivery receipt");
          }
          if (receipt.status === "done") return;
          const existing = delivery.taskId === undefined ? undefined : await tx.task(delivery.taskId);
          active(context);
          if (existing && existing.state.status !== "terminal") return;
          const taskId = await tx.createTask(
            task,
            {
              workflowId: state.workflowId,
              revision: state.revision,
              operationId: delivery.operationId,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          active(context);
          delivery.taskId = taskId;
          receipt.taskId = taskId;
          receipt.status = "pending";
          delete receipt.error;
        }, context),
      );
      active(context);
      bound.resume();
      return inspect(local, context);
    });
  }

  function dispose(context: Context): Promise<void> {
    if (disposal) return disposal;
    disposed = true;
    shutdown.abort(new Error("Plan Mode controller is disposed"));
    disposal = (async () => {
      // Join host commits before enumerating tasks: a commit may have been publishing at disposal.
      await Promise.allSettled([...mutations]);
      if (!harness) return;
      const cleanup = withoutAbortSignal(context);
      try {
        const inspection = await harness.inspect(cleanup);
        for (const { record } of inspection.tasks) {
          if (record.kind === TASK_NAME && record.background && record.owner === undefined)
            await stop(record.id, cleanup);
        }
      } catch (error) {
        // The pinned public Session and Harness APIs use plain close errors and SessionFailed for storage failure.
        if (
          !(error instanceof SessionFailed) &&
          !(error instanceof Error && (error.message === "Session is closed" || error.message === "Harness is closed"))
        )
          throw error;
        // Session.closed includes storage shutdown; no invocation remains to abort after this boundary.
        await harness.closed;
      }
    })();
    return disposal;
  }

  return {
    task,
    getHarness: () => harness,
    bind(bound) {
      if (harness) throw new Error("Plan Mode controller is already bound");
      if (disposed) throw new Error("Plan Mode controller is disposed");
      harness = bound;
      return {
        inspect,
        start: (conversation, input, context) => mutate(conversation, "start", input, context),
        answer: (conversation, input, context) => mutate(conversation, "answer", input, context),
        cancelQuestion: (conversation, input, context) => mutate(conversation, "cancel_question", input, context),
        revise: (conversation, input, context) => mutate(conversation, "revise", input, context),
        approve: (conversation, input, context) => mutate(conversation, "approve", input, context),
        discard: (conversation, input, context) => mutate(conversation, "discard", input, context),
        reconcile,
        dispose,
      };
    },
  };
}
