import { awaitWithContext } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type JsonObject, ToolResultEntry, wrapTool } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { PLAN_MODE_COMPLETE_PARAMS } from "../src/completion-domain.js";
import { createDurableTools } from "../src/durable-tools.js";
import { PLAN_MODE_QUESTION_PARAMS } from "../src/question-domain.js";
import {
  barrier,
  context,
  fauxAssistantMessage,
  fauxToolCall,
  fixture,
  WorkflowDoc,
} from "./durable-policy-support.js";
import { required } from "./durable-test-values.js";

const completeTarget = defineTool({
  name: "plan_mode_complete",
  description: "Wrapper target",
  parameters: PLAN_MODE_COMPLETE_PARAMS,
  execute: async () => ({}),
});

const questions = {
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which scope?",
      options: [
        { label: "Small", description: "Limit changes." },
        { label: "Large", description: "Include more changes." },
      ],
    },
  ],
};

describe("native durable Plan helpers", () => {
  it("keeps helper schemas stable, model-only, and free of prompt metadata", async () => {
    const f = await fixture();
    const tools = createDurableTools(f.options);
    expect(tools.map((tool) => tool.name)).toEqual(["plan_mode_question", "plan_mode_complete"]);
    expect(tools.map((tool) => tool.parameters)).toEqual([PLAN_MODE_QUESTION_PARAMS, PLAN_MODE_COMPLETE_PARAMS]);
    for (const tool of tools) {
      expect(tool.callers).toEqual(["model"]);
      expect(tool.replay).toBe("safe");
      expect(tool).not.toHaveProperty("promptSnippet");
      expect(tool).not.toHaveProperty("promptGuidelines");
    }
  });

  it.each(["question", "complete"] as const)("persists %s before its terminating acknowledgment", async (kind) => {
    const f = await fixture();
    await f.activate();
    await f.call(`plan_mode_${kind}`, kind === "question" ? questions : { plan: "  Exact accepted plan.\n" });
    const state = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    expect(state?.phase).toBe(kind === "question" ? "awaiting_answers" : "ready");
    expect(state?.revision).toBe(2);
    expect(state?.helperReceipts).toHaveLength(1);
    if (kind === "complete") expect(state?.plan).toBe("  Exact accepted plan.\n");
    else expect(state?.question?.questions).toEqual(questions.questions);
    const results = (await f.root.context(context)).entries.filter((entry) => ToolResultEntry.is(entry));
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(kind === "question" ? "Which scope?" : "Exact accepted plan");
    expect(JSON.stringify(results[0])).toContain("Await host");
  });

  it("stores an exact 50,000-character multibyte/multiline plan without returning it", async () => {
    const f = await fixture();
    await f.activate();
    const plan = "界\n".repeat(25_000);
    await f.call("plan_mode_complete", { plan });
    expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.plan).toBe(plan);
    const results = (await f.root.context(context)).entries.filter((entry) => ToolResultEntry.is(entry));
    const text = JSON.stringify(results);
    expect(Buffer.byteLength(text)).toBeLessThan(50 * 1024);
    expect(text.split("\n").length).toBeLessThan(2_000);
  });

  it.each<[string, JsonObject]>([
    ["plan_mode_complete", { plan: "   " }],
    ["plan_mode_complete", { plan: "x".repeat(50_001) }],
    ["plan_mode_question", { questions: [] }],
    ["plan_mode_question", { questions: [{ ...questions.questions[0], id: "bad/id" }] }],
    ["plan_mode_question", { questions: [{ ...questions.questions[0], question: "x".repeat(1_001) }] }],
  ])("rejects invalid %s payload without a workflow mutation", async (name, payload) => {
    const f = await fixture();
    await f.activate();
    await f.call(name, structuredClone(payload));
    const state = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    expect(state?.phase).toBe("planning");
    expect(state?.revision).toBe(1);
    expect(state?.helperReceipts).toEqual([]);
  });

  it.each(["same", "changed", "cancelled", "discarded"] as const)(
    "accepts only exact current-task replay: %s",
    async (replay) => {
      // Re-enter the production helper within one native invocation, with the same immutable task memo.
      const outcomes: boolean[] = [];
      const fake = completeTarget;
      const wrapping = defineExtension({
        name: "replay-fixture",
        wraps: [
          wrapTool(fake, (tool) => ({
            ...tool,
            execute: async (args, api, ctx) => {
              const result = await tool.execute(args, api, ctx);
              if (replay === "cancelled" || replay === "discarded")
                await api.commit(async (tx) => {
                  const state = await tx.doc(WorkflowDoc, api.conversationId);
                  state.revision++;
                  state.phase = replay === "cancelled" ? "planning" : "inactive";
                  if (replay === "discarded") state.closing = true;
                }, ctx);
              try {
                await tool.execute(replay === "changed" ? { plan: "different" } : args, api, ctx);
                outcomes.push(true);
              } catch {
                outcomes.push(false);
              }
              return result;
            },
          })),
        ],
      });
      const f = await fixture({ extensions: [wrapping] });
      await f.activate();
      await f.call("plan_mode_complete", { plan: "Original plan" });
      expect(outcomes).toEqual([replay === "same"]);
      expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.helperReceipts).toHaveLength(1);
    },
  );

  it("replays an interrupted committed helper exactly after reopening a real Harness", async () => {
    const committed = barrier();
    let executions = 0;
    const wrapping = defineExtension({
      name: "crash-fixture",
      wraps: [
        wrapTool(completeTarget, (tool) => ({
          ...tool,
          execute: async (args, api, ctx) => {
            const result = await tool.execute(args, api, ctx);
            executions++;
            if (executions === 1) {
              committed.resolve();
              await awaitWithContext(new Promise<never>(() => {}), ctx);
            }
            return result;
          },
        })),
      ],
    });
    const f = await fixture({ extensions: [wrapping] });
    await f.activate();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "Durable exact plan" }, { id: "complete" }), {
        stopReason: "toolUse",
      }),
    ]);
    const submission = await f.root.submit({ type: "input", content: "propose" }, context);
    await committed.promise;
    expect((await f.harness.snapshot(WorkflowDoc, f.root.id, context))?.phase).toBe("ready");
    await f.harness.close(context);
    const reopened = await f.open();
    await required(await reopened.submission(submission.id, context)).wait(context);
    const state = await reopened.snapshot(WorkflowDoc, f.root.id, context);
    expect(executions).toBe(2);
    expect(state?.revision).toBe(2);
    expect(state?.helperReceipts).toHaveLength(1);
  });

  it("rejects stale helpers in mixed parallel rounds without claiming termination cancels siblings", async () => {
    const f = await fixture();
    await f.activate();
    f.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("plan_mode_complete", { plan: "First plan" }, { id: "complete" }),
          fauxToolCall("plan_mode_question", questions, { id: "question" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("plan_mode_complete", { plan: "Unapproved replacement" }, { id: "stale-complete" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("finished"),
    ]);
    await (await f.root.submit({ type: "input", content: "propose" }, context)).wait(context);
    const state = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    expect(state?.helperReceipts).toHaveLength(1);
    expect(state?.revision).toBe(2);
    expect(["ready", "awaiting_answers"]).toContain(state?.phase);
    expect(state?.plan).not.toBe("Unapproved replacement");
  });

  it("finalizes an exact pending start delivery before helper revision changes", async () => {
    const f = await fixture();
    await f.activate();
    await f.root.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, f.root.id);
      state.delivery = {
        kind: "start",
        operationId: "start",
        requestId: "start-input",
        revision: 1,
        content: "Plan this",
      };
      state.receipts.push({
        kind: "start",
        operationId: "start",
        requestId: "start-input",
        revision: 1,
        fingerprint: "fixture",
        status: "pending",
      });
    }, context);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "Plan" }, { id: "finish" }), {
        stopReason: "toolUse",
      }),
    ]);
    await (
      await f.root.submit(
        {
          type: "input",
          requestId: "start-input",
          content: "Plan this",
          entry: { kind: "plan-mode.input", data: { workflowId: "workflow", revision: 1, operationId: "start" } },
        },
        context,
      )
    ).wait(context);
    const state = await f.harness.snapshot(WorkflowDoc, f.root.id, context);
    expect(state?.phase).toBe("ready");
    expect(state?.delivery).toBeUndefined();
    expect(state?.receipts[0]?.status).toBe("done");
    expect(state?.receipts[0]?.submissionId).toBeDefined();
  });
});
