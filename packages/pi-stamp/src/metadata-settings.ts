export const METADATA_LAYOUTS = ["compact", "expanded"] as const;
export const STOP_REASON_MODES = ["hidden", "abnormal", "all"] as const;
export const METADATA_PRESET_NAMES = ["compact", "model", "usage", "cost", "abnormal", "detailed", "none"] as const;
export const LEGACY_METADATA_MODES = ["off", "compact", "expanded"] as const;

export const METADATA_BOOLEAN_FIELDS = [
  "showRequestedModel",
  "showResponseModel",
  "showProvider",
  "showApi",
  "showPiThinkingLevel",
  "showInputTokens",
  "showOutputTokens",
  "showReasoningTokens",
  "showCacheReadTokens",
  "showCacheWriteTokens",
  "showTotalTokens",
  "showCallCost",
  "showResponseId",
  "showDiagnostics",
] as const;

export interface StampMetadataSettings extends Record<(typeof METADATA_BOOLEAN_FIELDS)[number], boolean> {
  metadataLayout: (typeof METADATA_LAYOUTS)[number];
  stopReason: (typeof STOP_REASON_MODES)[number];
}

export type StampMetadataPreset = (typeof METADATA_PRESET_NAMES)[number];
export type LegacyMetadataMode = (typeof LEGACY_METADATA_MODES)[number];

export const DEFAULT_METADATA_SETTINGS: Readonly<StampMetadataSettings> = Object.freeze({
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
});

export const METADATA_SETTING_FIELDS = [
  "metadataLayout",
  ...METADATA_BOOLEAN_FIELDS,
  "stopReason",
] as const satisfies readonly (keyof StampMetadataSettings)[];

export const METADATA_PRESETS: Readonly<Record<StampMetadataPreset, Readonly<StampMetadataSettings>>> = Object.freeze({
  none: DEFAULT_METADATA_SETTINGS,
  compact: Object.freeze({
    ...DEFAULT_METADATA_SETTINGS,
    showRequestedModel: true,
    showResponseModel: true,
    showPiThinkingLevel: true,
    showTotalTokens: true,
    showCallCost: true,
    stopReason: "abnormal",
  }),
  detailed: Object.freeze({
    ...DEFAULT_METADATA_SETTINGS,
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
  }),
  model: Object.freeze({
    ...DEFAULT_METADATA_SETTINGS,
    showRequestedModel: true,
    showResponseModel: true,
    showPiThinkingLevel: true,
  }),
  usage: Object.freeze({
    ...DEFAULT_METADATA_SETTINGS,
    metadataLayout: "expanded",
    showInputTokens: true,
    showOutputTokens: true,
    showReasoningTokens: true,
    showCacheReadTokens: true,
    showCacheWriteTokens: true,
    showTotalTokens: true,
  }),
  cost: Object.freeze({
    ...DEFAULT_METADATA_SETTINGS,
    showCallCost: true,
  }),
  abnormal: Object.freeze({
    ...DEFAULT_METADATA_SETTINGS,
    stopReason: "abnormal",
  }),
});

export function currentMetadataPreset(settings: Readonly<StampMetadataSettings>): StampMetadataPreset | "custom" {
  return (
    METADATA_PRESET_NAMES.find((name) =>
      METADATA_SETTING_FIELDS.every((field) => settings[field] === METADATA_PRESETS[name][field]),
    ) ?? "custom"
  );
}

export function hasAssistantMetadata(settings: Readonly<StampMetadataSettings>): boolean {
  return settings.stopReason !== "hidden" || METADATA_BOOLEAN_FIELDS.some((field) => settings[field]);
}

export function legacyMetadataSettings(
  mode: LegacyMetadataMode,
  showThinkingLevel = true,
  showCompactAbnormalOutcome = true,
): StampMetadataSettings {
  return {
    ...METADATA_PRESETS[mode === "off" ? "none" : mode === "expanded" ? "detailed" : "compact"],
    showPiThinkingLevel: mode !== "off" && showThinkingLevel,
    stopReason: mode === "expanded" ? "all" : mode === "compact" && showCompactAbnormalOutcome ? "abnormal" : "hidden",
    // Legacy metadata opt-in also captured these expansion-only debug fields.
    showResponseId: mode !== "off",
    showDiagnostics: mode !== "off",
  };
}
