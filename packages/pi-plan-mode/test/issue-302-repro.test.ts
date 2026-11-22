import assert from "node:assert/strict";
import { test } from "vitest";
import { interactionContractFromMessage } from "../src/interaction-contract.js";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi, updateThenCompletePlan } from "./support.js";

test("issue 302: history-only implementation stays ordinary context when Plan Mode restarts", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
  planMode(mock.pi);
  const context = createMockContext();

  await mock.commands.get("plan")?.handler("start", context.ctx);
  await updateThenCompletePlan(mock, context.ctx, "# Plan Mode repro");

  await mock.commands.get("plan")?.handler("implement", context.ctx);
  const implementationHandoff = mock.sentUserMessages.at(-1)?.text ?? "";
  assert.equal(implementationHandoff, "Implement the plan.");
  assert.equal(context.statuses.get("plan-mode"), undefined);

  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  const implementationMessages = [
    { role: "user", content: "Plan a one-line README change." },
    { role: "user", content: implementationHandoff },
    { role: "assistant", content: "Implemented the requested plan." },
  ];
  const inactiveContext = (await contextHook({ messages: implementationMessages }, context.ctx)) as {
    messages: unknown[];
  };
  assert.deepEqual(inactiveContext.messages.slice(0, -1), implementationMessages);
  assert.match(JSON.stringify(inactiveContext.messages.at(-1)), /CONTRACT v1: NORMAL/u);

  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.deepEqual(mock.rawPi.getActiveTools(), [
    "read",
    "bash",
    "custom",
    "plan_mode_question",
    "plan_mode_update",
    "plan_mode_complete",
  ]);

  const beforeStart = mock.events.get("before_agent_start")?.[0];
  assert.ok(beforeStart);
  const promptResult = beforeStart({ systemPrompt: "base" }, context.ctx) as { systemPrompt?: string } | undefined;
  assert.equal(promptResult?.systemPrompt, undefined);

  const activeMessages = [...inactiveContext.messages, { role: "user", content: "continue" }];
  const activeContext = (await contextHook({ messages: activeMessages }, context.ctx)) as {
    messages: unknown[];
  };

  assert.deepEqual(activeContext.messages.slice(0, -2), activeMessages);
  assert.match(JSON.stringify(activeContext.messages.at(-2)), /CONTRACT v2: PLAN/u);
  assert.equal(interactionContractFromMessage(activeContext.messages.at(-1)), "questions");
  assert.equal(activeContext.messages.length, activeMessages.length + 2);
  assert.match(JSON.stringify(activeContext.messages), /Implement the plan\./);
});
