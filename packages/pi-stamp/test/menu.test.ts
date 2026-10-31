import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { hardWrapTerminalDocument, resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import { createStampMenu, showStampMenu } from "../src/menu.js";
import {
  METADATA_BOOLEAN_FIELDS,
  METADATA_PRESET_NAMES,
  METADATA_PRESETS,
  METADATA_SETTING_FIELDS,
} from "../src/metadata-settings.js";
import type { StampSettingsPatch, StampSettingsRuntime, StampSettingsState } from "../src/settings.js";
import {
  currentOwner,
  memorySettingsRuntime,
  NONMETADATA_SETTINGS,
  PRESET_DESCRIPTIONS,
  PRESET_LABELS,
  PRESET_LINES,
  waitForPresetSave,
} from "./menu-fixtures.js";

initTheme("dark", false);

type StampMenu = ReturnType<typeof createStampMenu>;
type StampAction = keyof StampMenu["actions"];

const PRESETS_DESCRIPTION = "Choose assistant metadata presets.";
const MAIN_OPTIONS = ["Presets", "Settings", "Status", "Help", "Close"];
const MAIN_DESCRIPTIONS = [
  PRESETS_DESCRIPTION,
  "Edit individual settings.",
  "View effective settings and sources.",
  "Read usage and behavior.",
  "Return to Pi.",
];
const EXPECTED_SETTINGS = [
  ["hourCycle", "Hour cycle", "24-hour", ["24-hour", "12-hour"]],
  ["showSeconds", "Seconds", "Show", ["Show", "Hide"]],
  ["dateContext", "Date context", "Day changes", ["Day changes", "Always", "Never"]],
  ["locale", "Locale", "Invariant", undefined],
  ["timeZone", "Time zone", "Local", undefined],
  ["responseTiming", "Response timing", "Off", ["Off", "Duration", "Detailed"]],
  ["showOutputThroughput", "Show output throughput", "Hide", ["Show", "Hide"]],
  ["showExactTimeline", "Exact timeline", "Show", ["Show", "Hide"]],
  ["metadataLayout", "Metadata layout", "Compact", ["Compact", "Expanded"]],
  ["showRequestedModel", "Requested model", "Hide", ["Show", "Hide"]],
  ["showResponseModel", "Response model", "Hide", ["Show", "Hide"]],
  ["showProvider", "Provider", "Hide", ["Show", "Hide"]],
  ["showApi", "API", "Hide", ["Show", "Hide"]],
  ["showPiThinkingLevel", "Thinking level", "Hide", ["Show", "Hide"]],
  ["showInputTokens", "Input tokens", "Hide", ["Show", "Hide"]],
  ["showOutputTokens", "Output tokens", "Hide", ["Show", "Hide"]],
  ["showReasoningTokens", "Reasoning tokens", "Hide", ["Show", "Hide"]],
  ["showCacheReadTokens", "Cache read tokens", "Hide", ["Show", "Hide"]],
  ["showCacheWriteTokens", "Cache write tokens", "Hide", ["Show", "Hide"]],
  ["showTotalTokens", "Total tokens", "Hide", ["Show", "Hide"]],
  ["showCallCost", "Call cost", "Hide", ["Show", "Hide"]],
  ["stopReason", "Stop reason", "Hidden", ["Hidden", "Abnormal", "All"]],
  ["showResponseId", "Response ID", "Hide", ["Show", "Hide"]],
  ["showDiagnostics", "Diagnostics", "Hide", ["Show", "Hide"]],
  ["showCostSinceUser", "Cost since user message", "Hide", ["Show", "Hide"]],
  ["showTimeSinceUser", "Time since user message", "Hide", ["Show", "Hide"]],
  ["toolStamps", "Tool stamps", "Hide", ["Hide", "Show"]],
] as const;
test("main stays concise and Presets separates preview focus from confirmation", async () => {
  const runtime = memorySettingsRuntime();
  const menu = createStampMenu(runtime);
  const main = resolveMenuScreen(menu, "main", runtime.get());
  assert.equal(main.kind, "actions");
  if (main.kind !== "actions") assert.fail("Expected actions screen");
  assert.deepEqual(
    main.items.map((item) => item.label),
    MAIN_OPTIONS,
  );
  assert.deepEqual(
    main.items.map((item) => item.description),
    MAIN_DESCRIPTIONS,
  );
  assert.deepEqual(main.items[0], {
    id: "presets",
    label: "Presets",
    description: PRESETS_DESCRIPTION,
    action: "open-presets",
  });
  assert.deepEqual(main.lines, ["24-hour · seconds · Metadata: None"]);
  assert.ok(visibleWidth(main.lines[0] ?? "") <= 80);
  const rpc = createRpcHarness([
    {
      kind: "select",
      title: ["Stamp Presets", "Current preset: None", ...PRESET_LINES].join("\n"),
      options: presetOptions("None"),
      response: "← Back",
    },
  ]);
  const { ctx } = createMockContext({ mode: "rpc", ...rpc.ui });
  assert.deepEqual(await invoke(menu, "open-presets", runtime, ctx, "presets"), { kind: "stay" });
  assert.deepEqual(PRESET_LABELS, ["Compact", "Model", "Usage", "Cost", "Abnormal", "Detailed", "None"]);
  for (const description of PRESET_DESCRIPTIONS) assert.ok(visibleWidth(description) <= 56);
  assert.deepEqual(runtime.patches, []);
  rpc.assertConsumed();
});

test("Settings has every independent field and direct boolean/enum value without legacy bundles", () => {
  const runtime = memorySettingsRuntime();
  const screen = settingsScreen(createStampMenu(runtime), runtime.get());
  assert.deepEqual(
    screen.items.map(({ id, label, currentValue, values }) => [id, label, currentValue, values]),
    EXPECTED_SETTINGS,
  );
  assert.deepEqual(screen.items.map((item) => item.id).sort(), Object.keys(DEFAULT_STAMP_SETTINGS).sort());
  assert.equal(screen.items.length, new Set(screen.items.map((item) => item.id)).size);
  for (const item of screen.items) assert.ok(item.description, item.id);
  for (const id of ["assistantMetadata", "showThinkingLevel", "showCompactAbnormalOutcome"]) {
    assert.equal(
      screen.items.some((item) => item.id === id),
      false,
      id,
    );
  }
  for (const id of ["showResponseId", "showDiagnostics"]) {
    const description = screen.items.find((item) => item.id === id)?.description ?? "";
    assert.match(description, /Capture only while opted in/u);
    assert.match(description, /only in the expanded transcript/u);
    assert.match(description, /sensitive/u);
  }
});

test("Status enumerates every effective setting and source, derived preset, and safe path", () => {
  const runtime = memorySettingsRuntime({
    settings: { ...METADATA_PRESETS.compact, locale: "en-US" },
    path: "/tmp/\u001b[31m\u202epi-stamp.json",
  });
  const menu = createStampMenu(runtime);
  const state = runtime.get();
  const status = reviewScreen(menu, "status", state);
  assert.match(status.content, /^Metadata preset: Compact · derived from effective fields; no stored selector/u);
  const items = settingsScreen(menu, state).items;
  assert.equal(status.content.split("\n").length, items.length + 2);
  for (const item of items) {
    const field = item.id as keyof StampSettingsState["settings"];
    const source = state.sources[field] === "user" ? "User" : "Built-in";
    assert.ok(status.content.split("\n").includes(`${item.label}: ${item.currentValue} · ${source}`), field);
  }
  assert.match(status.content, /Hour cycle: 24-hour · Built-in/u);
  assert.match(status.content, /Requested model: Show · User/u);
  assert.match(status.content, /Settings file: \/tmp\/pi-stamp.json/u);
  assert.equal(status.content.includes("\u001b"), false);
  assert.equal(status.content.includes("\u202e"), false);
});

test.each(METADATA_PRESET_NAMES)(
  "%s applies one complete metadata-only patch and leaves debug capture off",
  async (preset) => {
    const runtime = memorySettingsRuntime({
      settings: { ...NONMETADATA_SETTINGS, ...METADATA_PRESETS.detailed, showResponseId: true, showDiagnostics: true },
    });
    const menu = createStampMenu(runtime);
    const rpc = createRpcHarness([
      { kind: "select", options: presetOptions(), response: presetOption(preset) },
      { kind: "select", options: presetOptions(capitalize(preset)), response: "← Back" },
    ]);
    const { ctx } = createMockContext({ mode: "rpc", ...rpc.ui });
    const before = { ...runtime.get().settings };
    assert.deepEqual(await invoke(menu, "open-presets", runtime, ctx, "presets"), { kind: "stay" });
    assert.deepEqual(runtime.patches, [METADATA_PRESETS[preset]]);
    assert.deepEqual(Object.keys(runtime.patches[0] ?? {}).sort(), [...METADATA_SETTING_FIELDS].sort());
    assert.deepEqual(runtime.get().settings, { ...before, ...METADATA_PRESETS[preset] });
    for (const key of Object.keys(NONMETADATA_SETTINGS) as (keyof typeof before)[]) {
      assert.equal(runtime.get().settings[key], before[key], key);
    }
    assert.equal(runtime.get().settings.showResponseId, false);
    assert.equal(runtime.get().settings.showDiagnostics, false);
    assert.equal(Object.hasOwn(runtime.get().settings, "preset"), false);
    assert.match(rpc.dialogs[1]?.title ?? "", new RegExp(`Current preset: ${capitalize(preset)}`, "u"));
    rpc.assertConsumed();
    if (preset === "none") {
      for (const key of METADATA_BOOLEAN_FIELDS) assert.equal(runtime.get().settings[key], false, key);
      assert.equal(runtime.get().settings.stopReason, "hidden");
    }
  },
);

test("each metadata row saves every supported value as one independent patch", async () => {
  const runtime = memorySettingsRuntime({ settings: NONMETADATA_SETTINGS });
  const menu = createStampMenu(runtime);
  const { ctx } = createMockContext({ mode: "tui" });
  const rows = settingsScreen(menu, runtime.get()).items.filter((item) => item.action === "set-metadata");
  assert.equal(rows.length, METADATA_SETTING_FIELDS.length);
  for (const row of rows) {
    assert.ok(row.values);
    for (const value of row.values) {
      const before = { ...runtime.get().settings };
      const expected = value === "Show" ? true : value === "Hide" ? false : value.toLowerCase();
      assert.deepEqual(await invoke(menu, row.action, runtime, ctx, row.id, value), { kind: "stay" });
      assert.deepEqual(runtime.patches.at(-1), { [row.id]: expected });
      assert.deepEqual(runtime.get().settings, { ...before, [row.id]: expected });
      assert.equal(settingsScreen(menu, runtime.get()).items.find((item) => item.id === row.id)?.currentValue, value);
    }
  }
  const beforeInvalid = runtime.patches.length;
  for (const [id, value] of [
    ["unknown", "Show"],
    ["metadataLayout", "Off"],
    ["stopReason", "Compact"],
    ["showPiThinkingLevel", "true"],
    ["showResponseId", undefined],
  ] as const) {
    assert.deepEqual(await invoke(menu, "set-metadata", runtime, ctx, id, value), { kind: "rejected" });
  }
  const invalidChoice = createMockContext({ mode: "rpc", select: async () => "Custom" });
  assert.deepEqual(await invoke(menu, "open-presets", runtime, invalidChoice.ctx, "presets"), { kind: "rejected" });
  assert.equal(runtime.patches.length, beforeInvalid);
});

test("a field change derives Custom without retaining a preset selector", async () => {
  const runtime = memorySettingsRuntime({ settings: NONMETADATA_SETTINGS });
  const menu = createStampMenu(runtime);
  const { ctx } = createMockContext({ mode: "tui" });
  const rpc = createRpcHarness([
    { kind: "select", options: presetOptions("None"), response: presetOption("compact") },
    { kind: "select", options: presetOptions("Compact"), response: "← Back" },
    { kind: "select", options: presetOptions(), response: "← Back" },
  ]);
  const rpcContext = createMockContext({ mode: "rpc", ...rpc.ui });
  await invoke(menu, "open-presets", runtime, rpcContext.ctx, "presets");
  await invoke(menu, "set-metadata", runtime, ctx, "showProvider", "Show");
  await invoke(menu, "open-presets", runtime, rpcContext.ctx, "presets");
  const dialog = rpc.dialogs[2];
  assert.ok(dialog?.kind === "select");
  assert.ok(dialog.options);
  assert.match(dialog.title, /Current preset: Custom/u);
  assert.equal(
    dialog.options.some((option) => option.includes("current") || option.startsWith("Custom")),
    false,
  );
  rpc.assertConsumed();
  assert.match(reviewScreen(menu, "status", runtime.get()).content, /^Metadata preset: Custom/u);
  const main = resolveMenuScreen(menu, "main", runtime.get());
  assert.ok("lines" in main);
  assert.deepEqual(main.lines, ["12-hour · no seconds · Metadata: Custom"]);
  assert.deepEqual(runtime.patches, [METADATA_PRESETS.compact, { showProvider: true }]);
});

test("existing nonmetadata bounded controls retain exact patches and values", async () => {
  const runtime = memorySettingsRuntime();
  const menu = createStampMenu(runtime);
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  const cases: [StampAction, string, string, StampSettingsPatch][] = [
    ["set-hour-cycle", "hourCycle", "12-hour", { hourCycle: "12h" }],
    ["set-hour-cycle", "hourCycle", "24-hour", { hourCycle: "24h" }],
    ["set-date-context", "dateContext", "Always", { dateContext: "always" }],
    ["set-date-context", "dateContext", "Never", { dateContext: "never" }],
    ["set-date-context", "dateContext", "Day changes", { dateContext: "day-change" }],
    ["set-response-timing", "responseTiming", "Duration", { responseTiming: "duration" }],
    ["set-response-timing", "responseTiming", "Detailed", { responseTiming: "detailed" }],
    ["set-response-timing", "responseTiming", "Off", { responseTiming: "off" }],
  ];
  for (const [action, id] of [
    ["set-seconds", "showSeconds"],
    ["set-output-throughput", "showOutputThroughput"],
    ["set-exact-timeline", "showExactTimeline"],
    ["set-cost-since-user", "showCostSinceUser"],
    ["set-time-since-user", "showTimeSinceUser"],
    ["set-tool-stamps", "toolStamps"],
  ] as const) {
    for (const value of ["Show", "Hide"]) cases.push([action, id, value, { [id]: value === "Show" }]);
  }
  for (const [action, id, value] of cases) {
    assert.deepEqual(await invoke(menu, action, runtime, ctx, id, value), { kind: "stay" });
  }
  assert.deepEqual(
    runtime.patches,
    cases.map(([, , , patch]) => patch),
  );
  assert.equal(notifications.at(-1)?.level, "info");
});

test("invalid settings route both Presets and Settings to the read-only screen and block saves", async () => {
  const runtime = memorySettingsRuntime({ invalid: true });
  const beginPreview = vi.fn(() => {
    throw new Error("Invalid settings must not start a preview");
  });
  const menu = createStampMenu(runtime, () => true, beginPreview);
  const state = runtime.get();
  const main = resolveMenuScreen(menu, "main", state);
  assert.equal(main.kind, "actions");
  if (main.kind !== "actions") assert.fail("Expected actions screen");
  assert.deepEqual(
    main.items.slice(0, 2).map((item) => ("to" in item ? item.to : undefined)),
    ["invalid", "invalid"],
  );
  const invalid = resolveMenuScreen(menu, "invalid", state);
  assert.equal(invalid.kind, "detail");
  if (invalid.kind !== "detail") assert.fail("Expected invalid detail");
  assert.match(invalid.lines.join("\n"), /will not be overwritten/u);
  assert.deepEqual(resolveMenuScreen(menu, "settings", state), invalid);
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  assert.deepEqual(await invoke(menu, "open-presets", runtime, ctx, "presets"), { kind: "to", screen: "invalid" });
  assert.equal(beginPreview.mock.calls.length, 0);
  for (const [action, id, value] of [
    ["set-metadata", "showProvider", "Show"],
    ["set-seconds", "showSeconds", "Hide"],
  ] as const) {
    assert.deepEqual(await invoke(menu, action, runtime, ctx, id, value), { kind: "rejected" });
  }
  assert.deepEqual(runtime.patches, []);
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(({ level, message }) => level === "error" && message.includes("read-only")));
});

test("Help explains scope, migration, capture privacy, and immediate save/cancel semantics", () => {
  const runtime = memorySettingsRuntime();
  const help = reviewScreen(createStampMenu(runtime), "help", runtime.get()).content;
  for (const pattern of [
    /assistant metadata patches only/u,
    /Project and environment overrides are not used/u,
    /Settings reload at session start and \/reload/u,
    /Legacy assistantMetadata, showThinkingLevel, and showCompactAbnormalOutcome migrate/u,
    /Explicit independent fields take priority/u,
    /showPiThinkingLevel is the canonical/u,
    /captured only while individually opted in.*only in the expanded transcript/u,
    /Hiding them does not erase data already saved/u,
    /Metadata layout changes arrangement, not capture permission/u,
    /moving the preset cursor.*original Stamp rows.*transcript/u,
    /no separate preview block/u,
    /no saved metadata.*enabled ordinary fields.*matching earlier assistant response on the active branch/u,
    /Saved Stamp metadata remains authoritative/u,
    /Response content, IDs, diagnostics, and raw\/current Thinking are never recovered/u,
    /Missing response fields are not invented/u,
    /display only, not recording settings or session history/u,
    /Each Settings change saves immediately/u,
    /one confirmed preset saves all metadata fields together/u,
    /Cancel before confirmation writes nothing/u,
    /does not undo completed saves/u,
    /failures retain previous values/u,
    /Invalid files are read-only/u,
    /Unknown fields are preserved/u,
    /outside model context/u,
  ])
    assert.match(help, pattern);
});

test("custom locale and time-zone screens validate and save canonical raw input", async () => {
  const runtime = memorySettingsRuntime();
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  const menu = createStampMenu(runtime);
  for (const [action, screenId, rejected, accepted, patch] of [
    ["choose-custom-locale", "locale", "not_a_locale", "EN-us", { locale: "en-US" }],
    ["choose-custom-time-zone", "time-zone", "Moon/Base", "utc", { timeZone: "UTC" }],
  ] as const) {
    assert.deepEqual(await invoke(menu, action, runtime, ctx, "custom"), { kind: "stay" });
    const input = resolveMenuScreen(menu, screenId, runtime.get());
    assert.equal(input.kind, "input");
    if (input.kind !== "input") assert.fail("Expected input screen");
    assert.equal(input.action, action);
    assert.deepEqual(await invoke(menu, action, runtime, ctx, "custom", rejected), { kind: "rejected" });
    assert.deepEqual(await invoke(menu, action, runtime, ctx, "custom", accepted), { kind: "back" });
    assert.deepEqual(runtime.patches.at(-1), patch);
  }
  assert.deepEqual(runtime.patches, [{ locale: "en-US" }, { timeZone: "UTC" }]);
  assert.equal(notifications.filter((notice) => notice.level === "warning").length, 2);
});

test.each(METADATA_PRESET_NAMES)(
  "TUI preset %s applies once and reopens with the updated current state",
  async (preset) => {
    const runtime = memorySettingsRuntime({ settings: NONMETADATA_SETTINGS });
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
    const running = showStampMenu(ctx, runtime, currentOwner());
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const before = tui.render().join("\n");
    const steps =
      (METADATA_PRESET_NAMES.indexOf(preset) - METADATA_PRESET_NAMES.indexOf("none") + METADATA_PRESET_NAMES.length) %
      METADATA_PRESET_NAMES.length;
    for (let index = 0; index < steps; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await waitForPresetSave(tui);
    const after = tui.render().join("\n");
    tui.press("ctrl+c");
    const result = await running;
    assert.equal(result.kind, "closed");
    assert.match(before, /Current preset: None/u);
    assert.match(before, /→ None ✓ current/u);
    assert.ok(after.includes(`Current preset: ${capitalize(preset)}`));
    assert.ok(after.includes(`→ ${capitalize(preset)} ✓ current`));
    assert.equal(after.includes("(current)"), false);
    assert.equal(tui.openCount, 4);
    assert.deepEqual(runtime.patches, [METADATA_PRESETS[preset]]);
    assert.deepEqual(runtime.get().settings, {
      ...DEFAULT_STAMP_SETTINGS,
      ...NONMETADATA_SETTINGS,
      ...METADATA_PRESETS[preset],
    });
  },
);

test.each(["back", "hard-cancel", "dispose", "shutdown"] as const)(
  "TUI preset %s before selection writes nothing",
  async (exit) => {
    const runtime = memorySettingsRuntime();
    const tui = createTuiHarness();
    const controller = new AbortController();
    const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
    const running = showStampMenu(ctx, runtime, currentOwner(controller));
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    if (exit === "back") {
      tui.press("tui.select.cancel");
      await tui.waitForOpen();
      tui.press("ctrl+c");
    } else if (exit === "hard-cancel") tui.press("ctrl+c");
    else if (exit === "dispose") tui.dispose();
    else controller.abort();
    const result = await running;
    assert.equal(result.kind, exit === "shutdown" ? "stale" : "closed");
    assert.deepEqual(runtime.patches, []);
    assert.deepEqual(notifications, []);
    assert.equal(tui.isOpen, false);
  },
);

test("TUI Settings is searchable and rolls back failed changes before a successful retry", async () => {
  let fail = true;
  const runtime = memorySettingsRuntime({
    beforeUpdate: async () => {
      if (fail) throw new Error("disk full");
    },
  });
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showStampMenu(ctx, runtime, currentOwner());
  await openSettings(tui);
  tui.type("Response model");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  const rejected = tui.render().join("\n");
  const previous = runtime.get().settings.showResponseModel;
  fail = false;
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
  const saved = tui.render().join("\n");
  tui.press("ctrl+c");
  await running;
  assert.match(rejected, /→ Response model\s+Hide/u);
  assert.equal(previous, false);
  assert.match(saved, /→ Response model\s+Show/u);
  assert.deepEqual(runtime.patches, [{ showResponseModel: true }, { showResponseModel: true }]);
  assert.deepEqual(
    notifications.map(({ level }) => level),
    ["error", "info"],
  );
});

test("TUI uses non-default standard bindings for Presets and searchable Settings, with hard Ctrl+C", async () => {
  const runtime = memorySettingsRuntime();
  const tui = createTuiHarness({
    width: 100,
    rows: 30,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "f1",
      "tui.select.down": "f2",
      "tui.select.confirm": "f3",
      "tui.select.cancel": "f4",
    }),
  });
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showStampMenu(ctx, runtime, currentOwner());
  await tui.waitForOpen();
  const main = tui.render().join("\n");
  tui.send("\u001bOR");
  await tui.waitForOpen();
  const presets = tui.render().join("\n");
  tui.send("\u001bOS");
  await tui.waitForOpen();
  tui.send("\u001bOQ");
  tui.send("\u001bOR");
  await tui.waitForOpen();
  tui.type("Thinking level");
  tui.send("\u001bOR");
  await tui.waitForPending();
  await tui.waitForOpen();
  const settings = tui.render().join("\n");
  tui.press("ctrl+c");
  const result = await running;
  assert.equal(result.kind, "closed");
  assert.match(main, /f1\/f2 navigate.*f3 select.*f4 close/u);
  assert.match(presets, /f4 back.*ctrl\+c close/u);
  assert.match(settings, /→ Thinking level\s+Show/u);
  assert.deepEqual(runtime.patches, [{ showPiThinkingLevel: true }]);
});

test("TUI custom input retains a rejected draft and Ctrl+C closes the menu", async () => {
  const runtime = memorySettingsRuntime();
  const tui = createTuiHarness({ width: 60, rows: 24 });
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showStampMenu(ctx, runtime, currentOwner());
  await openSettings(tui);
  for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send("\u001b[200~not_a_locale\u001b[201~");
  tui.press("tui.input.submit");
  await tui.waitForPending();
  const rejected = tui.render().join("\n");
  tui.send("\u0015");
  tui.type("EN-uss");
  tui.send("\u007f");
  tui.press("tui.input.submit");
  await tui.waitForPending();
  await tui.waitForOpen();
  tui.press("ctrl+c");
  const result = await running;
  assert.equal(result.kind, "closed");
  assert.equal(tui.openCount, 5);
  assert.match(rejected, /not_a_locale/u);
  assert.deepEqual(runtime.patches, [{ locale: "en-US" }]);
});

test.each(["main", "presets", "settings", "status", "help", "invalid"] as const)(
  "%s uses bounded Kit frames at narrow/zero widths and constrained heights",
  async (screen) => {
    const runtime = memorySettingsRuntime({ invalid: screen === "invalid" });
    const roles = new Set<string>();
    const zeroFrames: string[][] = [];
    const tui = createTuiHarness({
      width: 80,
      rows: 40,
      theme: {
        fg: (role, text) => {
          roles.add(role);
          return text;
        },
        bold: (text) => text,
      },
    });
    const custom: typeof tui.custom = (factory, options) =>
      tui.custom(async (host, theme, keybindings, done) => {
        const component = await factory(host, theme, keybindings, done);
        zeroFrames.push(component.render(0));
        return component;
      }, options);
    const { ctx } = createMockContext({ mode: "tui", custom });
    const running = showStampMenu(ctx, runtime, currentOwner());
    await tui.waitForOpen();
    if (screen !== "main") {
      const index = screen === "invalid" ? 0 : ["presets", "settings", "status", "help"].indexOf(screen);
      for (let step = 0; step < index; step += 1) tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
    }
    if (screen === "settings") tui.type("Diagnostics");
    if (screen === "presets") {
      tui.press("home");
      for (let index = 0; index < METADATA_PRESET_NAMES.indexOf("detailed"); index += 1) tui.press("tui.select.down");
    }
    const normal = tui.render();
    const frames: { width: number; rows: number; lines: readonly string[] }[] = [];
    for (const rows of [3, 4, 7, 8, 14, 24]) {
      for (const width of [1, 2, 8, 25, 80]) frames.push({ width, rows, lines: tui.resize({ width, rows }) });
    }
    tui.invalidate();
    const restored = tui.resize({ width: 80, rows: 40 });
    tui.press("end");
    const end = tui.render().join("\n");
    tui.press("ctrl+c");
    const result = await running;
    assert.equal(result.kind, "closed");
    assert.ok(zeroFrames.length > 0);
    assert.ok(zeroFrames.every((frame) => frame.length === 0));
    assert.ok(roles.has("border"));
    assert.ok(roles.has("muted"));
    assert.equal(normal[0], "─".repeat(80));
    assert.equal(normal.at(-1), "─".repeat(80));
    assert.deepEqual(restored, normal);
    for (const { width, rows, lines } of frames) {
      assert.ok(lines.length <= Math.max(1, rows - 3), `${width}×${rows}: ${lines.length} rows`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}×${rows}: ${line}`);
      if (width === 80 && rows === 24 && screen === "main")
        for (const text of MAIN_DESCRIPTIONS)
          assert.ok(
            lines.some((line) => line.includes(text)),
            text,
          );
      if (width === 80 && rows === 24 && screen === "presets") {
        assert.ok(lines.some((line) => line.includes("TUI: move to apply temporarily")));
        assert.doesNotMatch(
          lines.join("\n"),
          /(?:^|\n)Preview(?: ·|\n)|No assistant response|No enabled fields|metadata is hidden|Example|model-a|tokens in 600|pi-stamp\.json/u,
        );
      }
      if (rows >= 8) {
        assert.equal(lines[0], "─".repeat(width));
        assert.equal(lines.at(-1), "─".repeat(width));
      } else if (width >= 25) assert.ok(lines.every((line) => !/^─+$/u.test(line)));
      if (width >= 25 && ["main", "presets", "settings"].includes(screen)) {
        const label = screen === "main" ? "Presets" : screen === "presets" ? "Detailed" : "Diagnostics";
        assert.ok(
          lines.some((line) => line.includes(`→ ${width < 40 ? label.slice(0, 4) : label}`)),
          `${screen} at ${width}×${rows}: ${JSON.stringify(lines)}`,
        );
      }
      if (screen === "status" || screen === "help")
        assert.equal(
          lines.some((line) => line.startsWith("→")),
          false,
        );
    }
    if (screen === "status") assert.match(end, /Settings file: \/tmp\/pi-stamp.json/u);
    if (screen === "help") assert.match(end.replaceAll("\n", ""), /network request or refresh timer/u);
    assert.deepEqual(runtime.patches, []);
  },
);

test.each(["open-presets", "set-metadata"] as const)(
  "%s failure retains state, sanitizes the error, and permits retry",
  async (action) => {
    let fail = true;
    const runtime = memorySettingsRuntime({
      beforeUpdate: async () => {
        if (fail) throw new Error("save\u001b[31m\u202espoofed rejected");
      },
    });
    const menu = createStampMenu(runtime);
    let dialogs = 0;
    const { ctx, notifications } = createMockContext({
      mode: action === "open-presets" ? "rpc" : "tui",
      select: async () => (dialogs++ % 2 === 0 ? presetOption("compact") : undefined),
    });
    const id = action === "open-presets" ? "presets" : "showRequestedModel";
    const before = { ...runtime.get().settings };
    assert.deepEqual(await invoke(menu, action, runtime, ctx, id, "Show"), {
      kind: action === "open-presets" ? "stay" : "rejected",
    });
    assert.deepEqual(runtime.get().settings, before);
    const message = notifications.at(-1)?.message ?? "";
    assert.equal(message.includes("\u001b"), false);
    assert.equal(message.includes("\u202e"), false);
    assert.equal(notifications.at(-1)?.level, "error");
    fail = false;
    assert.deepEqual(await invoke(menu, action, runtime, ctx, id, "Show"), { kind: "stay" });
    assert.equal(runtime.patches.length, 2);
    assert.equal(runtime.get().settings.showRequestedModel, true);
    assert.equal(notifications.at(-1)?.level, "info");
  },
);

test.each(["abort", "replacement"] as const)(
  "%s rejects saves before mutation and suppresses pending success and failure notifications",
  async (exit) => {
    for (const fails of [false, true]) {
      const started = deferred();
      const release = deferred();
      const controller = new AbortController();
      let current = true;
      const runtime = memorySettingsRuntime({
        beforeUpdate: async () => {
          started.resolve();
          await release.promise;
          if (fails) throw new Error("disk full");
        },
      });
      const menu = createStampMenu(runtime, () => current);
      const { ctx, notifications } = createMockContext({ mode: "rpc", select: async () => presetOption("compact") });
      const action = (signal: AbortSignal) =>
        menu.actions["open-presets"]({ ctx, state: runtime.get(), signal, itemId: "presets" });
      const saving = action(controller.signal);
      await started.promise;
      if (exit === "abort") controller.abort();
      else current = false;
      release.resolve();
      assert.deepEqual(await saving, { kind: "close" });
      assert.deepEqual(await action(controller.signal), { kind: "close" });
      assert.equal(runtime.patches.length, 1);
      assert.deepEqual(notifications, []);
      assert.equal(runtime.get().settings.showRequestedModel, !fails);
    }
  },
);

test.each(["hard-cancel", "dispose", "shutdown", "replacement"] as const)(
  "TUI pending save drains after %s without stale UI",
  async (exit) => {
    const started = deferred();
    const release = deferred();
    const runtime = memorySettingsRuntime({
      beforeUpdate: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const tui = createTuiHarness();
    const controller = new AbortController();
    let current = true;
    const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
    const running = showStampMenu(ctx, runtime, { signal: controller.signal, isCurrent: () => current });
    await openSettings(tui);
    tui.type("Response model");
    tui.press("tui.select.confirm");
    await started.promise;
    if (exit === "hard-cancel") tui.press("ctrl+c");
    else if (exit === "dispose") tui.dispose();
    else {
      current = exit !== "replacement";
      controller.abort();
    }
    release.resolve();
    const result = await running;
    tui.press("tui.select.confirm");
    assert.equal(result.kind, exit === "hard-cancel" ? "closed" : "stale");
    assert.equal(tui.openCount, 2);
    assert.equal(tui.isOpen, false);
    assert.deepEqual(runtime.patches, [{ showResponseModel: true }]);
    assert.equal(runtime.get().settings.showResponseModel, true);
    assert.deepEqual(
      notifications,
      exit === "hard-cancel" ? [{ message: "Response model: Show.", level: "info" }] : [],
    );
  },
);

test("RPC custom input retries a rejected value with the new main entry and larger Settings list", async () => {
  const runtime = memorySettingsRuntime();
  const rpc = createRpcHarness([
    { kind: "select", title: mainTitle(), options: MAIN_OPTIONS, response: "Settings" },
    {
      kind: "select",
      title: "Stamp Settings\nUser settings · /tmp/pi-stamp.json",
      options: settingsOptions(),
      response: "Locale (Invariant)",
    },
    {
      kind: "select",
      title: "Stamp Locale\nCurrent: Invariant",
      options: ["Invariant (default)", "System locale", "Custom BCP 47 locale…"],
      response: "Custom BCP 47 locale…",
    },
    {
      kind: "input",
      title: "Custom BCP 47 locale\nCurrent: Invariant",
      placeholder: "Examples: en-US, fr-FR, zh-TW",
      response: "not_a_locale",
    },
    {
      kind: "input",
      title: "Custom BCP 47 locale\nCurrent: Invariant",
      placeholder: "Examples: en-US, fr-FR, zh-TW",
      response: "EN-us",
    },
    {
      kind: "select",
      title: "Stamp Settings\nUser settings · /tmp/pi-stamp.json",
      options: settingsOptions("en-US"),
      response: undefined,
    },
    { kind: "select", title: mainTitle(), options: MAIN_OPTIONS, response: "Close" },
  ]);
  const { ctx } = createMockContext({ mode: "rpc", ...rpc.ui });
  const result = await showStampMenu(ctx, runtime, currentOwner());
  assert.equal(result.kind, "closed");
  assert.equal(rpc.dialogs.filter((dialog) => dialog.kind === "input").length, 2);
  assert.deepEqual(runtime.patches, [{ locale: "en-US" }]);
  rpc.assertConsumed();
});

test("RPC Presets applies once, shows its new derived state, and cancels without another write", async () => {
  const runtime = memorySettingsRuntime();
  const rpc = createRpcHarness([
    { kind: "select", options: MAIN_OPTIONS, response: "Presets" },
    { kind: "select", options: presetOptions("None"), response: presetOption("compact") },
    { kind: "select", options: presetOptions("Compact"), response: "← Back" },
    { kind: "select", options: MAIN_OPTIONS, response: "Close" },
  ]);
  const getBranch = vi.fn(() => {
    throw new Error("RPC must not read response metadata");
  });
  const { ctx } = createMockContext({ mode: "rpc", ...rpc.ui, sessionManager: { getBranch } });
  const beginPreview = vi.fn(() => {
    throw new Error("RPC must not start a display preview");
  });
  const result = await showStampMenu(ctx, runtime, { ...currentOwner(), beginPreview });
  assert.equal(result.kind, "closed");
  assert.equal(beginPreview.mock.calls.length, 0);
  assert.equal(getBranch.mock.calls.length, 0);
  assert.ok(rpc.dialogs.every((dialog) => !/(?:^|\n)Preview(?: ·|\n)/u.test(dialog.title)));
  assert.match(rpc.dialogs[1]?.title ?? "", /Current preset: None/u);
  assert.match(rpc.dialogs[2]?.title ?? "", /Current preset: Compact/u);
  assert.match(rpc.dialogs[2]?.title ?? "", /Other settings unchanged\. Response ID and diagnostics stay off\./u);
  assert.match(rpc.dialogs[2]?.title ?? "", /TUI: move to apply temporarily\. Confirm to save\./u);
  assert.equal((rpc.dialogs[2]?.title ?? "").includes("Example"), false);
  assert.equal((rpc.dialogs[2]?.title ?? "").includes("pi-stamp.json"), false);
  assert.match(rpc.dialogs[3]?.title ?? "", /Metadata: Compact/u);
  assert.deepEqual(runtime.patches, [METADATA_PRESETS.compact]);
  rpc.assertConsumed();
});

test("RPC Status and Help expose scrollable review content as deterministic pages", async () => {
  const runtime = memorySettingsRuntime({ settings: METADATA_PRESETS.detailed });
  const dialogs: { title: string; options: string[] }[] = [];
  let route = 0;
  const { ctx } = createMockContext({
    mode: "rpc",
    select: async (title: string, options: string[]) => {
      dialogs.push({ title, options });
      if (options.includes("Status")) return ["Status", "Help", "Close"][route++];
      return options.includes("Next") ? "Next" : "Back";
    },
  });
  const result = await showStampMenu(ctx, runtime, currentOwner());
  assert.equal(result.kind, "closed");
  for (const screen of ["status", "help"] as const) {
    const content = reviewScreen(createStampMenu(runtime), screen, runtime.get()).content;
    const prefix = `Stamp ${capitalize(screen)}`;
    const pages = dialogs.filter(({ title }) => title.startsWith(prefix));
    assert.ok(pages.length > 1);
    const textRows = pages.flatMap(({ title }, index) => {
      const rows = title.split("\n");
      assert.equal(rows.shift(), prefix);
      assert.equal(rows.pop(), `Page ${index + 1}/${pages.length}`);
      return rows;
    });
    // Kit RPC text pages hard-wrap at 120 cells, including inside words or punctuation.
    assert.deepEqual(textRows, hardWrapTerminalDocument(content, 120));
  }
  assert.deepEqual(runtime.patches, []);
});

test.each(["Presets", "Settings"])("RPC invalid-file %s opens only the read-only screen", async (selection) => {
  const runtime = memorySettingsRuntime({ invalid: true });
  const rpc = createRpcHarness([
    { kind: "select", options: MAIN_OPTIONS, response: selection },
    { kind: "select", options: ["Back"], response: "Back" },
    { kind: "select", options: MAIN_OPTIONS, response: "Close" },
  ]);
  const { ctx } = createMockContext({ mode: "rpc", ...rpc.ui });
  assert.equal((await showStampMenu(ctx, runtime, currentOwner())).kind, "closed");
  assert.match(rpc.dialogs[1]?.title ?? "", /Stamp Settings · Read only/u);
  assert.match(rpc.dialogs[1]?.title ?? "", /will not be overwritten/u);
  assert.deepEqual(runtime.patches, []);
  rpc.assertConsumed();
});

test("RPC pending preset dialog aborts on shutdown without saving", async () => {
  const runtime = memorySettingsRuntime();
  const rpc = createRpcHarness([
    { kind: "select", options: MAIN_OPTIONS, response: "Presets" },
    { kind: "select", options: presetOptions("None"), waitForAbort: true },
  ]);
  const controller = new AbortController();
  const { ctx } = createMockContext({ mode: "rpc", ...rpc.ui });
  const running = showStampMenu(ctx, runtime, currentOwner(controller));
  await rpc.waitForCall();
  await rpc.waitForCall();
  controller.abort();
  assert.equal((await running).kind, "stale");
  assert.deepEqual(runtime.patches, []);
  rpc.assertConsumed();
});

test("RPC ignores a late preset selection after session ownership changes", async () => {
  const runtime = memorySettingsRuntime();
  const selected = deferred<string | undefined>();
  const opened = deferred();
  let current = true;
  let calls = 0;
  const { ctx, notifications } = createMockContext({
    mode: "rpc",
    select: async () => {
      if (calls++ === 0) return "Presets";
      opened.resolve();
      return selected.promise;
    },
  });
  const running = showStampMenu(ctx, runtime, { signal: new AbortController().signal, isCurrent: () => current });
  await opened.promise;
  current = false;
  selected.resolve(presetOption("detailed"));
  assert.equal((await running).kind, "stale");
  assert.deepEqual(runtime.patches, []);
  assert.deepEqual(notifications, []);
  assert.equal(calls, 2);
});

test.each(["print", "json"] as const)(
  "%s rejects before custom UI, and an aborted owner never opens a menu",
  async (mode) => {
    const runtime = memorySettingsRuntime();
    let opened = false;
    const { ctx } = createMockContext({
      mode,
      hasUI: false,
      custom: async () => {
        opened = true;
      },
    });
    await assert.rejects(showStampMenu(ctx, runtime, currentOwner()), new RegExp(`unavailable in ${mode} mode`, "u"));
    const controller = new AbortController();
    controller.abort();
    assert.equal((await showStampMenu(ctx, runtime, currentOwner(controller))).kind, "stale");
    assert.equal(opened, false);
    assert.deepEqual(runtime.patches, []);
  },
);

function settingsScreen(menu: StampMenu, state: StampSettingsState) {
  const screen = resolveMenuScreen(menu, "settings", state);
  if (screen.kind !== "settings") assert.fail("Expected settings screen");
  return screen;
}

function reviewScreen(menu: StampMenu, id: "status" | "help", state: StampSettingsState) {
  const screen = resolveMenuScreen(menu, id, state);
  if (screen.kind !== "review") assert.fail("Expected review screen");
  return screen;
}

function invoke(
  menu: StampMenu,
  action: StampAction,
  runtime: StampSettingsRuntime,
  ctx: Parameters<StampMenu["actions"][StampAction]>[0]["ctx"],
  itemId: string,
  value?: string,
) {
  return menu.actions[action]({ ctx, state: runtime.get(), signal: new AbortController().signal, itemId, value });
}

async function openSettings(tui: ReturnType<typeof createTuiHarness>) {
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
}

function mainTitle() {
  return "Stamp\n24-hour · seconds · Metadata: None";
}

function settingsOptions(locale = "Invariant") {
  return [...EXPECTED_SETTINGS.map(([id, label, value]) => `${label} (${id === "locale" ? locale : value})`), "Back"];
}

function presetOptions(current?: string) {
  return [
    ...PRESET_LABELS.map(
      (label, index) => `${label} — ${label === current ? "current · " : ""}${PRESET_DESCRIPTIONS[index]}`,
    ),
    "← Back",
  ];
}

function presetOption(preset: (typeof METADATA_PRESET_NAMES)[number], current?: string) {
  return presetOptions(current)[METADATA_PRESET_NAMES.indexOf(preset)];
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
