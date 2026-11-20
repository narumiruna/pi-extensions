import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { createPiLangfuseDurableConversation } from "../src/durable.js";
import { deferred, fixture, metadata, named } from "./durable-support.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.each(["faulted", "orphaned"] as const)(
  "records any task's %s outcome structurally, without its error or custom kind",
  async (kind) => {
    const f = await fixture(cleanup);
    const entered = deferred();
    const release = deferred();
    cleanup.push(async () => release.resolve());
    f.faux.setResponses([
      async () => {
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("answer");
      },
    ]);
    const task = defineTask({
      name: "PRIVATE-CUSTOM-KIND",
      version: 1,
      initial: (_input: null) => ({ phase: "run" as const }),
      phases: {
        run: async () => {
          throw new Error("PRIVATE-TASK-ERROR");
        },
      },
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    });
    if (kind === "faulted") f.registry.install(defineExtension({ name: "host", tasks: [task] }));
    const tracing = await createPiLangfuseDurableConversation(f.runtime, {
      harness: f.harness,
      conversationId: f.root.id,
      context,
    });
    const submission = await f.root.submit({ type: "input", content: "go" }, context);
    await entered.promise;
    const taskId = await f.harness.commit(
      (tx) =>
        tx.createTask(task, null, {
          conversationId: f.root.id,
          ownership: { kind: "conversation" },
          background: true,
        }),
      context,
    );
    if (kind === "orphaned") await f.harness.abortTask(taskId, context);
    expect((await f.harness.waitForTask(taskId, context)).state.outcome.status).toBe(kind);
    await vi.waitFor(() =>
      expect(metadata(named(f.backend, "pi.durable.run"))["pi.durable.failed_task_id"]).toBe(taskId),
    );
    expect(named(f.backend, "pi.durable.run").updates.some((update) => update.level === "ERROR")).toBe(true);
    expect(JSON.stringify(f.backend.observations)).not.toContain("PRIVATE-");
    release.resolve();
    expect((await submission.wait(context)).status).toBe("done");
    await tracing.dispose();
  },
);
