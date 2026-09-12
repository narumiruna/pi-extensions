import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import type { StampSettingsRuntime, StampSettingsState } from "../src/settings.js";
import stamp, { isToolStampData, MAX_TOOL_STAMP_OBSERVATIONS, STAMP_ENTRY_TYPE } from "../src/stamp.js";

const USER_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 7, 123).getTime();
const ASSISTANT_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 9, 456).getTime();

test("parallel tool stamps pair strictly by ID and append in source order after the tool block", async () => {
  const mock = createMockPi();
  const times = [USER_TIMESTAMP, USER_TIMESTAMP + 1_000, USER_TIMESTAMP + 3_500, USER_TIMESTAMP + 4_000];
  stamp(mock.pi, {
    settingsRuntime: settingsRuntimeWithToolStamps(),
    now: () => times.shift() ?? assert.fail("Unexpected clock read"),
  });
  const { ctx } = createMockContext({ mode: "tui" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP, "toolUse");
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "turn_start", { turnIndex: 0, timestamp: ASSISTANT_TIMESTAMP }, ctx);
  await emit(mock, "tool_execution_start", { toolCallId: "call-a", toolName: "read", args: { path: "a" } }, ctx);
  await emit(mock, "tool_execution_start", { toolCallId: "call-b", toolName: "bash", args: { command: "b" } }, ctx);
  await emit(mock, "tool_execution_end", { toolCallId: "missing", toolName: "write", result: {}, isError: false }, ctx);
  await emit(mock, "tool_execution_end", { toolCallId: "call-b", toolName: "bash", result: {}, isError: true }, ctx);
  await emit(mock, "tool_execution_end", { toolCallId: "call-a", toolName: "read", result: {}, isError: false }, ctx);
  await emit(
    mock,
    "turn_end",
    {
      message: assistant,
      toolResults: [toolResultMessage("call-a", "read", false), toolResultMessage("call-b", "bash", true)],
      turnIndex: 0,
    },
    ctx,
  );
  assert.deepEqual(mock.entries, [
    stampEntry("assistant", ASSISTANT_TIMESTAMP),
    toolStampEntry("call-a", "read", USER_TIMESTAMP, USER_TIMESTAMP + 4_000, "success"),
    toolStampEntry("call-b", "bash", USER_TIMESTAMP + 1_000, USER_TIMESTAMP + 3_500, "error"),
  ]);
});

test("duplicate, malformed, and reversed tool events never create duplicate or fabricated stamps", async () => {
  const mock = createMockPi();
  const times = [USER_TIMESTAMP, USER_TIMESTAMP + 1_000];
  stamp(mock.pi, {
    settingsRuntime: settingsRuntimeWithToolStamps(),
    now: () => times.shift() ?? assert.fail("Unexpected clock read"),
  });
  const { ctx } = createMockContext({ mode: "tui" });
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  const start = { toolCallId: "call-1", toolName: "read", args: {} };
  await emit(mock, "tool_execution_start", start, ctx);
  await emit(mock, "tool_execution_start", start, ctx);
  const end = { toolCallId: "call-1", toolName: "read", result: {}, isError: false };
  await emit(mock, "tool_execution_end", end, ctx);
  await emit(mock, "tool_execution_end", { ...end, isError: true }, ctx);
  await emit(
    mock,
    "turn_end",
    {
      message: assistantMessage(ASSISTANT_TIMESTAMP, "toolUse"),
      toolResults: [toolResultMessage("call-1", "read", false), toolResultMessage("call-1", "read", false)],
      turnIndex: 0,
    },
    ctx,
  );
  assert.deepEqual(
    mock.entries.filter((entry) => isToolStampData(entry.data)),
    [toolStampEntry("call-1", "read", USER_TIMESTAMP, USER_TIMESTAMP + 1_000, "success")],
  );

  const reversed = createMockPi();
  const reversedTimes = [USER_TIMESTAMP + 1_000, USER_TIMESTAMP];
  stamp(reversed.pi, {
    settingsRuntime: settingsRuntimeWithToolStamps(),
    now: () => reversedTimes.shift() ?? assert.fail("Unexpected reversed clock read"),
  });
  await emit(reversed, "session_start", { reason: "startup" }, ctx);
  await emit(reversed, "tool_execution_start", { toolCallId: "call-reversed", toolName: "read", args: {} }, ctx);
  await emit(
    reversed,
    "tool_execution_end",
    { toolCallId: "call-reversed", toolName: "read", result: {}, isError: false },
    ctx,
  );
  await emit(reversed, "tool_execution_start", { toolCallId: "bad\u001b-id", toolName: "read", args: {} }, ctx);
  await emit(
    reversed,
    "turn_end",
    {
      message: assistantMessage(ASSISTANT_TIMESTAMP, "toolUse"),
      toolResults: [toolResultMessage("call-reversed", "read", false)],
      turnIndex: 0,
    },
    ctx,
  );
  assert.equal(reversed.entries.filter((entry) => isToolStampData(entry.data)).length, 0);
});

test("tool observation state is bounded and disabled stamps do not read the clock", async () => {
  const disabled = createMockPi();
  stamp(disabled.pi, {
    settingsRuntime: settingsRuntimeWithToolStamps(false),
    now: () => assert.fail("Disabled tool stamps must not read the clock"),
  });
  const disabledContext = createMockContext({ mode: "tui" });
  await emit(disabled, "session_start", { reason: "startup" }, disabledContext.ctx);
  await emit(
    disabled,
    "tool_execution_start",
    { toolCallId: "call-disabled", toolName: "read", args: {} },
    disabledContext.ctx,
  );
  await emit(
    disabled,
    "tool_execution_end",
    { toolCallId: "call-disabled", toolName: "read", result: {}, isError: false },
    disabledContext.ctx,
  );

  const bounded = createMockPi();
  let now = USER_TIMESTAMP;
  stamp(bounded.pi, {
    settingsRuntime: settingsRuntimeWithToolStamps(),
    now: () => now++,
  });
  const { ctx } = createMockContext({ mode: "tui" });
  await emit(bounded, "session_start", { reason: "startup" }, ctx);
  const results = [];
  for (let index = 0; index <= MAX_TOOL_STAMP_OBSERVATIONS; index += 1) {
    const toolCallId = `call-${index}`;
    await emit(bounded, "tool_execution_start", { toolCallId, toolName: "read", args: {} }, ctx);
    results.push(toolResultMessage(toolCallId, "read", false));
  }
  for (let index = MAX_TOOL_STAMP_OBSERVATIONS; index >= 0; index -= 1) {
    await emit(
      bounded,
      "tool_execution_end",
      { toolCallId: `call-${index}`, toolName: "read", result: {}, isError: false },
      ctx,
    );
  }
  await emit(
    bounded,
    "turn_end",
    {
      message: assistantMessage(ASSISTANT_TIMESTAMP, "toolUse"),
      toolResults: results,
      turnIndex: 0,
    },
    ctx,
  );
  const tools = bounded.entries.filter((entry) => isToolStampData(entry.data));
  assert.equal(tools.length, MAX_TOOL_STAMP_OBSERVATIONS);
  const first = tools[0];
  const last = tools.at(-1);
  assert.ok(first && isToolStampData(first.data));
  assert.ok(last && isToolStampData(last.data));
  assert.equal(first.data.toolCallId, "call-0");
  assert.equal(last.data.toolCallId, `call-${MAX_TOOL_STAMP_OBSERVATIONS - 1}`);
});

test("turn replacement, cancellation, session replacement, and shutdown clear pending tools", async () => {
  const terminals = ["turn_start", "agent_end", "session_start", "session_shutdown"] as const;
  for (const terminal of terminals) {
    const mock = createMockPi();
    let now = USER_TIMESTAMP;
    stamp(mock.pi, {
      settingsRuntime: settingsRuntimeWithToolStamps(),
      now: () => now++,
    });
    const { ctx } = createMockContext({ mode: "tui" });
    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "tool_execution_start", { toolCallId: "call-stale", toolName: "read", args: {} }, ctx);
    if (terminal === "turn_start") {
      await emit(mock, terminal, { turnIndex: 1, timestamp: ASSISTANT_TIMESTAMP }, ctx);
    } else if (terminal === "agent_end") {
      await emit(mock, terminal, { messages: [] }, ctx);
    } else if (terminal === "session_start") {
      await emit(mock, terminal, { reason: "resume" }, ctx);
    } else {
      await emit(mock, terminal, { reason: "quit" }, ctx);
    }
    await emit(
      mock,
      "tool_execution_end",
      { toolCallId: "call-stale", toolName: "read", result: {}, isError: false },
      ctx,
    );
    await emit(
      mock,
      "turn_end",
      {
        message: assistantMessage(ASSISTANT_TIMESTAMP, "toolUse"),
        toolResults: [toolResultMessage("call-stale", "read", false)],
        turnIndex: 1,
      },
      ctx,
    );
    assert.equal(mock.entries.filter((entry) => isToolStampData(entry.data)).length, 0, terminal);
  }
});

function settingsRuntimeWithToolStamps(toolStamps = true): StampSettingsRuntime {
  const state: StampSettingsState = {
    settings: { ...DEFAULT_STAMP_SETTINGS, toolStamps },
    sources: {
      hourCycle: "built-in",
      showSeconds: "built-in",
      dateContext: "built-in",
      locale: "built-in",
      timeZone: "built-in",
      responseTiming: "built-in",
      assistantMetadata: "built-in",
      showExactTimeline: "built-in",
      showThinkingLevel: "built-in",
      showCompactAbnormalOutcome: "built-in",
      showCostSinceUser: "built-in",
      toolStamps: "user",
    },
    canSave: true,
  };
  return {
    get: () => state,
    getPath: () => "/tmp/pi-stamp.json",
    reload: async () => state,
    update: async () => state,
    flush: async () => undefined,
  };
}

function stampEntry(role: "user" | "assistant", timestamp: number, previousTimestamp?: number) {
  return {
    customType: STAMP_ENTRY_TYPE,
    data: {
      version: 2,
      role,
      timestamp,
      ...(previousTimestamp === undefined ? {} : { previousTimestamp }),
    },
  };
}

function toolStampEntry(
  toolCallId: string,
  toolName: string,
  startedAt: number,
  completedAt: number,
  outcome: "success" | "error",
) {
  return {
    customType: STAMP_ENTRY_TYPE,
    data: {
      version: 1,
      kind: "tool",
      toolCallId,
      toolName,
      startedAt,
      completedAt,
      outcome,
    },
  };
}

function toolResultMessage(toolCallId: string, toolName: string, isError: boolean) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [],
    isError,
    timestamp: ASSISTANT_TIMESTAMP + 1,
  };
}

function assistantMessage(timestamp: number, stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) {
    await handler(event, ctx);
  }
}
