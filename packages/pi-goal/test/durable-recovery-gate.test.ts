import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type Harness,
  hook,
  ToolTask,
  UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it } from "vitest";
import { context, deferred, openDurableFixture } from "./durable-fixture.js";

const harnesses: Harness[] = [];
const directories: string[] = [];
async function open(...args: Parameters<typeof openDurableFixture>) {
  const fixture = await openDurableFixture(...args);
  harnesses.push(fixture.harness);
  return fixture;
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-goal-durable-gate-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  try {
    for (const harness of harnesses.splice(0)) await harness.close(context);
  } finally {
    for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  }
});

const ProbeDoc = defineDoc<{ active: boolean; executions: number }>({
  kind: "test.goal-gate",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ active: false, executions: 0 }),
});

describe("durable ownership and persistent recovery gate", () => {
  it("deduplicates a settled request after reopening a persistent store", async () => {
    const path = await directory();
    const first = await open([], undefined, {}, await openNodeJsonlStorage(path, context));
    const request = { type: "input", content: "run once", requestId: "goal:one:activation:one" } as const;
    const submitted = await first.root.submit(request, context);
    expect((await submitted.wait(context)).status).toBe("done");
    await first.harness.close(context);

    const second = await open([], undefined, {}, await openNodeJsonlStorage(path, context));
    const duplicate = await second.root.submit(request, context);
    expect(duplicate.id).toBe(submitted.id);
    expect((await duplicate.wait(context)).status).toBe("done");
    expect(second.faux.state.callCount).toBe(0);
    expect((await second.root.context(context)).entries.filter(UserEntry.is)).toHaveLength(1);
  });

  it("safe-tool recovery bypasses beforeTool even when its current policy would deny execution", async () => {
    const path = await directory();
    const entered = deferred<void>();
    const release = deferred<void>();
    let allowed = true;
    let checks = 0;
    let executions = 0;
    const action = defineTool({
      name: "action",
      description: "Persist a synthetic execution count",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, ctx) => {
        executions++;
        await api.commit(async (tx) => {
          (await tx.doc(ProbeDoc, api.conversationId)).executions++;
        }, ctx);
        if (executions === 1) {
          entered.resolve();
          await awaitWithContext(release.promise, ctx);
        }
        return {};
      },
    });
    const extension = defineExtension({
      name: "replay-probe",
      tools: [action],
      hooks: [
        hook(ToolTask, {
          beforeTool: () => {
            checks++;
            return allowed ? undefined : { block: "Goal budget exhausted" };
          },
        }),
      ],
    });
    const request = { type: "input", content: "run", requestId: "goal:replay" } as const;
    const first = await open(
      [extension],
      [fauxAssistantMessage(fauxToolCall("action", {}, { id: "replayed" }), { stopReason: "toolUse" })],
      {},
      await openNodeJsonlStorage(path, context),
    );
    const submitted = await first.root.submit(request, context);
    await entered.promise;
    await first.harness.close(context);
    allowed = false;

    const second = await open(
      [extension],
      [fauxAssistantMessage("finished")],
      {},
      await openNodeJsonlStorage(path, context),
    );
    const view = await second.root.viewState(context);
    try {
      expect((await second.harness.inspect(context)).tasks.length).toBeGreaterThan(0);
      expect((await second.harness.snapshot(ProbeDoc, second.root.id, context))?.executions).toBe(1);
      expect(executions).toBe(1);
      expect(second.faux.state.callCount).toBe(0);
    } finally {
      view.dispose();
    }
    // Explicitly drive recovery; observation above must not start it.
    const duplicate = await second.root.submit(request, context);
    expect(duplicate.id).toBe(submitted.id);
    expect((await duplicate.wait(context)).status).toBe("done");
    expect(checks).toBe(1);
    expect(executions).toBe(2);
    expect((await second.harness.snapshot(ProbeDoc, second.root.id, context))?.executions).toBe(2);
  });

  it("source abort drains a task-owned execution conversation without aborting unrelated work", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    const sleeper = defineTask({
      name: "test.foreground-supervisor",
      version: 1,
      initial: () => ({ phase: "run" as const }),
      phases: {
        run: async (_task, runtime, ctx) => {
          await runtime.sleep(runtime.now() + 60_000, ctx);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), ctx);
        },
      },
      abort: async (_task, runtime, ctx) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
      },
    });
    const { root, harness } = await open(
      [defineExtension({ name: "ownership-probe", tasks: [sleeper] })],
      [
        async (_messages, options) => {
          signal = options?.signal;
          if (signal === undefined) throw new Error("Expected provider cancellation signal");
          entered.resolve();
          await awaitWithContext(release.promise, withAbortSignal(signal, context));
          return fauxAssistantMessage("late answer");
        },
      ],
    );
    const { supervisor, executionId } = await root.commit(async (tx) => {
      const supervisor = await tx.createTask(sleeper, {}, { ownership: { kind: "conversation" } });
      const execution = await tx.createConversation({ ownership: { kind: "task", taskId: supervisor } });
      return { supervisor, executionId: execution.id };
    }, context);
    const unrelated = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const unrelatedTask = await unrelated.commit(
      (tx) => tx.createTask(sleeper, {}, { ownership: { kind: "conversation" } }),
      context,
    );
    const execution = await harness.conversation(executionId, context);
    if (execution === undefined) throw new Error("Missing owned execution conversation");
    await execution.submit({ type: "input", content: "run" }, context);
    await entered.promise;
    await root.abort(context);
    expect(signal?.aborted).toBe(true);
    expect((await harness.getTask(supervisor, context))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted" },
    });
    expect((await harness.getTask(unrelatedTask, context))?.state.status).not.toBe("terminal");
    expect((await harness.getTask(unrelatedTask, context))?.abortRequested).not.toBe(true);
    await unrelated.abort(context);
  });

  it("a faulted custom supervisor bypasses its abort handler and leaves its document unchanged", async () => {
    let aborts = 0;
    const supervisor = defineTask({
      name: "test.faulted-supervisor",
      version: 1,
      initial: () => ({ phase: "run" as const }),
      phases: {
        run: async () => {
          throw new Error("synthetic supervisor fault");
        },
      },
      abort: async (_task, runtime, ctx) => {
        aborts++;
        await runtime.commit(async (tx) => {
          (await tx.doc(ProbeDoc, runtime.conversationId)).active = false;
          return { status: "terminal", outcome: { status: "aborted" } };
        }, ctx);
      },
    });
    const { root, harness } = await open([defineExtension({ name: "fault-probe", tasks: [supervisor] })]);
    const taskId = await root.commit(async (tx) => {
      (await tx.doc(ProbeDoc, root.id)).active = true;
      return tx.createTask(supervisor, {}, { ownership: { kind: "conversation" } });
    }, context);
    const settled = await harness.waitForTask(taskId, context);
    expect(settled.state.outcome).toMatchObject({
      status: "faulted",
      error: { message: "synthetic supervisor fault" },
    });
    expect(aborts).toBe(0);
    expect((await harness.snapshot(ProbeDoc, root.id, context))?.active).toBe(true);
  });
});
