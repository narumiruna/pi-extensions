import assert from "node:assert/strict";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { INTERACTION_CONTRACT_MESSAGE_TYPE } from "../src/interaction-contract.js";
import { MODE_CONTRACT_MESSAGE_TYPE, modeContractContent } from "../src/mode-contract.js";
import planMode from "../src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";
import { nativeTool } from "./tool-exposure-support.js";

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
    tools: Array<{ name: string; description: unknown; parameters: unknown; constrainedSampling: unknown }>;
    messages: unknown[];
  };
}

function normalizedMessages(messages: unknown[]) {
  return convertToLlm(messages as Parameters<typeof convertToLlm>[0]).map(({ role, content }) => ({
    role,
    content: structuredClone(content),
  }));
}

function sentCustomMessages(mock: ReturnType<typeof createMockPi>): Record<string, unknown>[] {
  return mock.sentMessages.map(({ message }) => ({ role: "custom", ...(message as Record<string, unknown>) }));
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
  const orderedDefinitions = activeTools.map((name) => snapshotToolDefinition(name, toolByName.get(name)));
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
      messages: normalizedMessages(visibleMessages),
    },
  };
}

function snapshotToolDefinition(name: string, tool: Record<string, unknown> | undefined) {
  return structuredClone({
    name,
    description: tool?.description,
    parameters: tool?.parameters,
    constrainedSampling: tool?.constrainedSampling,
  });
}

async function completePlan(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(complete);
  await complete("complete", { plan: "# Cache-stable plan" }, undefined, undefined, ctx);
}

test("captured tool definitions retain their values after nested schema changes", async () => {
  const label = { type: "string", description: "Original label" };
  const tool = { ...builtinTool("read"), parameters: { properties: { label } } };
  const mock = createMockPi({ activeTools: ["read"], allTools: [tool] });
  const context = createMockContext();
  const first = await captureRequest("normal", mock, context.ctx, []);
  label.description = "New label";
  const second = await captureRequest("normal", mock, context.ctx, []);

  assert.notDeepEqual(first.providerPayload.tools, second.providerPayload.tools);
  assert.partialDeepStrictEqual(first.providerPayload.tools[0]?.parameters, {
    properties: { label: { description: "Original label" } },
  });
});

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
    return snapshotToolDefinition(name, tool);
  });

  const request = await captureRequest("plan", mock, context.ctx, [
    { role: "user", content: "Inspect with the late tool" },
  ]);

  assert.deepEqual(request.activeTools, activeBeforeContext);
  assert.deepEqual(request.providerPayload.tools, definitionsBeforeContext);
  assert.deepEqual(activeToolWrites, []);
});

test("native callable admission preserves normalized request definitions and retained prefix", async () => {
  const allTools = [
    builtinTool("read"),
    nativeTool("codemode", "model-only", "codemode"),
    nativeTool("mcp__docs__read", "codemode"),
  ];
  const mock = createMockPi({ activeTools: ["read", "codemode"], allTools });
  const writes: string[][] = [];
  mock.rawPi.setActiveTools = (names) => {
    writes.push(names);
  };
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, defaultPlanTools: ["codemode", "mcp__docs__read"] },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  try {
    const prefix = [
      { role: "user", content: "Before planning" },
      { role: "assistant", content: "Existing response" },
    ];
    const normal = await captureRequest("normal", mock, context.ctx, prefix);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    const transitions = sentCustomMessages(mock);
    assert.deepEqual(
      transitions.map((message) => message.customType),
      [MODE_CONTRACT_MESSAGE_TYPE, INTERACTION_CONTRACT_MESSAGE_TYPE],
    );
    const contract = transitions.find((message) => message.customType === MODE_CONTRACT_MESSAGE_TYPE);
    const firstMessages = [...prefix, ...transitions, { role: "user", content: "Inspect" }];
    const first = await captureRequest("plan", mock, context.ctx, firstMessages);
    assert.deepEqual(first.providerPayload.messages, normalizedMessages(firstMessages));
    const second = await captureRequest("plan", mock, context.ctx, [
      ...first.messages,
      { role: "assistant", content: "Inspection" },
      { role: "user", content: "Continue" },
    ]);
    for (const request of [first, second]) {
      assert.equal(request.systemPrompt, normal.systemPrompt);
      assert.deepEqual(request.providerPayload.tools, normal.providerPayload.tools);
      assert.deepEqual(request.activePromptMetadata, normal.activePromptMetadata);
      assert.deepEqual(request.providerPayload.messages.slice(0, prefix.length), normal.providerPayload.messages);
    }
    assert.deepEqual(
      second.providerPayload.messages.slice(0, first.providerPayload.messages.length),
      first.providerPayload.messages,
    );
    assert.match(JSON.stringify(contract), /registered codemode or deferred tools/);
    assert.match(JSON.stringify(contract), /nested call/);
    assert.deepEqual(writes, []);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "exit" }, context.ctx);
  }
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
  const activation = sentCustomMessages(mock);
  assert.deepEqual(
    activation.map((message) => message.customType),
    [MODE_CONTRACT_MESSAGE_TYPE, INTERACTION_CONTRACT_MESSAGE_TYPE],
  );
  const planMessages = [...normal.messages, ...activation, { role: "user", content: "B" }];
  const plan = await captureRequest("plan", mock, context.ctx, planMessages);
  // Plan mode adds a message to the request without changing the leading system prompt.
  assert.deepEqual(plan.providerPayload.messages[normal.providerPayload.messages.length], {
    role: "user",
    content: [{ type: "text", text: modeContractContent("plan") }],
  });
  assert.deepEqual(plan.providerPayload.messages, normalizedMessages(planMessages));
  assert.deepEqual(
    plan.providerPayload.messages.slice(0, normal.providerPayload.messages.length),
    normal.providerPayload.messages,
  );
  const nextPlanMessages = [...plan.messages, { role: "user", content: "C" }];
  const nextPlan = await captureRequest("plan", mock, context.ctx, nextPlanMessages);
  assert.equal(nextPlan.systemPrompt, plan.systemPrompt);
  assert.deepEqual(nextPlan.activeTools, plan.activeTools);
  assert.equal(nextPlan.providerPayload.instructions, plan.providerPayload.instructions);
  assert.deepEqual(nextPlan.providerPayload.tools, plan.providerPayload.tools);
  assert.deepEqual(nextPlan.providerPayload.messages, normalizedMessages(nextPlanMessages));
  assert.deepEqual(
    nextPlan.providerPayload.messages.slice(0, plan.providerPayload.messages.length),
    plan.providerPayload.messages,
  );

  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("implement", context.ctx);
  const transitions = sentCustomMessages(mock);
  assert.deepEqual(
    transitions.map((message) => message.customType),
    [MODE_CONTRACT_MESSAGE_TYPE, INTERACTION_CONTRACT_MESSAGE_TYPE, MODE_CONTRACT_MESSAGE_TYPE],
  );
  const implementationMessages = [
    ...nextPlan.messages,
    ...transitions.slice(activation.length),
    ...mock.sentUserMessages.map(({ text }) => ({ role: "user", content: text })),
  ];
  const implementation = await captureRequest("implementation", mock, context.ctx, implementationMessages);
  assert.deepEqual(implementation.providerPayload.messages, normalizedMessages(implementationMessages));
  assert.deepEqual(
    implementation.providerPayload.messages.slice(0, nextPlan.providerPayload.messages.length),
    nextPlan.providerPayload.messages,
  );

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
  assert.deepEqual(implementation.providerPayload.messages[nextPlan.providerPayload.messages.length], {
    role: "user",
    content: [{ type: "text", text: modeContractContent("normal") }],
  });
  assert.deepEqual(
    implementation.messages
      .filter((message) => (message as { role?: string }).role === "user")
      .map((message) => (message as { content?: unknown }).content),
    ["A", "B", "C", "Implement the plan."],
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
  const questionDefinition = nextPlan.providerPayload.tools.find((tool) => tool.name === "plan_mode_question");
  assert.partialDeepStrictEqual(questionDefinition?.parameters, {
    properties: {
      questions: {
        items: {
          properties: {
            options: {
              items: {
                properties: {
                  label: {
                    type: "string",
                    description:
                      "Plain-text label (1-5 words) with no list numbers or bullets. The questionnaire adds the numbers.",
                  },
                },
              },
            },
          },
        },
      },
    },
  });
});
