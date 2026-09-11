import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

interface CapturedRequest {
  phase: "normal" | "plan" | "implementation";
  activeTools: string[];
  systemPrompt: string;
  messages: unknown[];
  activePromptMetadata: Array<{
    name: string;
    promptSnippet: unknown;
    promptGuidelines: unknown;
  }>;
  providerPayload: {
    instructions: string;
    tools: Array<{ name: string; description: unknown; parameters: unknown }>;
    messages: unknown[];
  };
}

async function captureRequest(
  phase: CapturedRequest["phase"],
  mock: ReturnType<typeof createMockPi>,
  ctx: ReturnType<typeof createMockContext>["ctx"],
  messages: unknown[],
): Promise<CapturedRequest> {
  const baseSystemPrompt = "stable base system prompt";
  const beforeStart = mock.events.get("before_agent_start")?.[0];
  const contextHook = mock.events.get("context")?.[0];
  const beforeResult = (await beforeStart?.({ prompt: phase, systemPrompt: baseSystemPrompt }, ctx)) as
    | { systemPrompt?: string }
    | undefined;
  const contextResult = (await contextHook?.({ messages }, ctx)) as { messages?: unknown[] } | undefined;
  const activeTools = mock.rawPi.getActiveTools();
  const allTools = [...mock.rawPi.getAllTools(), ...mock.tools];
  const toolByName = new Map(
    allTools.map((tool) => [(tool as { name: string }).name, tool as Record<string, unknown>]),
  );
  const orderedDefinitions = activeTools.map((name) => {
    const tool = toolByName.get(name);
    return { name, description: tool?.description, parameters: tool?.parameters };
  });
  const systemPrompt = beforeResult?.systemPrompt ?? baseSystemPrompt;
  const visibleMessages = contextResult?.messages ?? messages;
  return {
    phase,
    activeTools,
    systemPrompt,
    messages: visibleMessages,
    activePromptMetadata: activeTools.map((name) => {
      const tool = toolByName.get(name);
      return {
        name,
        promptSnippet: tool?.promptSnippet,
        promptGuidelines: tool?.promptGuidelines,
      };
    }),
    providerPayload: {
      instructions: systemPrompt,
      tools: orderedDefinitions,
      messages: visibleMessages,
    },
  };
}

async function completePlan(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(complete);
  await complete("complete", { plan: "# Cache-stable plan" }, undefined, undefined, ctx);
}

test("first-context policy resolution does not mutate late active tool schemas", async () => {
  const allTools = [builtinTool("read")];
  const mock = createMockPi({ activeTools: ["read"], allTools });
  const activeToolWrites: string[][] = [];
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (names) => {
    activeToolWrites.push([...names]);
    setActiveTools(names);
  };
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, defaultPlanTools: ["late_tool"] },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  allTools.push(extensionTool("late_tool"));
  setActiveTools([...mock.rawPi.getActiveTools(), "late_tool"]);
  const activeBeforeContext = mock.rawPi.getActiveTools();
  const definitionsBeforeContext = activeBeforeContext.map((name) => {
    const tool = [...allTools, ...mock.tools].find((candidate) => candidate.name === name) as
      | Record<string, unknown>
      | undefined;
    return { name, description: tool?.description, parameters: tool?.parameters };
  });

  const request = await captureRequest("plan", mock, context.ctx, [
    { role: "user", content: "Inspect with the late tool" },
  ]);

  assert.deepEqual(request.activeTools, activeBeforeContext);
  assert.deepEqual(request.providerPayload.tools, definitionsBeforeContext);
  assert.deepEqual(activeToolWrites, []);
});

test("stable Plan helper schema keeps request fields and inactive metadata safe", async () => {
  const allTools = [builtinTool("read"), builtinTool("bash"), builtinTool("edit"), builtinTool("write")];
  const mock = createMockPi({ activeTools: ["read", "bash", "edit", "write"], allTools });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

  const normal = await captureRequest("normal", mock, context.ctx, [{ role: "user", content: "A" }]);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const planContract = mock.sentMessages.at(-1)?.message;
  const plan = await captureRequest("plan", mock, context.ctx, [
    { role: "user", content: "A" },
    planContract,
    { role: "user", content: "B" },
  ]);
  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("implement", context.ctx);
  const normalContract = mock.sentMessages.at(-1)?.message;
  const implementation = await captureRequest("implementation", mock, context.ctx, [
    { role: "user", content: "A" },
    planContract,
    { role: "user", content: "B" },
    normalContract,
    { role: "user", content: "Implement the plan." },
  ]);

  assert.deepEqual(plan.activeTools, normal.activeTools);
  assert.deepEqual(implementation.activeTools, normal.activeTools);
  assert.equal(plan.systemPrompt, normal.systemPrompt);
  assert.equal(implementation.systemPrompt, normal.systemPrompt);
  assert.deepEqual(plan.providerPayload.tools, normal.providerPayload.tools);
  assert.deepEqual(implementation.providerPayload.tools, normal.providerPayload.tools);
  assert.deepEqual(plan.activePromptMetadata, normal.activePromptMetadata);
  assert.deepEqual(implementation.activePromptMetadata, normal.activePromptMetadata);
  assert.equal(plan.providerPayload.instructions, normal.providerPayload.instructions);
  assert.equal(implementation.providerPayload.instructions, normal.providerPayload.instructions);
  assert.match(JSON.stringify(plan.messages), /CONTRACT v1: PLAN/u);
  assert.match(JSON.stringify(implementation.messages), /CONTRACT v1: NORMAL/u);
  assert.match(JSON.stringify(implementation.messages), /CONTRACT v1: PLAN/u);
  assert.deepEqual(
    implementation.messages
      .filter((message) => (message as { role?: string }).role === "user")
      .map((message) => (message as { content?: unknown }).content),
    ["A", "B", "Implement the plan."],
  );
  const helperMetadata = normal.activePromptMetadata.filter((tool) => tool.name.startsWith("plan_mode_"));
  assert.equal(helperMetadata.length, 2);
  assert.ok(helperMetadata.every((tool) => tool.promptSnippet === undefined && tool.promptGuidelines === undefined));
  const helperDefinitions = normal.providerPayload.tools.filter((tool) => tool.name.startsWith("plan_mode_"));
  assert.ok(
    helperDefinitions.every((tool) =>
      /tool visibility alone does not activate Plan mode/i.test(String(tool.description)),
    ),
  );
  assert.ok(helperDefinitions.every((tool) => /writing-plans skill/i.test(String(tool.description))));
});
