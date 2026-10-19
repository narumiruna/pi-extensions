import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  Type,
} from "@earendil-works/pi-ai";
import {
  CompactionTask,
  type Conversation,
  ConversationBusy,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  hook,
  LiveDoc,
  MemoryStorage,
  type Submission,
  type SubmissionId,
  SystemEntry,
  section,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { required } from "./durable-test-values.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const Workflow = defineDoc<{
  owner: number;
  revision: number;
  mode: string;
  phase: string;
  request: string;
  plan: string;
  submissionId?: number;
}>({
  kind: "test.plan-mode.release-handoff",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({
    owner: 0,
    revision: 1,
    mode: "plan",
    phase: "planning",
    request: "kickoff:1:1",
    plan: "EXACT APPROVED PLAN",
  }),
});
const modeSection = section(
  "plan_mode",
  async (input, ctx) =>
    (await input.read.snapshot(Workflow, input.conversationId, ctx))?.mode === "normal"
      ? "NORMAL-CONTRACT"
      : "PLAN-CONTRACT",
  { tag: false },
);

it("a background handoff rechecks idle, keeps competing inputs restrictive, and delivers one exact kickoff", async () => {
  const idleSeen = barrier();
  const releaseGap = barrier();
  const busySeen = barrier();
  const busyRequest = barrier();
  const releaseBusy = barrier();
  let effects = 0;
  let denied = 0;
  let paused = false;
  const write = defineTool({
    name: "write",
    description: "Synthetic effect counter",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const allowed = await api.commit(async (tx) => {
        const workflow = await tx.doc(Workflow, api.conversationId);
        const receipt = await tx.submissionByRequest(api.conversationId, workflow.request);
        const live = await tx.doc(LiveDoc, api.conversationId);
        return (
          workflow.owner === api.conversationId &&
          workflow.revision === 1 &&
          workflow.phase !== "planning" &&
          receipt !== undefined &&
          live.run?.inputs.includes(receipt.id) === true
        );
      }, ctx);
      if (!allowed) {
        denied++;
        throw new Error("No approval for current run");
      }
      effects++;
      return {};
    },
  });
  const Handoff = defineTask<Record<string, never>, { phase: "deliver" }, { submissionId: SubmissionId }>({
    name: "test.plan-mode.handoff",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (_task, runtime, ctx) => {
        const conversation = required(await runtime.conversation(runtime.conversationId, ctx));
        let admitted: Submission | undefined;
        while (!admitted) {
          await conversation.waitForIdle(ctx);
          if (!paused) {
            paused = true;
            idleSeen.resolve();
            await awaitWithContext(releaseGap.promise, ctx);
          }
          let idle = false;
          await runtime.commit(async (tx) => {
            const workflow = await tx.doc(Workflow, runtime.conversationId);
            if (workflow.phase !== "pending" || workflow.owner !== runtime.conversationId || workflow.revision !== 1)
              throw new Error("stale");
            if ((await tx.doc(LiveDoc, runtime.conversationId)).run !== undefined) {
              busySeen.resolve();
              return undefined;
            }
            idle = true;
            workflow.mode = "normal";
            return undefined;
          }, ctx);
          if (!idle) continue;
          try {
            admitted = await conversation.submit(
              { type: "input", content: "EXACT APPROVED PLAN", requestId: "kickoff:1:1", whenBusy: "reject" },
              ctx,
            );
          } catch (error) {
            if (!(error instanceof ConversationBusy)) throw error;
          }
        }
        await runtime.commit(async (tx) => {
          const receipt = required(await tx.submissionByRequest(runtime.conversationId, "kickoff:1:1"));
          const workflow = await tx.doc(Workflow, runtime.conversationId);
          if (receipt.status !== "placed" && receipt.status !== "done") throw new Error("kickoff not placed");
          workflow.submissionId = receipt.id;
          workflow.phase = "implementing";
          return { status: "terminal", outcome: { status: "completed", result: { submissionId: receipt.id } } };
        }, ctx);
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools: [write], tasks: [Handoff], sections: [modeSection] }));
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    await root.commit(async (tx) => {
      (await tx.doc(Workflow, root.id)).owner = root.id;
    }, context);
    let kickoffContract = false;
    let kickoffExact = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", {}, { id: "unapproved" }), { stopReason: "toolUse" }),
      async () => {
        busyRequest.resolve();
        await releaseBusy.promise;
        return fauxAssistantMessage("unapproved finished");
      },
      (input) => {
        kickoffContract = input.messages.some(
          (message) => message.role === "system" && message.sections?.plan_mode === "NORMAL-CONTRACT",
        );
        kickoffExact =
          input.messages.filter((message) => message.role === "user").at(-1)?.content === "EXACT APPROVED PLAN";
        return fauxAssistantMessage(fauxToolCall("write", {}, { id: "approved" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("implemented"),
    ]);
    const taskId = await root.commit(async (tx) => {
      (await tx.doc(Workflow, root.id)).phase = "pending";
      return tx.createTask(Handoff, {}, { ownership: { kind: "conversation" }, background: true });
    }, context);
    harness.resume();
    await idleSeen.promise;
    const competing = await root.submit({ type: "input", content: "UNAPPROVED CONCURRENT PROMPT" }, context);
    await busyRequest.promise;
    releaseGap.resolve();
    await busySeen.promise;
    expect((await harness.snapshot(Workflow, root.id, context))?.mode).toBe("plan");
    expect({ effects, denied }).toEqual({ effects: 0, denied: 1 });
    releaseBusy.resolve();
    await competing.wait(context);
    const result = await harness.waitForTask(taskId, context);
    if (result.state.outcome.status !== "completed") throw new Error("handoff failed");
    const sid = result.state.outcome.result.submissionId;
    await required(await harness.submission(sid, context)).wait(context);
    await root.waitForIdle(context);
    expect(
      (await root.submit({ type: "input", content: "EXACT APPROVED PLAN", requestId: "kickoff:1:1" }, context)).id,
    ).toBe(sid);
    expect({ effects, kickoffContract, kickoffExact }).toEqual({
      effects: 1,
      kickoffContract: true,
      kickoffExact: true,
    });
  } finally {
    releaseGap.resolve();
    releaseBusy.resolve();
    await harness.close(context);
  }
});

it("native static sections persist one restored contract after compaction and preserve ordinary request prefixes", async () => {
  const requests: Message[][] = [];
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "test",
      sections: [modeSection],
      hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "Synthetic compacted history" }) })],
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { compaction: { enabled: false, keepRecentTokens: 0 }, retry: { maxRetries: 0 } } },
    context,
  );
  const send = async (root: Conversation, text: string) => {
    faux.setResponses([
      (input) => {
        requests.push(structuredClone(input.messages));
        return fauxAssistantMessage(`answer ${text}`);
      },
    ]);
    await (await root.submit({ type: "input", content: text }, context)).wait(context);
  };
  // Only model-visible serialized fields are compared, not timestamps or transport metadata.
  const normalized = (messages: Message[]) =>
    messages.map((message) => {
      const { timestamp: _timestamp, ...rest } = message;
      return rest;
    });
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    await root.commit(async (tx) => {
      await tx.doc(Workflow, root.id);
    }, context);
    await send(root, "one");
    await send(root, "two");
    expect(normalized(required(requests[1])).slice(0, required(requests[0]).length)).toEqual(
      normalized(required(requests[0])),
    );
    const compaction = await harness.waitForTask(await root.compact(undefined, context), context);
    if (compaction.state.outcome.status !== "completed") throw new Error("compaction failed");
    expect(compaction.state.outcome.result.submissionId).toBeDefined();
    await required(await harness.submission(required(compaction.state.outcome.result.submissionId), context)).wait(
      context,
    );
    await send(root, "three");
    await send(root, "four");
    expect(normalized(required(requests[3])).slice(0, required(requests[2]).length)).toEqual(
      normalized(required(requests[2])),
    );
    const active = await root.context(context);
    expect(
      active.entries.filter(
        (entry) =>
          SystemEntry.is(entry) &&
          entry.model?.some((message) => message.role === "system" && message.sections?.plan_mode === "PLAN-CONTRACT"),
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close(context);
  }
});
