import { awaitWithContext, BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type AgentEventStream,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type SubmissionId,
  type WatchEnd,
  watchEvents,
} from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { createLangfuseRuntimeFromBackend, createPiLangfuseDurableConversation } from "../src/durable.js";
import { DurableRecorder } from "../src/durable-recorder.js";
import { FakeBackend, type FakeObservation } from "./support.js";

vi.mock("@earendil-works/pi-durable", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-durable")>();
  return { ...original, watchEvents: vi.fn(original.watchEvents) };
});
const actual = await vi.importActual<typeof import("@earendil-works/pi-durable")>("@earendil-works/pi-durable");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.mocked(watchEvents).mockReset().mockImplementation(actual.watchEvents);
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function metadata(span: FakeObservation) {
  return Object.assign({}, span.attributes.metadata, ...span.updates.map((update) => update.metadata));
}
function named(backend: FakeBackend, name: string) {
  const span = backend.observations.find((candidate) => candidate.name === name);
  if (!span) throw new Error(`Missing ${name}`);
  return span;
}
async function fixture() {
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  cleanup.push(() => runtime.shutdown());
  return { faux, registry, storage, harness, root, backend, runtime };
}
async function recordedWork() {
  const f = await fixture();
  const stream = await actual.watchEvents(f.harness, f.root.id, context);
  const batches: Array<readonly AgentEvent[]> = [];
  stream.start(async (events) => {
    batches.push(events);
  });
  f.registry.install(
    defineExtension({
      name: "review",
      tools: [
        defineTool({
          name: "review",
          description: "Review tool",
          parameters: Type.Object({}),
          execute: async () => ({ output: [fauxText("tool result")] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("review", {}, { id: "review-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("final answer"),
  ]);
  const submission = await f.root.submit({ type: "input", content: "prompt", requestId: "primary" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  await vi.waitFor(() => expect(batches.flat().some((event) => event.type === "run_end")).toBe(true));
  const end = await stream.stop();
  return { ...f, batches, submission, snapshot: stream.snapshot, end };
}

it("continues a real committed batch after one submission entry read rejects", async () => {
  const f = await recordedWork();
  const closed = deferred<WatchEnd>();
  let deliver: Parameters<AgentEventStream["start"]>[0] | undefined;
  // Replay only public batches captured from real Harness work, not fabricated session events.
  vi.mocked(watchEvents).mockImplementationOnce(async () => ({
    snapshot: f.snapshot,
    closed: closed.promise,
    start: (listener) => {
      deliver = listener;
    },
    stop: async () => {
      closed.resolve(f.end);
      return f.end;
    },
  }));
  const errors: string[] = [];
  const tracing = await createPiLangfuseDurableConversation(f.runtime, {
    harness: f.harness,
    conversationId: f.root.id,
    context,
    onError: (stage) => {
      errors.push(stage);
    },
  });
  vi.spyOn(f.harness, "commit").mockRejectedValueOnce(new Error("private storage error"));
  const placement = f.batches.find((batch) =>
    batch.some((event) => event.type === "submission" && event.record.status === "placed"),
  );
  expect(placement?.some((event) => event.type === "run_start")).toBe(true);
  if (!deliver) throw new Error("Observer listener missing");
  for (const batch of f.batches) await deliver(batch, context);
  expect(errors).toEqual(["observer delivery"]);
  expect(named(f.backend, "pi.durable.run").ended).toBe(true);
  expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(2);
  expect(named(f.backend, "pi.durable.tool").ended).toBe(true);
  expect(metadata(named(f.backend, "pi.durable.submission"))["pi.durable.submission_status"]).toBe("done");
  await tracing.dispose();
});

it("does not assign a later follow-up's status placement to a stale snapshot run", async () => {
  const f = await fixture();
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
  expect((await second.status(context)).status).toBe("queued");
  const watched = await actual.watchEvents(f.harness, f.root.id, context);
  const snapshot = watched.snapshot;
  await watched.stop();
  expect(snapshot.run?.inputs).toEqual([first.id]);
  expect(snapshot.inbox.map((item) => item.id)).toEqual([second.id]);
  firstRelease.resolve();
  await first.wait(context);
  await secondEntered.promise;
  const laterPlacement = await second.status(context);
  expect(laterPlacement.status).toBe("placed");
  const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id });
  recorder.snapshot(snapshot, true);
  await recorder.submission(laterPlacement, (id) => f.root.commit((tx) => tx.entry(id), context), undefined, true);
  expect(metadata(named(f.backend, "pi.durable.run"))["pi.durable.inputs"]).toEqual([first.id]);
  recorder.dispose();
  secondRelease.resolve();
  await second.wait(context);
});

it("publishes same-run steered inputs from an authoritative public snapshot", async () => {
  const f = await fixture();
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
  const initial = await actual.watchEvents(f.harness, f.root.id, context);
  const before = initial.snapshot;
  await initial.stop();
  const steer = await f.root.submit({ type: "input", content: "steer", whenBusy: "steer" }, context);
  toolRelease.resolve();
  await generationEntered.promise;
  const expanded = await actual.watchEvents(f.harness, f.root.id, context);
  const after = expanded.snapshot;
  await expanded.stop();
  expect(before.run?.inputs).toEqual([first.id]);
  expect(after.run?.inputs).toEqual([first.id, steer.id]);
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
  "propagates late primary correlation to an active %s, not ended siblings",
  async (phase) => {
    const f = await recordedWork();
    const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id, userId: "conversation-user" });
    recorder.snapshot(f.snapshot, true);
    const placed = f.batches.flat().find((event) => event.type === "submission" && event.record.status === "placed");
    if (placed?.type !== "submission") throw new Error("No placed record");
    for (const event of f.batches.flat()) {
      if (event.type === "submission")
        await recorder.submission(event.record, (id) => f.root.commit((tx) => tx.entry(id), context));
      else recorder.event(event);
      if (
        (phase === "generation" && event.type === "message_start" && event.message.role === "assistant") ||
        (phase === "tool" && event.type === "tool_execution_start")
      )
        break;
    }
    const active = named(f.backend, phase === "generation" ? "pi.durable.llm" : "pi.durable.tool");
    expect(active.ended).toBe(false);
    const ended = f.backend.observations.filter((span) => span.ended);
    const priorUpdates = ended.map((span) => span.updates.length);
    await recorder.submission(
      placed.record,
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

it("only exposes unsettled IDs for reconciliation while keeping terminal deduplication", async () => {
  const f = await recordedWork();
  const recorder = new DurableRecorder(f.backend, { conversationId: f.root.id });
  const records = f.batches.flat().filter((event) => event.type === "submission");
  for (const event of records) {
    await recorder.submission(event.record, (id) => f.root.commit((tx) => tx.entry(id), context));
    expect(recorder.submissionIds).toEqual(event.record.status === "placed" ? [f.submission.id] : []);
  }
  expect(recorder.submissionIds).toEqual([]);
  const count = f.backend.observations.length;
  for (const event of records)
    await recorder.submission(event.record, async () => {
      throw new Error("terminal records should never reread entries");
    });
  expect(f.backend.observations).toHaveLength(count);
  const queued = await f.root.submit({ type: "write", entry: { kind: "app.note" } }, context);
  await recorder.submission(await queued.status(context), (id) => f.root.commit((tx) => tx.entry(id), context));
  expect(recorder.submissionIds).toEqual([]);
  recorder.dispose();
});

it("does not reread terminal history during real watch overflow", async () => {
  const f = await fixture();
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
  "suppresses orphan descendants after one %s start failure",
  async (failedName) => {
    const f = await recordedWork();
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
    for (const event of f.batches.flat()) {
      if (event.type === "submission")
        await recorder.submission(event.record, (id) => f.root.commit((tx) => tx.entry(id), context));
      else recorder.event(event);
    }
    expect(failed).toBe(true);
    expect(calls.filter((name) => name === "pi.durable.llm" || name === "pi.durable.tool")).toEqual([]);
    expect(
      f.backend.observations.every((span) => span.name === "pi.durable.conversation" || span.parent !== undefined),
    ).toBe(true);
    if (failedName === "pi.durable.run") {
      const stream = await actual.watchEvents(f.harness, f.root.id, context);
      const later: AgentEvent[] = [];
      stream.start(async (events) => {
        later.push(...events);
      });
      f.faux.setResponses([fauxAssistantMessage("later answer")]);
      await (await f.root.submit({ type: "input", content: "later" }, context)).wait(context);
      await vi.waitFor(() => expect(later.some((event) => event.type === "run_end")).toBe(true));
      await stream.stop();
      for (const event of later) {
        if (event.type === "submission")
          await recorder.submission(event.record, (id) => f.root.commit((tx) => tx.entry(id), context));
        else recorder.event(event);
      }
      expect(f.backend.observations.filter((span) => span.name === "pi.durable.run")).toHaveLength(1);
      expect(f.backend.observations.filter((span) => span.type === "generation")).toHaveLength(1);
      expect(
        f.backend.observations.every((span) => span.name === "pi.durable.conversation" || span.parent !== undefined),
      ).toBe(true);
    }
    recorder.dispose();
  },
);

it.each(["canceled", "invalid", "storage"])(
  "does not acquire a trace or notify its ID for %s attachment failure",
  async (failure) => {
    const f = await fixture();
    const canceled = withCancel(context);
    if (failure === "canceled") canceled.cancel();
    if (failure === "storage")
      f.storage.scanTasks = async () => {
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
  },
);
