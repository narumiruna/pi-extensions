import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type Models, Type } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type Harness,
  hook,
  type TaskId,
  ToolResultEntry,
  ToolTask,
  type Tx,
  UsageDoc,
  wrapTool,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it } from "vitest";
import { context, deferred, openDurableFixture } from "./durable-fixture.js";

// Repository-only feasibility prototypes for the pinned public API, not a Goal API.
const harnesses = new Set<Harness>();
const directories: string[] = [];
async function open(...args: Parameters<typeof openDurableFixture>) {
  const fixture = await openDurableFixture(...args);
  harnesses.add(fixture.harness);
  return fixture;
}
async function close(harness: Harness) {
  await harness.close(context);
  harnesses.delete(harness);
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-goal-host-lifecycle-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  const owned = [...harnesses];
  harnesses.clear();
  // Attempt every close and removal before reporting all cleanup failures.
  const closes = await Promise.allSettled(owned.map((harness) => harness.close(context)));
  const removals = await Promise.allSettled(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  const failures = [...closes, ...removals].filter((result) => result.status === "rejected");
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Host lifecycle fixture cleanup failed",
    );
});

type Identity = {
  goal: string;
  generation: number;
  source: ConversationId;
  supervisor: TaskId;
  execution: ConversationId;
};
type Canonical = {
  identity: Identity | null;
  status: "active" | "paused" | "blocked" | "complete" | "cleared";
  reason: string;
  receipt: string;
  outputTokens: number;
  elapsedOpen: boolean;
  continuation: boolean;
  wakeAt: number | null;
};
const CanonicalDoc = defineDoc<Canonical>({
  kind: "test.host-lifecycle.canonical",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({
    identity: null,
    status: "paused",
    reason: "",
    receipt: "",
    outputTokens: 0,
    elapsedOpen: false,
    continuation: false,
    wakeAt: null,
  }),
});
function matches(actual: Identity | null, expected: Identity) {
  return (
    actual !== null &&
    Object.keys(expected).every((key) => actual[key as keyof Identity] === expected[key as keyof Identity])
  );
}
async function reconcile(tx: Tx, expected: Identity) {
  const doc = await tx.doc(CanonicalDoc, expected.source);
  if (!matches(doc.identity, expected) || doc.status !== "active") return;
  const supervisor = await tx.task(expected.supervisor);
  if (supervisor?.state.status !== "terminal") throw new Error("Reconciliation requires a terminal receipt");
  const outcome = supervisor.state.outcome;
  const usage = await tx.doc(UsageDoc, expected.execution);
  // This probe checks committed usage publication, not the full Goal accounting contract.
  doc.outputTokens = Object.values(usage.models).reduce((sum, value) => sum + value.output, 0);
  doc.status = outcome.status === "aborted" ? "paused" : "blocked";
  doc.reason =
    outcome.status === "faulted" || outcome.status === "failed"
      ? outcome.error.message
      : outcome.status === "orphaned"
        ? outcome.reason
        : outcome.status;
  doc.receipt = `${expected.supervisor}:${outcome.status}`;
  doc.elapsedOpen = false;
  doc.continuation = false;
  doc.wakeAt = null;
}

function prototype() {
  const supervisorReady = deferred<void>();
  const holdingSupervisorReady = deferred<void>();
  const childReady = deferred<void>();
  const childAborting = deferred<void>();
  const childRelease = deferred<void>();
  const reconciliationReady = deferred<void>();
  const reconciliationRelease = deferred<void>();
  const never = deferred<void>();
  let delayReconciliation = false;
  let delayChildAbort = false;
  let reconciliationRuns = 0;
  let abortJoins = 0;
  let supervisorAborts = 0;
  let childDrained = false;
  const child = defineTask({
    name: "test.host-lifecycle.child",
    version: 1,
    initial: () => ({ phase: "run" as const }),
    phases: {
      run: async (_task, _api, ctx) => {
        childReady.resolve();
        await awaitWithContext(never.promise, ctx);
      },
    },
    abort: async (_task, api, ctx) => {
      childAborting.resolve();
      if (delayChildAbort) await awaitWithContext(childRelease.promise, ctx);
      await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
      childDrained = true;
    },
  });
  const supervisor = defineTask({
    name: "test.host-lifecycle.supervisor",
    version: 1,
    initial: (_input: { mode: "fault" | "hold" }) => ({ phase: "run" as const }),
    phases: {
      run: async (task, _api, ctx) => {
        supervisorReady.resolve();
        if (task.input.mode === "fault") throw new Error("synthetic supervisor fault");
        holdingSupervisorReady.resolve();
        await awaitWithContext(never.promise, ctx);
      },
    },
    abort: async (_task, api, ctx) => {
      supervisorAborts++;
      await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const reconciler = defineTask({
    name: "test.host-lifecycle.reconciler",
    version: 1,
    initial: (_input: Identity): { phase: "wait" | "settle" } => ({ phase: "wait" }),
    phases: {
      wait: async (task, api, ctx) => {
        await api.commit(
          () => ({
            status: "waiting",
            checkpoint: { phase: "settle" },
            on: [task.input.supervisor],
            policy: "allSettled",
          }),
          ctx,
        );
      },
      settle: async (task, api, ctx) => {
        reconciliationRuns++;
        reconciliationReady.resolve();
        if (delayReconciliation) await awaitWithContext(reconciliationRelease.promise, ctx);
        // Re-read identity and terminal receipt inside the transaction after the delayed await.
        await api.commit(async (tx) => {
          await reconcile(tx, task.input);
          return { status: "terminal", outcome: { status: "completed", result: {} } };
        }, ctx);
      },
    },
    abort: async (task, api, ctx) => {
      // A foreground sibling is also abort-marked by source abort. Its fresh abort
      // invocation must join the supervisor, not bypass the ordinary wait phase.
      await api.waitForTask(task.input.supervisor, ctx);
      abortJoins++;
      await api.commit(async (tx) => {
        await reconcile(tx, task.input);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
    },
  });
  const extension = defineExtension({ name: "host-lifecycle-probe", tasks: [supervisor, reconciler, child] });
  return {
    supervisor,
    reconciler,
    child,
    extension,
    supervisorReady,
    holdingSupervisorReady,
    childReady,
    childAborting,
    childRelease,
    reconciliationReady,
    reconciliationRelease,
    delayReconciliation: () => {
      delayReconciliation = true;
    },
    allowReconciliation: () => {
      delayReconciliation = false;
      reconciliationRelease.resolve();
    },
    delayChildAbort: () => {
      delayChildAbort = true;
    },
    evidence: () => ({ reconciliationRuns, abortJoins, supervisorAborts, childDrained }),
  };
}
async function activate(
  root: Conversation,
  probe: ReturnType<typeof prototype>,
  mode: "fault" | "hold",
  withChild = false,
  generation = 1,
) {
  return root.commit(async (tx) => {
    const supervisor = await tx.createTask(probe.supervisor, { mode }, { ownership: { kind: "conversation" } });
    const execution = await tx.createConversation({ ownership: { kind: "task", taskId: supervisor } });
    const identity: Identity = {
      goal: `goal-${generation}`,
      generation,
      source: root.id,
      supervisor,
      execution: execution.id,
    };
    const reconciler = await tx.createTask(probe.reconciler, identity, { ownership: { kind: "conversation" } });
    const child = withChild
      ? await tx.createTask(probe.child, {}, { ownership: { kind: "task", taskId: supervisor } })
      : undefined;
    Object.assign(await tx.doc(CanonicalDoc, root.id), {
      identity,
      status: "active",
      elapsedOpen: true,
      continuation: true,
      wakeAt: 123456,
    });
    return { identity, reconciler, child };
  }, context);
}
describe("durable public host-wrapper lifecycle feasibility", () => {
  it("reconciles a supervisor fault to blocked without observers or its abort handler", async () => {
    const probe = prototype();
    const { harness, root } = await open([probe.extension]);
    const active = await activate(root, probe, "fault");
    expect(await harness.getTask(active.reconciler, context)).toMatchObject({
      conversationId: root.id,
      background: false,
    });
    expect((await harness.getTask(active.reconciler, context))?.owner).toBeUndefined();
    await harness.waitForTask(active.reconciler, context);
    const supervisor = await harness.getTask(active.identity.supervisor, context);
    expect(supervisor?.state.outcome?.status).toBe("faulted");
    expect(probe.evidence()).toMatchObject({ reconciliationRuns: 1, supervisorAborts: 0 });
    expect(await harness.snapshot(CanonicalDoc, root.id, context)).toMatchObject({
      identity: active.identity,
      status: "blocked",
      reason: "synthetic supervisor fault",
      receipt: `${active.identity.supervisor}:faulted`,
      elapsedOpen: false,
      continuation: false,
      wakeAt: null,
    });
  });

  it("source abort joins the owned tree before publishing paused and leaves unrelated work live", async () => {
    const probe = prototype();
    probe.delayChildAbort();
    const providerReady = deferred<void>();
    const never = deferred<void>();
    let signal: AbortSignal | undefined;
    const { harness, root } = await open(
      [probe.extension],
      [
        fauxAssistantMessage("committed usage"),
        async (_messages, options) => {
          signal = options?.signal;
          if (signal === undefined) throw new Error("Missing provider signal");
          providerReady.resolve();
          await awaitWithContext(never.promise, withAbortSignal(signal, context));
          return fauxAssistantMessage("unreachable");
        },
      ],
    );
    const active = await activate(root, probe, "hold", true);
    const execution = await harness.conversation(active.identity.execution, context);
    if (execution === undefined || active.child === undefined) throw new Error("Missing owned tree");
    const unrelated = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const unrelatedTask = await unrelated.commit(
      (tx) =>
        tx.createTask(
          probe.supervisor,
          { mode: "hold" as const },
          {
            ownership: { kind: "conversation" },
          },
        ),
      context,
    );
    const committed = await execution.submit({ type: "input", content: "first" }, context);
    await committed.wait(context);
    const usage = await harness.snapshot(UsageDoc, execution.id, context);
    const outputTokens = Object.values(usage?.models ?? {}).reduce((sum, value) => sum + value.output, 0);
    expect(outputTokens).toBeGreaterThan(0);
    await execution.submit({ type: "input", content: "second" }, context);
    await Promise.all([providerReady.promise, probe.childReady.promise, probe.supervisorReady.promise]);
    const abort = root.abort(context);
    // Attach rejection handling before assertions can fail and cleanup closes the Harness.
    void abort.catch(() => {});
    await probe.childAborting.promise;
    expect((await harness.snapshot(CanonicalDoc, root.id, context))?.status).toBe("active");
    expect((await harness.getTask(active.identity.supervisor, context))?.state.status).not.toBe("terminal");
    probe.childRelease.resolve();
    await abort;
    expect(signal?.aborted).toBe(true);
    expect(probe.evidence()).toMatchObject({ abortJoins: 1, supervisorAborts: 1, childDrained: true });
    for (const id of [active.identity.supervisor, active.child, active.reconciler]) {
      expect((await harness.getTask(id, context))?.state.status).toBe("terminal");
    }
    expect(
      (await harness.inspect(context)).tasks.filter((task) => task.record.conversationId === execution.id),
    ).toEqual([]);
    expect(await harness.snapshot(CanonicalDoc, root.id, context)).toMatchObject({
      status: "paused",
      receipt: `${active.identity.supervisor}:aborted`,
      outputTokens,
      elapsedOpen: false,
      continuation: false,
      wakeAt: null,
    });
    expect((await harness.getTask(unrelatedTask, context))?.abortRequested).not.toBe(true);
    expect((await harness.getTask(unrelatedTask, context))?.state.status).not.toBe("terminal");
    await unrelated.abort(context);
  });

  it("reconciles an orphan receipt when the persisted supervisor definition is missing", async () => {
    const path = await directory();
    const probe = prototype();
    const first = await open([probe.extension], undefined, {}, await openNodeJsonlStorage(path, context));
    const active = await activate(first.root, probe, "hold");
    // No scheduler was enabled: the supervisor is durably pending, not an unobserved running child.
    expect((await first.harness.getTask(active.identity.supervisor, context))?.state.status).toBe("pending");
    await close(first.harness);
    const second = await open(
      [defineExtension({ name: "host-lifecycle-probe", tasks: [probe.reconciler] })],
      undefined,
      {},
      await openNodeJsonlStorage(path, context),
    );
    expect((await second.harness.snapshot(CanonicalDoc, second.root.id, context))?.status).toBe("active");
    const inspection = await second.harness.inspect(context);
    expect(inspection.scheduling).toBe("paused");
    expect(inspection.tasks.find((task) => task.record.id === active.identity.supervisor)?.state).toMatchObject({
      kind: "blocked",
      reason: "missing_task",
    });
    // A missing definition alone blocks reservation. Public abortTask creates the orphan receipt.
    await second.harness.abortTask(active.identity.supervisor, context);
    await second.harness.waitForTask(active.reconciler, context);
    expect((await second.harness.getTask(active.identity.supervisor, context))?.state.outcome?.status).toBe("orphaned");
    expect(await second.harness.snapshot(CanonicalDoc, second.root.id, context)).toMatchObject({
      status: "blocked",
      receipt: `${active.identity.supervisor}:orphaned`,
      continuation: false,
      wakeAt: null,
    });
    expect((await second.harness.snapshot(CanonicalDoc, second.root.id, context))?.reason).not.toBe("");
    expect(second.faux.state.callCount).toBe(0);
  });

  it.each(["new-activation", "paused", "complete", "blocked", "cleared"] as const)(
    "delayed reconciliation preserves %s",
    async (replacement) => {
      const probe = prototype();
      probe.delayReconciliation();
      const { harness, root } = await open([probe.extension]);
      const active = await activate(root, probe, "fault");
      harness.resume();
      await probe.reconciliationReady.promise;
      if (replacement === "new-activation") {
        await activate(root, probe, "hold", false, 2);
        await probe.holdingSupervisorReady.promise;
      } else {
        await root.commit(async (tx) => {
          const doc = await tx.doc(CanonicalDoc, root.id);
          doc.status = replacement;
          doc.receipt = "accepted terminal receipt";
          doc.reason = "accepted evidence";
          doc.elapsedOpen = false;
          doc.continuation = false;
          doc.wakeAt = null;
        }, context);
      }
      const accepted = await harness.snapshot(CanonicalDoc, root.id, context);
      probe.allowReconciliation();
      await harness.waitForTask(active.reconciler, context);
      expect(await harness.snapshot(CanonicalDoc, root.id, context)).toEqual(accepted);
      if (replacement === "new-activation") await root.abort(context);
    },
  );

  it("passively reopens JSONL after supervisor termination and reconciles only on explicit recovery", async () => {
    const path = await directory();
    const probe = prototype();
    probe.delayReconciliation();
    const first = await open([probe.extension], undefined, {}, await openNodeJsonlStorage(path, context));
    const active = await activate(first.root, probe, "fault");
    first.harness.resume();
    // Readiness proves the supervisor is terminal and the sibling has not yet committed reconciliation.
    await probe.reconciliationReady.promise;
    expect((await first.harness.getTask(active.identity.supervisor, context))?.state.status).toBe("terminal");
    expect((await first.harness.snapshot(CanonicalDoc, first.root.id, context))?.status).toBe("active");
    await close(first.harness);
    probe.allowReconciliation();
    const runsBeforeReopen = probe.evidence().reconciliationRuns;
    const second = await open([probe.extension], undefined, {}, await openNodeJsonlStorage(path, context));
    const view = await second.root.viewState(context);
    try {
      const inspection = await second.harness.inspect(context);
      expect(inspection.scheduling).toBe("paused");
      expect(inspection.tasks.map((task) => task.record.id)).toContain(active.reconciler);
      expect((await second.harness.getTask(active.identity.supervisor, context))?.state.outcome?.status).toBe(
        "faulted",
      );
      expect((await second.harness.snapshot(CanonicalDoc, second.root.id, context))?.status).toBe("active");
      expect(probe.evidence().reconciliationRuns).toBe(runsBeforeReopen);
      expect(second.faux.state.callCount).toBe(0);
    } finally {
      view.dispose();
    }
    await second.harness.waitForTask(active.reconciler, context);
    expect(probe.evidence().reconciliationRuns).toBe(runsBeforeReopen + 1);
    expect(await second.harness.snapshot(CanonicalDoc, second.root.id, context)).toMatchObject({
      status: "blocked",
      receipt: `${active.identity.supervisor}:faulted`,
      continuation: false,
      wakeAt: null,
    });
    expect(second.faux.state.callCount).toBe(0);
  });

  it("wrapTool execute denies a recovered replay-safe effect even though beforeTool is skipped", async () => {
    const path = await directory();
    const entered = deferred<void>();
    const never = deferred<void>();
    let beforeChecks = 0;
    let executeChecks = 0;
    let executions = 0;
    let effects = 0;
    const action = defineTool({
      name: "guarded_action",
      description: "Synthetic replay-safe effect",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, _api, ctx) => {
        executions++;
        if (executions === 1) {
          entered.resolve();
          await awaitWithContext(never.promise, ctx);
        }
        effects++;
        return {};
      },
    });
    const extension = defineExtension({
      name: "host-execute-guard",
      tools: [action],
      hooks: [
        hook(ToolTask, {
          beforeTool: () => {
            beforeChecks++;
          },
        }),
      ],
      wraps: [
        wrapTool(action, (tool) => ({
          ...tool,
          execute: async (args, api, ctx) => {
            executeChecks++;
            const allowed = await api.commit(
              async (tx) => (await tx.doc(CanonicalDoc, api.conversationId)).status === "active",
              ctx,
            );
            if (!allowed) throw new Error("Host execute guard denied stale or exhausted work");
            return tool.execute(args, api, ctx);
          },
        })),
      ],
    });
    const request = { type: "input", content: "run", requestId: "host-guard-replay" } as const;
    const first = await open(
      [extension],
      [fauxAssistantMessage(fauxToolCall(action.name, {}, { id: "guarded" }), { stopReason: "toolUse" })],
      {},
      await openNodeJsonlStorage(path, context),
    );
    await first.root.commit(async (tx) => {
      (await tx.doc(CanonicalDoc, first.root.id)).status = "active";
    }, context);
    const submission = await first.root.submit(request, context);
    await entered.promise;
    await close(first.harness);
    const second = await open([extension], undefined, {}, await openNodeJsonlStorage(path, context));
    await second.root.commit(async (tx) => {
      (await tx.doc(CanonicalDoc, second.root.id)).status = "blocked";
    }, context);
    expect(executeChecks).toBe(1);
    const recovered = await second.root.submit(request, context);
    expect(recovered.id).toBe(submission.id);
    expect((await recovered.wait(context)).status).toBe("done");
    expect({ beforeChecks, executeChecks, executions, effects }).toEqual({
      beforeChecks: 1,
      executeChecks: 2,
      executions: 1,
      effects: 0,
    });
    const results = (await second.root.context(context)).entries.filter(ToolResultEntry.is);
    expect(results).toHaveLength(1);
    expect(results[0]?.model?.[0]).toMatchObject({ role: "toolResult", isError: true });
    expect(JSON.stringify(results[0])).toContain("Host execute guard denied");
  });

  it("injects a task-scoped Models facade through a spread ToolExecutionApi for untagged subordinate calls", async () => {
    const bindings: { taskId: TaskId; conversationId: ConversationId }[] = [];
    let originalTask: TaskId | undefined;
    const subordinate = defineTool({
      name: "subordinate_model",
      description: "Run an untagged finite subordinate model call",
      parameters: Type.Object({}),
      execute: async (_args, api, ctx) => {
        originalTask = api.taskId;
        const ref = (await api.agent(ctx)).model;
        const model = ref && api.models.getModel(ref.provider, ref.modelId);
        if (!model) throw new Error("Missing synthetic model");
        // No Goal identity, task ID, conversation ID, or options are supplied by this subordinate.
        const result = await api.models.completeSimple(model, {
          messages: [{ role: "user", content: "subordinate", timestamp: 0 }],
        });
        return { output: [{ type: "text" as const, text: JSON.stringify(result.content) }], usage: result.usage };
      },
    });
    const extension = defineExtension({
      name: "host-task-model-facade",
      tools: [subordinate],
      wraps: [
        wrapTool(subordinate, (tool) => ({
          ...tool,
          execute: (args, api, ctx) => {
            const completeSimple: Models["completeSimple"] = (model, messages, options) => {
              bindings.push({ taskId: api.taskId, conversationId: api.conversationId });
              return api.models.completeSimple(model, messages, options);
            };
            // Models methods need their original receiver; only ToolExecutionApi is a spreadable object.
            const facade: Models = new Proxy(api.models, {
              get: (models, key) => {
                if (key === "completeSimple") return completeSimple;
                const value = Reflect.get(models, key, models);
                return typeof value === "function" ? value.bind(models) : value;
              },
            });
            return tool.execute(args, { ...api, models: facade }, ctx);
          },
        })),
      ],
    });
    const { root, harness, faux } = await open(
      [extension],
      [
        fauxAssistantMessage(fauxToolCall(subordinate.name, {}, { id: "subordinate" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("subordinate result"),
        fauxAssistantMessage("finished"),
      ],
    );
    const submission = await root.submit({ type: "input", content: "run" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const results = (await root.context(context)).entries.filter(ToolResultEntry.is);
    expect(results[0]?.model?.[0]).toMatchObject({ role: "toolResult", isError: false });
    expect(bindings).toEqual([{ taskId: originalTask, conversationId: root.id }]);
    if (originalTask === undefined) throw new Error("Subordinate tool did not execute");
    expect((await harness.getTask(originalTask, context))?.kind).toBe("pi.tool");
    expect(faux.state.callCount).toBe(3);
  });
});
