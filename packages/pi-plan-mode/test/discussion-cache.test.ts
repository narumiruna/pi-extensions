import assert from "node:assert/strict";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

test("question/discussion transitions preserve normalized prompt, tools, and the complete request prefix", async () => {
  const mock = createMockPi({
    activeTools: ["read", "bash", "edit"],
    allTools: [builtinTool("read"), builtinTool("bash"), builtinTool("edit")],
  });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" }) });
  const context = createMockContext({ mode: "tui", hasUI: true });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  const messages: unknown[] = [
    { role: "user", content: "Original request", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], timestamp: 1 },
  ];
  let sent = 0;
  const flushContracts = () => {
    for (const item of mock.sentMessages.slice(sent))
      messages.push({ ...(item.message as object), role: "custom", timestamp: 0 });
    sent = mock.sentMessages.length;
  };
  const snapshot = async () => {
    const before = (await mock.events.get("before_agent_start")?.[0]?.(
      { messageType: "user", prompt: "Discuss", systemPrompt: "unchanged leading prompt" },
      context.ctx,
    )) as { systemPrompt?: string } | undefined;
    const result = (await mock.events.get("context")?.[0]?.({ messages: structuredClone(messages) }, context.ctx)) as {
      messages: unknown[];
    };
    const active = mock.rawPi.getActiveTools();
    const all = new Map(
      [...mock.rawPi.getAllTools(), ...mock.tools].map((tool) => [
        (tool as { name: string }).name,
        tool as Record<string, unknown>,
      ]),
    );
    return {
      system: before?.systemPrompt ?? "unchanged leading prompt",
      active,
      definitions: active.map((name) => {
        const tool = all.get(name);
        return {
          name,
          description: tool?.description,
          parameters: tool?.parameters,
          constrainedSampling: tool?.constrainedSampling,
        };
      }),
      promptMetadata: active.map((name) => ({
        name,
        promptSnippet: all.get(name)?.promptSnippet,
        promptGuidelines: all.get(name)?.promptGuidelines,
      })),
      messages: convertToLlm(result.messages as never).map(({ role, content }) => ({ role, content })),
    };
  };
  try {
    const normal = await snapshot();
    await mock.commands.get("plan")?.handler("start", context.ctx);
    flushContracts();
    const first = await snapshot();
    assert.deepEqual(first.messages.slice(0, normal.messages.length), normal.messages);
    const toggle = mock.shortcuts.get("f2");
    assert.ok(toggle);
    let previous = first;
    for (const mode of ["discussion", "discussion", "questions", "questions"] as const) {
      if (mode === "discussion" && context.statuses.get("plan-mode") !== "plan discussion")
        await toggle.handler(context.ctx);
      if (mode === "questions" && context.statuses.get("plan-mode") === "plan discussion")
        await toggle.handler(context.ctx);
      flushContracts();
      messages.push({ role: "user", content: `${mode} follow-up ${messages.length}`, timestamp: messages.length });
      const beforeCount = mock.sentMessages.length;
      const next = await snapshot();
      assert.equal(next.system, normal.system);
      assert.deepEqual(next.active, normal.active);
      assert.deepEqual(next.definitions, normal.definitions);
      assert.deepEqual(next.promptMetadata, normal.promptMetadata);
      assert.deepEqual(next.messages.slice(0, previous.messages.length), previous.messages);
      assert.equal(mock.sentMessages.length, beforeCount, "ordinary requests don't republish retained contracts");
      previous = next;
    }
    assert.equal(mock.sentMessages.length, 4, "base Plan, initial questions, discussion, resumed questions only");
    assert.equal(mock.sentUserMessages.length, 0);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
  }
});
