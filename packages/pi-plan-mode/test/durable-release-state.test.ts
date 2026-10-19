import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  type EntryDraft,
  Harness,
  hook,
  MemoryStorage,
  type Storage,
  ToolTask,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it } from "vitest";

// Feasibility fixtures for the installed durable/chord 1.2.0 release, not a Plan Mode adapter.
// In particular, asOf copies data verbatim and requestId deduplication does not compare payloads.
type ReleaseState = {
  owner: number;
  revision: number;
  phase: "planning" | "awaiting-answers" | "ready" | "inactive";
  questions: { id: string; text: string; options: string[] }[];
  plan: string;
};
const Workflow = defineDoc<ReleaseState>({
  kind: "plan-mode.release-state",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ owner: 0, revision: 0, phase: "planning", questions: [], plan: "" }),
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(persistent = false) {
  let storage: () => Promise<Storage> = async () => new MemoryStorage();
  if (persistent) {
    const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-release-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    storage = () => openNodeJsonlStorage(directory, context);
  }
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const open = async () => {
    const harness = await Harness.open(
      await storage(),
      { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
      context,
    );
    cleanup.push(() => harness.close(context));
    return harness;
  };
  const harness = await open();
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    init: async (tx, id) => {
      (await tx.doc(Workflow, id)).owner = id;
    },
  });
  return { harness, root, faux, registry, open };
}

// A controlled tool round establishes a busy boundary without timers or an open human question.
function holdRound(registry: ReturnType<typeof createRegistry>) {
  const entered = deferred();
  const release = deferred();
  registry.install(
    defineExtension({
      name: "release-hold",
      tools: [
        defineTool({
          name: "release_hold",
          description: "Hold a synthetic tool round until the host releases it.",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_args, _api, ctx) => {
            entered.resolve();
            await awaitWithContext(release.promise, ctx);
            return { output: [fauxText("released")], control: { terminate: true } };
          },
        }),
      ],
    }),
  );
  return { entered, release };
}
function callHold() {
  return fauxAssistantMessage(fauxToolCall("release_hold", {}, { id: "hold-call" }), { stopReason: "toolUse" });
}

describe("durable 1.2.0 release state contract", () => {
  it("rewindable history and asOf forks select the entry's committed document, not current state", async () => {
    const f = await fixture(true);
    const pending = await f.root.commit(async (tx) => {
      const doc = await tx.doc(Workflow, f.root.id);
      doc.revision = 1;
      doc.phase = "awaiting-answers";
      doc.questions = [{ id: "scope", text: "Which scope?", options: ["package", "repository"] }];
      return tx.appendEntry(f.root.id, { kind: "app.question" });
    }, context);
    const pendingState = await f.harness.snapshot(Workflow, f.root.id, context);
    const ready = await f.root.commit(async (tx) => {
      const doc = await tx.doc(Workflow, f.root.id);
      doc.revision = 2;
      doc.phase = "ready";
      doc.questions = [];
      doc.plan = "Inspect first. Then add tests.";
      return tx.appendEntry(f.root.id, { kind: "app.proposal" });
    }, context);
    const readyState = await f.harness.snapshot(Workflow, f.root.id, context);
    // A document-only later commit must not replace either historical entry's value.
    await f.root.commit(async (tx) => {
      const doc = await tx.doc(Workflow, f.root.id);
      doc.revision = 3;
      doc.phase = "inactive";
    }, context);
    expect(await f.harness.snapshotAsOf(Workflow, f.root.id, pending.id, context)).toEqual(pendingState);
    expect(await f.harness.snapshotAsOf(Workflow, f.root.id, ready.id, context)).toEqual(readyState);
    const questionFork = await f.root.fork(pending.id, { ownership: { kind: "ownerless" } }, context);
    const planFork = await f.root.fork(ready.id, { ownership: { kind: "ownerless" } }, context);
    expect(await f.harness.snapshot(Workflow, questionFork.id, context)).toEqual(pendingState);
    expect(await f.harness.snapshot(Workflow, planFork.id, context)).toEqual(readyState);
    // Native copying does NOT transfer ownership or strip a pending human delivery.
    // A future adapter must reject the copied owner until the host activates this fork.
    expect((await f.harness.snapshot(Workflow, questionFork.id, context))?.owner).toBe(f.root.id);
    expect(questionFork.id).not.toBe(f.root.id);
    await planFork.commit(async (tx) => {
      const doc = await tx.doc(Workflow, planFork.id);
      doc.owner = planFork.id;
      doc.plan = "Independent branch proposal.";
    }, context);
    expect((await f.harness.snapshot(Workflow, f.root.id, context))?.plan).toBe(readyState?.plan);
    await f.harness.close(context);
    const reopened = await f.open();
    expect(await reopened.snapshotAsOf(Workflow, f.root.id, pending.id, context)).toEqual(pendingState);
    expect(await reopened.snapshotAsOf(Workflow, f.root.id, ready.id, context)).toEqual(readyState);
    expect(await reopened.snapshot(Workflow, questionFork.id, context)).toEqual(pendingState);
    expect(await reopened.snapshot(Workflow, planFork.id, context)).toMatchObject({
      owner: planFork.id,
      plan: "Independent branch proposal.",
    });
    expect(await reopened.snapshot(Workflow, f.root.id, context)).toMatchObject({ revision: 3, phase: "inactive" });
    expect(f.faux.state.callCount).toBe(0);
    expect((await reopened.inspect(context)).scheduling).toBe("paused");
  });

  it("status, snapshots, and attached observers do not resume a recovered replay-safe tool", async () => {
    const f = await fixture(true);
    const entered = deferred();
    const never = deferred();
    let executions = 0;
    f.registry.install(
      defineExtension({
        name: "release-recovery",
        tools: [
          defineTool({
            name: "release_recovery",
            description: "Pause the first execution, finish only on explicit recovery.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, _api, ctx) => {
              executions++;
              if (executions === 1) {
                entered.resolve();
                // Harness.close cancels this invocation Context; it does not settle the tool task.
                await awaitWithContext(never.promise, ctx);
              }
              return { output: [fauxText("recovered")], control: { terminate: true } };
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("release_recovery", {}, { id: "recovery-call" }), { stopReason: "toolUse" }),
    ]);
    const submitted = await f.root.submit({ type: "input", content: "start recovery fixture" }, context);
    await entered.promise;
    await f.harness.close(context);
    const reopened = await f.open();
    const root = await reopened.root(context);
    const observation = withCancel(context);
    cleanup.push(() => observation.cancel());
    const ctx = observation.context;
    const before = await reopened.inspect(ctx);
    expect(before.scheduling).toBe("paused");
    expect(before.tasks.some((task) => task.record.kind === "pi.tool" && task.state.kind === "ready")).toBe(true);
    const modelCalls = f.faux.state.callCount;
    const submission = await reopened.submission(submitted.id, ctx);
    expect(submission).toBeDefined();
    expect((await submission?.status(ctx))?.status).toBe("placed");
    expect(await reopened.conversation(root.id, ctx)).toBeDefined();
    expect((await root.agent(ctx)).model).toBeDefined();
    expect((await root.context(ctx)).entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
    expect((await root.entries({}, 100, undefined, ctx)).items.length).toBeGreaterThan(0);
    expect(await reopened.snapshot(Workflow, root.id, ctx)).toMatchObject({ owner: root.id });
    const view = await root.viewState(ctx);
    cleanup.push(() => view.dispose());
    const doc = await reopened.documentState(Workflow, root.id, ctx);
    cleanup.push(() => doc?.dispose());
    const graph = await reopened.taskGraph(ctx);
    cleanup.push(() => graph.dispose());
    const watch = await root.watch(ctx);
    cleanup.push(() => watch.stop());
    const docWatch = await reopened.watchDoc(Workflow, root.id, ctx);
    cleanup.push(() => docWatch?.stop());
    const graphWatch = await reopened.watchTaskGraph(ctx);
    cleanup.push(() => graphWatch.stop());
    const events = await watchEvents(reopened, root.id, ctx);
    cleanup.push(() => events.stop());
    watch.start(async () => {});
    docWatch?.start(async () => {});
    graphWatch.start(async () => {});
    events.start(async () => {});
    const unsubscribe = view.subscribe(() => {});
    cleanup.push(unsubscribe);
    expect(events.snapshot.run?.inputs).toEqual([submitted.id]);
    expect(graph.value.tasks).not.toEqual({});
    expect(doc?.value).toMatchObject({ owner: root.id });
    expect((await reopened.inspect(ctx)).scheduling).toBe("paused");
    expect(executions).toBe(1);
    expect(f.faux.state.callCount).toBe(modelCalls);
    observation.cancel();
    expect((await watch.closed).reason).toBe("cancelled");
    expect((await docWatch?.closed)?.reason).toBe("cancelled");
    expect((await graphWatch.closed).reason).toBe("cancelled");
    expect((await events.closed).reason).toBe("cancelled");
    view.dispose();
    doc?.dispose();
    graph.dispose();
    expect((await reopened.inspect(context)).scheduling).toBe("paused");
    // Positive control: explicit progress resumes the saved execution with no new model request.
    reopened.resume();
    expect((await submission?.wait(context))?.status).toBe("done");
    await root.waitForIdle(context);
    expect(executions).toBe(2);
    expect(f.faux.state.callCount).toBe(modelCalls);
  });

  it.each(["question", "completion"] as const)(
    "%s commits its document before a terminating result and leaves no human wait or follow-on generation",
    async (kind) => {
      const f = await fixture(true);
      const toolName = kind === "question" ? "plan_mode_question" : "plan_mode_complete";
      const questions = [{ id: "scope", text: "Which scope?", options: ["package", "repository"] }];
      const plan = "# Proposed plan\n\n1. Inspect the package.\n2. Add deterministic tests.\n";
      const afterExecution: Array<{
        state: Readonly<ReleaseState> | undefined;
        resultEntries: number;
        terminate: boolean;
      }> = [];
      f.registry.install(
        defineExtension({
          name: "release-helpers",
          tools: [
            defineTool({
              name: toolName,
              description: "Persist a synthetic question or proposal and end this run.",
              parameters: Type.Object({}),
              replay: "safe",
              execute: async (_args, api, ctx) => {
                await api.commit(async (tx) => {
                  const doc = await tx.doc(Workflow, api.conversationId);
                  doc.revision = 1;
                  if (kind === "question") {
                    doc.phase = "awaiting-answers";
                    doc.questions = questions;
                  } else {
                    doc.phase = "ready";
                    doc.plan = plan;
                  }
                }, ctx);
                // No promise waits for a person. The next human action belongs to a later host input.
                return { output: [fauxText("persisted")], details: { revision: 1 }, control: { terminate: true } };
              },
            }),
          ],
          hooks: [
            hook(ToolTask, {
              afterTool: async (_call, result, api, ctx) => {
                afterExecution.push({
                  state: await api.snapshot(Workflow, api.conversationId, ctx),
                  resultEntries: (await f.root.context(ctx)).entries.filter((entry) => entry.kind === "pi.tool-result")
                    .length,
                  terminate: result.control?.terminate === true,
                });
                return result;
              },
            }),
          ],
        }),
      );
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall(toolName, {}, { id: `${kind}-call` }), { stopReason: "toolUse" }),
      ]);
      const submission = await f.root.submit({ type: "input", content: `produce ${kind}` }, context);
      const settled = await submission.wait(context);
      await f.root.waitForIdle(context);
      expect(settled.status).toBe("done");
      const expected = {
        owner: f.root.id,
        revision: 1,
        phase: kind === "question" ? "awaiting-answers" : "ready",
        questions: kind === "question" ? questions : [],
        plan: kind === "completion" ? plan : "",
      };
      expect(afterExecution).toEqual([{ state: expected, resultEntries: 0, terminate: true }]);
      const entries = (await f.root.context(context)).entries;
      expect(entries.filter((entry) => entry.kind === "pi.tool-result")).toHaveLength(1);
      expect(entries.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);
      // A terminating round's answer receipt identifies the tool-calling assistant, not a later answer.
      expect(settled.type === "input" && settled.status === "done" ? settled.answer : undefined).toBe(
        entries.find((entry) => entry.kind === "pi.assistant")?.id,
      );
      expect((await f.harness.inspect(context)).tasks).toEqual([]);
      expect(f.faux.state.callCount).toBe(1);
      await f.harness.close(context);
      const reopened = await f.open();
      expect(await reopened.snapshot(Workflow, f.root.id, context)).toEqual(expected);
      expect((await (await reopened.submission(submission.id, context))?.status(context))?.status).toBe("done");
      expect((await reopened.inspect(context)).scheduling).toBe("paused");
      expect(f.faux.state.callCount).toBe(1);
    },
  );

  it("input requestId reuses queued, placed, and terminal admissions across reopen, but does not compare payloads", async () => {
    const f = await fixture(true);
    const held = holdRound(f.registry);
    f.faux.setResponses([callHold(), fauxAssistantMessage("answered once")]);
    const original = { type: "input", content: "start", requestId: "start" } as const;
    const [first, concurrent] = await Promise.all([f.root.submit(original, context), f.root.submit(original, context)]);
    expect(concurrent.id).toBe(first.id);
    await held.entered.promise;
    expect((await first.status(context)).status).toBe("placed");
    // Same-type retries find the receipt before busy rejection or any content comparison.
    const changed = await f.root.submit(
      { ...original, content: "must not replace start", whenBusy: "reject" },
      context,
    );
    expect(changed.id).toBe(first.id);
    const next = { type: "input", content: "answers", requestId: "answers" } as const;
    const queued = await f.root.submit(next, context);
    expect((await queued.status(context)).status).toBe("queued");
    expect((await f.root.submit({ ...next, content: "changed answers", whenBusy: "steer" }, context)).id).toBe(
      queued.id,
    );
    await expect(
      f.root.submit({ type: "write", requestId: "answers", entry: { kind: "app.invalid-type-retry" } }, context),
    ).rejects.toThrow("already identifies a submission of type input");
    held.release.resolve();
    expect((await first.wait(context)).status).toBe("done");
    expect((await queued.wait(context)).status).toBe("done");
    await f.root.waitForIdle(context);
    expect((await f.root.submit({ ...next, content: "changed after settlement" }, context)).id).toBe(queued.id);
    expect(
      (await f.root.context(context)).messages.filter((message) => message.role === "user").map((m) => m.content),
    ).toEqual(["start", "answers"]);
    expect(f.faux.state.callCount).toBe(2);
    await f.harness.close(context);
    const reopened = await f.open();
    const root = await reopened.root(context);
    expect((await root.submit(next, context)).id).toBe(queued.id);
    expect(f.faux.state.callCount).toBe(2);
    const other = await reopened.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: f.faux.provider.id, modelId: f.faux.getModel().id } },
      },
      context,
    );
    f.faux.setResponses([fauxAssistantMessage("separate conversation")]);
    const separate = await other.submit(next, context);
    expect(separate.id).not.toBe(queued.id);
    expect((await separate.wait(context)).status).toBe("done");
  });

  it("requestId finds unfinished placed and queued inputs after reopen instead of creating another run", async () => {
    const f = await fixture(true);
    const held = holdRound(f.registry);
    f.faux.setResponses([callHold(), fauxAssistantMessage("answers consumed once")]);
    const firstDraft = { type: "input", content: "start", requestId: "recover-start" } as const;
    const nextDraft = { type: "input", content: "answers", requestId: "recover-answers" } as const;
    const first = await f.root.submit(firstDraft, context);
    await held.entered.promise;
    const next = await f.root.submit(nextDraft, context);
    await f.harness.close(context);
    const reopened = await f.open();
    const root = await reopened.root(context);
    const recoveredFirst = await reopened.submission(first.id, context);
    const recoveredNext = await reopened.submission(next.id, context);
    expect((await recoveredFirst?.status(context))?.status).toBe("placed");
    expect((await recoveredNext?.status(context))?.status).toBe("queued");
    expect((await root.submit(firstDraft, context)).id).toBe(first.id);
    expect((await root.submit(nextDraft, context)).id).toBe(next.id);
    held.release.resolve();
    expect((await recoveredFirst?.wait(context))?.status).toBe("done");
    expect((await recoveredNext?.wait(context))?.status).toBe("done");
    await root.waitForIdle(context);
    expect(
      (await root.context(context)).messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["start", "answers"]);
    expect(f.faux.state.callCount).toBe(2);
  });

  it("a busy model-visible write is only admitted until the boundary, which places it before an earlier queued kickoff", async () => {
    const f = await fixture();
    const held = holdRound(f.registry);
    const providerInputs: unknown[] = [];
    f.faux.setResponses([
      callHold(),
      (input) => {
        providerInputs.push(
          input.messages.filter((message) => message.role === "user").map((message) => message.content),
        );
        return fauxAssistantMessage("implementation kickoff observed");
      },
    ]);
    const first = await f.root.submit({ type: "input", content: "planning round" }, context);
    await held.entered.promise;
    const kickoff = await f.root.submit(
      { type: "input", content: "approved exact plan", requestId: "kickoff" },
      context,
    );
    const contract = await f.root.submit(
      {
        type: "write",
        requestId: "normal-contract",
        entry: { kind: "app.normal-contract", model: [{ role: "user", content: "Normal contract", timestamp: 0 }] },
      },
      context,
    );
    const display = await f.root.submit(
      { type: "write", entry: { kind: "app.display-only", data: "visible now" } },
      context,
    );
    expect((await kickoff.status(context)).status).toBe("queued");
    expect((await contract.status(context)).status).toBe("queued");
    expect((await display.status(context)).status).toBe("done");
    const before = (await f.root.context(context)).entries;
    expect(before.some((entry) => entry.kind === "app.normal-contract")).toBe(false);
    expect(before.some((entry) => entry.kind === "app.display-only")).toBe(true);
    expect(f.faux.state.callCount).toBe(1);
    held.release.resolve();
    await first.wait(context);
    expect((await contract.wait(context)).status).toBe("done");
    expect((await kickoff.wait(context)).status).toBe("done");
    await f.root.waitForIdle(context);
    const entries = (await f.root.context(context)).entries;
    const contractIndex = entries.findIndex((entry) => entry.kind === "app.normal-contract");
    const kickoffRecord = await kickoff.status(context);
    expect(contractIndex).toBeGreaterThan(entries.findIndex((entry) => entry.kind === "pi.tool-result"));
    expect(entries.findIndex((entry) => entry.id === kickoffRecord.entry)).toBeGreaterThan(contractIndex);
    expect(providerInputs).toEqual([["planning round", "Normal contract", "approved exact plan"]]);
    expect(f.faux.state.callCount).toBe(2);
  });

  it.each([
    { name: "model (empty)", fields: { model: [] } },
    { name: "edits (empty)", fields: { edits: [] } },
    { name: "head (self)", fields: { head: "self" } },
  ] satisfies Array<{ name: string; fields: Partial<EntryDraft> }>)(
    "presence of $name queues a busy write even without added model text",
    async ({ fields }) => {
      const f = await fixture();
      const held = holdRound(f.registry);
      f.faux.setResponses([callHold()]);
      const first = await f.root.submit({ type: "input", content: "hold" }, context);
      await held.entered.promise;
      const write = await f.root.submit({ type: "write", entry: { kind: "app.boundary", ...fields } }, context);
      expect((await write.status(context)).status).toBe("queued");
      expect((await f.root.context(context)).entries.some((entry) => entry.kind === "app.boundary")).toBe(false);
      held.release.resolve();
      expect((await write.wait(context)).status).toBe("done");
      await first.wait(context);
      await f.root.waitForIdle(context);
      expect((await f.root.context(context)).entries.some((entry) => entry.kind === "app.boundary")).toBe(true);
      expect(f.faux.state.callCount).toBe(1);
    },
  );

  it("a display-only write behind a queued reset waits and lands after the reset, not in hidden history", async () => {
    const f = await fixture();
    const held = holdRound(f.registry);
    f.faux.setResponses([callHold()]);
    const first = await f.root.submit({ type: "input", content: "hold" }, context);
    await held.entered.promise;
    await f.root.reset(undefined, context);
    const display = await f.root.submit(
      { type: "write", entry: { kind: "app.after-reset", data: "retained" } },
      context,
    );
    expect((await display.status(context)).status).toBe("queued");
    expect((await f.root.context(context)).entries.some((entry) => entry.kind === "app.after-reset")).toBe(false);
    held.release.resolve();
    expect((await display.wait(context)).status).toBe("done");
    await first.wait(context);
    await f.root.waitForIdle(context);
    expect((await f.root.context(context)).entries.map((entry) => entry.kind)).toEqual(["pi.reset", "app.after-reset"]);
    expect(f.faux.state.callCount).toBe(1);
  });
});
