import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  DEFAULT_STAMP_SETTINGS,
  formatMessageStampLabel,
  formatOutputThroughput,
  type StampSettings,
} from "../src/format.js";
import { createStampMenu } from "../src/menu.js";
import { captureCompletedOutputTokens } from "../src/metadata.js";
import { METADATA_PRESETS } from "../src/metadata-settings.js";
import {
  createStampSettingsRuntime,
  normalizeStampSettingsDocument,
  type StampSettingsRuntime,
} from "../src/settings.js";

const BASE = Date.UTC(2026, 6, 30);
const theme = { fg: (_color: string, text: string) => text } as never;
const directory = mkdtempSync(join(tmpdir(), "pi-stamp-throughput-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let extension: typeof import("../src/stamp.js");

beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = directory;
  extension = await import("../src/stamp.js");
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
});

function message(stopReason = "stop", output = 134) {
  return {
    role: "assistant",
    timestamp: BASE,
    stopReason,
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { output, reasoning: 100, totalTokens: 5_000, cost: { total: 0.01 } },
  };
}

function harness(
  settings: Partial<StampSettings> = {},
  session = SessionManager.inMemory(),
  mode: "tui" | "rpc" | "print" | "json" = "tui",
) {
  const mock = createMockPi();
  let clock = BASE;
  const normalize = (settings: Partial<StampSettings>) => {
    const normalized = normalizeStampSettingsDocument(settings);
    assert.ok(normalized);
    return { ...normalized, canSave: true };
  };
  let state = normalize({ timeZone: "UTC", showOutputThroughput: true, ...settings });
  const runtime: StampSettingsRuntime = {
    get: () => state,
    getPath: () => "/unused/pi-stamp.json",
    reload: async () => state,
    update: async (patch) => {
      state = normalize({ ...state.settings, ...patch });
      return state;
    },
    flush: async () => undefined,
  };
  const append = mock.rawPi.appendEntry;
  mock.rawPi.appendEntry = (type, data) => {
    append(type, data);
    session.appendCustomEntry(type, data);
  };
  extension.default(mock.pi, { settingsRuntime: runtime, now: () => clock });
  const { ctx } = createMockContext({ mode, sessionManager: session, thinkingLevel: "high" });
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of mock.events.get(event) ?? []) await handler(payload, ctx);
  };
  const response = async (reply: unknown = message(), completedAt = BASE + 3_200, observeEnd = true) => {
    await emit("turn_start");
    await emit("message_start", { message: reply });
    clock = BASE + 800;
    await emit("message_update", { message: reply, assistantMessageEvent: { type: "thinking_delta", delta: "x" } });
    clock = completedAt;
    if (observeEnd) await emit("message_end", { message: reply });
    // Delayed tool execution must never enter the denominator.
    clock = BASE + 60_000;
    await emit("turn_end", { message: reply, toolResults: [] });
    return mock.entries.at(-1)?.data;
  };
  return { mock, runtime, session, emit, response };
}

function render(data: unknown, settings: Partial<StampSettings> = {}, expanded = false) {
  const renderer = extension.createStampEntryRenderer(() => ({
    ...DEFAULT_STAMP_SETTINGS,
    timeZone: "UTC",
    showOutputThroughput: true,
    ...settings,
  }));
  return (
    renderer({ data } as never, { expanded }, theme)
      ?.render(180)
      .map((line) => line.trim()) ?? []
  );
}

test("throughput uses only output and exact creation-to-completion time, regardless of first content", () => {
  assert.equal(DEFAULT_STAMP_SETTINGS.showOutputThroughput, false);
  assert.equal(captureCompletedOutputTokens(message()), 134);
  for (const firstContentAt of [undefined, BASE, BASE + 3_199]) {
    for (const responseTiming of ["off", "duration", "detailed"] as const) {
      const label = formatMessageStampLabel(
        { timestamp: BASE, completedAt: BASE + 3_200, firstContentAt, outputTokens: 134 },
        { ...DEFAULT_STAMP_SETTINGS, timeZone: "UTC", responseTiming, showOutputThroughput: true },
      );
      assert.ok(label?.endsWith(" · 41.9 tok/s"));
    }
  }
  for (const [outputTokens, ms, expected] of [
    [0, 1000, "0 tok/s"],
    [42, 1000, "42 tok/s"],
    [1, 100_000, "<0.1 tok/s"],
    [1, 1, "1000 tok/s"],
    [1, 10_000, "0.1 tok/s"],
    [1, 0, undefined],
    [1, -1, undefined],
    [1, NaN, undefined],
    [1, Infinity, undefined],
    [-1, 1000, undefined],
    [0.5, 1000, undefined],
    [NaN, 1000, undefined],
    [Infinity, 1000, undefined],
    [Number.MAX_SAFE_INTEGER + 1, 1000, undefined],
  ] as const) {
    assert.equal(formatOutputThroughput({ timestamp: BASE, completedAt: BASE + ms, outputTokens }), expected);
  }
  assert.equal(formatOutputThroughput({ timestamp: BASE, completedAt: BASE + 1000 }), undefined);
  assert.equal(formatOutputThroughput({ timestamp: NaN, completedAt: BASE, outputTokens: 1 }), undefined);
});

test("eligible stops capture independently of metadata, durations, costs, and elapsed-since-user settings", async () => {
  for (const stopReason of ["stop", "toolUse", "length"]) {
    for (const preset of ["none", "compact", "detailed"] as const) {
      for (const extras of [false, true]) {
        const h = harness({ ...METADATA_PRESETS[preset], showCostSinceUser: extras, showTimeSinceUser: extras });
        h.session.appendMessage({ role: "user", timestamp: BASE - 1000, content: "hello" });
        await h.emit("session_start");
        const data = await h.response(message(stopReason));
        assert.ok(extension.isMessageStampData(data) && data.version === 8);
        assert.equal(data.outputTokens, 134);
        assert.equal(data.completedAt, BASE + 3_200);
        assert.equal(data.firstContentAt, BASE + 800);
        assert.equal(data.metadata !== undefined, preset !== "none");
        assert.equal(data.thinkingLevel, preset === "none" ? undefined : "high");
        assert.equal(data.costSinceUser, extras && stopReason !== "toolUse" ? 0.01 : undefined);
        assert.equal(data.timeSinceUserMs, extras && stopReason !== "toolUse" ? 4_200 : undefined);
        assert.ok(render(data)[0]?.endsWith("41.9 tok/s"));
        assert.equal(h.mock.sentMessages.length, 0);
        assert.equal(h.mock.sentUserMessages.length, 0);
      }
    }
  }
});

test("missing or invalid output and error/aborted/unknown stops never produce throughput", async () => {
  for (const reply of [
    ...[undefined, null, "134", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((output) => ({
      ...message(),
      usage: { ...message().usage, output },
    })),
    ...["error", "aborted", "unknown"].map((reason) => message(reason)),
  ]) {
    const h = harness({ ...METADATA_PRESETS.detailed });
    await h.emit("session_start");
    assert.equal(captureCompletedOutputTokens(reply), undefined);
    const data = await h.response(reply);
    assert.ok(extension.isMessageStampData(data) && data.version !== 8);
    assert.ok(render(data).every((line) => !line.includes("tok/s")));
  }
  const zero = harness();
  await zero.emit("session_start");
  assert.match(render(await zero.response(message("stop", 0)))[0] ?? "", /0 tok\/s/u);
});

test("capture requires opt-in and a positive matching completion observation", async () => {
  for (const completedAt of [BASE, BASE - 1, NaN, Infinity]) {
    const h = harness();
    await h.emit("session_start");
    const data = await h.response(message(), completedAt);
    assert.ok(extension.isMessageStampData(data) && data.version !== 8);
  }
  const disabled = harness({ showOutputThroughput: false });
  await disabled.emit("session_start");
  const disabledData = await disabled.response();
  assert.ok(extension.isMessageStampData(disabledData));
  assert.equal(disabledData.version, 3);
  const unobserved = harness();
  await unobserved.emit("session_start");
  const unobservedData = await unobserved.response(message(), BASE + 1000, false);
  assert.ok(extension.isMessageStampData(unobservedData));
  assert.equal(unobservedData.version, 2);
  for (const boundary of ["turn_start", "agent_end", "session_start", "session_shutdown", "timestamp-change"]) {
    const h = harness();
    await h.emit("session_start");
    // Record a valid completion, then begin a fresh observation to test clearing.
    await h.response();
    const reply = { ...message(), timestamp: BASE - 1000 };
    await h.emit("message_start", { message: reply });
    await h.emit("message_end", { message: reply });
    const before = h.mock.entries.length;
    if (boundary === "timestamp-change") reply.timestamp += 1;
    else await h.emit(boundary);
    await h.emit("turn_end", { message: reply, toolResults: [] });
    if (boundary === "session_shutdown") assert.equal(h.mock.entries.length, before);
    else {
      const data = h.mock.entries.at(-1)?.data;
      assert.ok(extension.isMessageStampData(data));
      assert.notEqual(data.version, 8);
    }
  }
});

test("final stop and usage at turn_end control capture after message_end transformations", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("message_end", { message: { ...message(), timestamp: BASE - 1000 } });
  await h.emit("turn_end", { message: { ...message("aborted"), timestamp: BASE - 1000 }, toolResults: [] });
  const data = h.mock.entries.at(-1)?.data;
  assert.ok(extension.isMessageStampData(data));
  assert.notEqual(data.version, 8);
});

test("version 8 validates raw inputs and preserves the optional timing and cost contracts", () => {
  const valid = { version: 8, role: "assistant", timestamp: BASE, completedAt: BASE + 3200, outputTokens: 134 };
  for (const fields of [
    {},
    { outputTokens: 0 },
    { timeSinceUserMs: 4200 },
    { estimatedCost: 0.01, costSinceUser: 0.02 },
  ]) {
    assert.ok(extension.isMessageStampData({ ...valid, ...fields }));
  }
  for (const patch of [
    { role: "user" },
    { outputTokens: undefined },
    { outputTokens: -1 },
    { outputTokens: 1.5 },
    { outputTokens: NaN },
    { outputTokens: Infinity },
    { outputTokens: "134" },
    { completedAt: undefined },
    { completedAt: BASE },
    { completedAt: BASE - 1 },
    { timeSinceUserMs: undefined },
    { timeSinceUserMs: -1 },
    { timeSinceUserMs: Infinity },
    { estimatedCost: 0.01 },
    { estimatedCost: 0.02, costSinceUser: 0.01 },
    { costSinceUser: undefined },
    { metadata: {} },
    { thinkingLevel: "unknown" },
    { firstContentAt: BASE + 4000 },
    { previousTimestamp: NaN },
    { future: true },
  ])
    assert.equal(extension.isMessageStampData({ ...valid, ...patch }), false, JSON.stringify(patch));
});

test("mounted rendering keeps throughput on one row in both expansion modes and stays width-safe", async () => {
  const h = harness();
  await h.emit("session_start");
  const data = await h.response();
  const serialized = JSON.stringify(data);
  const renderer = extension.createStampEntryRenderer(() => h.runtime.get().settings);
  for (const expanded of [false, true]) {
    await h.runtime.update({ responseTiming: "off", showExactTimeline: true });
    const view = renderer({ data } as never, { expanded }, theme);
    assert.ok(view);
    assert.match(view.render(180)[0] ?? "", /41\.9 tok\/s/u);
    assert.equal(view.render(180).filter((line) => line.includes("tok/s")).length, 1);
    assert.doesNotMatch(view.render(180).join("\n"), /average output throughput|creation to completion/u);
    assert.equal(view.render(180).length, expanded ? 4 : 1);
    await h.runtime.update({ showExactTimeline: false });
    assert.deepEqual(
      view.render(180).map((line) => line.trim()),
      ["00:00:00 · 41.9 tok/s"],
    );
    for (const width of [0, 1, 5, 20, 80]) assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
    await h.runtime.update({ showOutputThroughput: false });
    assert.deepEqual(
      view.render(180).map((line) => line.trim()),
      ["00:00:00"],
    );
    await h.runtime.update({ showOutputThroughput: true, responseTiming: "detailed" });
    assert.match(view.render(180)[0] ?? "", /first 0\.8s · total 3\.2s · 41\.9 tok\/s/u);
    view.invalidate();
    assert.match(view.render(180)[0] ?? "", /41\.9 tok\/s/u);
  }
  assert.equal(JSON.stringify(data), serialized);
});

test("compatible metadata-only history can show rates; timestamp-only and incomplete history cannot", () => {
  for (const version of [4, 5, 6, 7]) {
    for (const stopReason of ["stop", "toolUse", "length", "error", "aborted"]) {
      const data = {
        version,
        role: "assistant",
        timestamp: BASE,
        completedAt: BASE + 3200,
        metadata: {
          api: "test",
          provider: "test",
          model: "test",
          stopReason,
          usage: { output: 134, reasoning: 100, totalTokens: 5000 },
        },
        ...(version === 5 ? { thinkingLevel: "high" } : {}),
        ...(version === 6 ? { costSinceUser: 0.01 } : {}),
        ...(version === 7 ? { timeSinceUserMs: 4200 } : {}),
      };
      assert.ok(extension.isMessageStampData(data));
      assert.equal(
        render(data).some((line) => line.includes("41.9 tok/s")),
        ["stop", "toolUse", "length"].includes(stopReason),
      );
    }
  }
  for (const version of [1, 2, 3]) {
    const data = {
      version,
      role: "assistant",
      timestamp: BASE,
      ...(version === 3 ? { completedAt: BASE + 3200 } : {}),
    };
    assert.deepEqual(render(data), ["00:00:00"]);
  }
});

test("reload and resume preserve raw counts outside model context, without backfilling history", async () => {
  const session = SessionManager.create(process.cwd(), directory);
  // Make a real assistant entry so SessionManager flushes the file.
  session.appendMessage({
    ...message(),
    role: "assistant",
    stopReason: "stop",
    content: [],
    usage: {
      input: 1,
      output: 134,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 135,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const h = harness({}, session);
  await h.emit("session_start");
  const data = await h.response();
  const snapshot = JSON.stringify(session.getEntries());
  await h.emit("session_shutdown");
  const file = session.getSessionFile();
  assert.ok(file);
  const reopened = SessionManager.open(file, directory);
  const resumed = harness({}, reopened);
  await resumed.emit("session_start");
  assert.equal(JSON.stringify(reopened.getEntries()), snapshot);
  await resumed.emit("session_shutdown");
  await resumed.emit("session_start", { reason: "reload" });
  assert.deepEqual(resumed.mock.entries, []);
  const saved = reopened
    .getBranch()
    .find((entry) => entry.type === "custom" && entry.customType === extension.STAMP_ENTRY_TYPE);
  assert.ok(saved?.type === "custom");
  assert.deepEqual(saved.data, data);
  assert.match(render(saved.data)[0] ?? "", /41\.9 tok\/s/u);
  assert.ok(reopened.buildSessionContext().messages.every((entry) => !("outputTokens" in entry)));
});

test("headless sessions never append throughput entries", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const h = harness({}, SessionManager.inMemory(), mode);
    await h.emit("session_start");
    await h.response();
    await h.emit("session_shutdown");
    assert.deepEqual(h.mock.entries, []);
  }
});

test("throughput settings save in order, reload after publication, and recover from failure without erasing unknown fields", async () => {
  const path = join(directory, "settings.json");
  writeFileSync(path, '{"future":true}');
  let fail = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createStampSettingsRuntime({
    path,
    operations: {
      writeFile: async (...args) => {
        await gate;
        await writeFile(...args);
      },
      rename: async (...args) => {
        if (fail) throw new Error("failed publication");
        await rename(...args);
      },
    },
  });
  await runtime.reload();
  const menu = createStampMenu(runtime);
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  const toggle = (value: string, signal = new AbortController().signal) =>
    menu.actions["set-output-throughput"]({ ctx, state: runtime.get(), signal, itemId: "showOutputThroughput", value });
  const first = toggle("Show");
  const second = toggle("Hide");
  const reload = runtime.reload();
  assert.equal(runtime.get().settings.showOutputThroughput, false);
  release();
  await Promise.all([first, second, reload, runtime.flush()]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { future: true, showOutputThroughput: false });
  assert.equal(runtime.get().sources.showOutputThroughput, "user");
  fail = true;
  assert.deepEqual(await toggle("Show"), { kind: "rejected" });
  assert.equal(runtime.get().settings.showOutputThroughput, false);
  assert.equal(notifications.at(-1)?.level, "error");
  fail = false;
  await toggle("Show");
  await runtime.reload();
  assert.equal(runtime.get().settings.showOutputThroughput, true);
  assert.deepEqual(await toggle("Hide", AbortSignal.abort()), { kind: "rejected" });
  assert.equal(runtime.get().settings.showOutputThroughput, true);
  writeFileSync(path, '{"showOutputThroughput":"yes"}');
  await runtime.reload();
  assert.deepEqual(await toggle("Hide"), { kind: "rejected" });
  assert.equal(runtime.get().settings.showOutputThroughput, true);
  assert.equal(readFileSync(path, "utf8"), '{"showOutputThroughput":"yes"}');
});
