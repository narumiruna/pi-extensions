import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";
import {
  canonicalizeLocale,
  canonicalizeTimeZone,
  type StampAssistantMetadataMode,
  type StampDateContext,
  type StampHourCycle,
  type StampResponseTimingMode,
} from "./format.js";
import { sanitizeTerminalText } from "./metadata.js";
import type { StampSettingsPatch, StampSettingsRuntime, StampSettingsState } from "./settings.js";

type StampScreen = "main" | "settings" | "locale" | "time-zone" | "status" | "help" | "invalid";
type StampAction =
  | "set-hour-cycle"
  | "set-seconds"
  | "set-date-context"
  | "set-response-timing"
  | "set-assistant-metadata"
  | "set-exact-timeline"
  | "set-thinking-level"
  | "set-compact-abnormal-outcome"
  | "set-cost-since-user"
  | "set-tool-stamps"
  | "open-locale"
  | "choose-invariant-locale"
  | "choose-system-locale"
  | "choose-custom-locale"
  | "open-time-zone"
  | "choose-local-time-zone"
  | "choose-utc-time-zone"
  | "choose-custom-time-zone";

export interface StampMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export function createStampMenu(
  runtime: StampSettingsRuntime,
): MenuDefinition<StampSettingsState, StampScreen, StampAction, ExtensionCommandContext> {
  let localeEntry = false;
  let timeZoneEntry = false;
  return {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Stamp",
        lines: [formatCompactStatus(state)],
        items: [
          state.issue
            ? {
                id: "settings",
                label: "Settings",
                description: "Read-only until the invalid settings file is fixed.",
                to: "invalid" as const,
              }
            : { id: "settings", label: "Settings", to: "settings" as const },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Stamp Settings",
        lines: [`User settings · ${safeTerminalText(runtime.getPath())}`],
        items: [
          {
            id: "hourCycle",
            label: "Hour cycle",
            description: "Choose a 24-hour or 12-hour clock.",
            currentValue: hourCycleLabel(state.settings.hourCycle),
            values: ["24-hour", "12-hour"],
            action: "set-hour-cycle",
          },
          {
            id: "showSeconds",
            label: "Seconds",
            description: "Show or hide seconds in each stamp.",
            currentValue: state.settings.showSeconds ? "Show" : "Hide",
            values: ["Show", "Hide"],
            action: "set-seconds",
          },
          {
            id: "dateContext",
            label: "Date context",
            description: "Show dates at day changes, always, or never.",
            currentValue: dateContextLabel(state.settings.dateContext),
            values: ["Day changes", "Always", "Never"],
            action: "set-date-context",
          },
          {
            id: "locale",
            label: "Locale",
            description: "Use invariant, system, or an explicit BCP 47 locale.",
            currentValue: localeLabel(state.settings.locale),
            action: "open-locale",
          },
          {
            id: "timeZone",
            label: "Time zone",
            description: "Use local time, UTC, or an explicit IANA time zone.",
            currentValue: timeZoneLabel(state.settings.timeZone),
            action: "open-time-zone",
          },
          {
            id: "responseTiming",
            label: "Response timing",
            description: "Show no timing, total duration, or detailed first/total timing.",
            currentValue: responseTimingLabel(state.settings.responseTiming),
            values: ["Off", "Duration", "Detailed"],
            action: "set-response-timing",
          },
          {
            id: "showExactTimeline",
            label: "Exact timeline",
            description: "Show exact UTC and Unix times when transcript details are expanded.",
            currentValue: visibilityLabel(state.settings.showExactTimeline),
            values: ["Show", "Hide"],
            action: "set-exact-timeline",
          },
          {
            id: "assistantMetadata",
            label: "Assistant metadata",
            description: "Show no provenance, a compact summary, or expanded reported fields.",
            currentValue: assistantMetadataLabel(state.settings.assistantMetadata),
            values: ["Off", "Compact", "Expanded"],
            action: "set-assistant-metadata",
          },
          {
            id: "showThinkingLevel",
            label: "Thinking level",
            description: "Capture and show Pi's effective level when assistant metadata is enabled.",
            currentValue: visibilityLabel(state.settings.showThinkingLevel),
            values: ["Show", "Hide"],
            action: "set-thinking-level",
          },
          {
            id: "showCompactAbnormalOutcome",
            label: "Compact abnormal outcome",
            description: "Show length, error, and aborted stop reasons in compact metadata.",
            currentValue: visibilityLabel(state.settings.showCompactAbnormalOutcome),
            values: ["Show", "Hide"],
            action: "set-compact-abnormal-outcome",
          },
          {
            id: "showCostSinceUser",
            label: "Cost since user message",
            description: "Show the final call cost and the running total since the last user message.",
            currentValue: visibilityLabel(state.settings.showCostSinceUser),
            values: ["Show", "Hide"],
            action: "set-cost-since-user",
          },
          {
            id: "toolStamps",
            label: "Tool stamps",
            description: "Show duration and outcome after newly observed tool blocks.",
            currentValue: toolStampsLabel(state.settings.toolStamps),
            values: ["Hide", "Show"],
            action: "set-tool-stamps",
          },
        ],
      }),
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
        kind: "detail",
        title: "Stamp Status",
        lines: [
          settingStatus("Hour cycle", hourCycleLabel(state.settings.hourCycle), state, "hourCycle"),
          settingStatus("Seconds", state.settings.showSeconds ? "Show" : "Hide", state, "showSeconds"),
          settingStatus("Date context", dateContextLabel(state.settings.dateContext), state, "dateContext"),
          settingStatus("Locale", localeLabel(state.settings.locale), state, "locale"),
          settingStatus("Time zone", timeZoneLabel(state.settings.timeZone), state, "timeZone"),
          settingStatus("Response timing", responseTimingLabel(state.settings.responseTiming), state, "responseTiming"),
          settingStatus(
            "Exact timeline",
            visibilityLabel(state.settings.showExactTimeline),
            state,
            "showExactTimeline",
          ),
          settingStatus(
            "Assistant metadata",
            assistantMetadataLabel(state.settings.assistantMetadata),
            state,
            "assistantMetadata",
          ),
          settingStatus(
            "Thinking level",
            visibilityLabel(state.settings.showThinkingLevel),
            state,
            "showThinkingLevel",
          ),
          settingStatus(
            "Compact abnormal outcome",
            visibilityLabel(state.settings.showCompactAbnormalOutcome),
            state,
            "showCompactAbnormalOutcome",
          ),
          settingStatus(
            "Cost since user message",
            visibilityLabel(state.settings.showCostSinceUser),
            state,
            "showCostSinceUser",
          ),
          settingStatus("Tool stamps", toolStampsLabel(state.settings.toolStamps), state, "toolStamps"),
          `Settings file: ${safeTerminalText(runtime.getPath())}`,
          ...(state.issue ? [`Issue: ${safeTerminalText(state.issue.message)}`] : []),
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Stamp Help",
        lines: [
          "The clock shows message creation; response timing ends at assistant message completion.",
          "First content is Pi's first non-empty text, thinking, or tool-call stream update.",
          "First n/a means no meaningful update was observed; no other boundary is substituted.",
          "Thinking level capture requires both assistant metadata and its own setting to be enabled.",
          "Compact abnormal labels require their setting; normal stops always stay quiet there.",
          "Cost since user message resets at every user message and appears on non-tool-use responses.",
          "Expanded exact UTC/Unix rows require Exact timeline; debug metadata remains separate.",
          "Tool stamps pair start/end by ID, exclude tool data, and appear after the complete block.",
          "Assistant timing excludes tool execution and is unavailable on legacy stamp entries.",
          "Day changes compare the previous recorded message stamp in the selected time zone.",
          "Changes save immediately and reformat compatible mounted and future stamps.",
          "Stamp entries remain outside model context and never use a network request or refresh timer.",
        ],
        hint: "back",
      }),
      invalid: ({ state }) => ({
        kind: "detail",
        title: "Stamp Settings · Read only",
        lines: [
          `Invalid settings file. Fix ${safeTerminalText(runtime.getPath())} and run /reload. The file will not be overwritten.`,
          ...(state.issue ? [`Issue: ${safeTerminalText(state.issue.message)}`] : []),
          formatCompactStatus(state),
        ],
        hint: "back",
      }),
    },
    actions: {
      "set-hour-cycle": ({ ctx, value, signal }) =>
        savePatch(runtime, ctx, signal, { hourCycle: value === "12-hour" ? "12h" : "24h" }, `Hour cycle: ${value}.`),
      "set-seconds": ({ ctx, value, signal }) =>
        savePatch(runtime, ctx, signal, { showSeconds: value !== "Hide" }, `Seconds: ${value}.`),
      "set-date-context": ({ ctx, value, signal }) => {
        const dateContext: StampDateContext =
          value === "Always" ? "always" : value === "Never" ? "never" : "day-change";
        return savePatch(runtime, ctx, signal, { dateContext }, `Date context: ${value}.`);
      },
      "set-response-timing": ({ ctx, value, signal }) => {
        const responseTiming: StampResponseTimingMode =
          value === "Detailed" ? "detailed" : value === "Duration" ? "duration" : "off";
        return savePatch(runtime, ctx, signal, { responseTiming }, `Response timing: ${value}.`);
      },
      "set-exact-timeline": ({ ctx, value, signal }) =>
        savePatch(runtime, ctx, signal, { showExactTimeline: value === "Show" }, `Exact timeline: ${value}.`),
      "set-assistant-metadata": ({ ctx, value, signal }) => {
        const assistantMetadata: StampAssistantMetadataMode =
          value === "Expanded" ? "expanded" : value === "Compact" ? "compact" : "off";
        return savePatch(runtime, ctx, signal, { assistantMetadata }, `Assistant metadata: ${value}.`);
      },
      "set-thinking-level": ({ ctx, value, signal }) =>
        savePatch(runtime, ctx, signal, { showThinkingLevel: value === "Show" }, `Thinking level: ${value}.`),
      "set-compact-abnormal-outcome": ({ ctx, value, signal }) =>
        savePatch(
          runtime,
          ctx,
          signal,
          { showCompactAbnormalOutcome: value === "Show" },
          `Compact abnormal outcome: ${value}.`,
        ),
      "set-cost-since-user": ({ ctx, value, signal }) =>
        savePatch(runtime, ctx, signal, { showCostSinceUser: value === "Show" }, `Cost since user message: ${value}.`),
      "set-tool-stamps": ({ ctx, value, signal }) =>
        savePatch(runtime, ctx, signal, { toolStamps: value === "Show" }, `Tool stamps: ${value}.`),
      "open-locale": async () => {
        localeEntry = false;
        return { kind: "to", screen: "locale" };
      },
      "choose-invariant-locale": ({ ctx, signal }) =>
        savePatch(runtime, ctx, signal, { locale: "invariant" }, "Locale: Invariant.", "back"),
      "choose-system-locale": ({ ctx, signal }) =>
        savePatch(runtime, ctx, signal, { locale: "system" }, "Locale: System.", "back"),
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
        const result = await savePatch(runtime, ctx, signal, { locale }, `Locale: ${locale}.`, "back");
        if (result.kind === "back") localeEntry = false;
        return result;
      },
      "open-time-zone": async () => {
        timeZoneEntry = false;
        return { kind: "to", screen: "time-zone" };
      },
      "choose-local-time-zone": ({ ctx, signal }) =>
        savePatch(runtime, ctx, signal, { timeZone: "local" }, "Time zone: Local.", "back"),
      "choose-utc-time-zone": ({ ctx, signal }) =>
        savePatch(runtime, ctx, signal, { timeZone: "UTC" }, "Time zone: UTC.", "back"),
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
        const result = await savePatch(runtime, ctx, signal, { timeZone }, `Time zone: ${timeZone}.`, "back");
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
  return runMenu(ctx, createStampMenu(runtime), {
    getState: () => runtime.get(),
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    onError: (errorCtx, error) => {
      if (owner.isCurrent()) {
        errorCtx.ui.notify(`Stamp menu failed: ${safeTerminalText(formatError(error))}`, "error");
      }
    },
    onUnsupportedMode: (_unsupportedCtx, mode) => {
      throw new Error(`/stamp is unavailable in ${mode} mode; use TUI or RPC mode.`);
    },
  });
}

async function savePatch(
  runtime: StampSettingsRuntime,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  patch: StampSettingsPatch,
  successMessage: string,
  successTransition: "stay" | "back" = "stay",
) {
  if (signal.aborted) return { kind: "rejected" as const };
  try {
    await runtime.update(patch);
    if (signal.aborted) return { kind: "rejected" as const };
    ctx.ui.notify(successMessage, "info");
    return { kind: successTransition } as const;
  } catch (error) {
    if (!signal.aborted) {
      ctx.ui.notify(
        `Could not save Stamp settings; the previous value remains: ${safeTerminalText(formatError(error))}`,
        "error",
      );
    }
    return { kind: "rejected" as const };
  }
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
    dateContextLabel(state.settings.dateContext),
    localeLabel(state.settings.locale),
    timeZoneLabel(state.settings.timeZone),
    `Timing ${responseTimingLabel(state.settings.responseTiming).toLowerCase()}`,
    `Timeline ${state.settings.showExactTimeline ? "shown" : "hidden"}`,
    `Metadata ${assistantMetadataLabel(state.settings.assistantMetadata).toLowerCase()}`,
    `Thinking ${state.settings.showThinkingLevel ? "shown" : "hidden"}`,
    `Abnormal ${state.settings.showCompactAbnormalOutcome ? "shown" : "hidden"}`,
    `Cost since user ${state.settings.showCostSinceUser ? "shown" : "hidden"}`,
    `Tool stamps ${state.settings.toolStamps ? "shown" : "hidden"}`,
  ].join(" · ");
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

function assistantMetadataLabel(value: StampAssistantMetadataMode): string {
  if (value === "compact") return "Compact";
  if (value === "expanded") return "Expanded";
  return "Off";
}

function visibilityLabel(value: boolean): string {
  return value ? "Show" : "Hide";
}

function toolStampsLabel(value: boolean): string {
  return visibilityLabel(value);
}

function safeTerminalText(value: string): string {
  return sanitizeTerminalText(value).trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
