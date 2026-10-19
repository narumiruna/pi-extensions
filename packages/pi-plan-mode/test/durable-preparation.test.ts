import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  wrapTool,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurablePlanMode } from "../src/durable.js";

it.each([false, true])("preserves pure argument repair through effective wrappers (nested=%s)", async (nested) => {
  let received: unknown;
  const read = defineTool({
    name: "read",
    description: "Synthetic read",
    parameters: Type.Object({ path: Type.String() }),
    prepareArguments: (input) => {
      const path = (input as { path: unknown }).path;
      return { path: Array.isArray(path) ? String(path[0]) : String(path) };
    },
    execute: async (input) => {
      received = input;
      return {};
    },
  });
  const orchestrator = defineTool({
    name: "orchestrator",
    description: "Synthetic nested read",
    parameters: Type.Object({}),
    execute: async (_input, api, ctx) => {
      await api.executeTool("read", { path: ["README.md"] }, ctx);
      return {};
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "host",
      tools: [read, orchestrator],
      wraps: [wrapTool(read, (tool) => ({ ...tool, execute: (args, api, ctx) => tool.execute(args, api, ctx) }))],
    }),
  );
  const integration = createDurablePlanMode({
    registry,
    registryVersion: "pure-preparation-v1",
    capabilities: [
      { name: "read", policy: "read-only" },
      { name: "orchestrator", policy: "read-only" },
    ],
  });
  registry.install(integration.extension);
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: integration.registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
    context,
  );
  const controller = integration.createController(harness);
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    await controller.start(
      root,
      { operationId: "start", workflowId: "pure-preparation", expected: { workflowId: null, revision: 0 } },
      context,
    );
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(nested ? "orchestrator" : "read", nested ? {} : { path: ["README.md"] }, { id: "read" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    await (await root.submit({ type: "input", content: "Inspect" }, context)).wait(context);
    expect(received).toEqual({ path: "README.md" });
  } finally {
    await controller.dispose(context);
    await harness.close(context);
  }
});

it.each([false, true])(
  "characterizes unsupported impure preparers before native admission (nested=%s)",
  async (nested) => {
    let prepared = 0;
    let executed = 0;
    const write = defineTool({
      name: "write",
      description: "Unsupported impure preparer characterization",
      parameters: Type.Object({}),
      // This deliberately violates Pi's PURE prepareArguments contract. A registry
      // containing it is unsupported: Plan policy is not a sandbox for arbitrary host code.
      prepareArguments: () => {
        prepared++;
        return {};
      },
      execute: async () => {
        executed++;
        return {};
      },
    });
    const orchestrator = defineTool({
      name: "orchestrator",
      description: "Synthetic nested denied call",
      parameters: Type.Object({}),
      execute: async (_input, api, ctx) => {
        await api.executeTool("write", {}, ctx);
        return {};
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "host", tools: [write, orchestrator] }));
    const integration = createDurablePlanMode({
      registry,
      registryVersion: "preparation-limit-v1",
      capabilities: [{ name: "orchestrator", policy: "read-only" }],
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
      await controller.start(
        root,
        { operationId: "start", workflowId: "preparation-limit", expected: { workflowId: null, revision: 0 } },
        context,
      );
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(nested ? "orchestrator" : "write", {}, { id: "denied" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await (await root.submit({ type: "input", content: "Attempt denied call" }, context)).wait(context);
      expect(prepared).toBe(1);
      expect(executed).toBe(0);
    } finally {
      await controller.dispose(context);
      await harness.close(context);
    }
  },
);
