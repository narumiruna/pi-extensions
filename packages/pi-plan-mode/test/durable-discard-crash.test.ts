import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type StorageWrite,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurablePlanMode } from "../src/durable.js";
import type { DurablePlanView } from "../src/durable-types.js";
import { required } from "./durable-test-values.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Point = "discard-publication" | "queued-abort" | "discard-settlement";
class WithdrawalStorage extends MemoryStorage {
  point?: Point;
  after = false;
  hit = false;
  queuedId?: SubmissionId;
  readonly withdrawn = barrier();
  override async close() {}
  override async commit(writes: readonly StorageWrite[], ctx: Context) {
    const queuedAbort = writes.some(
      (write) => write.type === "submission" && write.value.id === this.queuedId && write.value.status === "unanswered",
    );
    const discardTask = writes.find(
      (write) =>
        write.type === "task" &&
        write.value.kind === "plan-mode.delivery" &&
        typeof write.value.input === "object" &&
        write.value.input !== null &&
        !Array.isArray(write.value.input) &&
        write.value.input.operationId === "discard",
    );
    const taskState = discardTask?.type === "task" ? discardTask.value.state.status : undefined;
    const match =
      this.point === "queued-abort"
        ? queuedAbort
        : this.point === "discard-publication"
          ? taskState === "pending"
          : this.point === "discard-settlement" && taskState === "terminal";
    const fail = !this.hit && match;
    if (fail && !this.after) {
      this.hit = true;
      throw new Error("Synthetic withdrawal crash before commit");
    }
    const seq = await super.commit(writes, ctx);
    if (queuedAbort) this.withdrawn.resolve();
    if (fail && this.after) {
      this.hit = true;
      throw new Error("Synthetic withdrawal crash after commit");
    }
    return seq;
  }
}
const identity = (view: DurablePlanView) => ({ workflowId: view.workflowId, revision: view.revision });
const cases = (["discard-publication", "queued-abort", "discard-settlement"] as const).flatMap((point) => [
  { point, after: false },
  { point, after: true },
]);

it.each(cases)("recovers persisted queued withdrawal at $point (after=$after)", async ({ point, after }) => {
  const storage = new WithdrawalStorage();
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const entered = barrier();
  const release = barrier();
  const plan = "# Discarded exact plan";
  let staleProviderRequests = 0;
  const open = async () => {
    const registry = createRegistry();
    const integration = createDurablePlanMode({
      registry,
      registryVersion: "withdrawal-reviewed-v1",
      capabilities: [],
    });
    registry.install(integration.extension);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry: integration.registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    const controller = integration.createController(harness);
    const root = await harness.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    return { harness, controller, root };
  };
  const original = await open();
  let recovered: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await original.controller.start(
      original.root,
      { operationId: "start", workflowId: "withdrawal-workflow", expected: { workflowId: null, revision: 0 } },
      context,
    );
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan }, { id: "proposal" }), { stopReason: "toolUse" }),
    ]);
    await (await original.root.submit({ type: "input", content: "Prepare" }, context)).wait(context);
    const ready = await original.controller.inspect(original.root, context);
    faux.setResponses([
      async (_input, options) => {
        entered.resolve();
        await awaitWithContext(release.promise, options?.signal ? withAbortSignal(options.signal, context) : context);
        return fauxAssistantMessage("Busy research completed");
      },
    ]);
    await original.root.submit({ type: "input", content: "Busy research" }, context);
    await entered.promise;
    const approved = await original.controller.approve(
      original.root,
      { operationId: "approve", expected: identity(ready) },
      context,
    );
    const approval = required(approved.receipts.find((receipt) => receipt.operationId === "approve"));
    const queued = await original.root.submit(
      {
        type: "input",
        content: plan,
        requestId: approval.requestId,
        entry: {
          kind: "plan-mode.input",
          data: { workflowId: required(approved.workflowId), revision: approved.revision, operationId: "approve" },
        },
      },
      context,
    );
    expect((await queued.status(context)).status).toBe("queued");
    storage.queuedId = queued.id;
    storage.point = point;
    storage.after = after;
    const input = { operationId: "discard", expected: identity(approved) };
    const drive = async (f: Awaited<ReturnType<typeof open>>) => {
      const discarded = await f.controller.discard(f.root, input, context);
      release.resolve();
      const receipt = required(discarded.receipts.find((item) => item.operationId === "discard"));
      await f.harness.waitForTask(required(receipt.taskId), context);
      await f.root.waitForIdle(context);
      return f.controller.inspect(f.root, context);
    };
    await drive(original).catch(() => undefined);
    expect(storage.hit).toBe(true);
    await original.harness.close(context);
    storage.point = undefined;
    recovered = await open();
    // The resumed old request cannot finish its turn until native withdrawal is committed.
    // This is a server-observable barrier, not a sleep or a race against scheduling speed.
    faux.setResponses([
      async (request, options) => {
        if (request.messages.filter((message) => message.role === "user").at(-1)?.content === plan)
          staleProviderRequests++;
        await awaitWithContext(
          storage.withdrawn.promise,
          options?.signal ? withAbortSignal(options.signal, context) : context,
        );
        return fauxAssistantMessage("Resumed research completed");
      },
    ]);
    const final = await drive(recovered);
    expect(final).toMatchObject({ phase: "inactive" });
    expect(final.closing).toBeUndefined();
    expect(final.delivery).toBeUndefined();
    const old = required(final.receipts.find((receipt) => receipt.operationId === "approve"));
    expect(old).toMatchObject({ status: "failed", error: "Superseded by discard; queued input aborted" });
    expect(await (await recovered.harness.submission(queued.id, context))?.status(context)).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
    expect(staleProviderRequests).toBe(0);
    const entries = await recovered.root.entries({}, 200, undefined, context);
    expect(entries.items.some((entry) => entry.kind === "plan-mode.input")).toBe(false);
  } finally {
    release.resolve();
    storage.withdrawn.resolve();
    await recovered?.harness.close(context);
    await original.harness.close(context);
  }
});
