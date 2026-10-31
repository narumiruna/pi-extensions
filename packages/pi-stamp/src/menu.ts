import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition, MenuSettingItem, RunLiveChoiceResult } from "@narumitw/pi-tui-kit";
import {
  canonicalizeLocale,
  canonicalizeTimeZone,
  type StampDateContext,
  type StampHourCycle,
  type StampResponseTimingMode,
} from "./format.js";
import { sanitizeTerminalText } from "./metadata.js";
import {
  currentMetadataPreset,
  METADATA_BOOLEAN_FIELDS,
  METADATA_PRESET_NAMES,
  METADATA_PRESETS,
  type StampMetadataPreset,
  type StampMetadataSettings,
} from "./metadata-settings.js";
import type { StampPresetPreview } from "./preset-preview.js";
import type { StampSettingsPatch, StampSettingsRuntime, StampSettingsState } from "./settings.js";

type StampScreen = "main" | "settings" | "locale" | "time-zone" | "status" | "help" | "invalid";
type StampAction =
  | "open-presets"
  | "set-metadata"
  | "set-hour-cycle"
  | "set-seconds"
  | "set-date-context"
  | "set-response-timing"
  | "set-output-throughput"
  | "set-exact-timeline"
  | "set-cost-since-user"
  | "set-time-since-user"
  | "set-tool-stamps"
  | "open-locale"
  | "choose-invariant-locale"
  | "choose-system-locale"
  | "choose-custom-locale"
  | "open-time-zone"
  | "choose-local-time-zone"
  | "choose-utc-time-zone"
  | "choose-custom-time-zone";

type StampSettingItem = MenuSettingItem<StampAction> & { id: keyof StampSettingsState["settings"] };

const PRESETS_DESCRIPTION = "Choose assistant metadata presets.";
const PRESET_DESCRIPTIONS = {
  none: "Hide assistant metadata.",
  compact: "Model, thinking, total tokens, cost, and abnormal stops.",
  detailed: "Full provenance, token counts, cost, and stop reasons.",
  model: "Requested and response models, plus thinking level.",
  usage: "Input, output, reasoning, cache, and total tokens.",
  cost: "Reported cost per assistant call.",
  abnormal: "Length limits, errors, and aborted responses.",
} as const;
const METADATA_ROWS = [
  ["metadataLayout", "Metadata layout", "Arrange enabled metadata fields in a compact line or expanded rows."],
  ["showRequestedModel", "Requested model", "Show the model selected for the request."],
  ["showResponseModel", "Response model", "Show the model reported by the response."],
  ["showProvider", "Provider", "Show the provider reported by the response."],
  ["showApi", "API", "Show the API reported by the response."],
  ["showPiThinkingLevel", "Thinking level", "Capture and show Pi's effective thinking level while enabled."],
  ["showInputTokens", "Input tokens", "Show reported input tokens."],
  ["showOutputTokens", "Output tokens", "Show reported output tokens."],
  ["showReasoningTokens", "Reasoning tokens", "Show reasoning tokens only when the provider reports them."],
  ["showCacheReadTokens", "Cache read tokens", "Show reported cache read tokens."],
  ["showCacheWriteTokens", "Cache write tokens", "Show reported cache write tokens."],
  ["showTotalTokens", "Total tokens", "Show reported total tokens."],
  [
    "showCallCost",
    "Call cost",
    "Show this response's cost. Cost since user still includes the final call cost independently.",
  ],
  ["stopReason", "Stop reason", "Hide stop reasons, show abnormal outcomes, or show all reported reasons."],
  [
    "showResponseId",
    "Response ID",
    "Capture only while opted in; show only in the expanded transcript. IDs can be sensitive.",
  ],
  [
    "showDiagnostics",
    "Diagnostics",
    "Capture only while opted in; show only in the expanded transcript. Diagnostic identifiers can be sensitive.",
  ],
] as const satisfies readonly (readonly [keyof StampMetadataSettings, string, string])[];

export interface StampMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  beginPreview?(signal: AbortSignal): StampPresetPreview;
}

export function createStampMenu(
  runtime: StampSettingsRuntime,
  isCurrent: () => boolean = () => true,
  beginPreview?: StampMenuOwner["beginPreview"],
): MenuDefinition<StampSettingsState, StampScreen, StampAction, ExtensionCommandContext> {
  let localeEntry = false;
  let timeZoneEntry = false;
  const save = (
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
    patch: StampSettingsPatch,
    message: string,
    transition: "stay" | "back" = "stay",
  ) => savePatch(runtime, ctx, signal, isCurrent, patch, message, transition);
  return {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Stamp",
        lines: [formatCompactStatus(state)],
        items: [
          {
            id: "presets",
            label: "Presets",
            description: PRESETS_DESCRIPTION,
            ...(state.issue ? { to: "invalid" as const } : { action: "open-presets" as const }),
          },
          {
            id: "settings",
            label: "Settings",
            description: state.issue
              ? "Read-only until the invalid settings file is fixed."
              : "Edit individual settings.",
            to: state.issue ? "invalid" : "settings",
          },
          { id: "status", label: "Status", description: "View effective settings and sources.", to: "status" },
          { id: "help", label: "Help", description: "Read usage and behavior.", to: "help" },
          { id: "close", label: "Close", description: "Return to Pi.", close: true },
        ],
        hint: "close",
      }),
      settings: ({ state }) =>
        state.issue
          ? invalidScreen(runtime, state)
          : {
              kind: "settings",
              title: "Stamp Settings",
              lines: [`User settings · ${safeTerminalText(runtime.getPath())}`],
              items: settingItems(state),
            },
      locale: ({ state }) =>
        localeEntry
          ? {
              kind: "input",
              title: "Custom BCP 47 locale",
              lines: [`Current: ${localeLabel(state.settings.locale)}`],
              placeholder: "Examples: en-US, fr-FR, zh-TW",
              action: "choose-custom-locale",
              hint: "back",
            }
          : {
              kind: "actions",
              title: "Stamp Locale",
              lines: [`Current: ${localeLabel(state.settings.locale)}`],
              items: [
                {
                  id: "invariant",
                  label: "Invariant (default)",
                  description: "ISO date, Latin digits, and English AM/PM.",
                  action: "choose-invariant-locale",
                },
                {
                  id: "system",
                  label: "System locale",
                  description: "Use the operating system locale.",
                  action: "choose-system-locale",
                },
                {
                  id: "custom",
                  label: "Custom BCP 47 locale…",
                  description: "Examples: en-US, fr-FR, zh-TW.",
                  action: "choose-custom-locale",
                },
              ],
              hint: "back",
            },
      "time-zone": ({ state }) =>
        timeZoneEntry
          ? {
              kind: "input",
              title: "Custom IANA time zone",
              lines: [`Current: ${timeZoneLabel(state.settings.timeZone)}`],
              placeholder: "Examples: Asia/Taipei, America/New_York",
              action: "choose-custom-time-zone",
              hint: "back",
            }
          : {
              kind: "actions",
              title: "Stamp Time Zone",
              lines: [`Current: ${timeZoneLabel(state.settings.timeZone)}`],
              items: [
                {
                  id: "local",
                  label: "Local (default)",
                  description: "Follow the operating system time zone.",
                  action: "choose-local-time-zone",
                },
                {
                  id: "UTC",
                  label: "UTC",
                  description: "Use Coordinated Universal Time.",
                  action: "choose-utc-time-zone",
                },
                {
                  id: "custom",
                  label: "Custom IANA time zone…",
                  description: "Examples: Asia/Taipei, America/New_York.",
                  action: "choose-custom-time-zone",
                },
              ],
              hint: "back",
            },
      status: ({ state }) => ({
        kind: "review",
        title: "Stamp Status",
        content: [
          `Metadata preset: ${metadataPresetLabel(state)} · derived from effective fields; no stored selector`,
          ...settingItems(state).map((item) => settingStatus(item.label, item.currentValue, state, item.id)),
          `Settings file: ${safeTerminalText(runtime.getPath())}`,
          ...(state.issue ? [`Issue: ${safeTerminalText(state.issue.message)}`] : []),
        ].join("\n"),
        hint: "back",
      }),
      help: () => ({
        kind: "review",
        title: "Stamp Help",
        content: [
          "Presets apply complete assistant metadata patches only. Fine tune each field in Settings.",
          "None hides all metadata. Every preset leaves Response ID and diagnostics off.",
          "Model, Usage, Cost, and Abnormal focus on identity, token counts, call cost, or abnormal stop reasons.",
          "The current preset is derived from effective fields; unmatched combinations show Custom.",
          "Presets preserve clocks, exact timeline, response timing, throughput, since-user totals, and tool stamps.",
          "Only user settings are supported: built-in defaults < user file. Project and environment overrides are not used.",
          `Settings file: ${safeTerminalText(runtime.getPath())}. Settings reload at session start and /reload.`,
          "Legacy assistantMetadata, showThinkingLevel, and showCompactAbnormalOutcome migrate to independent fields.",
          "Explicit independent fields take priority; showPiThinkingLevel is the canonical Thinking level key.",
          "The clock shows message creation; response timing ends at assistant message completion.",
          "First content is Pi's first non-empty text, thinking, or tool-call stream update.",
          "First n/a means no meaningful update was observed; no other boundary is substituted.",
          "Output throughput averages reported output tokens from creation to completion, not server generation speed.",
          "Throughput is independent of metadata and timing display; errors and aborted responses omit it.",
          "Thinking level capture requires its own setting, independent of layout and other metadata fields.",
          "Reasoning tokens appear only when explicitly reported; Stamp does not estimate them.",
          "Response ID and diagnostics are captured only while individually opted in, and shown only in the expanded transcript.",
          "Diagnostics capture identifiers, type, error name, and code, never diagnostic messages.",
          "These debug fields can contain sensitive identifiers. Hiding them does not erase data already saved in sessions.",
          "Metadata layout changes arrangement, not capture permission. Unreported fields are omitted.",
          "Cost since user message resets at every user message and appears on non-tool-use responses.",
          "Time since user message includes tools and pauses; each non-tool-use response records a fixed duration.",
          "Expanded exact UTC/Unix rows require Exact timeline; debug metadata remains separate.",
          "Tool stamps pair start/end by ID, exclude tool data, and appear after the complete block.",
          "Per-response timing excludes tool execution and is unavailable on timestamp-only entries.",
          "Day changes compare the previous recorded message stamp in the selected time zone.",
          "In TUI, moving the preset cursor immediately reformats the original Stamp rows in the transcript; there is no separate preview block.",
          "When a Stamp has no saved metadata, enabled ordinary fields can be read from its matching earlier assistant response on the active branch.",
          "Saved Stamp metadata remains authoritative. Response content, IDs, diagnostics, and raw/current Thinking are never recovered.",
          "This changes display only, not recording settings or session history. Missing response fields are not invented.",
          "RPC offers a normal selector without cursor previews. Presets save only after confirmation.",
          "Each Settings change saves immediately; one confirmed preset saves all metadata fields together.",
          "Cancel before confirmation writes nothing and clears the display preview. Back or cancel does not undo completed saves; failures retain previous values.",
          "Accepted saves finish in order even if the menu closes. Compatible mounted and future stamps are reformatted.",
          "Invalid files are read-only and are never overwritten. Unknown fields are preserved on save.",
          "Stamp entries remain outside model context and never use a network request or refresh timer.",
        ].join("\n"),
        hint: "back",
      }),
      invalid: ({ state }) => invalidScreen(runtime, state),
    },
    actions: {
      "open-presets": ({ ctx, signal }) => showStampPresets(ctx, runtime, signal, isCurrent, beginPreview),
      "set-metadata": ({ ctx, itemId, value, signal }) => {
        const patch = metadataPatch(itemId, value);
        const row = METADATA_ROWS.find(([field]) => field === itemId);
        if (!patch || !row) return { kind: "rejected" };
        return save(ctx, signal, patch, `${row[1]}: ${value}.`);
      },
      "set-hour-cycle": ({ ctx, value, signal }) =>
        save(ctx, signal, { hourCycle: value === "12-hour" ? "12h" : "24h" }, `Hour cycle: ${value}.`),
      "set-seconds": ({ ctx, value, signal }) =>
        save(ctx, signal, { showSeconds: value !== "Hide" }, `Seconds: ${value}.`),
      "set-date-context": ({ ctx, value, signal }) => {
        const dateContext: StampDateContext =
          value === "Always" ? "always" : value === "Never" ? "never" : "day-change";
        return save(ctx, signal, { dateContext }, `Date context: ${value}.`);
      },
      "set-response-timing": ({ ctx, value, signal }) => {
        const responseTiming: StampResponseTimingMode =
          value === "Detailed" ? "detailed" : value === "Duration" ? "duration" : "off";
        return save(ctx, signal, { responseTiming }, `Response timing: ${value}.`);
      },
      "set-output-throughput": ({ ctx, value, signal }) =>
        save(ctx, signal, { showOutputThroughput: value === "Show" }, `Output throughput: ${value}.`),
      "set-exact-timeline": ({ ctx, value, signal }) =>
        save(ctx, signal, { showExactTimeline: value === "Show" }, `Exact timeline: ${value}.`),
      "set-cost-since-user": ({ ctx, value, signal }) =>
        save(ctx, signal, { showCostSinceUser: value === "Show" }, `Cost since user message: ${value}.`),
      "set-time-since-user": ({ ctx, value, signal }) =>
        save(ctx, signal, { showTimeSinceUser: value === "Show" }, `Time since user message: ${value}.`),
      "set-tool-stamps": ({ ctx, value, signal }) =>
        save(ctx, signal, { toolStamps: value === "Show" }, `Tool stamps: ${value}.`),
      "open-locale": async () => {
        localeEntry = false;
        return { kind: "to", screen: "locale" };
      },
      "choose-invariant-locale": ({ ctx, signal }) =>
        save(ctx, signal, { locale: "invariant" }, "Locale: Invariant.", "back"),
      "choose-system-locale": ({ ctx, signal }) => save(ctx, signal, { locale: "system" }, "Locale: System.", "back"),
      "choose-custom-locale": async ({ ctx, signal, value }) => {
        if (value === undefined) {
          localeEntry = true;
          return { kind: "stay" };
        }
        const locale = canonicalizeLocale(value.trim());
        if (!locale || locale === "invariant" || locale === "system") {
          ctx.ui.notify("Enter one valid BCP 47 locale, such as en-US.", "warning");
          return { kind: "rejected" };
        }
        const result = await save(ctx, signal, { locale }, `Locale: ${locale}.`, "back");
        if (result.kind === "back") localeEntry = false;
        return result;
      },
      "open-time-zone": async () => {
        timeZoneEntry = false;
        return { kind: "to", screen: "time-zone" };
      },
      "choose-local-time-zone": ({ ctx, signal }) =>
        save(ctx, signal, { timeZone: "local" }, "Time zone: Local.", "back"),
      "choose-utc-time-zone": ({ ctx, signal }) => save(ctx, signal, { timeZone: "UTC" }, "Time zone: UTC.", "back"),
      "choose-custom-time-zone": async ({ ctx, signal, value }) => {
        if (value === undefined) {
          timeZoneEntry = true;
          return { kind: "stay" };
        }
        const timeZone = canonicalizeTimeZone(value.trim());
        if (!timeZone || timeZone === "local") {
          ctx.ui.notify("Enter one valid IANA time zone, such as Asia/Taipei.", "warning");
          return { kind: "rejected" };
        }
        const result = await save(ctx, signal, { timeZone }, `Time zone: ${timeZone}.`, "back");
        if (result.kind === "back") timeZoneEntry = false;
        return result;
      },
    },
  };
}

export async function showStampMenu(
  ctx: ExtensionCommandContext,
  runtime: StampSettingsRuntime,
  owner: StampMenuOwner,
) {
  const { runMenu } = await import("@narumitw/pi-tui-kit");
  if (owner.signal.aborted || !owner.isCurrent()) return { kind: "stale" } as const;
  return runMenu(ctx, createStampMenu(runtime, owner.isCurrent, owner.beginPreview), {
    getState: () => runtime.get(),
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    onError: (errorCtx, error) => {
      if (!owner.signal.aborted && owner.isCurrent()) {
        errorCtx.ui.notify(`Stamp menu failed: ${safeTerminalText(formatError(error))}`, "error");
      }
    },
    onUnsupportedMode: (_unsupportedCtx, mode) => {
      throw new Error(`/stamp is unavailable in ${mode} mode; use TUI or RPC mode.`);
    },
  });
}

async function showStampPresets(
  ctx: ExtensionCommandContext,
  runtime: StampSettingsRuntime,
  signal: AbortSignal,
  isCurrent: () => boolean,
  beginPreview: StampMenuOwner["beginPreview"],
) {
  const { runLiveChoice, runTask } = await import("@narumitw/pi-tui-kit");
  const onError = (errorCtx: ExtensionCommandContext, error: unknown) => {
    if (!signal.aborted && isCurrent()) {
      errorCtx.ui.notify(`Stamp menu failed: ${safeTerminalText(formatError(error))}`, "error");
    }
  };
  let focusedPreset: StampMetadataPreset | undefined;
  while (!signal.aborted && isCurrent()) {
    const state = runtime.get();
    if (!state.canSave) return { kind: "to", screen: "invalid" } as const;
    const currentPreset = currentMetadataPreset(state.settings);
    const preview = ctx.mode === "tui" ? beginPreview?.(signal) : undefined;
    let choice: RunLiveChoiceResult<StampMetadataPreset, never>;
    try {
      choice = await runLiveChoice(ctx, {
        title: "Stamp Presets",
        lines: [
          `Current preset: ${metadataPresetLabel(state)}`,
          "TUI: move to apply temporarily. Confirm to save.",
          "Other settings unchanged. Response ID and diagnostics stay off.",
        ],
        items: METADATA_PRESET_NAMES.map((name) => ({
          id: name,
          label: capitalized(name),
          description: PRESET_DESCRIPTIONS[name],
        })),
        currentItemId: currentPreset === "custom" ? undefined : currentPreset,
        initialItemId: focusedPreset ?? (currentPreset === "custom" ? "compact" : currentPreset),
        navigationLabel: "preview",
        confirmLabel: "apply",
        hint: "back",
        signal,
        isCurrent,
        onSelectionChange: ({ item, signal: previewSignal }) => {
          if (!previewSignal.aborted && !signal.aborted && isCurrent()) preview?.set(item.id);
        },
        onError,
      });
    } finally {
      preview?.dispose();
    }
    if (signal.aborted || !isCurrent()) return { kind: "close" } as const;
    if (choice.kind === "closed") return { kind: choice.reason === "back" ? "stay" : "close" } as const;
    if (choice.kind === "error") return { kind: "rejected" } as const;
    if (choice.kind !== "selected") return { kind: "close" } as const;
    focusedPreset = choice.itemId;
    // Keep input ownership while an accepted atomic save drains after cancellation.
    const saving = await runTask(ctx, {
      label: "Saving Stamp preset…",
      signal,
      isCurrent,
      onError,
      task: ({ signal: saveSignal }) =>
        savePatch(
          runtime,
          ctx,
          saveSignal,
          isCurrent,
          { ...METADATA_PRESETS[choice.itemId] },
          `Metadata preset: ${capitalized(choice.itemId)}.`,
          "stay",
        ),
    });
    if (signal.aborted || !isCurrent() || saving.kind !== "completed") return { kind: "close" } as const;
    // Reload the latest canonical state after each accepted or failed save.
  }
  return { kind: "close" } as const;
}

async function savePatch(
  runtime: StampSettingsRuntime,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  isCurrent: () => boolean,
  patch: StampSettingsPatch,
  successMessage: string,
  successTransition: "stay" | "back",
) {
  if (signal.aborted || !isCurrent()) return { kind: "rejected" as const };
  try {
    if (!runtime.get().canSave) throw new Error("The settings file is read-only; fix it and run /reload.");
    // An accepted save finishes through the runtime queue; closing only cancels its UI continuation.
    await runtime.update(patch);
    if (signal.aborted || !isCurrent()) return { kind: "rejected" as const };
    ctx.ui.notify(successMessage, "info");
    return { kind: successTransition } as const;
  } catch (error) {
    if (!signal.aborted && isCurrent()) {
      ctx.ui.notify(
        `Could not save Stamp settings; the previous value remains: ${safeTerminalText(formatError(error))}`,
        "error",
      );
    }
    return { kind: "rejected" as const };
  }
}

function settingItems(state: StampSettingsState): StampSettingItem[] {
  const settings = state.settings;
  return [
    {
      id: "hourCycle",
      label: "Hour cycle",
      description: "Choose a 24-hour or 12-hour clock.",
      currentValue: hourCycleLabel(settings.hourCycle),
      values: ["24-hour", "12-hour"],
      action: "set-hour-cycle",
    },
    {
      id: "showSeconds",
      label: "Seconds",
      description: "Show or hide seconds in each stamp.",
      currentValue: visibilityLabel(settings.showSeconds),
      values: ["Show", "Hide"],
      action: "set-seconds",
    },
    {
      id: "dateContext",
      label: "Date context",
      description: "Show dates at day changes, always, or never.",
      currentValue: dateContextLabel(settings.dateContext),
      values: ["Day changes", "Always", "Never"],
      action: "set-date-context",
    },
    {
      id: "locale",
      label: "Locale",
      description: "Use invariant, system, or an explicit BCP 47 locale.",
      currentValue: localeLabel(settings.locale),
      action: "open-locale",
    },
    {
      id: "timeZone",
      label: "Time zone",
      description: "Use local time, UTC, or an explicit IANA time zone.",
      currentValue: timeZoneLabel(settings.timeZone),
      action: "open-time-zone",
    },
    {
      id: "responseTiming",
      label: "Response timing",
      description: "Show no timing, total duration, or detailed first/total timing.",
      currentValue: responseTimingLabel(settings.responseTiming),
      values: ["Off", "Duration", "Detailed"],
      action: "set-response-timing",
    },
    {
      id: "showOutputThroughput",
      label: "Show output throughput",
      description: "Average reported output tokens per second, from creation to completion.",
      currentValue: visibilityLabel(settings.showOutputThroughput),
      values: ["Show", "Hide"],
      action: "set-output-throughput",
    },
    {
      id: "showExactTimeline",
      label: "Exact timeline",
      description: "Show exact UTC and Unix times when transcript details are expanded.",
      currentValue: visibilityLabel(settings.showExactTimeline),
      values: ["Show", "Hide"],
      action: "set-exact-timeline",
    },
    ...METADATA_ROWS.map(([id, label, description]): StampSettingItem => {
      const value = settings[id];
      return {
        id,
        label,
        description,
        currentValue: typeof value === "boolean" ? visibilityLabel(value) : capitalized(value),
        values:
          id === "metadataLayout"
            ? ["Compact", "Expanded"]
            : id === "stopReason"
              ? ["Hidden", "Abnormal", "All"]
              : ["Show", "Hide"],
        action: "set-metadata",
      };
    }),
    {
      id: "showCostSinceUser",
      label: "Cost since user message",
      description: "Show the final call cost and the running total since the last user message.",
      currentValue: visibilityLabel(settings.showCostSinceUser),
      values: ["Show", "Hide"],
      action: "set-cost-since-user",
    },
    {
      id: "showTimeSinceUser",
      label: "Time since user message",
      description: "Record elapsed time through response completion, including tools and pauses.",
      currentValue: visibilityLabel(settings.showTimeSinceUser),
      values: ["Show", "Hide"],
      action: "set-time-since-user",
    },
    {
      id: "toolStamps",
      label: "Tool stamps",
      description: "Show duration and outcome after newly observed tool blocks.",
      currentValue: visibilityLabel(settings.toolStamps),
      values: ["Hide", "Show"],
      action: "set-tool-stamps",
    },
  ];
}

function metadataPatch(itemId: string, value: string | undefined): StampSettingsPatch | undefined {
  if (itemId === "metadataLayout") {
    if (value === "Compact" || value === "Expanded")
      return { metadataLayout: value === "Compact" ? "compact" : "expanded" };
    return undefined;
  }
  if (itemId === "stopReason") {
    if (value === "Hidden") return { stopReason: "hidden" };
    if (value === "Abnormal") return { stopReason: "abnormal" };
    if (value === "All") return { stopReason: "all" };
    return undefined;
  }
  const field = METADATA_BOOLEAN_FIELDS.find((candidate) => candidate === itemId);
  if (field && (value === "Show" || value === "Hide")) return { [field]: value === "Show" };
  return undefined;
}

function invalidScreen(runtime: StampSettingsRuntime, state: StampSettingsState) {
  return {
    kind: "detail" as const,
    title: "Stamp Settings · Read only",
    lines: [
      `Invalid settings file. Fix ${safeTerminalText(runtime.getPath())} and run /reload. The file will not be overwritten.`,
      ...(state.issue ? [`Issue: ${safeTerminalText(state.issue.message)}`] : []),
      formatCompactStatus(state),
    ],
    hint: "back" as const,
  };
}

function settingStatus(
  label: string,
  value: string,
  state: StampSettingsState,
  field: keyof StampSettingsState["settings"],
): string {
  return `${label}: ${value} · ${state.sources[field] === "user" ? "User" : "Built-in"}`;
}

function formatCompactStatus(state: StampSettingsState): string {
  return [
    hourCycleLabel(state.settings.hourCycle),
    state.settings.showSeconds ? "seconds" : "no seconds",
    `Metadata: ${metadataPresetLabel(state)}`,
  ].join(" · ");
}

function metadataPresetLabel(state: StampSettingsState): string {
  return capitalized(currentMetadataPreset(state.settings));
}

function capitalized(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hourCycleLabel(value: StampHourCycle): string {
  return value === "24h" ? "24-hour" : "12-hour";
}

function dateContextLabel(value: StampDateContext): string {
  if (value === "always") return "Always";
  if (value === "never") return "Never";
  return "Day changes";
}

function localeLabel(value: string): string {
  if (value === "invariant") return "Invariant";
  if (value === "system") return "System";
  return safeTerminalText(value);
}

function timeZoneLabel(value: string): string {
  return value === "local" ? "Local" : safeTerminalText(value);
}

function responseTimingLabel(value: StampResponseTimingMode): string {
  if (value === "duration") return "Duration";
  if (value === "detailed") return "Detailed";
  return "Off";
}

function visibilityLabel(value: boolean): string {
  return value ? "Show" : "Hide";
}

function safeTerminalText(value: string): string {
  return sanitizeTerminalText(value).trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
