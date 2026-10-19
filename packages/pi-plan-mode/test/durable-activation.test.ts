import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  ConversationBusy,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  MemoryStorage,
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
const identity = (view: DurablePlanView) => ({ workflowId: view.workflowId, revision: view.revision });

it.each(["inactive", "implementing"] as const)(
  "activation from %s cannot overlap an already-executing Normal mutation",
  async (phase) => {
    const entered = barrier();
    const release = barrier();
    let effects = 0;
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "host",
        tools: [
          defineTool({
            name: "write",
            description: "Synthetic Normal mutation",
            parameters: Type.Object({}),
            execute: async (_args, _api, ctx) => {
              entered.resolve();
              await awaitWithContext(release.promise, ctx);
              effects++;
              return {};
            },
          }),
        ],
      }),
    );
    const integration = createDurablePlanMode({
      registry,
      registryVersion: "activation-reviewed-v1",
      capabilities: [],
    });
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
      if (phase === "implementing") {
        await controller.start(
          root,
          { operationId: "first-start", workflowId: "first-workflow", expected: { workflowId: null, revision: 0 } },
          context,
        );
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Exact plan" }, { id: "proposal" }), {
            stopReason: "toolUse",
          }),
        ]);
        await (await root.submit({ type: "input", content: "Prepare the plan" }, context)).wait(context);
        const ready = await controller.inspect(root, context);
        faux.setResponses([fauxAssistantMessage("Implementation kickoff acknowledged")]);
        const pending = await controller.approve(
          root,
          { operationId: "first-approve", expected: identity(ready) },
          context,
        );
        await harness.waitForTask(
          required(required(pending.receipts.find((item) => item.operationId === "first-approve")).taskId),
          context,
        );
        const placed = await controller.inspect(root, context);
        await required(await harness.submission(required(required(placed.approval).submissionId), context)).wait(
          context,
        );
      }
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", {}, { id: "normal-write" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Normal mutation completed"),
      ]);
      const input = await root.submit({ type: "input", content: "Normal work" }, context);
      await entered.promise;
      const before = await controller.inspect(root, context);
      expect(before.phase).toBe(phase);
      const start = { operationId: "second-start", workflowId: "second-workflow", expected: identity(before) };
      await expect(controller.start(root, start, context)).rejects.toBeInstanceOf(ConversationBusy);
      expect(await controller.inspect(root, context)).toEqual(before);
      expect(effects).toBe(0);
      release.resolve();
      await input.wait(context);
      await root.waitForIdle(context);
      expect(effects).toBe(1);
      expect((await controller.start(root, start, context)).phase).toBe("planning");
      expect(effects).toBe(1);
    } finally {
      release.resolve();
      await controller.dispose(context);
      await harness.close(context);
    }
  },
);

it("activation checks paginated ordinary task roots, not only LiveDoc.run", async () => {
  const entered = barrier();
  const release = barrier();
  const task = defineTask<{ hold: boolean }, { phase: "run" }, Record<string, never>>({
    name: "host.foreground",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (current, runtime, ctx) => {
        if (current.input.hold) {
          entered.resolve();
          await awaitWithContext(release.promise, ctx);
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), ctx);
      },
    },
    abort: async (_current, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "host", tasks: [task] }));
  const integration = createDurablePlanMode({ registry, registryVersion: "task-reviewed-v1", capabilities: [] });
  registry.install(integration.extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: integration.registry },
    context,
  );
  const controller = integration.createController(harness);
  try {
    const root = await harness.root(context);
    await root.commit(async (tx) => {
      for (let i = 0; i < 130; i++) await tx.createTask(task, { hold: false }, { ownership: { kind: "conversation" } });
    }, context);
    await root.waitForIdle(context);
    const id = await root.commit(
      (tx) => tx.createTask(task, { hold: true }, { ownership: { kind: "conversation" } }),
      context,
    );
    harness.resume();
    await entered.promise;
    await expect(
      controller.start(
        root,
        { operationId: "start", workflowId: "workflow", expected: { workflowId: null, revision: 0 } },
        context,
      ),
    ).rejects.toBeInstanceOf(ConversationBusy);
    expect((await controller.inspect(root, context)).phase).toBe("inactive");
    release.resolve();
    await harness.waitForTask(id, context);
    const request = { operationId: "start", workflowId: "workflow", expected: { workflowId: null, revision: 0 } };
    const result = controller.start(root, request, context);
    request.workflowId = "caller-mutated-after-invocation";
    expect((await result).workflowId).toBe("workflow");
  } finally {
    release.resolve();
    await controller.dispose(context);
    await harness.close(context);
  }
});
