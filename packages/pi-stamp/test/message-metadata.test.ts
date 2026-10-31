import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import { createMessageMetadataReader } from "../src/message-metadata.js";
import * as metadataModule from "../src/metadata.js";
import { METADATA_PRESET_NAMES, METADATA_PRESETS } from "../src/metadata-settings.js";
import { createStampEntryRenderer, STAMP_ENTRY_TYPE } from "../src/stamp.js";
import { RESPONSE_MESSAGE, RESPONSE_METADATA_ROWS, UTC_SETTINGS } from "./menu-fixtures.js";

const TIMESTAMP = RESPONSE_MESSAGE.timestamp;
const STAMP = { version: 2, role: "assistant", timestamp: TIMESTAMP } as const;
const METADATA = metadataModule.captureAssistantMetadata(RESPONSE_MESSAGE, METADATA_PRESETS.detailed);
assert.ok(METADATA);

function messageEntry(message: unknown = RESPONSE_MESSAGE) {
  return { type: "message", message };
}

function stampEntry(id = "stamp", data: unknown = STAMP) {
  return { id, type: "custom", customType: STAMP_ENTRY_TYPE, data };
}

function boundReader(entries: readonly unknown[], leaf: string | null = "leaf") {
  const source = { getLeafId: vi.fn(() => leaf), getBranch: vi.fn(() => entries) };
  const reader = createMessageMetadataReader();
  reader.bind(source);
  return { reader, source };
}

function mount(
  renderer: ReturnType<typeof createStampEntryRenderer>,
  data: unknown = STAMP,
  id = "stamp",
  expanded = false,
): Component {
  const component = renderer({ id, data } as never, { expanded }, {
    fg: (_role: string, text: string) => text,
  } as never);
  assert.ok(component);
  return component;
}

function rendered(component: Component) {
  return component.render(240).map((line) => line.trim());
}

test.each([
  { name: "empty branch", entries: [] },
  { name: "non-record values", entries: [null, undefined, false, 0, "assistant", []] },
  { name: "unrelated entry types", entries: [{ type: "usage" }, { type: "compaction" }, stampEntry()] },
  {
    name: "invalid message records",
    entries: [{ type: "message" }, messageEntry([]), messageEntry(null), stampEntry()],
  },
  { name: "message without a Stamp", entries: [messageEntry()] },
  { name: "Stamp before its response", entries: [stampEntry(), messageEntry()] },
  {
    name: "different timestamp",
    entries: [messageEntry({ ...RESPONSE_MESSAGE, timestamp: TIMESTAMP + 1 }), stampEntry()],
  },
])("$name has no metadata or sample fallback", ({ entries }) => {
  const { reader } = boundReader(entries);
  assert.equal(reader.get("stamp"), undefined);
});

test.each([
  { name: "foreign custom type", entry: { ...stampEntry(), customType: "other-extension" } },
  { name: "custom message instead of custom entry", entry: { ...stampEntry(), type: "custom_message" } },
  { name: "missing entry type", entry: { ...stampEntry(), type: undefined } },
  { name: "missing entry ID", entry: { ...stampEntry(), id: undefined } },
  { name: "numeric entry ID", entry: { ...stampEntry(), id: 7 } },
  { name: "empty entry ID", entry: { ...stampEntry(), id: "" } },
  { name: "non-record data", entry: stampEntry("stamp", []) },
  { name: "null data", entry: stampEntry("stamp", null) },
  { name: "user role", entry: stampEntry("stamp", { ...STAMP, role: "user" }) },
  { name: "tool role", entry: stampEntry("stamp", { ...STAMP, role: "toolResult" }) },
  { name: "missing role", entry: stampEntry("stamp", { ...STAMP, role: undefined }) },
  { name: "unsupported version", entry: stampEntry("stamp", { ...STAMP, version: 9 }) },
  { name: "old unsupported version", entry: stampEntry("stamp", { ...STAMP, version: 0 }) },
  { name: "string version", entry: stampEntry("stamp", { ...STAMP, version: "2" }) },
  { name: "fractional version", entry: stampEntry("stamp", { ...STAMP, version: 2.5 }) },
  { name: "missing version", entry: stampEntry("stamp", { ...STAMP, version: undefined }) },
  { name: "missing timestamp", entry: stampEntry("stamp", { ...STAMP, timestamp: undefined }) },
  { name: "string timestamp", entry: stampEntry("stamp", { ...STAMP, timestamp: String(TIMESTAMP) }) },
  { name: "NaN timestamp", entry: stampEntry("stamp", { ...STAMP, timestamp: Number.NaN }) },
  { name: "infinite timestamp", entry: stampEntry("stamp", { ...STAMP, timestamp: Number.POSITIVE_INFINITY }) },
  {
    name: "negative infinite timestamp",
    entry: stampEntry("stamp", { ...STAMP, timestamp: Number.NEGATIVE_INFINITY }),
  },
  { name: "out-of-range timestamp", entry: stampEntry("stamp", { ...STAMP, timestamp: 8_640_000_000_000_001 }) },
])("invalid used Stamp field ($name) cannot recover metadata", ({ entry }) => {
  const { reader } = boundReader([messageEntry(), entry]);
  assert.equal(reader.get("stamp"), undefined);
  assert.equal(reader.get(""), undefined);
});

test.each([
  { name: "user message", patch: { role: "user" } },
  { name: "tool result", patch: { role: "toolResult" } },
  { name: "custom role", patch: { role: "custom" } },
  { name: "missing role", patch: { role: undefined } },
  { name: "missing timestamp", patch: { timestamp: undefined } },
  { name: "string timestamp", patch: { timestamp: String(TIMESTAMP) } },
  { name: "NaN timestamp", patch: { timestamp: Number.NaN } },
  { name: "infinite timestamp", patch: { timestamp: Number.POSITIVE_INFINITY } },
  { name: "out-of-range timestamp", patch: { timestamp: -8_640_000_000_000_001 } },
])("$name cannot be matched to an assistant Stamp", ({ patch }) => {
  const { reader } = boundReader([messageEntry({ ...RESPONSE_MESSAGE, ...patch }), stampEntry()]);
  assert.equal(reader.get("stamp"), undefined);
});

test.each([1, 2, 3, 4, 5, 6, 7, 8])("v%s association reads only the used persisted fields", (version) => {
  const data = { ...STAMP, version };
  const prohibited = vi.fn(() => {
    throw new Error("Metadata association must not validate or read unused persisted fields");
  });
  for (const field of [
    "metadata",
    "completedAt",
    "firstContentAt",
    "previousTimestamp",
    "thinkingLevel",
    "costSinceUser",
    "estimatedCost",
    "timeSinceUserMs",
    "outputTokens",
    "unknown",
  ])
    Object.defineProperty(data, field, { get: prohibited });
  const { reader } = boundReader([messageEntry(), stampEntry("stamp", data)]);
  assert.deepEqual(reader.get("stamp"), METADATA);
  assert.equal(prohibited.mock.calls.length, 0);
});

test.each([-8_640_000_000_000_000, -1, 0, 8_640_000_000_000_000])(
  "valid timestamp %s remains matchable",
  (timestamp) => {
    const { reader } = boundReader([
      messageEntry({ ...RESPONSE_MESSAGE, timestamp }),
      stampEntry("stamp", { ...STAMP, timestamp }),
    ]);
    assert.deepEqual(reader.get("stamp"), METADATA);
  },
);

test("each Stamp maps to its nearest earlier same-timestamp assistant, not the latest response", () => {
  const { reader } = boundReader([
    stampEntry("before"),
    messageEntry({ ...RESPONSE_MESSAGE, model: "first-model" }),
    stampEntry("first"),
    messageEntry({ ...RESPONSE_MESSAGE, timestamp: TIMESTAMP + 1, model: "other-timestamp" }),
    { type: "session_info", name: "session" },
    stampEntry("still-first"),
    messageEntry({ ...RESPONSE_MESSAGE, model: "nearest-model" }),
    messageEntry({ ...RESPONSE_MESSAGE, role: "user", model: "user-model" }),
    stampEntry("nearest"),
  ]);
  assert.equal(reader.get("before"), undefined);
  assert.equal(reader.get("first")?.model, "first-model");
  assert.equal(reader.get("still-first")?.model, "first-model");
  assert.equal(reader.get("nearest")?.model, "nearest-model");
});

test("a newer unusable assistant never borrows ordinary fields from an older response", () => {
  const { reader } = boundReader([
    messageEntry(),
    stampEntry("older"),
    messageEntry({ role: "assistant", timestamp: TIMESTAMP, content: "no reported metadata" }),
    stampEntry(),
  ]);
  assert.deepEqual(reader.get("older"), METADATA);
  assert.equal(reader.get("stamp"), undefined);
});

test("only the active branch supplies metadata, without changing entries, leaf, or model context", () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage({ role: "user", timestamp: TIMESTAMP - 1, content: "prompt" });
  manager.appendMessage({ ...RESPONSE_MESSAGE, model: "abandoned-model" });
  const abandoned = manager.appendCustomEntry(STAMP_ENTRY_TYPE, STAMP);
  manager.branch(root);
  manager.appendMessage(structuredClone(RESPONSE_MESSAGE));
  const active = manager.appendCustomEntry(STAMP_ENTRY_TYPE, STAMP);
  const reader = createMessageMetadataReader();
  reader.bind(manager);
  const snapshot = () =>
    JSON.stringify({
      entries: manager.getEntries(),
      leaf: manager.getLeafId(),
      context: manager.buildSessionContext(),
    });
  const before = snapshot();
  assert.equal(reader.get(abandoned), undefined);
  assert.deepEqual(reader.get(active), METADATA);
  assert.equal(snapshot(), before);
  manager.branch(abandoned);
  const changed = snapshot();
  assert.equal(reader.get(active), undefined);
  assert.equal(reader.get(abandoned)?.model, "abandoned-model");
  assert.equal(snapshot(), changed);
  manager.resetLeaf();
  assert.equal(reader.get(active), undefined);
  assert.equal(reader.get(abandoned), undefined);
});

test("binding is lazy and captures one detached snapshot per requested Stamp and leaf", () => {
  const raw = structuredClone(RESPONSE_MESSAGE);
  const entries = [messageEntry(raw), stampEntry("first"), stampEntry("second")];
  let leaf = "initial";
  const source = { getLeafId: vi.fn(() => leaf), getBranch: vi.fn(() => entries) };
  const capture = vi.spyOn(metadataModule, "captureAssistantMetadata");
  const reader = createMessageMetadataReader();
  assert.equal(reader.get("first"), undefined);
  reader.bind(source);
  assert.equal(source.getLeafId.mock.calls.length, 0);
  assert.equal(source.getBranch.mock.calls.length, 0);
  for (const invalid of ["", null, undefined, 7]) assert.equal(reader.get(invalid as never), undefined);
  assert.equal(source.getLeafId.mock.calls.length, 0);
  assert.equal(reader.get("unknown"), undefined);
  assert.equal(capture.mock.calls.length, 0, "Unrequested responses must not be captured");
  const first = reader.get("first");
  assert.ok(first);
  assert.equal(reader.get("first"), first);
  assert.equal(source.getBranch.mock.calls.length, 1);
  assert.equal(capture.mock.calls.length, 1);
  assert.deepEqual(capture.mock.calls[0], [raw, METADATA_PRESETS.detailed]);
  assert.equal(reader.get("second")?.model, raw.model);
  assert.equal(capture.mock.calls.length, 2, "Each Stamp owns its snapshot");
  raw.model = "changed-model";
  raw.usage.input = 1;
  assert.equal(reader.get("first"), first);
  assert.equal(first.model, "actual-request");
  assert.equal(first.usage?.input, 900);
  leaf = "changed-leaf";
  const changed = reader.get("first");
  assert.notEqual(changed, first);
  assert.equal(changed?.model, "changed-model");
  assert.equal(source.getBranch.mock.calls.length, 2);
  assert.equal(capture.mock.calls.length, 3);
  reader.bind(source);
  assert.equal(source.getBranch.mock.calls.length, 2, "Rebinding must stay lazy");
  assert.notEqual(reader.get("first"), changed, "An explicit bind invalidates even the same source");
  assert.equal(source.getBranch.mock.calls.length, 3);
  const next = boundReader(
    [messageEntry({ ...RESPONSE_MESSAGE, model: "replacement-model" }), stampEntry("first")],
    leaf,
  );
  reader.bind(next.source);
  assert.equal(reader.get("first")?.model, "replacement-model", "Source identity must not share a same-leaf cache");
  assert.equal(next.source.getBranch.mock.calls.length, 1);
  reader.clear();
  reader.clear();
  assert.equal(reader.get("first"), undefined);
  assert.equal(next.source.getBranch.mock.calls.length, 1);
  reader.bind(source);
  assert.equal(reader.get("first")?.model, "changed-model");
});

test("missing metadata is cached once per leaf, and unrelated requested IDs never trigger capture", () => {
  const capture = vi.spyOn(metadataModule, "captureAssistantMetadata");
  const { reader, source } = boundReader([
    messageEntry({ role: "assistant", timestamp: TIMESTAMP }),
    stampEntry(),
    messageEntry({ ...RESPONSE_MESSAGE, timestamp: TIMESTAMP + 1 }),
  ]);
  assert.equal(reader.get("stamp"), undefined);
  assert.equal(reader.get("stamp"), undefined);
  assert.equal(reader.get("missing"), undefined);
  assert.equal(source.getBranch.mock.calls.length, 1);
  assert.equal(capture.mock.calls.length, 1);
});

test("capture sanitizes and bounds ordinary metadata without reading content, IDs, diagnostics, or Thinking", () => {
  const raw = structuredClone(RESPONSE_MESSAGE);
  raw.api = `api\u001b\n${"a".repeat(1_000)}`;
  raw.provider = `provider\u202e${"p".repeat(1_000)}`;
  raw.model = `model\t${"m".repeat(1_000)}`;
  raw.responseModel = `response\r${"r".repeat(1_000)}`;
  const prohibited = vi.fn(() => {
    throw new Error("Fallback must not read raw content, identifiers, debug fields, or Thinking");
  });
  for (const field of [
    "id",
    "content",
    "responseId",
    "diagnostics",
    "thinkingLevel",
    "providerThinkingLevel",
    "errorMessage",
    "unknown",
  ])
    Object.defineProperty(raw, field, { get: prohibited });
  const { reader } = boundReader([messageEntry(raw), stampEntry()]);
  const metadata = reader.get("stamp");
  assert.ok(metadata);
  for (const field of ["api", "provider", "model", "responseModel"] as const) {
    const value: string | undefined = metadata[field];
    assert.ok(value);
    assert.equal([...value].length, 160);
    for (const control of ["\u001b", "\n", "\r", "\t", "\u202e"]) assert.equal(value.includes(control), false);
  }
  assert.equal(prohibited.mock.calls.length, 0);
  const before = JSON.stringify(metadata);
  raw.usage.input = 1;
  raw.usage.cost.total = 99;
  assert.equal(JSON.stringify(metadata), before);
  for (const field of ["responseId", "diagnostics", "diagnosticCount", "thinkingLevel"])
    assert.equal(Object.hasOwn(metadata, field), false, field);
});

test.each(METADATA_PRESET_NAMES)("%s formats actual metadata without debug or unrecorded Thinking", (preset) => {
  const { reader } = boundReader([messageEntry(), stampEntry()]);
  const settings = { ...METADATA_PRESETS[preset], showResponseId: true, showDiagnostics: true };
  assert.deepEqual(
    metadataModule.formatAssistantMetadataLines(reader.get("stamp"), settings, true),
    RESPONSE_METADATA_ROWS[preset],
  );
});

test.each(["usage", "cost", "abnormal"] as const)("%s never invents absent response fields", (preset) => {
  const { reader } = boundReader([
    messageEntry({ ...RESPONSE_MESSAGE, stopReason: "stop", usage: undefined }),
    stampEntry(),
  ]);
  assert.deepEqual(
    metadataModule.formatAssistantMetadataLines(reader.get("stamp"), METADATA_PRESETS[preset], true),
    [],
  );
});

test("reported zero usage and cost survive capture, while absent reasoning stays absent", () => {
  const { reader } = boundReader([
    messageEntry({
      ...RESPONSE_MESSAGE,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    }),
    stampEntry(),
  ]);
  const metadata = reader.get("stamp");
  assert.deepEqual(metadataModule.formatAssistantMetadataLines(metadata, METADATA_PRESETS.usage, false), [
    "tokens in 0 · out 0 · cache read 0 · cache write 0 · total 0",
  ]);
  assert.deepEqual(metadataModule.formatAssistantMetadataLines(metadata, METADATA_PRESETS.cost, false), ["est $0"]);
  assert.deepEqual(
    metadataModule.formatAssistantMetadataLines(
      metadata,
      { ...METADATA_PRESETS.none, showReasoningTokens: true },
      false,
    ),
    [],
  );
});

test("hidden fields, user/tool entries, and saved metadata never ask the reader to inspect a branch", () => {
  let settings = { ...DEFAULT_STAMP_SETTINGS, ...UTC_SETTINGS, ...METADATA_PRESETS.none, toolStamps: true };
  const { reader, source } = boundReader([messageEntry(), stampEntry()]);
  const get = vi.fn(reader.get);
  const renderer = createStampEntryRenderer(() => settings, get);
  const assistant = mount(renderer);
  rendered(assistant);
  assert.equal(get.mock.calls.length, 0);
  assert.equal(source.getBranch.mock.calls.length, 0);
  settings = { ...settings, ...METADATA_PRESETS.detailed };
  rendered(mount(renderer, { version: 2, role: "user", timestamp: TIMESTAMP }));
  rendered(
    mount(renderer, {
      version: 1,
      kind: "tool",
      toolCallId: "call",
      toolName: "read",
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP + 1,
      outcome: "success",
    }),
  );
  const saved = {
    version: 4,
    role: "assistant",
    timestamp: TIMESTAMP,
    metadata: { ...METADATA, model: "saved-model" },
  };
  const savedLines = rendered(mount(renderer, saved));
  assert.match(savedLines.join("\n"), /requested saved-model/u);
  assert.doesNotMatch(savedLines.join("\n"), /actual-request/u);
  assert.equal(get.mock.calls.length, 0);
  assert.equal(source.getBranch.mock.calls.length, 0);
  assert.match(rendered(assistant).join("\n"), /actual-request/u);
  assert.equal(source.getBranch.mock.calls.length, 1);
});

test.each([1, 2, 3])(
  "mounted timestamp-only v%s refreshes after bind, leaf change, clear, and rebind without settings changes",
  (version) => {
    const data = { ...STAMP, version, ...(version === 3 ? { completedAt: TIMESTAMP + 3_200 } : {}) };
    const reader = createMessageMetadataReader();
    const renderer = createStampEntryRenderer(
      () => ({ ...DEFAULT_STAMP_SETTINGS, ...UTC_SETTINGS, ...METADATA_PRESETS.detailed }),
      reader.get,
    );
    const component = mount(renderer, data);
    const before = rendered(component);
    assert.deepEqual(before, ["2026-10-30 · 14:32:08"]);
    let leaf = "initial";
    let entries: readonly unknown[] = [messageEntry(), stampEntry("stamp", data)];
    const source = { getLeafId: () => leaf, getBranch: vi.fn(() => entries) };
    reader.bind(source);
    assert.deepEqual(rendered(component), [...before, ...RESPONSE_METADATA_ROWS.detailed]);
    entries = [messageEntry({ ...RESPONSE_MESSAGE, model: "branch-model" }), stampEntry("stamp", data)];
    leaf = "new-leaf";
    assert.match(rendered(component).join("\n"), /requested branch-model/u);
    assert.equal(source.getBranch.mock.calls.length, 2);
    reader.clear();
    assert.deepEqual(rendered(component), before);
    reader.bind(source);
    assert.match(rendered(component).join("\n"), /requested branch-model/u);
  },
);

test("fallback does not reconstruct response timing, throughput, since-user history, or debug fields", () => {
  const { reader } = boundReader([messageEntry(), stampEntry()]);
  const settings = {
    ...DEFAULT_STAMP_SETTINGS,
    ...UTC_SETTINGS,
    ...METADATA_PRESETS.detailed,
    responseTiming: "detailed" as const,
    showOutputThroughput: true,
    showCostSinceUser: true,
    showTimeSinceUser: true,
    showResponseId: true,
    showDiagnostics: true,
  };
  const renderer = createStampEntryRenderer(() => settings, reader.get);
  const timestampOnly = rendered(mount(renderer, STAMP, "stamp", true));
  assert.equal(timestampOnly[0], "2026-10-30 · 14:32:08");
  assert.doesNotMatch(timestampOnly.join("\n"), /tok\/s|since user|first n\/a|total 3\.2s|thinking|debug/u);
  const timed = rendered(mount(renderer, { ...STAMP, version: 3, completedAt: TIMESTAMP + 3_200 }, "stamp", true));
  assert.equal(timed[0], "2026-10-30 · 14:32:08 · first n/a · total 3.2s");
  assert.doesNotMatch(timed.join("\n"), /tok\/s|since user|thinking|debug/u);
  const historical = rendered(
    mount(
      renderer,
      {
        ...STAMP,
        version: 8,
        completedAt: TIMESTAMP + 3_200,
        firstContentAt: TIMESTAMP + 800,
        outputTokens: 160,
        timeSinceUserMs: 51_200,
        costSinceUser: 0.039,
        estimatedCost: 0.018,
        thinkingLevel: "high",
      },
      "stamp",
      true,
    ),
  );
  assert.equal(historical[0], "2026-10-30 · 14:32:08 · first 0.8s · total 3.2s · 50 tok/s · since user 51.2s");
  assert.match(historical.join("\n"), /thinking high/u);
  assert.match(historical.join("\n"), /tokens in 900 · out 120.*est cost \$0\.018 · since user \$0\.039/u);
  assert.doesNotMatch(historical.join("\n"), /thinking max|est cost \$0\.024|debug/u);
});
