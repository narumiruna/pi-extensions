import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { DEFAULT_STAMP_SETTINGS, type StampSettings } from "../src/format.js";
import { captureAssistantMetadata } from "../src/metadata.js";
import { createStampEntryRenderer, isMessageStampData, isToolStampData, STAMP_ENTRY_TYPE } from "../src/stamp.js";

const USER_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 7, 123).getTime();
const ASSISTANT_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 9, 456).getTime();

test("isMessageStampData accepts exact message versions 1 through 6", () => {
  assert.equal(isMessageStampData({ version: 1, role: "user", timestamp: USER_TIMESTAMP }), true);
  assert.equal(isMessageStampData({ version: 2, role: "assistant", timestamp: ASSISTANT_TIMESTAMP }), true);
  assert.equal(
    isMessageStampData({
      version: 2,
      role: "user",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
    }),
    true,
  );
  assert.equal(
    isMessageStampData({
      version: 1,
      role: "user",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
    }),
    false,
  );
  assert.equal(
    isMessageStampData({
      version: 2,
      role: "user",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: NaN,
    }),
    false,
  );
  assert.equal(
    isMessageStampData({
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
      completedAt: USER_TIMESTAMP + 3_200,
      firstContentAt: USER_TIMESTAMP + 800,
    }),
    true,
  );
  const metadata = captureAssistantMetadata(assistantMessage(ASSISTANT_TIMESTAMP));
  assert.ok(metadata);
  assert.equal(
    isMessageStampData({
      version: 4,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
      completedAt: USER_TIMESTAMP + 3_200,
      firstContentAt: USER_TIMESTAMP + 800,
      metadata,
    }),
    true,
  );
  assert.equal(isMessageStampData({ version: 4, role: "assistant", timestamp: USER_TIMESTAMP, metadata }), true);
  assert.equal(
    isMessageStampData({
      version: 5,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 3_200,
      firstContentAt: USER_TIMESTAMP + 800,
      metadata,
      thinkingLevel: "high",
    }),
    true,
  );
  assert.equal(
    isMessageStampData({
      version: 5,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      metadata,
      thinkingLevel: "off",
    }),
    true,
  );
  assert.equal(
    isMessageStampData({
      version: 6,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      metadata,
      thinkingLevel: "high",
      estimatedCost: 0.009,
      costSinceUser: 0.039,
    }),
    true,
  );
  assert.equal(
    isMessageStampData({
      version: 6,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      costSinceUser: 0.03,
    }),
    true,
  );
  for (const value of [
    {
      version: 3,
      role: "user",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
    },
    { version: 3, role: "assistant", timestamp: USER_TIMESTAMP },
    {
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP - 1,
    },
    {
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
      firstContentAt: USER_TIMESTAMP + 2_000,
    },
    {
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
      future: true,
    },
    { version: 4, role: "user", timestamp: USER_TIMESTAMP, metadata },
    { version: 4, role: "assistant", timestamp: USER_TIMESTAMP },
    {
      version: 4,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      firstContentAt: USER_TIMESTAMP + 1,
      metadata,
    },
    {
      version: 4,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
      metadata: { ...metadata, future: true },
    },
    {
      version: 4,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      metadata,
      thinkingLevel: "high",
    },
    { version: 5, role: "assistant", timestamp: USER_TIMESTAMP, metadata },
    {
      version: 5,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      metadata,
      thinkingLevel: "ultra",
    },
    {
      version: 5,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      metadata,
      thinkingLevel: "high",
      future: true,
    },
    { version: 6, role: "assistant", timestamp: USER_TIMESTAMP },
    {
      version: 6,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      costSinceUser: -1,
    },
    {
      version: 6,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      costSinceUser: 0.03,
      estimatedCost: Number.NaN,
    },
    {
      version: 6,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      costSinceUser: 0.01,
      estimatedCost: 0.02,
    },
    {
      version: 6,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      costSinceUser: 0.03,
      future: true,
    },
  ]) {
    assert.equal(isMessageStampData(value), false);
  }
  assert.equal(isMessageStampData({ version: 1, role: "toolResult", timestamp: USER_TIMESTAMP }), false);
  assert.equal(isMessageStampData({ version: 1, role: "user", timestamp: Number.NaN }), false);
  assert.equal(isMessageStampData(null), false);
});

test("isToolStampData accepts only exact ordered version-1 tool observations", () => {
  const valid = {
    version: 1,
    kind: "tool",
    toolCallId: "call-1",
    toolName: "read",
    startedAt: USER_TIMESTAMP,
    completedAt: USER_TIMESTAMP + 1_250,
    outcome: "success",
  };
  assert.equal(isToolStampData(valid), true);
  assert.equal(isToolStampData({ ...valid, outcome: "error" }), true);
  for (const value of [
    { ...valid, version: 2 },
    { ...valid, kind: "message" },
    { ...valid, toolCallId: "" },
    { ...valid, toolName: "x".repeat(161) },
    { ...valid, completedAt: USER_TIMESTAMP - 1 },
    { ...valid, outcome: "cancelled" },
    { ...valid, future: true },
  ]) {
    assert.equal(isToolStampData(value), false);
  }
});

test("entry renderer reads live settings, uses the callback theme, and stays width-safe", () => {
  let settings: StampSettings = { ...DEFAULT_STAMP_SETTINGS, timeZone: "UTC" };
  const renderer = createStampEntryRenderer(() => settings);
  const colors: string[] = [];
  const component = renderer(
    {
      data: {
        version: 2,
        role: "user",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 2),
        previousTimestamp: Date.UTC(2026, 6, 29, 23, 59, 58),
      },
    } as never,
    { expanded: false },
    {
      fg(color: string, text: string) {
        colors.push(color);
        return text;
      },
    } as never,
  );

  assert.ok(component);
  assert.equal(component.render(30).join("\n"), "         2026-07-30 · 00:01:02");
  settings = { ...settings, showSeconds: false, dateContext: "never" };
  assert.equal(component.render(12).join("\n"), "       00:01");
  settings = { ...settings, showSeconds: true, responseTiming: "duration" };
  const timedComponent = renderer(
    {
      data: {
        version: 3,
        role: "assistant",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 2),
        completedAt: Date.UTC(2026, 6, 30, 0, 1, 5, 200),
        firstContentAt: Date.UTC(2026, 6, 30, 0, 1, 2, 800),
      },
    } as never,
    { expanded: false },
    { fg: (_color: string, text: string) => text } as never,
  );
  assert.ok(timedComponent);
  assert.equal(timedComponent.render(50).join("\n").trim(), "00:01:02 · 3.2s");
  settings = { ...settings, responseTiming: "detailed" };
  assert.equal(timedComponent.render(50).join("\n"), "                00:01:02 · first 0.8s · total 3.2s");
  assert.deepEqual(colors, ["dim", "dim"]);
  const renderedComponents = [component, timedComponent];
  for (const width of [1, 4, 8, 10]) {
    for (const renderedComponent of renderedComponents) {
      for (const line of renderedComponent.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} exceeded width ${width}`);
      }
    }
  }

  assert.equal(renderer({ data: { version: 99 } } as never, { expanded: false }, { fg: () => "" } as never), undefined);
});

test("entry renderer expands exact timelines from only the observations each version retains", () => {
  const renderer = createStampEntryRenderer(() => ({
    ...DEFAULT_STAMP_SETTINGS,
    timeZone: "UTC",
  }));
  const theme = { fg: (_color: string, text: string) => text } as never;
  const user = renderer(
    {
      data: {
        version: 2,
        role: "user",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 2, 345),
      },
    } as never,
    { expanded: true },
    theme,
  );
  assert.ok(user);
  const exactUserTimeline = "timeline · created 2026-07-30T00:01:02.345Z · unix-ms 1785369662345";
  assert.deepEqual(
    user.render(80).map((line) => line.trim()),
    ["00:01:02", exactUserTimeline],
  );
  const exactChunks = exactUserTimeline.match(/.{1,10}/gu) ?? [];
  assert.deepEqual(
    user.render(10).slice(1),
    exactChunks.map((chunk) => `${" ".repeat(10 - visibleWidth(chunk))}${chunk}`),
  );

  const legacyAssistant = renderer(
    {
      data: {
        version: 3,
        role: "assistant",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 2),
        completedAt: Date.UTC(2026, 6, 30, 0, 1, 5, 200),
      },
    } as never,
    { expanded: true },
    theme,
  );
  assert.ok(legacyAssistant);
  assert.deepEqual(
    legacyAssistant.render(80).map((line) => line.trim()),
    [
      "00:01:02",
      "timeline · created 2026-07-30T00:01:02.000Z · unix-ms 1785369662000",
      "timeline · completed 2026-07-30T00:01:05.200Z · unix-ms 1785369665200",
    ],
  );
  const renderedComponents: Component[] = [user, legacyAssistant];
  for (const width of [1, 4, 8, 12]) {
    for (const renderedComponent of renderedComponents) {
      for (const line of renderedComponent.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} exceeded width ${width}`);
      }
    }
  }
});

test("version-6 rendering gates cost since user without requiring assistant metadata", () => {
  let settings: StampSettings = {
    ...DEFAULT_STAMP_SETTINGS,
    timeZone: "UTC",
    showCostSinceUser: true,
  };
  const renderer = createStampEntryRenderer(() => settings);
  const assistant = assistantMessage(Date.UTC(2026, 6, 30, 0, 1, 2));
  const metadata = captureAssistantMetadata(assistant);
  assert.ok(metadata);
  const data = {
    version: 6,
    role: "assistant",
    timestamp: assistant.timestamp,
    metadata,
    estimatedCost: 0.009,
    costSinceUser: 0.039,
  } as const;
  const theme = { fg: (_color: string, text: string) => text } as never;
  const component = renderer({ data } as never, { expanded: false }, theme);
  assert.ok(component);
  assert.deepEqual(
    component.render(80).map((line) => line.trim()),
    ["00:01:02", "est $0.009 · since user $0.039"],
  );

  settings = { ...settings, assistantMetadata: "compact" };
  assert.deepEqual(
    component.render(80).map((line) => line.trim()),
    ["00:01:02", "test-model · 2 tok · est $0.009 · since user $0.039"],
  );
  settings = { ...settings, showCostSinceUser: false };
  assert.deepEqual(
    component.render(80).map((line) => line.trim()),
    ["00:01:02", "test-model · 2 tok · est $0"],
  );
  for (const width of [1, 4, 8, 12]) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} exceeded width ${width}`);
    }
  }
});

test("diagnostic settings independently control timeline, Thinking, and compact outcomes", () => {
  let settings: StampSettings = {
    ...DEFAULT_STAMP_SETTINGS,
    timeZone: "UTC",
    assistantMetadata: "compact",
  };
  const renderer = createStampEntryRenderer(() => settings);
  const assistant = assistantMessage(Date.UTC(2026, 6, 30, 0, 1, 2), "error");
  const metadata = captureAssistantMetadata(assistant);
  assert.ok(metadata);
  const component = renderer(
    {
      data: {
        version: 5,
        role: "assistant",
        timestamp: assistant.timestamp,
        completedAt: assistant.timestamp + 1_000,
        metadata,
        thinkingLevel: "high",
      },
    } as never,
    { expanded: true },
    { fg: (_color: string, text: string) => text } as never,
  );
  assert.ok(component);
  const render = () =>
    component
      .render(120)
      .map((line) => line.trim())
      .join("\n");
  assert.match(render(), /timeline · created/u);
  assert.match(render(), /thinking high/u);
  assert.match(render(), /stop error/u);

  settings = { ...settings, showExactTimeline: false };
  assert.doesNotMatch(render(), /timeline ·/u);
  assert.match(render(), /thinking high/u);
  assert.match(render(), /stop error/u);

  settings = { ...settings, showExactTimeline: true, showThinkingLevel: false };
  assert.match(render(), /timeline · created/u);
  assert.doesNotMatch(render(), /thinking high/u);
  assert.match(render(), /stop error/u);

  settings = {
    ...settings,
    showThinkingLevel: true,
    showCompactAbnormalOutcome: false,
  };
  assert.match(render(), /timeline · created/u);
  assert.match(render(), /thinking high/u);
  assert.doesNotMatch(render(), /stop error/u);
});

test("entry renderer composes opt-in assistant metadata, explicit debug details, and tool stamps", () => {
  let settings: StampSettings = {
    ...DEFAULT_STAMP_SETTINGS,
    timeZone: "UTC",
    assistantMetadata: "compact",
  };
  const renderer = createStampEntryRenderer(() => settings);
  const assistant = {
    ...assistantMessage(Date.UTC(2026, 6, 30, 0, 1, 2)),
    responseModel: "actual-model",
    responseId: "response-1",
    diagnostics: [
      {
        type: "retry",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 3),
        error: { name: "HTTPError", code: 429, message: "raw secret" },
      },
    ],
  };
  const metadata = captureAssistantMetadata(assistant);
  assert.ok(metadata);
  const data = {
    version: 5,
    role: "assistant",
    timestamp: assistant.timestamp,
    completedAt: assistant.timestamp + 3_200,
    firstContentAt: assistant.timestamp + 800,
    metadata,
    thinkingLevel: "high",
  } as const;
  const theme = { fg: (_color: string, text: string) => text } as never;
  const compact = renderer({ data } as never, { expanded: false }, theme);
  assert.ok(compact);
  assert.deepEqual(
    compact.render(80).map((line) => line.trim()),
    ["00:01:02", "test-model → actual-model · thinking high · 2 tok · est $0"],
  );

  settings = { ...settings, assistantMetadata: "expanded", responseTiming: "duration" };
  const debug = renderer({ data } as never, { expanded: true }, theme);
  assert.ok(debug);
  assert.deepEqual(
    debug.render(120).map((line) => line.trim()),
    [
      "00:01:02 · 3.2s",
      "timeline · created 2026-07-30T00:01:02.000Z · unix-ms 1785369662000",
      "timeline · first content 2026-07-30T00:01:02.800Z · unix-ms 1785369662800",
      "timeline · completed 2026-07-30T00:01:05.200Z · unix-ms 1785369665200",
      "api anthropic-messages · provider anthropic · requested test-model · response actual-model · thinking high · stop stop",
      "tokens in 1 · out 1 · cache read 0 · cache write 0 · total 2 · est cost $0",
      "debug · response id response-1",
      "debug · diagnostics 1",
      "debug · retry · HTTPError · code 429",
    ],
  );
  assert.equal(debug.render(120).join("\n").includes("raw secret"), false);

  settings = { ...settings, toolStamps: false };
  const toolEntry = {
    data: {
      version: 1,
      kind: "tool",
      toolCallId: "call-1",
      toolName: "read",
      startedAt: assistant.timestamp,
      completedAt: assistant.timestamp + 1_250,
      outcome: "success",
    },
  } as never;
  assert.equal(renderer(toolEntry, { expanded: false }, theme), undefined);
  settings = { ...settings, toolStamps: true };
  const tool = renderer(toolEntry, { expanded: false }, theme);
  assert.ok(tool);
  assert.deepEqual(
    tool.render(80).map((line) => line.trim()),
    ["tool read · 1.3s · success"],
  );
  const expandedTool = renderer(toolEntry, { expanded: true }, theme);
  assert.ok(expandedTool);
  assert.deepEqual(
    expandedTool.render(80).map((line) => line.trim()),
    [
      "tool read · 1.3s · success",
      "timeline · started 2026-07-30T00:01:02.000Z · unix-ms 1785369662000",
      "timeline · completed 2026-07-30T00:01:03.250Z · unix-ms 1785369663250",
    ],
  );
  settings = { ...settings, showExactTimeline: false };
  assert.deepEqual(
    expandedTool.render(80).map((line) => line.trim()),
    ["tool read · 1.3s · success"],
  );
  settings = { ...settings, showExactTimeline: true, toolStamps: false };
  assert.deepEqual(tool.render(80), []);
  settings = { ...settings, toolStamps: true };
  for (const width of [1, 4, 8, 12]) {
    for (const line of [...debug.render(width), ...tool.render(width), ...expandedTool.render(width)]) {
      assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} exceeded width ${width}`);
    }
  }
});

test("Pi persists version-6 stamp entries across reopen without adding them to model context", (t) => {
  const sessionDir = mkdtempSync(`${os.tmpdir()}/pi-stamp-session-`);
  t.onTestFinished(() => rmSync(sessionDir, { recursive: true, force: true }));
  const session = SessionManager.create(process.cwd(), sessionDir);
  const metadata = captureAssistantMetadata(assistantMessage(ASSISTANT_TIMESTAMP));
  assert.ok(metadata);
  const stampData = {
    version: 6,
    role: "assistant",
    timestamp: USER_TIMESTAMP,
    previousTimestamp: USER_TIMESTAMP - 1_000,
    completedAt: USER_TIMESTAMP + 3_200,
    firstContentAt: USER_TIMESTAMP + 800,
    metadata,
    thinkingLevel: "high",
    estimatedCost: 0.009,
    costSinceUser: 0.039,
  } as const;

  session.appendMessage(userMessage(USER_TIMESTAMP));
  session.appendCustomEntry(STAMP_ENTRY_TYPE, stampData);
  session.appendMessage(assistantMessage(ASSISTANT_TIMESTAMP));
  const sessionFile = session.getSessionFile();
  assert.ok(sessionFile);

  const reopened = SessionManager.open(sessionFile, sessionDir);
  assert.deepEqual(
    reopened.getBranch().map((entry) => entry.type),
    ["message", "custom", "message"],
  );
  const restoredStamp = reopened.getBranch().at(1);
  assert.equal(restoredStamp?.type, "custom");
  if (restoredStamp?.type !== "custom") assert.fail("Expected restored custom stamp entry");
  assert.equal(restoredStamp.customType, STAMP_ENTRY_TYPE);
  assert.deepEqual(restoredStamp.data, stampData);
  assert.deepEqual(
    reopened.buildSessionContext().messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

function userMessage(timestamp: number) {
  return { role: "user" as const, content: "hello", timestamp };
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
