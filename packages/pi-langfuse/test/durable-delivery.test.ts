import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, MemoryStorage, type Submission } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createPiLangfuseDurableConversation } from "../src/durable.js";
import { deferred, fixture, metadata, named } from "./durable-support.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("retains an explicit terminal-ID reconciliation across real source overflow behind a stalled read", async () => {
  const f = await fixture(cleanup);
  f.faux.setResponses([
    fauxAssistantMessage("first historical answer"),
    fauxAssistantMessage("second historical answer"),
  ]);
  const first = await f.root.submit({ type: "input", content: "first historical input" }, context);
  await first.wait(context);
  const second = await f.root.submit({ type: "input", content: "second historical input" }, context);
  await second.wait(context);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  const entered = deferred();
  const release = deferred();
  cleanup.push(async () => release.resolve());
  const lookup = f.harness.submission.bind(f.harness);
  vi.spyOn(f.harness, "submission").mockImplementationOnce(async (id, ctx) => {
    entered.resolve();
    await awaitWithContext(release.promise, ctx);
    return lookup(id, ctx);
  });
  const readingFirst = tracing.observeSubmission(first.id);
  await entered.promise;
  let secondDone = false;
  const readingSecond = tracing.observeSubmission(second.id, { requestId: "explicit-late" }).then(() => {
    secondDone = true;
  });
  await Promise.all(
    Array.from({ length: 150 }, (_, index) =>
      f.root.commit((tx) => tx.appendEntry(f.root.id, { kind: "host.note", data: index }), context),
    ),
  );
  expect(secondDone).toBe(false);
  release.resolve();
  await Promise.all([readingFirst, readingSecond]);
  await vi.waitFor(() =>
    expect(metadata(named(f.backend, "pi.durable.conversation"))["pi.durable.resync_count"]).toBeGreaterThan(0),
  );
  const summary = f.backend.observations.find((span) => metadata(span)["pi.durable.submission_id"] === second.id);
  expect(summary?.ended).toBe(true);
  expect(summary && metadata(summary)["pi.request.id"]).toBe("explicit-late");
  expect(JSON.stringify(summary?.updates)).toContain("second historical answer");
  expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission")).toHaveLength(2);
  expect(f.backend.observations.filter((span) => span.type === "generation" || span.type === "tool")).toHaveLength(0);
  await tracing.dispose();
});

it("retains intermediate committed rounds while a status reader is stalled, without waiting in source callbacks", async () => {
  const f = await fixture(cleanup);
  f.faux.setResponses([fauxAssistantMessage("historical answer")]);
  const historical = await f.root.submit({ type: "input", content: "historical" }, context);
  await historical.wait(context);
  let depth = 0;
  const callbackReturns: unknown[] = [];
  const outsideSource: boolean[] = [];
  const observe = f.harness.observeCommits.bind(f.harness);
  vi.spyOn(f.harness, "observeCommits").mockImplementation((observer) =>
    observe({
      advance(publication, ctx) {
        depth++;
        try {
          callbackReturns.push(observer.advance(publication, ctx));
        } finally {
          depth--;
        }
      },
      end: (end) => observer.end(end),
    }),
  );
  const start = f.backend.start.bind(f.backend);
  f.backend.start = (...args) => {
    outsideSource.push(depth === 0);
    return start(...args);
  };
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
    submissionCorrelation: (record) => {
      outsideSource.push(depth === 0);
      return { requestId: record.requestId };
    },
  });
  const entered = deferred();
  const release = deferred();
  cleanup.push(async () => release.resolve());
  const lookup = f.harness.submission.bind(f.harness);
  vi.spyOn(f.harness, "submission").mockImplementationOnce(async (id, ctx) => {
    outsideSource.push(depth === 0);
    entered.resolve();
    await awaitWithContext(release.promise, ctx);
    return lookup(id, ctx);
  });
  const stalled = tracing.observeSubmission(historical.id);
  await entered.promise;
  f.registry.install(
    defineExtension({
      name: "round",
      tools: [
        defineTool({
          name: "round",
          description: "Round",
          parameters: Type.Object({}),
          execute: async () => ({ output: [fauxText("tool output")] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("round", {}, { id: "round-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("new committed answer"),
  ]);
  const input = await f.root.submit({ type: "input", content: "new input", requestId: "new-request" }, context);
  expect((await input.wait(context)).status).toBe("done");
  await f.harness.waitForIdle(context);
  expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(0);
  release.resolve();
  await stalled;
  await vi.waitFor(() =>
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission" && span.ended)).toHaveLength(
      2,
    ),
  );
  expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(2);
  expect(f.backend.observations.filter((span) => span.type === "tool")).toHaveLength(1);
  expect(callbackReturns.length).toBeGreaterThan(0);
  expect(callbackReturns.every((value) => value === undefined)).toBe(true);
  expect(outsideSource.every(Boolean)).toBe(true);
  expect(metadata(named(f.backend, "pi.durable.conversation"))["pi.durable.resync_count"]).toBeUndefined();
  await tracing.dispose();
});

it("recovers after status and entry reads fail without poisoning later explicit reconciliation", async () => {
  const f = await fixture(cleanup);
  f.faux.setResponses([fauxAssistantMessage("committed answer")]);
  const input = await f.root.submit({ type: "input", content: "committed input" }, context);
  await input.wait(context);
  const errors: string[] = [];
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
    onError: (stage) => {
      errors.push(stage);
    },
  });
  const real = f.harness.submission.bind(f.harness);
  vi.spyOn(f.harness, "submission").mockImplementationOnce(async (id, ctx) => {
    const submission = await real(id, ctx);
    return (
      submission && {
        ...submission,
        status: async () => {
          throw new Error("PRIVATE-STATUS");
        },
      }
    );
  });
  await tracing.observeSubmission(input.id);
  vi.spyOn(f.harness, "commit").mockRejectedValueOnce(new Error("PRIVATE-ENTRY"));
  await tracing.observeSubmission(input.id);
  await tracing.observeSubmission(input.id);
  expect(errors).toEqual(["submission status read", "submission status read"]);
  expect(named(f.backend, "pi.durable.submission").ended).toBe(true);
  expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission")).toHaveLength(1);
  expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE");
  await tracing.dispose();
});

it("does not lose a new submission started reentrantly by trace-ID publication", async () => {
  const f = await fixture(cleanup);
  f.faux.setResponses([fauxAssistantMessage("new answer")]);
  let submitted: Promise<Submission> | undefined;
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
    onTraceId: () => {
      submitted = f.root.submit({ type: "input", content: "new input", requestId: "new-request" }, context);
    },
  });
  const submission = await submitted;
  expect((await submission?.wait(context))?.status).toBe("done");
  if (!submission) throw new Error("No submission");
  await tracing.observeSubmission(submission.id);
  expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(1);
  expect(metadata(named(f.backend, "pi.durable.run"))["pi.request.id"]).toBe("new-request");
  await tracing.dispose();
});

it("ends a retrying committed assistant exactly once before the next request attempt", async () => {
  const f = await fixture(cleanup, new MemoryStorage(), { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
  f.faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit PRIVATE-PROVIDER-ERROR" }),
    fauxAssistantMessage("recovered answer"),
  ]);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  const submission = await f.root.submit({ type: "input", content: "retry" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  await tracing.observeSubmission(submission.id);
  const generations = f.backend.observations.filter((span) => span.type === "generation");
  expect(generations).toHaveLength(2);
  expect(generations.every((span) => span.endCalls === 1)).toBe(true);
  expect(metadata(generations[0])["pi.durable.retry_attempt"]).toBe(1);
  expect(generations[0].updates.some((update) => update.level === "ERROR")).toBe(true);
  expect(generations[1].updates.some((update) => update.level === "DEFAULT")).toBe(true);
  expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE-PROVIDER-ERROR");
  await tracing.dispose();
});

it("observes a new request after overflow compaction even when its public attempt number is unchanged", async () => {
  const f = await fixture(cleanup, new MemoryStorage(), {
    compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 0 },
  });
  f.faux.setResponses([fauxAssistantMessage("historical answer")]);
  await (await f.root.submit({ type: "input", content: "historical input" }, context)).wait(context);
  const entered = deferred();
  const release = deferred();
  cleanup.push(async () => release.resolve());
  f.faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "context_length_exceeded PRIVATE-OVERFLOW" }),
    fauxAssistantMessage("compaction summary"),
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("recovered answer");
    },
  ]);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  const input = await f.root.submit({ type: "input", content: "new input" }, context);
  await entered.promise;
  await vi.waitFor(() => expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(2));
  expect(f.backend.observations.filter((span) => span.type === "generation")[1].ended).toBe(false);
  release.resolve();
  expect((await input.wait(context)).status).toBe("done");
  await tracing.observeSubmission(input.id);
  expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE-OVERFLOW");
  expect(JSON.stringify(f.backend.observations)).not.toContain("compaction summary");
  await tracing.dispose();
});
