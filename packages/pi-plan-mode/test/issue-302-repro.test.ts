import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

test("issue 302: history-only implementation stays ordinary context when Plan Mode restarts", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
  planMode(mock.pi);
  const context = createMockContext();

  await mock.commands.get("plan")?.handler("start", context.ctx);
  const executeComplete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(executeComplete);
  await executeComplete("complete", { plan: "# Plan Mode repro" }, undefined, undefined, context.ctx);

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
  assert.match(JSON.stringify(inactiveContext.messages[0]), /CONTRACT v1: NORMAL/u);
  assert.deepEqual(inactiveContext.messages.slice(1), implementationMessages);

  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "custom", "plan_mode_question", "plan_mode_complete"]);

  const beforeStart = mock.events.get("before_agent_start")?.[0];
  assert.ok(beforeStart);
  const promptResult = beforeStart({ systemPrompt: "base" }, context.ctx) as { systemPrompt?: string } | undefined;
  assert.equal(promptResult?.systemPrompt, undefined);

  const activeMessages = [...implementationMessages, { role: "user", content: "continue" }];
  const activeContext = (await contextHook({ messages: activeMessages }, context.ctx)) as {
    messages: unknown[];
  };

  assert.match(JSON.stringify(activeContext.messages[0]), /CONTRACT v1: PLAN/u);
  assert.deepEqual(activeContext.messages.slice(1), activeMessages);
  assert.match(JSON.stringify(activeContext.messages), /Implement the plan\./);
});
