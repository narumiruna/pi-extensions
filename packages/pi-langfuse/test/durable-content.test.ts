import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  ToolTask,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createLangfuseRuntimeFromBackend, createPiLangfuseDurableConversation } from "../src/durable.js";
import { MAX_CAPTURE_BYTES } from "../src/sanitizer.js";
import { deferred } from "./durable-support.js";
import { FakeBackend, serializedBytes } from "./support.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider({ ...faux.provider, headers: { Authorization: "Bearer PRIVATE-PROVIDER-HEADER" } });
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
  const tracing = await createPiLangfuseDurableConversation(runtime, { harness, conversationId: root.id, context });
  return { faux, registry, root, backend, tracing };
}

it.each([false, true])(
  "omits raw diagnostics and returned-error content without changing committed tool results (isError=%s)",
  async (isError) => {
    const f = await fixture();
    f.registry.install(
      defineExtension({
        name: "privacy",
        tools: [
          defineTool({
            name: "privacy",
            description: "Return content and diagnostics",
            parameters: Type.Object({}),
            execute: async () => ({
              output: [fauxText(isError ? "PRIVATE-RETURNED-ERROR" : "visible tool output")],
              diagnostics: [{ severity: "warn", code: "host_diagnostic", message: "PRIVATE-DIAGNOSTIC-Authorization" }],
              isError,
              details: { secretKey: "PRIVATE-TOOL-DETAILS" },
            }),
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("privacy", {}, { id: "privacy-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("answer"),
    ]);
    const submission = await f.root.submit({ type: "input", content: "go" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    await vi.waitFor(() => expect(f.backend.observations.find((span) => span.type === "tool")?.ended).toBe(true));
    const captured = JSON.stringify(f.backend.observations);
    expect(captured).not.toContain("PRIVATE-DIAGNOSTIC-Authorization");
    expect(captured).not.toContain("PRIVATE-TOOL-DETAILS");
    expect(captured).not.toContain("PRIVATE-PROVIDER-HEADER");
    expect(captured).not.toContain("PRIVATE-RETURNED-ERROR");
    expect(captured).toContain(isError ? "tool error content omitted" : "visible tool output");
    if (!isError) expect(captured).toContain("diagnosticsOmitted");
    const transcript = JSON.stringify((await f.root.context(context)).entries);
    expect(transcript).toContain("PRIVATE-DIAGNOSTIC-Authorization");
    expect(transcript).toContain("PRIVATE-TOOL-DETAILS");
    if (isError) expect(transcript).toContain("PRIVATE-RETURNED-ERROR");
  },
);

it("bounds oversized committed tool identifiers in metadata without rewriting execution identifiers", async () => {
  const f = await fixture();
  const id = "💫".repeat(MAX_CAPTURE_BYTES);
  f.registry.install(
    defineExtension({
      name: "id",
      tools: [
        defineTool({
          name: "id",
          description: "Execute",
          parameters: Type.Object({}),
          execute: async () => ({ output: [fauxText("result")] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("id", {}, { id }), { stopReason: "toolUse" }),
    fauxAssistantMessage("answer"),
  ]);
  expect((await (await f.root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
  await vi.waitFor(() => expect(f.backend.observations.find((span) => span.type === "tool")?.ended).toBe(true));
  for (const span of f.backend.observations)
    for (const attributes of [span.attributes, ...span.updates, ...span.traceUpdates]) {
      if (attributes.metadata) expect(serializedBytes(attributes.metadata)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    }
  expect(JSON.stringify(f.backend.observations)).not.toContain(id);
  expect(JSON.stringify((await f.root.context(context)).entries)).toContain(id);
});

it("omits image payloads and continuation signatures from committed messages without modifying them", async () => {
  const f = await fixture();
  const imageData = Buffer.from("PRIVATE-IMAGE-PAYLOAD").toString("base64");
  const assistant = fauxAssistantMessage([fauxText("visible text")]);
  const block = assistant.content[0];
  if (block.type !== "text") throw new Error("Expected text");
  block.textSignature = "PRIVATE-CONTINUATION-SIGNATURE";
  f.faux.setResponses([assistant]);
  const submission = await f.root.submit(
    {
      type: "input",
      content: [
        { type: "text", text: "inspect" },
        { type: "image", data: imageData, mimeType: "image/png" },
      ],
    },
    context,
  );
  expect((await submission.wait(context)).status).toBe("done");
  await vi.waitFor(() =>
    expect(f.backend.observations.find((span) => span.name === "pi.durable.submission")?.ended).toBe(true),
  );
  const captured = JSON.stringify(f.backend.observations);
  expect(captured).not.toContain(imageData);
  expect(captured).not.toContain("PRIVATE-CONTINUATION-SIGNATURE");
  expect(captured).toContain("base64 omitted");
  expect(captured).toContain("visible text");
  const transcript = JSON.stringify((await f.root.context(context)).entries);
  expect(transcript).toContain(imageData);
  expect(transcript).toContain("PRIVATE-CONTINUATION-SIGNATURE");
});

it.each(["throw", "invalid", "blocked", "hook_throw", "unoffered", "abort"] as const)(
  "omits diagnostic bodies for the real %s tool-result branch",
  async (kind) => {
    const f = await fixture();
    const entered = deferred();
    const tool = defineTool({
      name: "private",
      description: "Privacy test",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_args, _api, ctx) => {
        if (kind === "throw") throw new Error("PRIVATE-EXECUTION-ERROR");
        if (kind === "abort") {
          entered.resolve();
          await awaitWithContext(new Promise<void>(() => undefined), ctx);
        }
        return { output: [fauxText("visible result")] };
      },
    });
    f.registry.install(
      defineExtension({
        name: "private",
        tools: [tool],
        hooks: [
          hook(ToolTask, {
            beforeTool: () => {
              if (kind === "hook_throw") throw new Error("PRIVATE-HOOK-ERROR");
              return kind === "blocked" ? { block: "PRIVATE-BLOCK-ERROR" } : undefined;
            },
            afterTool: (_call, result) => ({
              ...result,
              details: { secretKey: "PRIVATE-DETAIL" },
              diagnostics: [
                ...(result.diagnostics ?? []),
                { severity: "warn", code: "host_private", message: "PRIVATE-ADDED-DIAGNOSTIC" },
              ],
            }),
          }),
        ],
      }),
    );
    if (kind === "unoffered") await f.root.configure({ modelTools: [] }, context);
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("private", { value: kind === "invalid" ? 123 : "safe argument" }, { id: "private-call" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("final"),
    ]);
    const submission = await f.root.submit({ type: "input", content: "go" }, context);
    if (kind === "abort") {
      await entered.promise;
      await f.root.abort(context);
    }
    await submission.wait(context);
    await vi.waitFor(() => expect(f.backend.observations.find((span) => span.type === "tool")?.ended).toBe(true));
    expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE-");
    const transcript = JSON.stringify((await f.root.context(context)).entries);
    expect(transcript).toContain("PRIVATE-ADDED-DIAGNOSTIC");
    expect(f.backend.observations.filter((span) => span.type === "tool")).toHaveLength(1);
  },
);
