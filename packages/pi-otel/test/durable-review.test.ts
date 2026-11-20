import { awaitWithContext, BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, LiveDoc, type SubmissionId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createPiLangfuseDurableConversation } from "../src/durable.js";
import { DurableRecorder } from "../src/durable-recorder.js";
import { durableSnapshot } from "../src/durable-state.js";
import { deferred, fixture, metadata, named, recordedWork } from "./durable-support.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("continues a stored publication after one submission entry read rejects", async () => {
  const f = await recordedWork(cleanup);
  const errors: string[] = [];
  const recorder = new DurableRecorder(f.backend, {
    conversationId: f.root.id,
    onError: (stage) => {
      errors.push(stage);
    },
  });
  recorder.snapshot(f.snapshot, true);
  let failed = false;
  for (const commit of f.commits)
    await recorder.commit(commit, (id) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("PRIVATE-STORAGE-ERROR"));
      }
      return f.root.commit((tx) => tx.entry(id), context);
    });
  expect(errors).toEqual(["observer delivery"]);
  expect(named(f.backend, "pi.durable.run").ended).toBe(true);
  expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(2);
  expect(named(f.backend, "pi.durable.tool").ended).toBe(true);
  expect(metadata(named(f.backend, "pi.durable.submission"))["pi.durable.submission_status"]).toBe("done");
  recorder.dispose();
});

it("does not assign a newer follow-up status to an older snapshot run", async () => {
  const f = await fixture(cleanup);
  const firstEntered = deferred();
  const firstRelease = deferred();
  const secondEntered = deferred();
  const secondRelease = deferred();
  cleanup.push(async () => {
    firstRelease.resolve();
    secondRelease.resolve();
  });
  f.faux.setResponses([
    async () => {
      firstEntered.resolve();
      await firstRelease.promise;
      return fauxAssistantMessage("first answer");
    },
    async () => {
      secondEntered.resolve();
      await secondRelease.promise;
      return fauxAssistantMessage("second answer");
    },
  ]);
  const first = await f.root.submit({ type: "input", content: "first" }, context);
  await firstEntered.promise;
  const second = await f.root.submit({ type: "input", content: "follow-up" }, context);
  const view = await f.harness.observeConversation(f.root.id, { advance() {}, end() {} }, context);
  const snapshot = durableSnapshot(view.value);
  view.detach();
  firstRelease.resolve();
  await first.wait(context);
  await secondEntered.promise;
  const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id });
  recorder.snapshot(snapshot, true);
  await recorder.submission(
    await second.status(context),
    (id) => f.root.commit((tx) => tx.entry(id), context),
    undefined,
    true,
  );
  expect(metadata(named(f.backend, "pi.durable.run"))["pi.durable.inputs"]).toEqual([first.id]);
  recorder.dispose();
  secondRelease.resolve();
  await second.wait(context);
});

it("publishes steered membership from the authoritative public snapshot without creating another run", async () => {
  const f = await fixture(cleanup);
  const toolEntered = deferred();
  const toolRelease = deferred();
  const generationEntered = deferred();
  const generationRelease = deferred();
  cleanup.push(async () => {
    toolRelease.resolve();
    generationRelease.resolve();
  });
  f.registry.install(
    defineExtension({
      name: "hold",
      tools: [
        defineTool({
          name: "hold",
          description: "Hold",
          parameters: Type.Object({}),
          execute: async (_args, _api, ctx) => {
            toolEntered.resolve();
            await awaitWithContext(toolRelease.promise, ctx);
            return { output: [fauxText("result")] };
          },
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}, { id: "hold-call" }), { stopReason: "toolUse" }),
    async () => {
      generationEntered.resolve();
      await generationRelease.promise;
      return fauxAssistantMessage("answer");
    },
  ]);
  const first = await f.root.submit({ type: "input", content: "first" }, context);
  await toolEntered.promise;
  const initial = await f.harness.observeConversation(f.root.id, { advance() {}, end() {} }, context);
  const before = durableSnapshot(initial.value);
  initial.detach();
  const steer = await f.root.submit({ type: "input", content: "steer", whenBusy: "steer" }, context);
  toolRelease.resolve();
  await generationEntered.promise;
  const expanded = await f.harness.observeConversation(f.root.id, { advance() {}, end() {} }, context);
  const after = durableSnapshot(expanded.value);
  expanded.detach();
  expect(before.live.run?.inputs).toEqual([first.id]);
  expect(after.live.run?.inputs).toEqual([first.id, steer.id]);
  const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id });
  recorder.snapshot(before, true);
  recorder.snapshot(after);
  expect(metadata(named(f.backend, "pi.durable.run"))["pi.durable.inputs"]).toEqual([first.id, steer.id]);
  expect(f.backend.observations.filter((span) => span.name === "pi.durable.run")).toHaveLength(1);
  recorder.dispose();
  generationRelease.resolve();
  await Promise.all([first.wait(context), steer.wait(context)]);
});

it.each(["generation", "tool"] as const)(
  "propagates late primary correlation only to active %s descendants",
  async (phase) => {
    const f = await recordedWork(cleanup);
    const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id, userId: "conversation-user" });
    recorder.snapshot(f.snapshot, true);
    const placed = f.commits.flatMap((commit) => commit.submissions).find((record) => record.status === "placed");
    if (!placed) throw new Error("No placed record");
    for (const commit of f.commits) {
      await recorder.commit(commit, (id) => f.root.commit((tx) => tx.entry(id), context));
      if (commit.tasks.some((task) => (phase === "generation" ? task.phase === "request" : task.phase === "execute")))
        break;
    }
    const active = named(f.backend, phase === "generation" ? "pi.durable.llm" : "pi.durable.tool");
    expect(active.ended).toBe(false);
    const ended = f.backend.observations.filter((span) => span.ended);
    const priorUpdates = ended.map((span) => span.updates.length);
    await recorder.submission(
      placed,
      (id) => f.root.commit((tx) => tx.entry(id), context),
      {
        requestId: "late-request",
        userId: "late-user",
        applicationId: "late-app",
      },
      true,
    );
    for (const span of [active, named(f.backend, "pi.durable.run"), named(f.backend, "pi.durable.submission")]) {
      expect(metadata(span)).toMatchObject({
        "pi.request.id": "late-request",
        "pi.user.id": "late-user",
        "pi.application.id": "late-app",
      });
      expect(span.attributes.userId).toBe("conversation-user");
    }
    expect(ended.map((span) => span.updates.length)).toEqual(priorUpdates);
    recorder.dispose();
  },
);

it("keeps only unsettled IDs pending and never rereads terminal duplicates", async () => {
  const f = await recordedWork(cleanup);
  const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id });
  const records = f.commits.flatMap((commit) => commit.submissions);
  for (const record of records) {
    await recorder.submission(record, (id) => f.root.commit((tx) => tx.entry(id), context));
    expect(recorder.submissionIds).toEqual(record.status === "placed" ? [f.submission.id] : []);
  }
  const count = f.backend.observations.length;
  for (const record of records)
    await recorder.submission(record, async () => {
      throw new Error("terminal reread");
    });
  expect(f.backend.observations).toHaveLength(count);
  expect(recorder.submissionIds).toEqual([]);
  recorder.dispose();
});

it("does not reread terminal history during actual owned-queue overflow", async () => {
  const f = await fixture(cleanup);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("answer")));
  const terminalIds: SubmissionId[] = [];
  for (let index = 0; index < 3; index++) {
    const submission = await f.root.submit({ type: "input", content: `history-${index}` }, context);
    await submission.wait(context);
    terminalIds.push(submission.id);
    await vi.waitFor(() =>
      expect(f.backend.observations.filter((span) => span.name === "pi.durable.submission" && span.ended)).toHaveLength(
        index + 1,
      ),
    );
  }
  const lookup = vi.spyOn(f.harness, "submission");
  const submitting = f.root.submit({ type: "input", content: "pending" }, context);
  const writes = Array.from({ length: 150 }, (_, index) =>
    f.root.commit((tx) => tx.appendEntry(f.root.id, { kind: "app.note", data: index }), context),
  );
  const pending = await submitting;
  await Promise.all(writes);
  await pending.wait(context);
  await vi.waitFor(() =>
    expect(metadata(named(f.backend, "pi.durable.conversation"))["pi.durable.resync_count"]).toBeGreaterThan(0),
  );
  expect(lookup.mock.calls.some(([id]) => terminalIds.includes(id))).toBe(false);
  await tracing.dispose();
});

it.each(["pi.durable.conversation", "pi.durable.run"])(
  "suppresses orphan children after %s start fails",
  async (failedName) => {
    const f = await recordedWork(cleanup);
    const start = f.backend.start.bind(f.backend);
    let failed = false;
    const calls: string[] = [];
    f.backend.start = (...args) => {
      calls.push(args[0]);
      if (!failed && args[0] === failedName) {
        failed = true;
        throw new Error("transient parent failure");
      }
      return start(...args);
    };
    const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id });
    for (const commit of f.commits) await recorder.commit(commit, (id) => f.root.commit((tx) => tx.entry(id), context));
    expect(failed).toBe(true);
    expect(calls.filter((name) => name === "pi.durable.llm" || name === "pi.durable.tool")).toEqual([]);
    expect(
      f.backend.observations.every((span) => span.name === "pi.durable.conversation" || span.parent !== undefined),
    ).toBe(true);
    recorder.dispose();
  },
);

it.each(["canceled", "invalid", "storage"])("never acquires a trace for %s attachment failure", async (failure) => {
  const f = await fixture(cleanup);
  const canceled = withCancel(context);
  if (failure === "canceled") canceled.cancel();
  if (failure === "storage")
    f.storage.scanEntries = async () => {
      throw new Error("unavailable");
    };
  const onTraceId = vi.fn();
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: failure === "invalid" ? ((f.root.id + 1000) as typeof f.root.id) : f.root.id,
    context: canceled.context,
    onTraceId,
  });
  expect(tracing.active).toBe(false);
  await tracing.closed;
  expect(f.backend.observations).toEqual([]);
  expect(onTraceId).not.toHaveBeenCalled();
});

it("uses committed repaired arguments, not the model call or deferred live-slot progress", async () => {
  const f = await fixture(cleanup);
  let executed = "";
  f.registry.install(
    defineExtension({
      name: "repair",
      tools: [
        defineTool({
          name: "repair",
          description: "Repair",
          parameters: Type.Object({ value: Type.String() }),
          execute: async ({ value }) => {
            executed = value;
            return { output: [fauxText(value)] };
          },
        }),
      ],
      hooks: [{ task: "pi.tool", handlers: { beforeTool: () => ({ arguments: { value: "actual repaired input" } }) } }],
    }),
  );
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("repair", { value: "original model input" }, { id: "repaired" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("answer"),
  ]);
  await (await f.root.submit({ type: "input", content: "go" }, context)).wait(context);
  await vi.waitFor(() => expect(named(f.backend, "pi.durable.tool").ended).toBe(true));
  expect(executed).toBe("actual repaired input");
  expect(named(f.backend, "pi.durable.tool").attributes.input).toEqual({ value: "actual repaired input" });
  await tracing.dispose();
});

it("never exports a deferred unstored partial shown by public conversation observers", async () => {
  const f = await fixture(cleanup);
  const entered = deferred();
  const release = deferred();
  const sawPartial = deferred();
  cleanup.push(async () => release.resolve());
  f.faux.setResponses([
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("committed final");
    },
  ]);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
  });
  const view = await f.harness.observeConversation(
    f.root.id,
    {
      advance(call) {
        if (
          call.kind === "value" &&
          JSON.stringify(call.value.docs[LiveDoc.definition.kind]).includes("PRIVATE-UNSTORED")
        )
          sawPartial.resolve();
      },
      end() {},
    },
    context,
  );
  const submission = await f.root.submit({ type: "input", content: "go" }, context);
  await entered.promise;
  const partial = fauxAssistantMessage("");
  await f.root.commit(
    async (tx) => {
      (await tx.doc(LiveDoc, f.root.id)).generation = {
        attempt: 0,
        message: {
          role: "assistant",
          api: partial.api,
          provider: partial.provider,
          model: partial.model,
          usage: partial.usage,
          stopReason: partial.stopReason,
          timestamp: partial.timestamp,
          content: [{ type: "text", text: "PRIVATE-UNSTORED" }],
        },
      };
    },
    context,
    { persistence: { kind: "deferred", withinMs: Infinity } },
  );
  await sawPartial.promise;
  expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE-UNSTORED");
  release.resolve();
  await submission.wait(context);
  await vi.waitFor(() => expect(named(f.backend, "pi.durable.submission").ended).toBe(true));
  expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE-UNSTORED");
  expect(JSON.stringify(f.backend.observations)).toContain("committed final");
  view.detach();
  await tracing.dispose();
});

it("joins a canceled status reconciliation before closed resolves, without leaking queued work", async () => {
  const f = await fixture(cleanup);
  f.faux.setResponses([fauxAssistantMessage("old answer")]);
  const historical = await f.root.submit({ type: "input", content: "old" }, context);
  await historical.wait(context);
  const observation = withCancel(context);
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context: observation.context,
  });
  const entered = deferred();
  let readJoined = false;
  vi.spyOn(f.harness, "submission").mockImplementationOnce(async (_id, ctx) => {
    entered.resolve();
    try {
      await awaitWithContext(new Promise<void>(() => undefined), ctx);
    } finally {
      readJoined = true;
    }
    return undefined;
  });
  const pending = tracing.observeSubmission(historical.id);
  await entered.promise;
  const next = tracing.observeSubmission(historical.id);
  observation.cancel();
  await tracing.closed;
  await Promise.all([pending, next]);
  expect(readJoined).toBe(true);
  expect(f.backend.observations.every((span) => span.endCalls === 1)).toBe(true);
  expect(f.backend.observations).toHaveLength(1);
});
