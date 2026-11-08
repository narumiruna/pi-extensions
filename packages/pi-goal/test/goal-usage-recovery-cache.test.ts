import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerGoalWithSettingsPath, settingsPath } from "./support/goal-fixture.js";

const RETRY_MS = 15 * 60 * 1000;

test("quota waits and repeated scheduled requests preserve the normalized provider prefix and helper definitions", async () => {
  vi.useFakeTimers();
  const path = settingsPath("quota-cache-contract.json");
  writeFileSync(path, '{"retryUsageLimits":true}\n');
  const mock = createMockPi();
  registerGoalWithSettingsPath(mock.pi, path);
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "quota-test", api: "openai-codex-responses" },
  });
  const emit = async (name: string, event: unknown) => await mock.events.get(name)?.[0]?.(event, ctx);
  await emit("session_start", {});
  try {
    await mock.commands.get("goal")?.handler("preserve cache through quota recovery", ctx);
    let history: unknown[] = [];
    let previous: Record<string, unknown> | undefined;
    const activeTools = mock.rawPi.getActiveTools();
    const tools = mock.tools.flatMap((tool) =>
      typeof tool.name === "string" && activeTools.includes(tool.name)
        ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }]
        : [],
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = mock.sentUserMessages.at(-1)?.text ?? "";
      history.push({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
      const boundary = (await emit("before_agent_start", { prompt, systemPrompt: "stable base" })) as
        | { message?: unknown; systemPrompt?: string }
        | undefined;
      if (boundary?.message) history.push(boundary.message);
      await emit("agent_start", {});
      const transformed = (await emit("context", { messages: history })) as { messages?: unknown[] } | undefined;
      history = transformed?.messages ?? history;
      const input = convertToLlm(history as never);
      // Capture at Pi AI's payload boundary and stop before any transport request.
      const apiModule = "@earendil-works/pi-ai/api/openai-responses";
      const { streamSimple } = await import(apiModule);
      let payload: Record<string, unknown> | undefined;
      const stream = streamSimple(
        {
          id: "quota-cache-test",
          name: "Quota cache test",
          api: "openai-responses",
          provider: "quota-cache-test",
          baseUrl: "http://capture.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 1000,
        },
        { systemPrompt: boundary?.systemPrompt ?? "stable base", messages: input, tools },
        {
          apiKey: "capture-only",
          onPayload(value: unknown) {
            payload = value as Record<string, unknown>;
            throw new Error("captured before transport");
          },
        },
      );
      for await (const event of stream) if (event.type === "error") break;
      assert.ok(payload);
      assert.deepEqual(mock.rawPi.getActiveTools(), activeTools);
      if (previous) {
        assert.equal(payload.instructions, previous.instructions);
        assert.deepEqual(payload.tools, previous.tools);
        assert.deepEqual((payload.input as unknown[]).slice(0, (previous.input as unknown[]).length), previous.input);
      }
      previous = payload;
      const message = {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Codex error: The usage limit has been reached",
        api: "openai-responses",
        provider: "quota-cache-test",
        model: "quota-cache-test",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      history.push(message);
      await emit("turn_end", { message, toolResults: [] });
      await emit("agent_end", { messages: [message] });
      await emit("agent_settled", {});
      if (attempt < 2) await vi.advanceTimersByTimeAsync(RETRY_MS);
    }
    assert.equal(mock.sentUserMessages.length, 3);
  } finally {
    await emit("session_shutdown", {});
    assert.equal(vi.getTimerCount(), 0);
    vi.useRealTimers();
  }
});
