import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, onTestFinished, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { DEFAULT_STAMP_SETTINGS, type StampSettings } from "../src/format.js";
import { captureAssistantMetadata } from "../src/metadata.js";
import {
  METADATA_BOOLEAN_FIELDS,
  METADATA_PRESET_NAMES,
  METADATA_PRESETS,
  type StampMetadataPreset,
} from "../src/metadata-settings.js";
import type { StampSettingsRuntime, StampSettingsState } from "../src/settings.js";

const BASE = Date.UTC(2026, 6, 30);
const directory = mkdtempSync(join(tmpdir(), "pi-stamp-metadata-runtime-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let extension: typeof import("../src/stamp.js");

beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  extension = await import("../src/stamp.js");
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
});

function message() {
  return {
    role: "assistant" as const,
    timestamp: BASE,
    content: [{ type: "text" as const, text: "hello" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "requested-model",
    responseModel: "actual-model",
    responseId: "response-1",
    stopReason: "stop" as const,
    usage: {
      input: 1,
      output: 2,
      reasoning: 1,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { total: 0.009 },
    },
    diagnostics: [{ type: "retry", error: { name: "HTTPError", code: 429, message: "private error" } }],
  };
}

function harness(overrides: Partial<StampSettings> = {}, mode: "tui" | "rpc" | "print" | "json" = "tui") {
  const settings = { ...DEFAULT_STAMP_SETTINGS, timeZone: "UTC", showExactTimeline: false, ...overrides };
  const state: Readonly<StampSettingsState> = {
    settings,
    sources: Object.fromEntries(
      Object.keys(DEFAULT_STAMP_SETTINGS).map((key) => [key, Object.hasOwn(overrides, key) ? "user" : "built-in"]),
    ) as StampSettingsState["sources"],
    canSave: true,
  };
  const runtime: StampSettingsRuntime = {
    get: () => state,
    getPath: () => join(directory, "pi-stamp.json"),
    reload: async () => state,
    update: async () => state,
    flush: async () => undefined,
  };
  const mock = createMockPi();
  extension.default(mock.pi, { settingsRuntime: runtime, now: () => BASE + 3_200 });
  const { ctx } = createMockContext({ mode, thinkingLevel: "high" });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
  };
  onTestFinished(() => emit("session_shutdown", { reason: "quit" }));
  const response = async (reply: unknown = message()) => {
    await emit("session_start", { reason: "startup" });
    await emit("turn_start", { turnIndex: 0, timestamp: BASE });
    await emit("message_start", { message: reply });
    await emit("message_end", { message: reply });
    await emit("turn_end", { message: reply, toolResults: [], turnIndex: 0 });
    return mock.entries.at(-1)?.data;
  };
  const render = (data: unknown, expanded: boolean) =>
    extension.createStampEntryRenderer(() => settings)({ data } as never, { expanded }, {
      fg: (_color: string, text: string) => text,
    } as never);
  return { mock, settings, response, render };
}

test("default runtime captures neither metadata nor Thinking and does not read metadata fields", async () => {
  const h = harness();
  const reply = {
    ...message(),
    get api(): string {
      return assert.fail("Default runtime must not inspect API metadata");
    },
    get provider(): string {
      return assert.fail("Default runtime must not inspect provider metadata");
    },
    get model(): string {
      return assert.fail("Default runtime must not inspect model metadata");
    },
    get responseModel(): string {
      return assert.fail("Default runtime must not inspect response-model metadata");
    },
    get responseId(): string {
      return assert.fail("Default runtime must not inspect response IDs");
    },
    get diagnostics(): never {
      return assert.fail("Default runtime must not inspect diagnostics");
    },
  };
  assert.deepEqual(await h.response(reply), {
    version: 3,
    role: "assistant",
    timestamp: BASE,
    completedAt: BASE + 3_200,
  });
  assert.deepEqual(h.mock.sentMessages, []);
  assert.deepEqual(h.mock.sentUserMessages, []);
});

test("Thinking-only runtime captures and renders Thinking with model and token display disabled", async () => {
  const h = harness({ ...METADATA_PRESETS.none, showPiThinkingLevel: true });
  const data = await h.response();
  assert.ok(extension.isMessageStampData(data) && data.version === 5);
  assert.equal(data.thinkingLevel, "high");
  assert.deepEqual(data.metadata, captureAssistantMetadata(message(), h.settings));
  const snapshot = JSON.stringify(data);
  for (const expanded of [false, true]) {
    const component = h.render(data, expanded);
    assert.ok(component);
    assert.deepEqual(
      component.render(120).map((line) => line.trim()),
      ["00:00:00", "thinking high"],
    );
    for (const width of [0, 1, 4, 8, 12, 80]) {
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
  }
  assert.equal(JSON.stringify(data), snapshot);
});

test.each(METADATA_BOOLEAN_FIELDS)("runtime activates %s without activating other metadata flags", async (field) => {
  const h = harness({ ...METADATA_PRESETS.none, [field]: true });
  const data = await h.response();
  assert.ok(extension.isMessageStampData(data));
  assert.equal(data.version, field === "showPiThinkingLevel" ? 5 : 4);
  assert.ok("metadata" in data);
  assert.deepEqual(data.metadata, captureAssistantMetadata(message(), h.settings));
  assert.equal("thinkingLevel" in data, field === "showPiThinkingLevel");
  if (data.metadata) {
    assert.equal(Object.hasOwn(data.metadata, "responseId"), field === "showResponseId");
    assert.equal(Object.hasOwn(data.metadata, "diagnosticCount"), field === "showDiagnostics");
    assert.equal(Object.hasOwn(data.metadata, "diagnostics"), field === "showDiagnostics");
  }
});

test.each([
  { showResponseId: false, showDiagnostics: false },
  { showResponseId: true, showDiagnostics: false },
  { showResponseId: false, showDiagnostics: true },
  { showResponseId: true, showDiagnostics: true },
])("runtime passes independent debug capture flags: %j", async ({ showResponseId, showDiagnostics }) => {
  const h = harness({ ...METADATA_PRESETS.detailed, showResponseId, showDiagnostics });
  const original = message();
  let responseIdReads = 0;
  let diagnosticsReads = 0;
  const data = await h.response({
    ...original,
    get responseId() {
      if (!showResponseId) assert.fail("Runtime must not read disabled response IDs");
      responseIdReads += 1;
      return original.responseId;
    },
    get diagnostics() {
      if (!showDiagnostics) assert.fail("Runtime must not read disabled diagnostics");
      diagnosticsReads += 1;
      return original.diagnostics;
    },
  });
  assert.ok(extension.isMessageStampData(data) && data.version === 5);
  assert.equal(responseIdReads > 0, showResponseId);
  assert.equal(diagnosticsReads > 0, showDiagnostics);
  assert.equal(Object.hasOwn(data.metadata, "responseId"), showResponseId);
  assert.equal(Object.hasOwn(data.metadata, "diagnosticCount"), showDiagnostics);
  assert.equal(Object.hasOwn(data.metadata, "diagnostics"), showDiagnostics);
  const component = h.render(data, true);
  assert.ok(component);
  const lines = component.render(240).join("\n");
  assert.equal(lines.includes("debug · response id response-1"), showResponseId);
  assert.equal(lines.includes("debug · diagnostics 1"), showDiagnostics);
  assert.doesNotMatch(lines, /private error/u);
});

test.each(["hidden", "abnormal", "all"] as const)(
  "stop-reason-only runtime preserves the capture contract for %s",
  async (stopReason) => {
    const h = harness({ ...METADATA_PRESETS.none, stopReason });
    const data = await h.response();
    assert.ok(extension.isMessageStampData(data));
    assert.equal(data.version, stopReason === "hidden" ? 3 : 4);
    const component = h.render(data, true);
    assert.ok(component);
    assert.deepEqual(
      component.render(120).map((line) => line.trim()),
      stopReason === "all" ? ["00:00:00", "stop stop"] : ["00:00:00"],
    );
  },
);

const PRESET_ROWS: Record<StampMetadataPreset, readonly string[]> = {
  none: [],
  compact: ["requested-model → actual-model · thinking high · 10 tok · est $0.009"],
  detailed: [
    "api anthropic-messages · provider anthropic · requested requested-model · response actual-model · thinking high · stop stop",
    "tokens in 1 · out 2 · reasoning 1 · cache read 3 · cache write 4 · total 10 · est cost $0.009",
  ],
  model: ["requested-model → actual-model · thinking high"],
  usage: ["tokens in 1 · out 2 · reasoning 1 · cache read 3 · cache write 4 · total 10"],
  cost: ["est $0.009"],
  abnormal: ["stop length"],
};

test.each(METADATA_PRESET_NAMES)("%s captures and renders its selected metadata without debug data", async (preset) => {
  const h = harness(METADATA_PRESETS[preset]);
  const data = await h.response({ ...message(), stopReason: preset === "abnormal" ? "length" : "stop" });
  assert.ok(extension.isMessageStampData(data));
  for (const expanded of [false, true]) {
    const component = h.render(data, expanded);
    assert.ok(component);
    assert.deepEqual(
      component.render(240).map((line) => line.trim()),
      ["00:00:00", ...PRESET_ROWS[preset]],
    );
  }
  assert.doesNotMatch(JSON.stringify(data), /response-1|private error|HTTPError/u);
  assert.deepEqual(h.mock.sentMessages, []);
  assert.deepEqual(h.mock.sentUserMessages, []);
});

test.each(["rpc", "print", "json"] as const)("opted-in metadata runtime remains inactive in %s mode", async (mode) => {
  const h = harness({ ...METADATA_PRESETS.detailed, showResponseId: true, showDiagnostics: true }, mode);
  assert.equal(await h.response(), undefined);
  assert.deepEqual(h.mock.entries, []);
  assert.deepEqual(h.mock.sentMessages, []);
  assert.deepEqual(h.mock.sentUserMessages, []);
});
