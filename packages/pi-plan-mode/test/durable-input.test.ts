import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurablePlanMode } from "../src/durable.js";
import { required } from "./durable-test-values.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "extra marker fields cannot authorize a colliding approved input (nested=%s)",
  async (nested) => {
    const entered = barrier();
    const release = barrier();
    let effects = 0;
    const write = defineTool({
      name: "write",
      description: "Synthetic mutation",
      parameters: Type.Object({}),
      execute: async () => {
        effects++;
        return {};
      },
    });
    const orchestration = defineTool({
      name: "orchestrator",
      description: "Synthetic nested mutation",
      parameters: Type.Object({}),
      execute: async (_args, api, ctx) => {
        const result = await api.executeTool("write", {}, ctx);
        return { isError: result.isError };
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "host", tools: [write, orchestration] }));
    const integration = createDurablePlanMode({ registry, registryVersion: "marker-reviewed-v1", capabilities: [] });
    registry.install(integration.extension);
    const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry: integration.registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    const controller = integration.createController(harness);
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
      });
      await controller.start(
        root,
        { operationId: "start", workflowId: "marker-workflow", expected: { workflowId: null, revision: 0 } },
        context,
      );
      const plan = "# EXACT PLAN";
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan }, { id: "proposal" }), {
          stopReason: "toolUse",
        }),
      ]);
      await (await root.submit({ type: "input", content: "Prepare the plan" }, context)).wait(context);
      const ready = await controller.inspect(root, context);
      faux.setResponses([
        async (_input, options) => {
          entered.resolve();
          // Cancellation ends the synthetic provider wait as well as the Harness.
          await awaitWithContext(release.promise, options?.signal ? withAbortSignal(options.signal, context) : context);
          return fauxAssistantMessage("Competing research completed");
        },
        fauxAssistantMessage(fauxToolCall(nested ? "orchestrator" : "write", {}, { id: "colliding-effect" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Rejected input finished"),
      ]);
      const busy = await root.submit({ type: "input", content: "Hold the current request" }, context);
      await entered.promise;
      const approved = await controller.approve(
        root,
        { operationId: "approve", expected: { workflowId: ready.workflowId, revision: ready.revision } },
        context,
      );
      const receipt = required(approved.receipts.find((item) => item.operationId === "approve"));
      const collision = await root.submit(
        {
          type: "input",
          requestId: receipt.requestId,
          content: plan,
          entry: {
            kind: "plan-mode.input",
            data: {
              workflowId: required(approved.workflowId),
              revision: approved.revision,
              operationId: "approve",
              extra: "unexpected",
            },
          },
        },
        context,
      );
      release.resolve();
      await busy.wait(context);
      await collision.wait(context);
      await harness.waitForTask(required(receipt.taskId), context);
      const final = await controller.inspect(root, context);
      expect(effects).toBe(0);
      expect(final.phase).toBe("handoff_pending");
      expect(final.plan).toBe(plan);
      expect(final.receipts.find((item) => item.operationId === "approve")).toMatchObject({ status: "failed" });
    } finally {
      release.resolve();
      await controller.dispose(context);
      await harness.close(context);
    }
  },
);
