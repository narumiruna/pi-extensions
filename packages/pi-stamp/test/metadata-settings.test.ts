import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test } from "vitest";
import {
  currentMetadataPreset,
  DEFAULT_METADATA_SETTINGS,
  hasAssistantMetadata,
  LEGACY_METADATA_MODES,
  legacyMetadataSettings,
  METADATA_BOOLEAN_FIELDS,
  METADATA_LAYOUTS,
  METADATA_PRESET_NAMES,
  METADATA_PRESETS,
  METADATA_SETTING_FIELDS,
  STOP_REASON_MODES,
  type StampMetadataPreset,
  type StampMetadataSettings,
} from "../src/metadata-settings.js";

const NONE: StampMetadataSettings = {
  metadataLayout: "compact",
  showRequestedModel: false,
  showResponseModel: false,
  showProvider: false,
  showApi: false,
  showPiThinkingLevel: false,
  showInputTokens: false,
  showOutputTokens: false,
  showReasoningTokens: false,
  showCacheReadTokens: false,
  showCacheWriteTokens: false,
  showTotalTokens: false,
  showCallCost: false,
  stopReason: "hidden",
  showResponseId: false,
  showDiagnostics: false,
};
const EXPECTED_PRESETS: Record<StampMetadataPreset, StampMetadataSettings> = {
  none: NONE,
  compact: {
    ...NONE,
    showRequestedModel: true,
    showResponseModel: true,
    showPiThinkingLevel: true,
    showTotalTokens: true,
    showCallCost: true,
    stopReason: "abnormal",
  },
  detailed: {
    metadataLayout: "expanded",
    showRequestedModel: true,
    showResponseModel: true,
    showProvider: true,
    showApi: true,
    showPiThinkingLevel: true,
    showInputTokens: true,
    showOutputTokens: true,
    showReasoningTokens: true,
    showCacheReadTokens: true,
    showCacheWriteTokens: true,
    showTotalTokens: true,
    showCallCost: true,
    stopReason: "all",
    showResponseId: false,
    showDiagnostics: false,
  },
  model: {
    ...NONE,
    showRequestedModel: true,
    showResponseModel: true,
    showPiThinkingLevel: true,
  },
  usage: {
    ...NONE,
    metadataLayout: "expanded",
    showInputTokens: true,
    showOutputTokens: true,
    showReasoningTokens: true,
    showCacheReadTokens: true,
    showCacheWriteTokens: true,
    showTotalTokens: true,
  },
  cost: { ...NONE, showCallCost: true },
  abnormal: { ...NONE, stopReason: "abnormal" },
};

test("metadata defaults and presets have exact values and own only metadata keys", () => {
  assert.deepEqual(DEFAULT_METADATA_SETTINGS, NONE);
  assert.deepEqual(METADATA_PRESETS, EXPECTED_PRESETS);
  assert.deepEqual(METADATA_PRESET_NAMES, ["compact", "model", "usage", "cost", "abnormal", "detailed", "none"]);
  assert.deepEqual([...METADATA_SETTING_FIELDS].sort(), Object.keys(NONE).sort());
  assert.equal(new Set(METADATA_SETTING_FIELDS).size, METADATA_SETTING_FIELDS.length);
  assert.deepEqual(
    [...METADATA_BOOLEAN_FIELDS].sort(),
    Object.keys(NONE)
      .filter((field) => field !== "metadataLayout" && field !== "stopReason")
      .sort(),
  );
  const unrelated = {
    hourCycle: "12h",
    showSeconds: false,
    dateContext: "never",
    locale: "en-US",
    timeZone: "UTC",
    responseTiming: "detailed",
    showOutputThroughput: true,
    showExactTimeline: false,
    showCostSinceUser: true,
    showTimeSinceUser: true,
    toolStamps: true,
  };
  for (const name of METADATA_PRESET_NAMES) {
    const preset: Readonly<StampMetadataSettings> = METADATA_PRESETS[name];
    assert.deepEqual(Object.keys(preset).sort(), [...METADATA_SETTING_FIELDS].sort());
    assert.equal(preset.showResponseId, false);
    assert.equal(preset.showDiagnostics, false);
    const applied = { ...unrelated, ...preset };
    for (const [field, value] of Object.entries(unrelated)) {
      assert.equal(applied[field as keyof typeof unrelated], value, field);
    }
  }
});

test.each(METADATA_PRESET_NAMES)("%s matches exactly and edits resolve to a named preset or Custom", (name) => {
  const preset: Readonly<StampMetadataSettings> = METADATA_PRESETS[name];
  assert.equal(currentMetadataPreset(preset), name);
  assert.equal(currentMetadataPreset({ ...preset, ...{ showSeconds: false, responseTiming: "detailed" } }), name);
  const expectedMatch = (candidate: StampMetadataSettings) =>
    Object.entries(EXPECTED_PRESETS).find(([, expected]) => isDeepStrictEqual(candidate, expected))?.[0] ?? "custom";
  for (const field of METADATA_BOOLEAN_FIELDS) {
    const changed = { ...preset, [field]: !preset[field] };
    assert.equal(currentMetadataPreset(changed), expectedMatch(changed), field);
  }
  for (const metadataLayout of METADATA_LAYOUTS) {
    if (metadataLayout === preset.metadataLayout) continue;
    const changed = { ...preset, metadataLayout };
    assert.equal(currentMetadataPreset(changed), expectedMatch(changed));
  }
  for (const stopReason of STOP_REASON_MODES) {
    if (stopReason === preset.stopReason) continue;
    const changed = { ...preset, stopReason };
    assert.equal(currentMetadataPreset(changed), expectedMatch(changed));
  }
});

const legacyCases = LEGACY_METADATA_MODES.flatMap((mode) =>
  [false, true].flatMap((thinking) => [false, true].map((abnormal) => ({ mode, thinking, abnormal }))),
);

test.each(legacyCases)(
  "legacy $mode/$thinking/$abnormal retains the old field and debug opt-ins",
  ({ mode, thinking, abnormal }) => {
    const expected: StampMetadataSettings = {
      ...EXPECTED_PRESETS[mode === "off" ? "none" : mode === "expanded" ? "detailed" : "compact"],
      showPiThinkingLevel: mode !== "off" && thinking,
      stopReason: mode === "expanded" ? "all" : mode === "compact" && abnormal ? "abnormal" : "hidden",
      showResponseId: mode !== "off",
      showDiagnostics: mode !== "off",
    };
    assert.deepEqual(legacyMetadataSettings(mode, thinking, abnormal), expected);
  },
);

test("legacy defaults keep thinking and compact abnormal outcomes enabled only for active modes", () => {
  assert.deepEqual(legacyMetadataSettings("off"), NONE);
  assert.deepEqual(legacyMetadataSettings("compact"), {
    ...EXPECTED_PRESETS.compact,
    showResponseId: true,
    showDiagnostics: true,
  });
  assert.deepEqual(legacyMetadataSettings("expanded"), {
    ...EXPECTED_PRESETS.detailed,
    showResponseId: true,
    showDiagnostics: true,
  });
});

test("metadata activation depends on field choices rather than layout", () => {
  for (const metadataLayout of METADATA_LAYOUTS) {
    const settings = { ...NONE, metadataLayout };
    assert.equal(hasAssistantMetadata(settings), false);
    for (const field of METADATA_BOOLEAN_FIELDS) {
      assert.equal(hasAssistantMetadata({ ...settings, [field]: true }), true, field);
    }
    for (const stopReason of ["abnormal", "all"] as const) {
      assert.equal(hasAssistantMetadata({ ...settings, stopReason }), true);
    }
  }
});
