import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import {
  createLangfuseRuntimeFromBackend,
  createPiLangfuseDurableConversation,
  type PiLangfuseDurableConversation,
} from "../src/durable.js";
import { FakeBackend } from "./support.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  cleanup.push(() => runtime.shutdown().catch(() => undefined));
  return { faux, registry, root, backend, runtime, harness };
}

it("a host error callback can dispose during tool-span finalization without double-ending or interrupting execution", async () => {
  const f = await fixture();
  let tracing: PiLangfuseDurableConversation | undefined;
  const start = f.backend.start.bind(f.backend);
  f.backend.start = (...args) => {
    const span = start(...args);
    if (span.type === "tool")
      span.update = () => {
        throw new Error("exporter unavailable");
      };
    return span;
  };
  tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
    onError: () => tracing?.dispose(),
  });
  f.registry.install(
    defineExtension({
      name: "tool",
      tools: [
        defineTool({
          name: "tool",
          description: "Execute",
          parameters: Type.Object({}),
          execute: async () => ({ output: [fauxText("executed fully")] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool", {}, { id: "tool-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("full answer"),
  ]);
  const record = await (await f.root.submit({ type: "input", content: "go" }, context)).wait(context);
  expect(record.status).toBe("done");
  await tracing.closed;
  expect(f.backend.observations.some((span) => span.type === "tool")).toBe(true);
  expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
  expect(JSON.stringify((await f.root.context(context)).entries)).toContain("full answer");
  expect(f.runtime.closed).toBe(false);
  await tracing.dispose();
  expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
});

it("a correlation callback can dispose before its submission span is acquired", async () => {
  const f = await fixture();
  let tracing: PiLangfuseDurableConversation | undefined;
  tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
    submissionCorrelation: () => {
      void tracing?.dispose();
      return { requestId: "correlated" };
    },
  });
  f.faux.setResponses([fauxAssistantMessage("full answer")]);
  expect((await (await f.root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
  await tracing.closed;
  expect(f.backend.observations).toHaveLength(1);
  expect(f.backend.observations[0].endCalls).toBe(1);
  expect(f.runtime.closed).toBe(false);
});

it("a backend can synchronously dispose while returning a new generation handle without leaking it", async () => {
  const f = await fixture();
  let tracing: PiLangfuseDurableConversation | undefined;
  const start = f.backend.start.bind(f.backend);
  f.backend.start = (...args) => {
    const span = start(...args);
    if (span.type === "generation") void tracing?.dispose();
    return span;
  };
  tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  f.faux.setResponses([fauxAssistantMessage("full answer")]);
  expect((await (await f.root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
  await tracing.closed;
  await vi.waitFor(() => expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true));
  expect(f.backend.observations.some((span) => span.type === "generation")).toBe(true);
  expect(f.runtime.closed).toBe(false);
});
