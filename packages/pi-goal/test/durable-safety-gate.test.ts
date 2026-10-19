import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  CompactionTask,
  defineExtension,
  defineTool,
  GenerationTask,
  type Harness,
  hook,
  type TaskId,
  ToolResultEntry,
  ToolTask,
  UsageDoc,
  UserEntry,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { context, openDurableFixture } from "./durable-fixture.js";

const harnesses: Harness[] = [];
async function open(...args: Parameters<typeof openDurableFixture>) {
  const fixture = await openDurableFixture(...args);
  harnesses.push(fixture.harness);
  return fixture;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close(context);
});

// These tests characterize the pinned upstream runtime. Passing tests do NOT
// mean Goal's safety gate passes: several assertions prove the missing boundary.
describe("durable native request-admission safety gate", () => {
  it.each(["beforeRequest", "afterResponse", "afterTools"] as const)(
    "%s rejection does not stop a finite tool loop",
    async (phase) => {
      let executions = 0;
      const rejection = new Error("Goal response/token limit exhausted");
      const action = defineTool({
        name: "action",
        description: "Synthetic action with no external effects",
        parameters: Type.Object({}),
        execute: async () => {
          executions++;
          return {};
        },
      });
      const guard = defineExtension({
        name: "goal-safety-probe",
        tools: [action],
        hooks: [
          hook(GenerationTask, {
            [phase]: async () => {
              throw rejection;
            },
          }),
        ],
      });
      const { root, harness, faux, reports } = await open(
        [guard],
        [
          fauxAssistantMessage(fauxToolCall("action", {}, { id: "first" }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("action", {}, { id: "second" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("finished"),
        ],
      );
      const settled = await (await root.submit({ type: "input", content: "run" }, context)).wait(context);
      expect(settled.status).toBe("done");
      expect(faux.state.callCount).toBe(3);
      expect(executions).toBe(2);
      expect(reports).toEqual(Array(phase === "afterTools" ? 2 : 3).fill(rejection));
      const entries = (await root.context(context)).entries;
      expect(entries.filter(AssistantEntry.is)).toHaveLength(3);
      const usage = await harness.snapshot(UsageDoc, root.id, context);
      expect(Object.values(usage?.models ?? {}).reduce((sum, item) => sum + item.totalTokens, 0)).toBeGreaterThan(0);
    },
  );

  it("blocking a substantive tool prevents its effect but not another provider request", async () => {
    let executions = 0;
    const action = defineTool({
      name: "action",
      description: "Synthetic action with no external effects",
      parameters: Type.Object({}),
      execute: async () => {
        executions++;
        return {};
      },
    });
    const { root, faux } = await open(
      [
        defineExtension({
          name: "blocked-action-probe",
          tools: [action],
          hooks: [hook(ToolTask, { beforeTool: () => ({ block: "Goal limit exhausted" }) })],
        }),
      ],
      [
        fauxAssistantMessage(fauxToolCall("action", {}, { id: "blocked" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("provider still called"),
      ],
    );
    await (await root.submit({ type: "input", content: "run" }, context)).wait(context);
    expect(executions).toBe(0);
    expect(faux.state.callCount).toBe(2);
    const results = (await root.context(context)).entries.filter(ToolResultEntry.is);
    expect(results).toHaveLength(1);
    expect(results[0]?.data?.diagnostics).toEqual([expect.objectContaining({ code: "blocked" })]);
  });

  it("hook memos are write-once and belong to each generation, not the whole Goal", async () => {
    const observed: { taskId: TaskId; first: number | undefined; second: number | undefined }[] = [];
    const { root, faux } = await open(
      [
        defineExtension({
          name: "memo-probe",
          hooks: [
            hook(GenerationTask, {
              afterResponse: async (_message, api, ctx) => {
                observed.push({
                  taskId: api.taskId,
                  first: await api.memo("responses", 1, ctx),
                  second: await api.memo("responses", 2, ctx),
                });
              },
              onYield: async (_answer, api, ctx) => {
                const first = await api.memo("continue", true, ctx);
                // Bound the probe by the finite script, not by a supposed memo counter.
                if (first && faux.getPendingResponseCount() > 0) return { continue: "continue" };
                return undefined;
              },
            }),
          ],
        }),
      ],
      [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
    );
    await (await root.submit({ type: "input", content: "run" }, context)).wait(context);
    expect(observed).toHaveLength(2);
    expect(new Set(observed.map((item) => item.taskId)).size).toBe(2);
    expect(observed.map(({ first, second }) => [first, second])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it("deferred polling bypasses beforeRequest", async () => {
    let requests = 0;
    let responses = 0;
    const { root, faux } = await open(
      [
        defineExtension({
          name: "deferred-probe",
          hooks: [
            hook(GenerationTask, {
              beforeRequest: () => {
                requests++;
              },
              afterResponse: () => {
                responses++;
              },
            }),
          ],
        }),
      ],
      [fauxAssistantMessage("deferred answer")],
      { stream: { deferred: true } },
    );
    expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
    expect(faux.state.callCount).toBe(1);
    expect(faux.state.deferredFetchCount).toBe(3);
    expect(requests).toBe(1);
    expect(responses).toBe(1);
  });

  it("a rejected beforeRequest is skipped again on a transient retry", async () => {
    let requests = 0;
    const rejection = new Error("Goal cannot admit another request");
    const { root, faux, reports } = await open(
      [
        defineExtension({
          name: "retry-probe",
          hooks: [
            hook(GenerationTask, {
              beforeRequest: () => {
                requests++;
                throw rejection;
              },
            }),
          ],
        }),
      ],
      [
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }),
        fauxAssistantMessage("retry answer"),
      ],
      { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } },
    );
    expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
    expect(faux.state.callCount).toBe(2);
    expect(requests).toBe(2);
    expect(reports).toEqual([rejection, rejection]);
  });

  it("compaction sends a provider request without generation hooks and skips a throwing selection hook", async () => {
    let generationRequests = 0;
    let selections = 0;
    const rejection = new Error("Goal compaction budget exhausted");
    const { root, harness, faux, reports } = await open(
      [
        defineExtension({
          name: "compaction-probe",
          hooks: [
            hook(GenerationTask, {
              beforeRequest: () => {
                generationRequests++;
              },
            }),
            hook(CompactionTask, {
              beforeCompact: () => {
                selections++;
                throw rejection;
              },
            }),
          ],
        }),
      ],
      [fauxAssistantMessage("summary")],
    );
    await root.commit(async (tx) => {
      for (const text of ["old context", "recent context"]) {
        await tx.appendEntry(UserEntry, root.id, {
          model: [{ role: "user", content: text.repeat(100), timestamp: 0 }],
        });
      }
    }, context);
    const taskId = await root.compact(undefined, context);
    expect((await harness.waitForTask(taskId, context)).state.outcome.status).toBe("completed");
    await root.waitForIdle(context);
    expect(faux.state.callCount).toBe(1);
    expect(generationRequests).toBe(0);
    expect(selections).toBe(1);
    expect(reports).toEqual([rejection]);
    expect((await root.context(context)).entries.some(CompactionEntry.is)).toBe(true);
  });
});
