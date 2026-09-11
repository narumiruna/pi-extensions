import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { DEFAULT_STAMP_SETTINGS, type StampSettings } from "../src/format.js";
import { captureAssistantMetadata } from "../src/metadata.js";
import type { StampSettingsRuntime, StampSettingsState } from "../src/settings.js";
import stamp, {
  createStampEntryRenderer,
  formatStampTime,
  isMessageStampData,
  STAMP_ENTRY_TYPE,
} from "../src/stamp.js";

const USER_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 7, 123).getTime();
const ASSISTANT_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 9, 456).getTime();

test("stamp registers one entry renderer, one menu command, and no tools", () => {
  const mock = createMockPi();
  stamp(mock.pi);

  assert.deepEqual([...mock.entryRenderers.keys()], [STAMP_ENTRY_TYPE]);
  assert.deepEqual([...mock.commands.keys()], ["stamp"]);
  assert.equal(mock.tools.length, 0);
  assert.deepEqual([...mock.events.keys()].sort(), [
    "agent_end",
    "message_end",
    "message_start",
    "message_update",
    "session_shutdown",
    "session_start",
    "tool_execution_end",
    "tool_execution_start",
    "turn_end",
    "turn_start",
  ]);
});

test("formatStampTime uses zero-padded local 24-hour time and rejects invalid values", () => {
  assert.equal(formatStampTime(USER_TIMESTAMP), "05:06:07");
  assert.equal(formatStampTime(Number.NaN), undefined);
  assert.equal(formatStampTime(Number.POSITIVE_INFINITY), undefined);
  assert.equal(formatStampTime(10 ** 20), undefined);
});

test("TUI lifecycle appends one user stamp before the assistant and measured assistant timing at turn end", async () => {
  const mock = createMockPi();
  const times = [ASSISTANT_TIMESTAMP + 800, ASSISTANT_TIMESTAMP + 3_200];
  stamp(mock.pi, {
    settingsRuntime: testSettingsRuntime(),
    now: () => times.shift() ?? assert.fail("Unexpected clock read"),
  });
  const { ctx } = createMockContext({ mode: "tui" });
  const user = userMessage(USER_TIMESTAMP);
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: user }, ctx);
  await emit(mock, "message_end", { message: user }, ctx);
  assert.deepEqual(mock.entries, []);

  await emit(mock, "message_start", { message: assistant }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("user", USER_TIMESTAMP)]);
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    ctx,
  );
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "" } },
    ctx,
  );
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "hello" } },
    ctx,
  );
  await emit(mock, "message_end", { message: assistant }, ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [
    stampEntry("user", USER_TIMESTAMP),
    timedAssistantStamp(ASSISTANT_TIMESTAMP, ASSISTANT_TIMESTAMP + 3_200, {
      previousTimestamp: USER_TIMESTAMP,
      firstContentAt: ASSISTANT_TIMESTAMP + 800,
    }),
  ]);

  await emit(mock, "agent_end", { messages: [user, assistant] }, ctx);
  await emit(mock, "session_shutdown", { reason: "quit" }, ctx);
  assert.equal(mock.entries.length, 2);
  assert.deepEqual(mock.sentMessages, []);
  assert.deepEqual(mock.sentUserMessages, []);
});

test("opt-in assistant metadata persists a sanitized version-4 snapshot with measured timing", async () => {
  const mock = createMockPi();
  const runtime = settingsRuntimeWith({ assistantMetadata: "compact" });
  stamp(mock.pi, {
    settingsRuntime: runtime,
    now: () => ASSISTANT_TIMESTAMP + 3_200,
  });
  const { ctx } = createMockContext({ mode: "tui" });
  const assistant = {
    ...assistantMessage(ASSISTANT_TIMESTAMP),
    responseModel: "reported-model",
    responseId: "response-1",
  };
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);
  await emit(mock, "message_end", { message: assistant }, ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  const metadata = captureAssistantMetadata(assistant);
  assert.ok(metadata);
  assert.deepEqual(mock.entries, [
    {
      customType: STAMP_ENTRY_TYPE,
      data: {
        version: 4,
        role: "assistant",
        timestamp: ASSISTANT_TIMESTAMP,
        completedAt: ASSISTANT_TIMESTAMP + 3_200,
        metadata,
      },
    },
  ]);

  const reversed = createMockPi();
  stamp(reversed.pi, {
    settingsRuntime: settingsRuntimeWith({ assistantMetadata: "compact" }),
    now: () => ASSISTANT_TIMESTAMP - 1,
  });
  await emit(reversed, "session_start", { reason: "startup" }, ctx);
  await emit(reversed, "message_start", { message: assistant }, ctx);
  await emit(reversed, "message_end", { message: assistant }, ctx);
  await emit(reversed, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(reversed.entries, [
    {
      customType: STAMP_ENTRY_TYPE,
      data: {
        version: 4,
        role: "assistant",
        timestamp: ASSISTANT_TIMESTAMP,
        metadata,
      },
    },
  ]);
});

test("opt-in assistant metadata persists the effective turn Thinking level in version 5", async () => {
  const mock = createMockPi();
  const runtime = settingsRuntimeWith({ assistantMetadata: "compact" });
  stamp(mock.pi, {
    settingsRuntime: runtime,
    now: () => ASSISTANT_TIMESTAMP + 3_200,
  });
  const { ctx } = createMockContext({ mode: "tui", thinkingLevel: "high" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP, "error");
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "turn_start", { turnIndex: 0, timestamp: ASSISTANT_TIMESTAMP }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);
  await emit(mock, "message_end", { message: assistant }, ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  const metadata = captureAssistantMetadata(assistant);
  assert.ok(metadata);
  assert.deepEqual(mock.entries, [
    {
      customType: STAMP_ENTRY_TYPE,
      data: {
        version: 5,
        role: "assistant",
        timestamp: ASSISTANT_TIMESTAMP,
        completedAt: ASSISTANT_TIMESTAMP + 3_200,
        metadata,
        thinkingLevel: "high",
      },
    },
  ]);

  const reversed = createMockPi();
  stamp(reversed.pi, {
    settingsRuntime: settingsRuntimeWith({ assistantMetadata: "compact" }),
    now: () => ASSISTANT_TIMESTAMP - 1,
  });
  await emit(reversed, "session_start", { reason: "startup" }, ctx);
  await emit(reversed, "turn_start", { turnIndex: 0, timestamp: ASSISTANT_TIMESTAMP }, ctx);
  await emit(reversed, "message_start", { message: assistant }, ctx);
  await emit(reversed, "message_end", { message: assistant }, ctx);
  await emit(reversed, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(reversed.entries, [
    {
      customType: STAMP_ENTRY_TYPE,
      data: {
        version: 5,
        role: "assistant",
        timestamp: ASSISTANT_TIMESTAMP,
        metadata,
        thinkingLevel: "high",
      },
    },
  ]);

  const optedOut = createMockPi();
  stamp(optedOut.pi, {
    settingsRuntime: testSettingsRuntime(),
    now: () => ASSISTANT_TIMESTAMP + 1_000,
  });
  await emit(optedOut, "session_start", { reason: "startup" }, ctx);
  await emit(optedOut, "turn_start", { turnIndex: 0, timestamp: ASSISTANT_TIMESTAMP }, ctx);
  await emit(optedOut, "message_start", { message: assistant }, ctx);
  await emit(optedOut, "message_end", { message: assistant }, ctx);
  await emit(optedOut, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(optedOut.entries, [timedAssistantStamp(ASSISTANT_TIMESTAMP, ASSISTANT_TIMESTAMP + 1_000)]);
});

test("Thinking level state cannot survive turn, agent, session, or shutdown boundaries", async () => {
  for (const boundary of ["turn_start", "agent_end", "session_start", "session_shutdown"] as const) {
    const mock = createMockPi();
    stamp(mock.pi, { settingsRuntime: settingsRuntimeWith({ assistantMetadata: "compact" }) });
    const active = createMockContext({ mode: "tui", thinkingLevel: "high" });
    const replacement = createMockContext({ mode: "tui" });
    const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
    await emit(mock, "session_start", { reason: "startup" }, active.ctx);
    await emit(mock, "turn_start", { turnIndex: 0, timestamp: ASSISTANT_TIMESTAMP }, active.ctx);
    if (boundary === "turn_start") {
      await emit(mock, boundary, { turnIndex: 1, timestamp: ASSISTANT_TIMESTAMP + 1 }, replacement.ctx);
    } else if (boundary === "agent_end") {
      await emit(mock, boundary, { messages: [] }, replacement.ctx);
    } else if (boundary === "session_start") {
      await emit(mock, boundary, { reason: "resume" }, replacement.ctx);
    } else {
      await emit(mock, boundary, { reason: "reload" }, active.ctx);
      await emit(mock, "session_start", { reason: "reload" }, replacement.ctx);
    }
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 1 }, replacement.ctx);
    assert.equal(messageStampDataAt(mock).version, 4, boundary);
  }
});

test("disabled, missing, or invalid Thinking levels retain version-4 metadata", async () => {
  for (const scenario of [
    { thinkingLevel: "high", showThinkingLevel: false },
    { thinkingLevel: undefined, showThinkingLevel: true },
    { thinkingLevel: "ultra", showThinkingLevel: true },
  ] as const) {
    const mock = createMockPi();
    stamp(mock.pi, {
      settingsRuntime: settingsRuntimeWith({
        assistantMetadata: "compact",
        showThinkingLevel: scenario.showThinkingLevel,
      }),
    });
    const { ctx } = createMockContext({ mode: "tui", thinkingLevel: scenario.thinkingLevel });
    const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "turn_start", { turnIndex: 0, timestamp: ASSISTANT_TIMESTAMP }, ctx);
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
    assert.equal(messageStampDataAt(mock).version, 4, JSON.stringify(scenario));
  }
});

test("thinking, completed blocks, and tool calls can be the first meaningful assistant content", async () => {
  const events = [
    { type: "thinking_delta", delta: "reasoning" },
    { type: "text_end", content: "complete" },
    { type: "toolcall_end", toolCall: { id: "call-1", name: "read", arguments: {} } },
  ] as const;
  for (const [index, assistantMessageEvent] of events.entries()) {
    const mock = createMockPi();
    const timestamp = ASSISTANT_TIMESTAMP + index * 10_000;
    let now = timestamp + 700;
    stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
    const { ctx } = createMockContext({ mode: "tui" });
    const assistant = assistantMessage(timestamp);
    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "turn_start", { turnIndex: 0, timestamp: timestamp - 10 }, ctx);
    await emit(mock, "message_start", { message: assistant }, ctx);
    await emit(mock, "message_update", { message: assistant, assistantMessageEvent }, ctx);
    now = timestamp + 2_000;
    await emit(mock, "message_end", { message: assistant }, ctx);
    now = timestamp + 20_000;
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
    assert.deepEqual(
      mock.entries,
      [timedAssistantStamp(timestamp, timestamp + 2_000, { firstContentAt: timestamp + 700 })],
      assistantMessageEvent.type,
    );
  }
});

test("missing first content stays unavailable and tool execution does not extend completion", async () => {
  const mock = createMockPi();
  let now = ASSISTANT_TIMESTAMP + 3_200;
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
  const { ctx } = createMockContext({ mode: "tui" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP, "toolUse");
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);
  await emit(mock, "message_end", { message: assistant }, ctx);
  now = ASSISTANT_TIMESTAMP + 30_000;
  await emit(
    mock,
    "message_end",
    {
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: now,
      },
    },
    ctx,
  );
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [timedAssistantStamp(ASSISTANT_TIMESTAMP, ASSISTANT_TIMESTAMP + 3_200)]);
  const renderer = createStampEntryRenderer(() => ({
    ...DEFAULT_STAMP_SETTINGS,
    responseTiming: "detailed",
  }));
  const component = renderer({ data: mock.entries[0]?.data } as never, { expanded: false }, {
    fg: (_color: string, text: string) => text,
  } as never);
  assert.ok(component);
  assert.match(component.render(80).join("\n"), /first n\/a · total 3\.2s$/u);
});

test("successive user messages flush in source order at the following message boundaries", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const { ctx } = createMockContext({ mode: "tui" });
  const first = userMessage(USER_TIMESTAMP);
  const second = userMessage(USER_TIMESTAMP + 1_000);
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_end", { message: first }, ctx);
  await emit(mock, "message_start", { message: second }, ctx);
  await emit(mock, "message_end", { message: second }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);

  assert.deepEqual(mock.entries, [
    stampEntry("user", USER_TIMESTAMP),
    stampEntry("user", USER_TIMESTAMP + 1_000, USER_TIMESTAMP),
  ]);
});

test("error and aborted assistant messages retain completion timing", async () => {
  for (const [index, stopReason] of ["error", "aborted"].entries()) {
    const mock = createMockPi();
    const timestamp = ASSISTANT_TIMESTAMP + index * 10_000;
    stamp(mock.pi, {
      settingsRuntime: testSettingsRuntime(),
      now: () => timestamp + 1_500,
    });
    const { ctx } = createMockContext({ mode: "tui" });
    const assistant = assistantMessage(timestamp, stopReason as "error" | "aborted");
    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "message_start", { message: assistant }, ctx);
    await emit(mock, "message_end", { message: assistant }, ctx);
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
    assert.deepEqual(mock.entries, [timedAssistantStamp(timestamp, timestamp + 1_500)]);
  }
});

test("mismatched and reversed timing degrades without leaking into a later response", async () => {
  const mock = createMockPi();
  let now = ASSISTANT_TIMESTAMP + 500;
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
  const { ctx } = createMockContext({ mode: "tui" });
  const first = assistantMessage(ASSISTANT_TIMESTAMP);
  const mismatch = assistantMessage(ASSISTANT_TIMESTAMP + 1_000);
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: first }, ctx);
  await emit(
    mock,
    "message_update",
    { message: first, assistantMessageEvent: { type: "text_delta", delta: "x" } },
    ctx,
  );
  now = ASSISTANT_TIMESTAMP + 900;
  await emit(mock, "message_end", { message: first }, ctx);
  await emit(mock, "turn_end", { message: mismatch, toolResults: [], turnIndex: 0 }, ctx);

  const reversed = assistantMessage(ASSISTANT_TIMESTAMP + 2_000);
  await emit(mock, "turn_start", { turnIndex: 1, timestamp: ASSISTANT_TIMESTAMP + 1_500 }, ctx);
  await emit(mock, "message_start", { message: reversed }, ctx);
  now = reversed.timestamp - 1;
  await emit(mock, "message_end", { message: reversed }, ctx);
  await emit(mock, "turn_end", { message: reversed, toolResults: [], turnIndex: 1 }, ctx);

  assert.deepEqual(mock.entries, [
    stampEntry("assistant", mismatch.timestamp),
    stampEntry("assistant", reversed.timestamp, mismatch.timestamp),
  ]);
});

test("an out-of-order first-content clock is omitted while valid completion remains", async () => {
  const mock = createMockPi();
  let now = ASSISTANT_TIMESTAMP - 1;
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
  const { ctx } = createMockContext({ mode: "tui" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "x" } },
    ctx,
  );
  now = ASSISTANT_TIMESTAMP + 1_000;
  await emit(mock, "message_end", { message: assistant }, ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [timedAssistantStamp(ASSISTANT_TIMESTAMP, ASSISTANT_TIMESTAMP + 1_000)]);
});

test("session replacement clears finalized timing owned by the prior session", async () => {
  const mock = createMockPi();
  stamp(mock.pi, {
    settingsRuntime: testSettingsRuntime(),
    now: () => ASSISTANT_TIMESTAMP + 2_000,
  });
  const first = createMockContext({ mode: "tui" });
  const second = createMockContext({ mode: "tui" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
  await emit(mock, "session_start", { reason: "startup" }, first.ctx);
  await emit(mock, "message_start", { message: assistant }, first.ctx);
  await emit(mock, "message_end", { message: assistant }, first.ctx);
  await emit(mock, "session_start", { reason: "resume" }, second.ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, second.ctx);
  assert.deepEqual(mock.entries, [stampEntry("assistant", ASSISTANT_TIMESTAMP)]);
});

test("cost since user accumulates assistant and tool-result costs and resets on user messages", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: settingsRuntimeWith({ showCostSinceUser: true }) });
  const { ctx } = createMockContext({ mode: "tui" });
  const firstUser = userMessage(USER_TIMESTAMP);
  const firstToolUse = assistantMessage(ASSISTANT_TIMESTAMP, "toolUse", 0.012);
  const firstToolResult = toolResultMessage(ASSISTANT_TIMESTAMP + 500, 0.006);
  const secondToolUse = assistantMessage(ASSISTANT_TIMESTAMP + 1_000, "toolUse", 0.018);
  const final = assistantMessage(ASSISTANT_TIMESTAMP + 2_000, "stop", 0.009);

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_end", { message: firstUser }, ctx);
  await emit(mock, "message_start", { message: firstToolUse }, ctx);
  await emit(mock, "turn_end", { message: firstToolUse, toolResults: [firstToolResult], turnIndex: 0 }, ctx);
  await emit(mock, "message_start", { message: secondToolUse }, ctx);
  await emit(mock, "turn_end", { message: secondToolUse, toolResults: [], turnIndex: 1 }, ctx);
  await emit(mock, "message_start", { message: final }, ctx);
  await emit(mock, "turn_end", { message: final, toolResults: [], turnIndex: 2 }, ctx);

  assert.deepEqual(
    [0, 1, 2].map((index) => messageStampDataAt(mock, index).version),
    [2, 2, 2],
  );
  const finalStamp = messageStampDataAt(mock, 3);
  assert.equal(finalStamp.version, 6);
  if (finalStamp.version !== 6) assert.fail("Expected a version-6 cost stamp");
  assert.equal(finalStamp.estimatedCost, 0.009);
  assert.ok(Math.abs(finalStamp.costSinceUser - 0.045) < 1e-12);
  assert.equal(finalStamp.metadata, undefined);

  await emit(mock, "agent_end", { messages: [firstToolUse, secondToolUse, final] }, ctx);
  const autonomous = assistantMessage(ASSISTANT_TIMESTAMP + 3_000, "stop", 0.001);
  await emit(mock, "message_start", { message: autonomous }, ctx);
  await emit(mock, "turn_end", { message: autonomous, toolResults: [], turnIndex: 3 }, ctx);
  const autonomousStamp = messageStampDataAt(mock, 4);
  assert.equal(autonomousStamp.version, 6);
  if (autonomousStamp.version !== 6) assert.fail("Expected a version-6 cost stamp");
  assert.ok(Math.abs(autonomousStamp.costSinceUser - 0.046) < 1e-12);

  const secondUser = userMessage(USER_TIMESTAMP + 10_000);
  const secondFinal = assistantMessage(ASSISTANT_TIMESTAMP + 11_000, "stop", 0.004);
  await emit(mock, "message_end", { message: secondUser }, ctx);
  await emit(mock, "message_start", { message: secondFinal }, ctx);
  await emit(mock, "turn_end", { message: secondFinal, toolResults: [], turnIndex: 4 }, ctx);
  const resetStamp = messageStampDataAt(mock, 6);
  assert.equal(resetStamp.version, 6);
  if (resetStamp.version !== 6) assert.fail("Expected a version-6 cost stamp");
  assert.equal(resetStamp.costSinceUser, 0.004);
});

test("session resume rebuilds cost since user from assistant and tool-result usage", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: settingsRuntimeWith({ showCostSinceUser: true }) });
  const resumedUser = userMessage(USER_TIMESTAMP);
  const firstToolUse = assistantMessage(ASSISTANT_TIMESTAMP, "toolUse", 0.012);
  const firstToolResult = toolResultMessage(ASSISTANT_TIMESTAMP + 500, 0.006);
  const secondToolUse = assistantMessage(ASSISTANT_TIMESTAMP + 1_000, "toolUse", 0.018);
  const { ctx } = createMockContext({
    mode: "tui",
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionName: () => undefined,
      getEntries: () => [],
      getBranch: () => [
        { type: "message", message: assistantMessage(USER_TIMESTAMP - 1_000, "stop", 1) },
        { type: "message", message: resumedUser },
        { type: "message", message: firstToolUse },
        { type: "message", message: firstToolResult },
        { type: "message", message: secondToolUse },
      ],
    },
  });

  await emit(mock, "session_start", { reason: "resume" }, ctx);
  const final = assistantMessage(ASSISTANT_TIMESTAMP + 2_000, "stop", 0.009);
  await emit(mock, "turn_end", { message: final, toolResults: [], turnIndex: 2 }, ctx);
  const finalStamp = messageStampDataAt(mock);
  assert.equal(finalStamp.version, 6);
  if (finalStamp.version !== 6) assert.fail("Expected a version-6 cost stamp");
  assert.ok(Math.abs(finalStamp.costSinceUser - 0.045) < 1e-12);
});

test("assistant tool and error turns receive one stamp without stamping tool results", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const { ctx } = createMockContext({ mode: "tui" });
  const toolAssistant = assistantMessage(ASSISTANT_TIMESTAMP, "toolUse");
  const errorAssistant = assistantMessage(ASSISTANT_TIMESTAMP + 2_000, "error");

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(
    mock,
    "message_end",
    {
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: ASSISTANT_TIMESTAMP + 1_000,
      },
    },
    ctx,
  );
  await emit(mock, "turn_end", { message: toolAssistant, toolResults: [], turnIndex: 0 }, ctx);
  await emit(mock, "turn_end", { message: errorAssistant, toolResults: [], turnIndex: 1 }, ctx);

  assert.deepEqual(mock.entries, [
    stampEntry("assistant", ASSISTANT_TIMESTAMP),
    stampEntry("assistant", ASSISTANT_TIMESTAMP + 2_000, ASSISTANT_TIMESTAMP),
  ]);
});

test("session start rebuilds the predecessor cursor from the active branch", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const previous = USER_TIMESTAMP - 60_000;
  const { ctx } = createMockContext({
    mode: "tui",
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionName: () => undefined,
      getEntries: () => [],
      getBranch: () => [
        {
          type: "custom",
          customType: STAMP_ENTRY_TYPE,
          data: { version: 1, role: "user", timestamp: previous - 60_000 },
        },
        {
          type: "custom",
          customType: STAMP_ENTRY_TYPE,
          data: {
            version: 3,
            role: "assistant",
            timestamp: previous,
            completedAt: previous + 2_000,
          },
        },
      ],
    },
  });

  await emit(mock, "session_start", { reason: "resume" }, ctx);
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("assistant", ASSISTANT_TIMESTAMP, previous)]);
});

test("a delayed settings reload cannot notify through a replaced session", async () => {
  const mock = createMockPi();
  const delayed = deferred<Readonly<StampSettingsState>>();
  const activeState = defaultSettingsState();
  let reloads = 0;
  const runtime = testSettingsRuntime({
    reload: async () => {
      reloads += 1;
      return reloads === 1 ? delayed.promise : activeState;
    },
  });
  stamp(mock.pi, { settingsRuntime: runtime });
  const first = createMockContext({ mode: "tui" });
  const second = createMockContext({ mode: "tui" });

  const firstStart = emit(mock, "session_start", { reason: "startup" }, first.ctx);
  await Promise.resolve();
  await emit(mock, "session_start", { reason: "switch" }, second.ctx);
  delayed.resolve({
    ...activeState,
    issue: { kind: "invalid", message: "stale issue" },
    canSave: false,
  });
  await firstStart;

  assert.deepEqual(first.notifications, []);
  assert.deepEqual(second.notifications, []);
});

test("session shutdown waits for an in-flight settings durability boundary", async () => {
  const mock = createMockPi();
  const flushing = deferred<void>();
  const runtime = testSettingsRuntime({ flush: () => flushing.promise });
  stamp(mock.pi, { settingsRuntime: runtime });
  const { ctx } = createMockContext({ mode: "tui" });
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  let settled = false;
  const shutdown = emit(mock, "session_shutdown", { reason: "quit" }, ctx).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  flushing.resolve();
  await shutdown;
  assert.equal(settled, true);
});

test("agent end and shutdown flush a pending user at most once and reload resets state", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const { ctx } = createMockContext({ mode: "tui" });

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_end", { message: userMessage(USER_TIMESTAMP) }, ctx);
  await emit(mock, "agent_end", { messages: [] }, ctx);
  await emit(mock, "session_shutdown", { reason: "reload" }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("user", USER_TIMESTAMP)]);

  await emit(mock, "session_start", { reason: "reload" }, ctx);
  await emit(mock, "agent_end", { messages: [] }, ctx);
  assert.equal(mock.entries.length, 1);

  await emit(mock, "message_end", { message: userMessage(USER_TIMESTAMP + 1_000) }, ctx);
  await emit(mock, "session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("user", USER_TIMESTAMP), stampEntry("user", USER_TIMESTAMP + 1_000)]);
});

test("/stamp is argument-free, supports TUI, and rejects print and JSON observably", async () => {
  const mock = createMockPi();
  stamp(mock.pi);
  const command = mock.commands.get("stamp");
  assert.ok(command);
  const tui = createMockContext({
    mode: "tui",
    select: async (_title: string, options: string[]) => options.find((option) => option === "Close"),
  });
  await command.handler("", tui.ctx);
  await assert.rejects(async () => command.handler("extra", tui.ctx), /does not accept arguments/u);
  for (const mode of ["print", "json"] as const) {
    const { ctx } = createMockContext({ mode });
    await assert.rejects(async () => command.handler("", ctx), new RegExp(`${mode} mode`, "u"));
  }
});

test("print, JSON, and RPC sessions never append stamp entries", async () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const mock = createMockPi();
    stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
    const { ctx } = createMockContext({ mode });
    const assistant = assistantMessage(ASSISTANT_TIMESTAMP);

    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "message_end", { message: userMessage(USER_TIMESTAMP) }, ctx);
    await emit(mock, "message_start", { message: assistant }, ctx);
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
    await emit(mock, "agent_end", { messages: [] }, ctx);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx);

    assert.deepEqual(mock.entries, [], mode);
  }
});

function messageStampDataAt(mock: ReturnType<typeof createMockPi>, index = 0) {
  const data = mock.entries[index]?.data;
  if (!isMessageStampData(data)) assert.fail(`Expected message stamp data at index ${index}`);
  return data;
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

function timedAssistantStamp(
  timestamp: number,
  completedAt: number,
  options: { previousTimestamp?: number; firstContentAt?: number } = {},
) {
  return {
    customType: STAMP_ENTRY_TYPE,
    data: {
      version: 3,
      role: "assistant",
      timestamp,
      ...(options.previousTimestamp === undefined ? {} : { previousTimestamp: options.previousTimestamp }),
      completedAt,
      ...(options.firstContentAt === undefined ? {} : { firstContentAt: options.firstContentAt }),
    },
  };
}

function userMessage(timestamp: number) {
  return { role: "user" as const, content: "hello", timestamp };
}

function toolResultMessage(timestamp: number, estimatedCost: number) {
  return {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "model-backed-tool",
    content: [],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: estimatedCost },
    },
    isError: false,
    timestamp,
  };
}

function assistantMessage(
  timestamp: number,
  stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
  estimatedCost = 0,
) {
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: estimatedCost },
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

function defaultSettingsState(): Readonly<StampSettingsState> {
  return {
    settings: { ...DEFAULT_STAMP_SETTINGS },
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
      toolStamps: "built-in",
    },
    canSave: true,
  };
}

function settingsRuntimeWith(settings: Partial<StampSettings>): StampSettingsRuntime {
  const state: Readonly<StampSettingsState> = {
    ...defaultSettingsState(),
    settings: { ...DEFAULT_STAMP_SETTINGS, ...settings },
    sources: {
      ...defaultSettingsState().sources,
      ...Object.fromEntries(Object.keys(settings).map((key) => [key, "user"])),
    },
  };
  return testSettingsRuntime({
    get: () => state,
    reload: async () => state,
    update: async () => state,
  });
}

function testSettingsRuntime(overrides: Partial<StampSettingsRuntime> = {}): StampSettingsRuntime {
  const state = defaultSettingsState();
  return {
    get: () => state,
    getPath: () => "/tmp/pi-stamp.json",
    reload: async () => state,
    update: async () => state,
    flush: async () => undefined,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
