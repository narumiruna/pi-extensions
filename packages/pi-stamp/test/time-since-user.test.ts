import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { DEFAULT_STAMP_SETTINGS, formatTimeSinceUser, type StampSettings } from "../src/format.js";
import { normalizeStampSettingsDocument, type StampSettingsRuntime } from "../src/settings.js";
import stamp, { createStampEntryRenderer, isMessageStampData, STAMP_ENTRY_TYPE } from "../src/stamp.js";

const BASE = Date.UTC(2026, 6, 30, 0, 0, 0);
const theme = { fg: (_color: string, text: string) => text } as never;

function settingsState(settings: Partial<StampSettings>) {
  const normalized = normalizeStampSettingsDocument(settings);
  assert.ok(normalized);
  return { ...normalized, canSave: true };
}

function harness(
  settings: Partial<StampSettings> = {},
  session = SessionManager.inMemory(),
  mode: "tui" | "rpc" | "print" | "json" = "tui",
) {
  const mock = createMockPi();
  let clock = BASE;
  let state = settingsState({ showTimeSinceUser: true, timeZone: "UTC", ...settings });
  const runtime: StampSettingsRuntime = {
    get: () => state,
    getPath: () => "/unused/pi-stamp.json",
    reload: async () => state,
    update: async (patch) => {
      state = settingsState({ ...state.settings, ...patch });
      return state;
    },
    flush: async () => undefined,
  };
  const append = mock.rawPi.appendEntry;
  mock.rawPi.appendEntry = (type, data) => {
    append(type, data);
    session.appendCustomEntry(type, data);
  };
  stamp(mock.pi, { settingsRuntime: runtime, now: () => clock });
  const { ctx } = createMockContext({ mode, sessionManager: session, thinkingLevel: "high" });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
  };
  const user = async (at: number) => {
    const message = { role: "user" as const, timestamp: at, content: "hello" };
    await emit("message_start", { message });
    await emit("message_end", { message });
    return session.appendMessage(message);
  };
  const response = async (started: number, completed: number, stopReason: StopReason = "stop", delay = 0) => {
    const message: AssistantMessage = {
      role: "assistant",
      timestamp: started,
      stopReason,
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
    };
    await emit("turn_start", { turnIndex: 0, timestamp: started });
    await emit("message_start", { message });
    clock = completed;
    await emit("message_end", { message });
    session.appendMessage(message);
    clock += delay;
    await emit("turn_end", { message, toolResults: [], turnIndex: 0 });
    const data = mock.entries.at(-1)?.data;
    assert.ok(isMessageStampData(data));
    return data;
  };
  return { mock, runtime, session, emit, user, response };
}

function elapsed(data: unknown) {
  assert.ok(isMessageStampData(data));
  return data.version === 7 ? data.timeSinceUserMs : undefined;
}

test("time since user includes tool loops, freezes at message completion, and resets on steering/follow-ups", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.user(BASE);
  assert.equal(elapsed(await h.response(BASE + 1_000, BASE + 3_000, "toolUse", 10_000)), undefined);
  h.session.appendMessage({
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: BASE + 13_000,
  });
  assert.equal(elapsed(await h.response(BASE + 13_000, BASE + 15_000, "toolUse", 10_000)), undefined);
  const final = await h.response(BASE + 25_000, BASE + 84_000, "stop", 20_000);
  assert.equal(elapsed(final), 84_000);
  await h.emit("agent_end");
  await h.emit("agent_settled");
  assert.equal(elapsed(await h.response(BASE + 100_000, BASE + 110_000)), 110_000);
  for (const at of [BASE + 120_000, BASE + 150_000]) {
    await h.user(at);
    assert.equal(elapsed(await h.response(at + 1_000, at + 2_000)), 2_000);
  }
  assert.equal(elapsed(final), 84_000);
  assert.deepEqual(h.mock.sentMessages, []);
  assert.deepEqual(h.mock.sentUserMessages, []);
});

test("error, aborted, length, and retry responses each retain their own fixed duration", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.user(BASE);
  const snapshots = [];
  for (const [index, reason] of (["error", "aborted", "length", "stop"] as const).entries()) {
    snapshots.push(await h.response(BASE + index * 10_000, BASE + index * 10_000 + 2_000, reason));
    await h.emit("agent_end");
  }
  assert.deepEqual(snapshots.map(elapsed), [2_000, 12_000, 22_000, 32_000]);
});

test("reopen, reload, tree navigation, and compaction never rewrite captured stamps", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-stamp-elapsed-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const h = harness({}, SessionManager.create(process.cwd(), dir));
  await h.emit("session_start");
  await h.user(BASE);
  const first = await h.response(BASE + 1_000, BASE + 2_000);
  const firstLeaf = h.session.getLeafId();
  assert.ok(firstLeaf);
  await h.user(BASE + 10_000);
  const second = await h.response(BASE + 11_000, BASE + 15_000);
  const snapshot = JSON.stringify(h.session.getEntries());
  await h.emit("session_shutdown");
  const file = h.session.getSessionFile();
  assert.ok(file);
  const reopened = SessionManager.open(file, dir);
  const resumed = harness({}, reopened);
  await resumed.emit("session_start", { reason: "resume" });
  assert.equal(JSON.stringify(reopened.getEntries()), snapshot);
  assert.equal(elapsed(await resumed.response(BASE + 3_600_000, BASE + 3_602_000)), 3_592_000);
  await resumed.emit("session_shutdown");
  await resumed.emit("session_start", { reason: "reload" });
  reopened.branch(firstLeaf);
  await resumed.emit("session_tree");
  const compactAt = reopened
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(compactAt);
  reopened.appendCompaction("summary", compactAt.id, 100);
  assert.equal(elapsed(await resumed.response(BASE + 3_700_000, BASE + 3_702_000)), 3_702_000);
  assert.equal(elapsed(first), 2_000);
  assert.equal(elapsed(second), 5_000);
  const saved = reopened
    .getEntries()
    .filter((entry) => entry.type === "custom")
    .filter((entry) => entry.customType === STAMP_ENTRY_TYPE);
  assert.ok(saved.some((entry) => JSON.stringify(entry.data) === JSON.stringify(first)));
  assert.ok(saved.some((entry) => JSON.stringify(entry.data) === JSON.stringify(second)));
  assert.ok(reopened.buildSessionContext().messages.every((message) => !("timeSinceUserMs" in message)));

  const empty = harness();
  await empty.emit("session_start", { reason: "switch" });
  assert.equal(elapsed(await empty.response(BASE + 1_000, BASE + 2_000)), undefined);
});

test("missing, malformed, backwards, and unobserved boundaries omit elapsed time rather than inventing it", async () => {
  for (const timestamp of [undefined, Number.NaN, Infinity, 1e20, BASE + 20_000]) {
    const h = harness();
    await h.emit("session_start");
    if (timestamp !== undefined) {
      await h.user(BASE - 1_000);
      await h.user(timestamp);
    }
    assert.equal(elapsed(await h.response(BASE, BASE + 2_000)), undefined, String(timestamp));
  }
  for (const completedAt of [BASE - 1, Number.NaN, Infinity]) {
    const h = harness();
    await h.emit("session_start");
    await h.user(BASE);
    assert.equal(elapsed(await h.response(BASE, completedAt)), undefined);
  }
  const zero = harness();
  await zero.emit("session_start");
  await zero.user(BASE);
  assert.equal(elapsed(await zero.response(BASE, BASE)), 0);
});

test("capture is opt-in and works independently of or together with metadata and cost", async () => {
  for (const enabled of [false, true]) {
    for (const metadata of ["off", "compact", "expanded"] as const) {
      for (const showCostSinceUser of [false, true]) {
        const h = harness({ showTimeSinceUser: enabled, assistantMetadata: metadata, showCostSinceUser });
        await h.emit("session_start");
        await h.user(BASE);
        const data = await h.response(BASE + 1_000, BASE + 2_000);
        assert.equal(data.version, enabled ? 7 : showCostSinceUser ? 6 : metadata === "off" ? 3 : 5);
        assert.equal(elapsed(data), enabled ? 2_000 : undefined);
        if (data.version === 6 || data.version === 7) {
          assert.equal(data.costSinceUser, showCostSinceUser ? 0.01 : undefined);
          assert.equal(data.estimatedCost, showCostSinceUser ? 0.01 : undefined);
          assert.equal(data.metadata !== undefined, metadata !== "off");
          assert.equal(data.thinkingLevel, metadata === "off" ? undefined : "high");
        }
      }
    }
  }
});

test("pending elapsed observations are cleared at lifecycle boundaries", async () => {
  for (const boundary of ["turn_start", "agent_end", "session_start", "session_shutdown"] as const) {
    const h = harness();
    await h.emit("session_start");
    await h.user(BASE);
    const message = { role: "assistant", timestamp: BASE, stopReason: "stop" };
    await h.emit("message_start", { message });
    await h.emit("message_end", { message });
    await h.emit(boundary);
    const before = h.mock.entries.length;
    await h.emit("turn_end", { message, toolResults: [] });
    if (boundary === "session_shutdown") assert.equal(h.mock.entries.length, before);
    else assert.equal(elapsed(h.mock.entries.at(-1)?.data), undefined, boundary);
  }
});

test("opted-in headless sessions never append transcript stamps", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const h = harness({}, SessionManager.inMemory(), mode);
    await h.emit("session_start");
    await h.user(BASE);
    const message = { role: "assistant", timestamp: BASE, stopReason: "stop" };
    await h.emit("message_start", { message });
    await h.emit("message_end", { message });
    await h.emit("turn_end", { message, toolResults: [] });
    await h.emit("session_shutdown");
    assert.deepEqual(h.mock.entries, [], mode);
  }
});

test("turn-end stop reason controls elapsed display after message-end transforms", async () => {
  for (const [observed, finalized, expected] of [
    ["toolUse", "stop", 0],
    ["stop", "toolUse", undefined],
  ] as const) {
    const h = harness();
    await h.emit("session_start");
    await h.user(BASE);
    await h.emit("message_start", { message: { role: "assistant", timestamp: BASE } });
    await h.emit("message_end", { message: { role: "assistant", timestamp: BASE, stopReason: observed } });
    await h.emit("turn_end", {
      message: { role: "assistant", timestamp: BASE, stopReason: finalized },
      toolResults: [],
    });
    assert.equal(elapsed(h.mock.entries.at(-1)?.data), expected);
  }
});

test("turn-end timestamp changes cannot reuse an elapsed observation", async () => {
  const h = harness({ showCostSinceUser: true });
  await h.emit("session_start");
  await h.user(BASE);
  const message = { role: "assistant", timestamp: BASE, stopReason: "stop", usage: { cost: { total: 0.01 } } };
  await h.emit("message_start", { message });
  await h.emit("message_end", { message });
  await h.emit("turn_end", { message: { ...message, timestamp: BASE + 1 }, toolResults: [] });
  const data = h.mock.entries.at(-1)?.data;
  assert.ok(isMessageStampData(data));
  assert.equal(data.version, 6);
  assert.equal(elapsed(data), undefined);
});

test("versions 6 and 7 enforce the complete optional cost pair contract", () => {
  for (const version of [6, 7]) {
    const base = {
      version,
      role: "assistant",
      timestamp: BASE,
      ...(version === 7 ? { completedAt: BASE, timeSinceUserMs: 0 } : {}),
    };
    for (const [cost, valid] of [
      [{}, version === 7],
      [{ costSinceUser: 0 }, true],
      [{ costSinceUser: 0, estimatedCost: 0 }, true],
      [{ costSinceUser: 0.02, estimatedCost: 0.01 }, true],
      [{ estimatedCost: 0 }, false],
      [{ costSinceUser: undefined }, false],
      [{ costSinceUser: -1 }, false],
      [{ costSinceUser: Infinity }, false],
      [{ costSinceUser: NaN }, false],
      [{ costSinceUser: "0" }, false],
      [{ costSinceUser: 0, estimatedCost: undefined }, false],
      [{ costSinceUser: 0, estimatedCost: -1 }, false],
      [{ costSinceUser: 0, estimatedCost: Infinity }, false],
      [{ costSinceUser: 0, estimatedCost: NaN }, false],
      [{ costSinceUser: 0, estimatedCost: "0" }, false],
      [{ costSinceUser: 0.01, estimatedCost: 0.02 }, false],
    ] as const) {
      assert.equal(isMessageStampData({ ...base, ...cost }), valid, JSON.stringify({ version, cost }));
    }
  }
});

test("version 7 validates exact timing and optional metadata/cost fields", () => {
  const valid = { version: 7, role: "assistant", timestamp: BASE, completedAt: BASE + 2_000, timeSinceUserMs: 2_000 };
  assert.ok(isMessageStampData(valid));
  assert.ok(isMessageStampData({ ...valid, timeSinceUserMs: 0 }));
  assert.ok(isMessageStampData({ ...valid, estimatedCost: 0, costSinceUser: 0 }));
  for (const patch of [
    { role: "user" },
    { completedAt: undefined },
    { completedAt: BASE - 1 },
    { timeSinceUserMs: undefined },
    { timeSinceUserMs: -1 },
    { timeSinceUserMs: NaN },
    { timeSinceUserMs: Infinity },
    { timeSinceUserMs: "2000" },
    { future: true },
    { costSinceUser: undefined },
    { costSinceUser: -1 },
    { estimatedCost: 0.01 },
    { estimatedCost: 0.02, costSinceUser: 0.01 },
    { firstContentAt: BASE + 3_000 },
    { metadata: {} },
    { thinkingLevel: "ultra" },
  ])
    assert.equal(isMessageStampData({ ...valid, ...patch }), false, JSON.stringify(patch));
});

test("persisted elapsed rendering is immutable, width-safe, and independently toggleable", async () => {
  const h = harness({ showCostSinceUser: true });
  await h.emit("session_start");
  await h.user(BASE);
  const data = await h.response(BASE + 80_800, BASE + 84_000);
  const renderer = createStampEntryRenderer(() => h.runtime.get().settings);
  const component = renderer({ data } as never, { expanded: false }, theme);
  assert.ok(component);
  const render = () => component.render(120).map((line) => line.trim());
  assert.deepEqual(render(), ["00:01:20 · since user 1m 24s", "est $0.01 · since user $0.01"]);
  await h.runtime.update({ responseTiming: "duration" });
  assert.equal(render()[0], "00:01:20 · response 3.2s · since user 1m 24s");
  await h.runtime.update({ responseTiming: "detailed" });
  assert.equal(render()[0], "00:01:20 · first n/a · total 3.2s · since user 1m 24s");
  await h.runtime.update({ showTimeSinceUser: false });
  assert.equal(render()[0], "00:01:20 · first n/a · total 3.2s");
  await h.runtime.update({ showTimeSinceUser: true, showCostSinceUser: false, responseTiming: "off" });
  assert.deepEqual(render(), ["00:01:20 · since user 1m 24s"]);
  component.invalidate();
  assert.deepEqual(render(), ["00:01:20 · since user 1m 24s"]);
  for (const expanded of [false, true]) {
    const view = renderer({ data } as never, { expanded }, theme);
    assert.ok(view);
    for (const width of [0, 1, 4, 8, 12, 80]) {
      assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
    }
  }
  const legacy = renderer(
    { data: { version: 3, role: "assistant", timestamp: BASE, completedAt: BASE + 2_000 } } as never,
    { expanded: false },
    theme,
  );
  assert.deepEqual(
    legacy?.render(80).map((line) => line.trim()),
    ["00:00:00"],
  );
});

test("minute rounding renders consistently in collapsed and expanded stamps", () => {
  const renderer = createStampEntryRenderer(() => ({ ...DEFAULT_STAMP_SETTINGS, showTimeSinceUser: true }));
  for (const expanded of [false, true]) {
    const component = renderer(
      {
        data: { version: 7, role: "assistant", timestamp: BASE, completedAt: BASE + 59_950, timeSinceUserMs: 59_950 },
      } as never,
      { expanded },
      theme,
    );
    assert.ok(component);
    assert.match(component.render(120).join("\n"), /since user 1m 0s/u);
  }
});

test("elapsed formatting covers subsecond, minute, hour, and invalid durations", () => {
  assert.equal(DEFAULT_STAMP_SETTINGS.showTimeSinceUser, false);
  for (const [ms, expected] of [
    [0, "0.0s"],
    [1, "<0.1s"],
    [100, "0.1s"],
    [3_200, "3.2s"],
    [59_949, "59.9s"],
    [59_950, "1m 0s"],
    [59_999, "1m 0s"],
    [60_000, "1m 0s"],
    [60_001, "1m 0s"],
    [84_999, "1m 24s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 0m 0s"],
    [90_061_000, "25h 1m 1s"],
    [-1, undefined],
    [NaN, undefined],
    [Infinity, undefined],
  ] as const)
    assert.equal(formatTimeSinceUser(ms), expected);
});
