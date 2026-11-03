import { awaitWithContext, BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  MemoryStorage,
  runEndTask,
  type Submission,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createPiLangfuseDurableConversation } from "../src/durable.js";
import { deferred, fixture, metadata, named } from "./durable-support.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("captures continue's authoritative answer without assuming it has a user entry", async () => {
  const f = await fixture(cleanup);
  f.registry.install(
    defineExtension({
      name: "continue",
      tools: [
        defineTool({
          name: "one",
          description: "One tool",
          parameters: Type.Object({}),
          execute: async () => ({ output: [fauxText("result")] }),
        }),
      ],
    }),
  );
  await f.root.configure({ maxTurns: 1 }, context);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("one", {}, { id: "one-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("continued answer"),
  ]);
  const first = await f.root.submit({ type: "input", content: "go" }, context);
  expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "turn_limit" });
  const continued = await f.root.submit({ type: "continue", requestId: "continued-request" }, context);
  expect(await continued.wait(context)).toMatchObject({ type: "continue", status: "done" });
  await tracing.observeSubmission(continued.id);
  const span = f.backend.observations.find((span) => metadata(span)["pi.durable.submission_id"] === continued.id);
  expect(span?.ended).toBe(true);
  expect(span?.updates.some((update) => JSON.stringify(update.output)?.includes("continued answer"))).toBe(true);
  expect(span?.updates.every((update) => update.input === undefined)).toBe(true);
  const calls = f.faux.state.callCount;
  const empty = await f.root.submit({ type: "continue" }, context);
  expect(await empty.wait(context)).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
  await tracing.observeSubmission(empty.id);
  expect(f.faux.state.callCount).toBe(calls);
  expect(f.backend.observations.filter((span) => span.name === "pi.durable.run")).toHaveLength(3);
  await tracing.dispose();
});

it("keeps one run open when afterRun settles its inputs to an empty list", async () => {
  const f = await fixture(cleanup);
  const entered = deferred();
  const release = deferred();
  cleanup.push(async () => release.resolve());
  const after = defineTask({
    name: "host.after",
    version: 1,
    initial: (_input: null) => ({ phase: "run" as const }),
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        entered.resolve();
        await awaitWithContext(release.promise, ctx);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
      },
    },
  });
  f.registry.install(
    defineExtension({
      name: "after",
      tasks: [after],
      hooks: [
        hook(GenerationTask, {
          afterRun: () => ({ tasks: [runEndTask(after, null)] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("next answer")]);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  const first = await f.root.submit({ type: "input", content: "first" }, context);
  expect((await first.wait(context)).status).toBe("done");
  await entered.promise;
  expect((await f.harness.snapshot(LiveDoc, f.root.id, context))?.run).toMatchObject({
    inputs: [],
    afterRun: expect.any(Object),
  });
  await vi.waitFor(() => expect(metadata(named(f.backend, "pi.durable.run"))["pi.durable.inputs"]).toEqual([]));
  expect(named(f.backend, "pi.durable.run").ended).toBe(false);
  expect(named(f.backend, "pi.durable.submission").ended).toBe(true);
  const next = await f.root.submit({ type: "input", content: "next" }, context);
  expect((await next.status(context)).status).toBe("queued");
  release.resolve();
  await next.wait(context);
  await f.harness.waitForIdle(context);
  await vi.waitFor(() =>
    expect(f.backend.observations.filter((span) => span.name === "pi.durable.run" && span.ended)).toHaveLength(2),
  );
  expect(
    f.backend.observations
      .filter((span) => span.name === "pi.durable.run")
      .map((span) => metadata(span)["pi.durable.primary_submission_id"]),
  ).toEqual([first.id, next.id]);
  await tracing.dispose();
});

it.each([
  "orphaned",
  "interrupted",
  "restart_limit",
  "nothing_to_answer",
  "turn_limit",
  "run_failed",
  "PRIVATE-UNKNOWN-REASON",
])("exports only a fixed allowlisted unanswered reason: %s", async (reason) => {
  const f = await fixture(cleanup);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  // A table-only commit has no conversation-view update. Stored observation must still deliver its settlement.
  const record = await f.harness.commit(
    (tx) =>
      tx.createSubmission({
        conversationId: f.root.id,
        type: "continue",
        status: "unanswered",
        reason,
        detail: "PRIVATE-DETAIL",
      }),
    context,
  );
  await vi.waitFor(() => expect(named(f.backend, "pi.durable.submission").ended).toBe(true));
  expect(metadata(named(f.backend, "pi.durable.submission"))["pi.durable.unanswered_reason"]).toBe(
    reason.startsWith("PRIVATE") ? "unknown" : reason,
  );
  expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE");
  await tracing.observeSubmission(record.id);
  expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission")).toHaveLength(1);
  await tracing.dispose();
});

it("uses the latest baseline when real callbacks precede the attaching promise's resolution", async () => {
  const f = await fixture(cleanup);
  const entered = deferred();
  const release = deferred();
  cleanup.push(async () => release.resolve());
  f.registry.install(
    defineExtension({
      name: "attach",
      tools: [
        defineTool({
          name: "attach",
          description: "Hold",
          parameters: Type.Object({}),
          execute: async (_args, _api, ctx) => {
            entered.resolve();
            await awaitWithContext(release.promise, ctx);
            return { output: [fauxText("later result")] };
          },
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("attach", {}, { id: "attach-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("later final"),
  ]);
  const observe = f.harness.observeConversation.bind(f.harness);
  let submission: Submission | undefined;
  vi.spyOn(f.harness, "observeConversation").mockImplementationOnce(async (...args) => {
    const observation = await observe(...args);
    submission = await f.root.submit({ type: "input", content: "during attachment" }, context);
    await entered.promise;
    return observation;
  });
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  expect(tracing.active).toBe(true);
  expect(f.backend.observations.filter((span) => span.type === "tool" || span.type === "generation")).toHaveLength(0);
  expect(metadata(named(f.backend, "pi.durable.run"))["pi.durable.snapshot_observation"]).toBe(true);
  release.resolve();
  await submission?.wait(context);
  await vi.waitFor(() => expect(named(f.backend, "pi.durable.submission").ended).toBe(true));
  expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(1);
  expect(metadata(named(f.backend, "pi.durable.tool"))["pi.durable.start_not_observed"]).toBe(true);
  await tracing.dispose();
});

it.each([
  ["task", false],
  ["task", true],
  ["document", false],
  ["document", true],
] as const)("joins an earlier %s-only store at the outer attachment barrier (cancel=%s)", async (kind, cancel) => {
  const entered = deferred();
  const release = deferred();
  const viewAttached = deferred();
  class GatedStorage extends MemoryStorage {
    block = false;
    override async commit(...args: Parameters<MemoryStorage["commit"]>) {
      if (this.block) {
        this.block = false;
        entered.resolve();
        await awaitWithContext(release.promise, args[2]);
      }
      return super.commit(...args);
    }
  }
  const storage = new GatedStorage();
  const f = await fixture(cleanup, storage);
  cleanup.push(async () => release.resolve());
  const task = defineTask({
    name: "host.pending",
    version: 1,
    initial: (_input: null) => ({ phase: "run" as const }),
    phases: { run: async () => {} },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  let writing: Promise<unknown> | undefined;
  const observe = f.harness.observeConversation.bind(f.harness);
  vi.spyOn(f.harness, "observeConversation").mockImplementationOnce(async (...args) => {
    const observation = await observe(...args);
    storage.block = true;
    writing =
      kind === "task"
        ? f.harness.commit(
            (tx) =>
              tx.createTask(task, null, {
                conversationId: f.root.id,
                ownership: { kind: "conversation" },
                background: true,
              }),
            context,
          )
        : f.harness.commit(async (tx) => {
            (await tx.doc(AgentDoc, f.root.id)).instructions = "baseline instructions";
          }, context);
    await entered.promise;
    viewAttached.resolve();
    return observation;
  });
  const observation = withCancel(context);
  let attached = false;
  const attaching = createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context: observation.context,
  }).then((controller) => {
    attached = true;
    return controller;
  });
  await viewAttached.promise;
  // Advance through the next public read admission; the pending store remains unrelated to its conversation table.
  await Promise.resolve();
  await Promise.resolve();
  expect(attached).toBe(false);
  expect(f.backend.observations).toEqual([]);
  if (cancel) observation.cancel();
  release.resolve();
  await writing;
  const tracing = await attaching;
  expect(tracing.active).toBe(!cancel);
  if (cancel) {
    await tracing.closed;
    expect(f.backend.observations).toEqual([]);
  } else {
    f.faux.setResponses([fauxAssistantMessage("new generation after readiness")]);
    const input = await f.root.submit({ type: "input", content: "new input" }, context);
    await input.wait(context);
    await tracing.observeSubmission(input.id);
    expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(1);
  }
  await tracing.dispose();
});
