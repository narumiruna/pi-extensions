import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurablePlanMode } from "../src/durable.js";
import { barrier, ControllerStorage } from "./durable-controller-support.js";

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing expected test value");
  return value;
}

it("linearizes approval placement and concurrent discard at the second native receipt lookup", async () => {
  const storage = new ControllerStorage();
  const raw = createRegistry();
  const planMode = createDurablePlanMode({ registry: raw, registryVersion: "race-v1", capabilities: [] });
  raw.install(planMode.extension);
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    storage,
    {
      registry: planMode.registry,
      models,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  const controller = planMode.createController(harness);
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const paused = barrier();
  const release = barrier();
  try {
    await controller.start(
      root,
      { operationId: "start", workflowId: "race-workflow", expected: { workflowId: null, revision: 0 } },
      context,
    );
    const plan = "# Exact approved plan\n\nDo not place this after discard.\n";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan }, { id: "proposal" }), { stopReason: "toolUse" }),
    ]);
    await (await root.submit({ type: "input", content: "Prepare the plan" }, context)).wait(context);
    const ready = await controller.inspect(root, context);
    expect(ready).toMatchObject({ phase: "ready", plan });
    const requestId = `plan-mode:${ready.workflowId}:${ready.revision + 1}:approve`;
    let lookups = 0;
    storage.beforeSubmissionByRequest = async (request) => {
      if (request !== requestId || ++lookups !== 2) return;
      paused.resolve();
      await release.promise;
    };
    const order: string[] = [];
    storage.afterCommit = (writes) => {
      if (
        writes.some(
          (write) =>
            write.type === "submission" && write.value.requestId === requestId && write.value.status === "placed",
        )
      )
        order.push("placed");
      if (
        !order.includes("discard") &&
        writes.some(
          (write) =>
            write.type === "task" &&
            write.value.kind === "plan-mode.delivery" &&
            typeof write.value.input === "object" &&
            write.value.input !== null &&
            !Array.isArray(write.value.input) &&
            write.value.input.operationId === "discard",
        )
      )
        order.push("discard");
    };
    faux.setResponses([fauxAssistantMessage("implementation finished")]);
    const approving = controller.approve(
      root,
      { operationId: "approve", expected: { workflowId: ready.workflowId, revision: ready.revision } },
      context,
    );
    await paused.promise;
    // The worker has read the approval at check(true), but has not submitted it.
    const discarding = controller.discard(
      root,
      { operationId: "discard", expected: { workflowId: ready.workflowId, revision: ready.revision + 1 } },
      context,
    );
    release.resolve();
    await Promise.all([approving, discarding]);
    const discarded = await controller.inspect(root, context);
    const receipt = discarded.receipts.find((item) => item.operationId === "approve");
    // Check committed admission order, not only the final transcript. Both linearizations are safe.
    if (order[0] === "discard") {
      expect(order).toEqual(["discard"]);
      expect(receipt?.status).toBe("failed");
      expect(receipt?.submissionId).toBeUndefined();
    } else {
      expect(order).toEqual(["placed", "discard"]);
      expect(receipt?.status).toBe("done");
      expect(receipt?.submissionId).toBeDefined();
      const submission = required(await harness.submission(required(receipt?.submissionId), context));
      expect((await submission.wait(context)).status).toBe("done");
    }
    const discardTask = discarded.receipts.find((item) => item.operationId === "discard")?.taskId;
    expect(discardTask).toBeDefined();
    await harness.waitForTask(required(discardTask), context);
    expect(order.filter((event) => event === "placed")).toHaveLength(receipt?.status === "done" ? 1 : 0);
    expect((await controller.inspect(root, context)).receipts.every((item) => item.status !== "pending")).toBe(true);
  } finally {
    release.resolve();
    await harness.close(context);
    await controller.dispose(context);
  }
});
