import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLangfuseRuntimeFromBackend, createPiLangfuseDurableConversation } from "../src/durable.js";
import { DurableRecorder } from "../src/durable-recorder.js";
import { MAX_CAPTURE_BYTES } from "../src/sanitizer.js";
import { FakeBackend, type FakeObservation, serializedBytes } from "./support.js";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function metadata(observation: FakeObservation) {
  return Object.assign({}, observation.attributes.metadata, ...observation.updates.map((update) => update.metadata));
}
function submissionSpan(backend: FakeBackend): FakeObservation {
  const span = backend.observations.find((candidate) => candidate.name === "pi.durable.submission");
  if (!span) throw new Error("Missing submission span");
  return span;
}
function output(observation: FakeObservation) {
  return [...observation.updates].reverse().find((update) => update.output !== undefined)?.output;
}

async function fixture(backend = new FakeBackend(), storage = new MemoryStorage()) {
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const runtime = createLangfuseRuntimeFromBackend(backend);
  cleanup.push(() => runtime.shutdown().catch(() => undefined));
  return { faux, models, registry, harness, root, runtime, backend };
}

async function settledTrace(backend: FakeBackend, count = 1) {
  await vi.waitFor(() =>
    expect(backend.observations.filter((span) => span.name === "pi.durable.submission" && span.ended)).toHaveLength(
      count,
    ),
  );
}

describe("public durable conversation tracing", () => {
  it("keeps multiple tool rounds and intermediate messages separate from committed submission completion and usage", async () => {
    const f = await fixture();
    f.registry.install(
      defineExtension({
        name: "tools",
        tools: [
          defineTool({
            name: "echo",
            parameters: Type.Object({ value: Type.String() }),
            description: "Echo",
            execute: async ({ value }) => ({ output: [{ type: "text", text: value }] }),
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(
        [fauxText("intermediate one"), fauxToolCall("echo", { value: "first" }, { id: "call-one" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxText("intermediate two"), fauxToolCall("echo", { value: "second" }, { id: "call-two" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("final one"), fauxText("final two")]),
    ]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
      sessionId: "host-session",
      userId: "host-user",
      applicationId: "app",
      submissionCorrelation: (record) => ({ requestId: record.requestId }),
    });
    const submission = await f.root.submit({ type: "input", content: "prompt", requestId: "request-one" }, context);
    const record = await submission.wait(context);
    expect(record.status).toBe("done");
    await settledTrace(f.backend);
    const generations = f.backend.observations.filter((span) => span.type === "generation");
    expect(generations).toHaveLength(3);
    expect(f.backend.observations.filter((span) => span.type === "tool")).toHaveLength(2);
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.run")).toHaveLength(1);
    const request = submissionSpan(f.backend);
    expect(metadata(request)["pi.request.id"]).toBe("request-one");
    expect(output(request)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "final one" },
          { type: "text", text: "final two" },
        ],
      },
    ]);
    expect(generations.every((span) => span.updates.some((update) => (update.usageDetails?.total ?? 0) > 0))).toBe(
      true,
    );
    if (record.status !== "done" || record.type !== "input") throw new Error("Missing committed answer");
    const committed = await f.root.commit((tx) => tx.entry(record.answer), context);
    const message = committed?.model?.[0];
    if (message?.role !== "assistant") throw new Error("Missing assistant usage");
    const finalUsage = generations[2].updates.find((update) => update.usageDetails)?.usageDetails;
    expect(finalUsage).toEqual({
      input: message.usage.input,
      output: message.usage.output,
      cache_read_input_tokens: message.usage.cacheRead,
      cache_creation_input_tokens: message.usage.cacheWrite,
      total: message.usage.totalTokens,
    });
    expect(generations[2].updates.find((update) => update.costDetails)?.costDetails).toEqual({
      input: message.usage.cost.input,
      output: message.usage.cost.output,
      cache_read: message.usage.cost.cacheRead,
      cache_write: message.usage.cost.cacheWrite,
      total: message.usage.cost.total,
    });
    await tracing.observeSubmission(submission.id);
    await tracing.observeSubmission(submission.id);
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission")).toHaveLength(1);
    await tracing.dispose();
    await tracing.dispose();
    expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
    expect(f.backend.shutdowns).toBe(0);
  });

  it("bounds tracing copies, not transcripts, tool arguments/results, or caller-visible answers", async () => {
    const f = await fixture();
    const large = "🦊".repeat(40_000);
    let executed = "";
    f.registry.install(
      defineExtension({
        name: "large",
        tools: [
          defineTool({
            name: "large",
            parameters: Type.Object({ value: Type.String(), apiKey: Type.String() }),
            description: "Large data",
            execute: async ({ value }) => {
              executed = value;
              return { output: [{ type: "text", text: value }] };
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("large", { value: large, apiKey: "provider-secret" }, { id: "large-call" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText(large), fauxText(large)]),
    ]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    const record = await (await f.root.submit({ type: "input", content: large }, context)).wait(context);
    expect(record.status).toBe("done");
    if (record.status !== "done" || record.type !== "input") throw new Error("Expected answer");
    const answer = await f.root.commit((tx) => tx.entry(record.answer), context);
    expect(answer?.model?.[0].content).toEqual([fauxText(large), fauxText(large)]);
    expect(executed).toBe(large);
    const transcript = await f.root.context(context);
    expect(JSON.stringify(transcript.entries)).toContain(large);
    await settledTrace(f.backend);
    for (const span of f.backend.observations) {
      for (const attributes of [span.attributes, ...span.updates]) {
        if (attributes.input !== undefined)
          expect(serializedBytes(attributes.input)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
        if (attributes.output !== undefined)
          expect(serializedBytes(attributes.output)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
      }
    }
    expect(JSON.stringify(f.backend.observations)).not.toContain("provider-secret");
    await tracing.dispose();
  });

  it("isolates concurrent conversations, queued submissions, correlation and shared-runtime disposal", async () => {
    const f = await fixture();
    const other = await f.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: f.faux.provider.id, modelId: f.faux.getModel().id } },
      },
      context,
    );
    const entered = deferred();
    const release = deferred();
    f.faux.setResponses([
      async () => {
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("answer-a");
      },
      fauxAssistantMessage("answer-b"),
      fauxAssistantMessage("answer-c"),
    ]);
    const a = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
      sessionId: "session-a",
      userId: "user-a",
      applicationId: "app-a",
    });
    const b = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: other.id,
      context,
      sessionId: "session-b",
      userId: "user-b",
      applicationId: "app-b",
      captureContent: false,
    });
    const sa = await f.root.submit({ type: "input", content: "prompt-a", requestId: "req-a" }, context);
    await entered.promise;
    const sc = await f.root.submit({ type: "input", content: "prompt-c", requestId: "req-c" }, context);
    const sb = await other.submit({ type: "input", content: "prompt-b", requestId: "req-b" }, context);
    expect((await sb.wait(context)).status).toBe("done");
    await b.dispose();
    expect(f.runtime.closed).toBe(false);
    release.resolve();
    expect((await sa.wait(context)).status).toBe("done");
    expect((await sc.wait(context)).status).toBe("done");
    await settledTrace(f.backend, 3);
    const spansA = f.backend.observations.filter((span) => span.attributes.sessionId === "session-a");
    const spansB = f.backend.observations.filter((span) => span.attributes.sessionId === "session-b");
    expect(JSON.stringify(spansA)).not.toContain("prompt-b");
    expect(JSON.stringify(spansB)).not.toContain("prompt-a");
    expect(spansA.every((span) => span.attributes.userId === "user-a")).toBe(true);
    expect(spansB.every((span) => span.attributes.userId === "user-b")).toBe(true);
    const requests = f.backend.observations.filter((span) => span.name === "pi.durable.submission");
    expect(requests.map((span) => metadata(span)["pi.request.id"]).sort()).toEqual(["req-a", "req-b", "req-c"]);
    await a.dispose();
  });

  it("deduplicates identifiable real event observations without inventing additional runs or spans", async () => {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const watched = await watchEvents(f.harness, f.root.id, context);
    watched.start(async (batch) => {
      events.push(...batch);
    });
    f.registry.install(
      defineExtension({
        name: "duplicate",
        tools: [
          defineTool({
            name: "duplicate",
            description: "Result",
            parameters: Type.Object({}),
            execute: async () => ({ output: [{ type: "text", text: "result" }] }),
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("duplicate", {}, { id: "duplicate-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("final"),
    ]);
    await (await f.root.submit({ type: "input", content: "duplicate" }, context)).wait(context);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "submission" && event.record.status === "done")).toBe(true),
    );
    await watched.stop();
    const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id });
    recorder.snapshot(watched.snapshot, true);
    for (const event of events) {
      for (let repeat = 0; repeat < 2; repeat++) {
        if (event.type === "submission")
          await recorder.submission(event.record, (id) => f.root.commit((tx) => tx.entry(id), context));
        else recorder.event(event);
      }
    }
    recorder.dispose();
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.run")).toHaveLength(1);
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission")).toHaveLength(1);
    expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(2);
    expect(f.backend.observations.filter((span) => span.type === "tool")).toHaveLength(1);
    expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
  });

  it("late active attachment does not replay tool starts and captures only later committed activity", async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    f.registry.install(
      defineExtension({
        name: "late",
        tools: [
          defineTool({
            name: "late",
            description: "Late",
            parameters: Type.Object({}),
            execute: async (_args, _api, ctx) => {
              entered.resolve();
              await awaitWithContext(release.promise, ctx);
              return { output: [{ type: "text", text: "later committed result" }] };
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("late", {}, { id: "late-tool" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("later final"),
    ]);
    const submission = await f.root.submit({ type: "input", content: "late" }, context);
    await entered.promise;
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    expect(f.backend.observations.filter((span) => span.type === "tool" || span.type === "generation")).toHaveLength(0);
    release.resolve();
    await submission.wait(context);
    await settledTrace(f.backend);
    const tool = f.backend.observations.find((span) => span.type === "tool");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("Missing tool");
    expect(metadata(tool)["pi.durable.start_not_observed"]).toBe(true);
    expect(JSON.stringify(output(tool))).toContain("later committed result");
    expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(1);
    await tracing.dispose();
  });

  it("correlates steered submissions independently while one run stays open across its tool round", async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    f.registry.install(
      defineExtension({
        name: "round",
        tools: [
          defineTool({
            name: "round",
            description: "Hold round",
            parameters: Type.Object({}),
            execute: async (_args, _api, ctx) => {
              entered.resolve();
              await awaitWithContext(release.promise, ctx);
              return { output: [{ type: "text", text: "complete tool result" }] };
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage([fauxText("not final"), fauxToolCall("round", {}, { id: "steer-tool" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("shared final answer"),
    ]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
      submissionCorrelation: (record) => ({
        requestId: record.requestId,
        userId: `user-${record.requestId}`,
        applicationId: `app-${record.requestId}`,
      }),
    });
    const first = await f.root.submit({ type: "input", content: "first", requestId: "first" }, context);
    await entered.promise;
    expect((await first.status(context)).status).toBe("placed");
    expect(
      f.backend.observations.filter((span) => span.name === "pi.durable.submission").every((span) => !span.ended),
    ).toBe(true);
    const steer = await f.root.submit(
      { type: "input", content: "steer", requestId: "steer", whenBusy: "steer" },
      context,
    );
    release.resolve();
    await Promise.all([first.wait(context), steer.wait(context)]);
    await settledTrace(f.backend, 2);
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.run")).toHaveLength(1);
    const requests = f.backend.observations.filter((span) => span.name === "pi.durable.submission");
    expect(requests.map((span) => metadata(span)["pi.user.id"]).sort()).toEqual(["user-first", "user-steer"]);
    expect(requests.every((span) => JSON.stringify(output(span)).includes("shared final answer"))).toBe(true);
    expect(
      f.backend.observations
        .filter((span) => span.type === "generation")
        .every((span) => metadata(span)["pi.user.id"] === "user-first"),
    ).toBe(true);
    await tracing.dispose();
  });

  it("suppresses simultaneous duplicate attachment and preserves the original observer", async () => {
    const f = await fixture();
    const original = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    const duplicate = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    expect(duplicate.active).toBe(false);
    expect(original.active).toBe(true);
    expect(f.backend.observations).toHaveLength(1);
    f.faux.setResponses([fauxAssistantMessage("one trace")]);
    const submission = await f.root.submit({ type: "input", content: "one" }, context);
    await submission.wait(context);
    await settledTrace(f.backend);
    await original.dispose();
  });

  it("late attachment observes a snapshot, not replay, and reads terminal submissions without scheduling", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage("historical answer")]);
    const submission = await f.root.submit({ type: "input", content: "historical input" }, context);
    await submission.wait(context);
    const count = f.faux.state.callCount;
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    expect(f.backend.observations.map((span) => span.name)).toEqual(["pi.durable.conversation"]);
    await tracing.observeSubmission(submission.id, { requestId: "host-late-request" });
    expect(f.faux.state.callCount).toBe(count);
    expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(0);
    const span = submissionSpan(f.backend);
    expect(metadata(span)["pi.durable.snapshot_observation"]).toBe(true);
    expect(JSON.stringify(output(span))).toContain("historical answer");
    await tracing.dispose();
  });

  it("resynchronizes after actual watch overflow, preserving known submission identity and marking missed history", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage("complete answer")]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    // Queue real commits ahead of the observer's read-only transaction. The Session stays real,
    // while the serialized event consumer accumulates more than its 100-frame capacity.
    const submitting = f.root.submit({ type: "input", content: "overflow input" }, context);
    const writes = Array.from({ length: 150 }, (_, i) =>
      f.root.commit((tx) => tx.appendEntry(f.root.id, { kind: "app.note", data: i }), context),
    );
    const submission = await submitting;
    await Promise.all(writes);
    await submission.wait(context);
    await vi.waitFor(() => expect(metadata(f.backend.observations[0])["pi.durable.resync_count"]).toBeGreaterThan(0));
    await settledTrace(f.backend);
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission")).toHaveLength(1);
    expect(JSON.stringify(output(submissionSpan(f.backend)))).toContain("complete answer");
    expect(metadata(f.backend.observations[0])["pi.durable.history_complete"]).toBe(false);
    await tracing.dispose();
  });

  it("records real provider and tool failures without exporting diagnostic secrets", async () => {
    const f = await fixture();
    f.registry.install(
      defineExtension({
        name: "fail",
        tools: [
          defineTool({
            name: "fail",
            description: "Fail",
            parameters: Type.Object({}),
            execute: async () => {
              throw new Error("PRIVATE-TOOL-ERROR-credentials-secret");
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fail", {}, { id: "fail-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Authorization: provider-secret" }),
    ]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    const record = await (await f.root.submit({ type: "input", content: "fail" }, context)).wait(context);
    expect(record.status).toBe("unanswered");
    await settledTrace(f.backend);
    expect(
      f.backend.observations
        .filter((span) => span.type === "tool")[0]
        .updates.some((update) => update.level === "ERROR"),
    ).toBe(true);
    expect(
      f.backend.observations
        .filter((span) => span.type === "generation")
        .some((span) => span.updates.some((update) => update.level === "ERROR")),
    ).toBe(true);
    expect(JSON.stringify(f.backend.observations)).not.toContain("provider-secret");
    expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE-TOOL-ERROR-credentials-secret");
    const transcript = await f.root.context(context);
    expect(JSON.stringify(transcript.entries.flatMap((entry) => entry.model ?? []))).toContain(
      "PRIVATE-TOOL-ERROR-credentials-secret",
    );
    await tracing.dispose();
  });

  it("observation cancellation detaches without aborting work; explicit host abort is independently observed", async () => {
    const f = await fixture();
    const observation = withCancel(context);
    const entered = deferred();
    const release = deferred();
    f.faux.setResponses([
      async () => {
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("still executes");
      },
    ]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context: observation.context,
    });
    const submission = await f.root.submit({ type: "input", content: "continue" }, context);
    await entered.promise;
    observation.cancel();
    await tracing.closed;
    expect((await submission.status(context)).status).toBe("placed");
    release.resolve();
    expect((await submission.wait(context)).status).toBe("done");
    const next = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    const toolEntered = deferred();
    f.registry.install(
      defineExtension({
        name: "wait",
        tools: [
          defineTool({
            name: "wait",
            description: "Wait",
            parameters: Type.Object({}),
            execute: async (_args, _api, ctx) => {
              toolEntered.resolve();
              await awaitWithContext(new Promise<void>(() => undefined), ctx);
              return {};
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wait", {}, { id: "abort-call" }), { stopReason: "toolUse" }),
    ]);
    const aborted = await f.root.submit({ type: "input", content: "abort" }, context);
    await toolEntered.promise;
    await f.root.abort(context);
    expect((await aborted.status(context)).status).toBe("unanswered");
    await settledTrace(f.backend, 2);
    await next.dispose();
  });

  it("disposes in-flight tool spans as observation-interrupted without cancelling execution", async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    f.registry.install(
      defineExtension({
        name: "dispose-tool",
        tools: [
          defineTool({
            name: "dispose-tool",
            description: "Hold",
            parameters: Type.Object({}),
            execute: async (_args, _api, ctx) => {
              entered.resolve();
              await awaitWithContext(release.promise, ctx);
              return { output: [{ type: "text", text: "full result after detach" }] };
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dispose-tool", {}, { id: "dispose-tool-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("full answer after detach"),
    ]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    const submission = await f.root.submit({ type: "input", content: "dispose observer" }, context);
    await entered.promise;
    await vi.waitFor(() => expect(f.backend.observations.filter((span) => span.type === "tool")).toHaveLength(1));
    await tracing.dispose();
    expect((await submission.status(context)).status).toBe("placed");
    const tool = f.backend.observations.find((span) => span.type === "tool");
    if (!tool) throw new Error("Missing tool");
    expect(tool.endCalls).toBe(1);
    expect(metadata(tool)["pi.durable.outcome"]).toBe("observation_interrupted");
    expect(tool.updates.some((update) => update.level === "WARNING")).toBe(true);
    const spans = f.backend.observations.length;
    release.resolve();
    expect((await submission.wait(context)).status).toBe("done");
    expect(f.backend.observations).toHaveLength(spans);
    expect(JSON.stringify(f.backend.observations)).not.toContain("full result after detach");
    const transcript = await f.root.context(context);
    expect(JSON.stringify(transcript.entries)).toContain("full result after detach");
  });

  it("handles shutdown reentered by trace-id and exporter-error callbacks during partial initialization", async () => {
    const f = await fixture();
    let shutdown: Promise<void> | undefined;
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
      onTraceId: () => {
        shutdown = f.runtime.shutdown();
      },
    });
    await shutdown;
    expect(tracing.active).toBe(false);
    expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
    expect(f.backend.shutdowns).toBe(1);
    const next = await fixture();
    const realStart = next.backend.start.bind(next.backend);
    next.backend.start = (...args) => {
      const span = realStart(...args);
      span.update = () => {
        throw new Error("exporter unavailable");
      };
      return span;
    };
    let errorShutdown: Promise<void> | undefined;
    const failed = await createPiLangfuseDurableConversation(next.runtime, {
      harness: next.harness,
      conversationId: next.root.id,
      context,
      onError: () => {
        errorShutdown = next.runtime.shutdown();
      },
    });
    await errorShutdown;
    await failed.closed;
    expect(next.backend.shutdowns).toBe(1);
    expect(next.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
  });

  it("contains exporter flush/shutdown rejection at the administrative boundary and still detaches controllers", async () => {
    const f = await fixture();
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    f.backend.forceFlush = async () => {
      throw new Error("export unavailable");
    };
    f.backend.shutdown = async () => {
      f.backend.shutdowns += 1;
      throw new Error("shutdown unavailable");
    };
    f.faux.setResponses([fauxAssistantMessage("caller succeeds")]);
    expect((await (await f.root.submit({ type: "input", content: "succeed" }, context)).wait(context)).status).toBe(
      "done",
    );
    await expect(f.runtime.flush()).rejects.toThrow("export unavailable");
    await expect(f.runtime.shutdown()).rejects.toThrow("Langfuse runtime shutdown failed");
    await tracing.closed;
    await tracing.dispose();
    await expect(f.runtime.shutdown()).rejects.toThrow("Langfuse runtime shutdown failed");
    expect(f.runtime.closed).toBe(true);
    expect(f.backend.shutdowns).toBe(1);
    expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
  });

  it("attaching after paused reopen does not start model or tool execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-langfuse-paused-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const entered = deferred();
    let toolCalls = 0;
    registry.install(
      defineExtension({
        name: "paused",
        tools: [
          defineTool({
            name: "paused",
            description: "Pause",
            replay: "safe",
            parameters: Type.Object({}),
            execute: async (_args, _api, ctx) => {
              toolCalls += 1;
              entered.resolve();
              await awaitWithContext(new Promise<void>(() => undefined), ctx);
              return {};
            },
          }),
        ],
      }),
    );
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("paused", {}, { id: "paused-call" }), { stopReason: "toolUse" }),
    ]);
    const first = await Harness.open(await openNodeJsonlStorage(directory, context), { models, registry }, context);
    const root = await first.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    const submission = await root.submit({ type: "input", content: "pause" }, context);
    await entered.promise;
    await first.close(context);
    const reopened = await Harness.open(await openNodeJsonlStorage(directory, context), { models, registry }, context);
    cleanup.push(() => reopened.close(context));
    expect((await reopened.inspect(context)).scheduling).toBe("paused");
    const modelCalls = faux.state.callCount;
    const backend = new FakeBackend();
    const runtime = createLangfuseRuntimeFromBackend(backend);
    cleanup.push(() => runtime.shutdown());
    const tracing = await createPiLangfuseDurableConversation(runtime, {
      harness: reopened,
      conversationId: root.id,
      context,
    });
    await tracing.observeSubmission(submission.id);
    expect((await reopened.inspect(context)).scheduling).toBe("paused");
    expect(toolCalls).toBe(1);
    expect(faux.state.callCount).toBe(modelCalls);
    expect(backend.observations.filter((span) => span.type === "generation" || span.type === "tool")).toHaveLength(0);
    await tracing.dispose();
    expect((await reopened.inspect(context)).scheduling).toBe("paused");
    expect(backend.observations.every((span) => span.endCalls === 1)).toBe(true);
  });

  it("cancels pending observer initialization when the runtime shuts down", async () => {
    const entered = deferred();
    const release = deferred();
    class SlowStorage extends MemoryStorage {
      block = false;
      override async scanTasks(...args: Parameters<MemoryStorage["scanTasks"]>) {
        if (this.block) {
          this.block = false;
          entered.resolve();
          await awaitWithContext(release.promise, args[3]);
        }
        return super.scanTasks(...args);
      }
    }
    const storage = new SlowStorage();
    const f = await fixture(new FakeBackend(), storage);
    storage.block = true;
    const attaching = createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    await entered.promise;
    await f.runtime.shutdown();
    const tracing = await attaching;
    expect(tracing.active).toBe(false);
    await tracing.closed;
    await tracing.dispose();
    expect(f.backend.shutdowns).toBe(1);
    expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
    const before = f.backend.observations.length;
    await f.root.commit((tx) => tx.appendEntry(f.root.id, { kind: "app.after" }), context);
    expect(f.backend.observations).toHaveLength(before);
  });

  it("fails open after observer initialization/read failures, backend start failure and Harness closure", async () => {
    const f = await fixture();
    const cancelled = withCancel(context);
    cancelled.cancel();
    const inactive = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context: cancelled.context,
    });
    expect(inactive.active).toBe(false);
    await inactive.closed;
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    const original = f.harness.submission.bind(f.harness);
    f.harness.submission = async () => {
      throw new Error("read secret");
    };
    // Reads are fail-open too; a host-side error must not become a caller execution error.
    const submission = await f.root.submit({ type: "write", entry: { kind: "app.note" } }, context);
    await tracing.observeSubmission(submission.id);
    f.harness.submission = original;
    await f.harness.close(context);
    await tracing.closed;
    expect(tracing.active).toBe(false);
    const next = await fixture();
    next.backend.start = () => {
      throw new Error("start secret");
    };
    const noExport = await createPiLangfuseDurableConversation(next.runtime, {
      harness: next.harness,
      conversationId: next.root.id,
      context,
    });
    next.faux.setResponses([fauxAssistantMessage("not blocked")]);
    expect((await (await next.root.submit({ type: "input", content: "works" }, context)).wait(context)).status).toBe(
      "done",
    );
    await noExport.dispose();
  });

  it("is fail-open for exporter/callback failures and idempotent shared-runtime shutdown", async () => {
    const backend = new FakeBackend();
    const f = await fixture(backend);
    const errors: string[] = [];
    const realStart = backend.start.bind(backend);
    backend.start = (...args) => {
      const span = realStart(...args);
      span.update = () => {
        throw new Error("exporter secret");
      };
      span.end = () => {
        throw new Error("exporter secret");
      };
      return span;
    };
    f.faux.setResponses([fauxAssistantMessage("success")]);
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
      onError: (stage) => {
        errors.push(stage);
      },
      onTraceId: async () => {
        throw new Error("callback");
      },
    });
    expect((await (await f.root.submit({ type: "input", content: "success" }, context)).wait(context)).status).toBe(
      "done",
    );
    await f.runtime.shutdown();
    await f.runtime.shutdown();
    await tracing.dispose();
    expect(tracing.active).toBe(false);
    expect(backend.shutdowns).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join()).not.toContain("secret");
  });
});
