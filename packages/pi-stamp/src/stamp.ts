import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  DEFAULT_STAMP_SETTINGS,
  formatExactTimelineLine,
  formatMessageStampLabel,
  formatStampLabel,
  resolveStampFormatEnvironment,
  type StampFormatEnvironment,
  type StampSettings,
  type StampTimelineBoundary,
} from "./format.js";
import { createMessageMetadataReader } from "./message-metadata.js";
import {
  type AssistantCostSinceUserData,
  type AssistantMetadataData,
  captureAssistantMetadata,
  captureCompletedOutputTokens,
  captureReportedCost,
  formatAssistantMetadataLines,
  formatToolStampLabel,
  isAssistantEstimatedCost,
  isStampThinkingLevel,
  type StampThinkingLevel,
  sanitizeMetadataText,
  sanitizeTerminalText,
  type ToolStampOutcome,
} from "./metadata.js";
import { hasAssistantMetadata } from "./metadata-settings.js";
import { createStampDisplaySettings } from "./preset-preview.js";
import { createStampSettingsRuntime, type StampSettingsRuntime } from "./settings.js";
import {
  type AssistantMessageStampDataV3,
  isMessageStampData,
  isRecord,
  isSafePersistedText,
  isToolStampData,
  isValidTimestamp,
  type MessageStampData,
  type MessageStampDataV2,
  STAMP_ENTRY_TYPE,
  type StampEntryData,
  type ToolStampDataV1,
} from "./stamp-data.js";

export {
  type AssistantMessageStampDataV3,
  type AssistantMessageStampDataV4,
  type AssistantMessageStampDataV5,
  type AssistantMessageStampDataV6,
  type AssistantMessageStampDataV7,
  type AssistantMessageStampDataV8,
  isMessageStampData,
  isToolStampData,
  type MessageStampData,
  type MessageStampDataV1,
  type MessageStampDataV2,
  STAMP_ENTRY_TYPE,
  type StampEntryData,
  type ToolStampDataV1,
} from "./stamp-data.js";

export const MAX_TOOL_STAMP_OBSERVATIONS = 256;

export interface StampExtensionOptions {
  settingsRuntime?: StampSettingsRuntime;
  now?: () => number;
}

interface AssistantTimingObservation {
  timestamp: number;
  firstContentAt?: number;
}

interface FinalizedAssistantTiming extends AssistantTimingObservation {
  completedAt: number;
  timeSinceUserMs?: number;
}

interface CostSinceUserAccumulator {
  total: number;
  hasReportedCost: boolean;
  valid: boolean;
}

interface ToolTimingObservation {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  completedAt?: number;
  outcome?: ToolStampOutcome;
}

export function formatStampTime(timestamp: number): string | undefined {
  return formatStampLabel(timestamp, undefined, {
    ...DEFAULT_STAMP_SETTINGS,
    dateContext: "never",
  });
}

interface RightAlignedLine {
  text: string;
  exact: boolean;
}

export function createStampEntryRenderer(
  getSettings: () => Readonly<StampSettings>,
  getFallbackMetadata?: (entryId: string) => AssistantMetadataData | undefined,
): EntryRenderer<StampEntryData> {
  return (entry, options, theme) => {
    if (isToolStampData(entry.data)) {
      if (!getSettings().toolStamps) return undefined;
      const data = entry.data;
      return dynamicRightAlignedText(
        memoizeStampLines(getSettings, (settings) => {
          if (!settings.toolStamps) return [];
          const label = formatToolStampLabel(data.toolName, data.completedAt - data.startedAt, data.outcome);
          if (!label) return [];
          return [
            regularLine(label),
            ...(options.expanded && settings.showExactTimeline
              ? exactTimelineLines([
                  ["started", data.startedAt],
                  ["completed", data.completedAt],
                ])
              : []),
          ];
        }),
        (line) => theme.fg("dim", line),
      );
    }
    if (!isMessageStampData(entry.data)) return undefined;
    const data = entry.data;
    return dynamicRightAlignedText(
      memoizeStampLines(
        getSettings,
        (settings, fallbackMetadata) => {
          const hasAssistantTiming = data.version !== 1 && data.version !== 2;
          const outputTokens =
            data.version === 8
              ? data.outputTokens
              : "metadata" in data
                ? captureCompletedOutputTokens(data.metadata)
                : undefined;
          const label = formatMessageStampLabel(
            {
              timestamp: data.timestamp,
              outputTokens,
              ...(data.version === 7 || data.version === 8 ? { timeSinceUserMs: data.timeSinceUserMs } : {}),
              ...(data.version === 1 ? {} : { previousTimestamp: data.previousTimestamp }),
              ...(hasAssistantTiming
                ? {
                    completedAt: data.completedAt,
                    firstContentAt: data.firstContentAt,
                  }
                : {}),
            },
            settings,
          );
          if (!label) return [];
          const timelineObservations: Array<readonly [StampTimelineBoundary, number]> = [["created", data.timestamp]];
          if (hasAssistantTiming && data.firstContentAt !== undefined) {
            timelineObservations.push(["first content", data.firstContentAt]);
          }
          if (hasAssistantTiming && data.completedAt !== undefined) {
            timelineObservations.push(["completed", data.completedAt]);
          }
          const timelineLines =
            options.expanded && settings.showExactTimeline ? exactTimelineLines(timelineObservations) : [];
          const metadataLines =
            data.role === "assistant"
              ? formatAssistantMetadataLines(
                  ("metadata" in data ? data.metadata : undefined) ?? fallbackMetadata,
                  settings,
                  options.expanded,
                  data.version === 5 || data.version === 6 || data.version === 7 || data.version === 8
                    ? data.thinkingLevel
                    : undefined,
                  (data.version === 6 || data.version === 7 || data.version === 8) &&
                    data.costSinceUser !== undefined &&
                    settings.showCostSinceUser
                    ? {
                        ...(data.estimatedCost === undefined ? {} : { estimatedCost: data.estimatedCost }),
                        costSinceUser: data.costSinceUser,
                      }
                    : undefined,
                )
              : [];
          return [regularLine(label), ...timelineLines, ...metadataLines.map(regularLine)];
        },
        data.role === "assistant" && !("metadata" in data && data.metadata !== undefined) && getFallbackMetadata
          ? () => getFallbackMetadata(entry.id)
          : undefined,
      ),
      (line) => theme.fg("dim", line),
    );
  };
}

export const renderStampEntry = createStampEntryRenderer(() => DEFAULT_STAMP_SETTINGS);

function memoizeStampLines(
  getSettings: () => Readonly<StampSettings>,
  createLines: (
    settings: Readonly<StampSettings>,
    fallbackMetadata?: AssistantMetadataData,
  ) => readonly RightAlignedLine[],
  getFallbackMetadata?: () => AssistantMetadataData | undefined,
): () => readonly RightAlignedLine[] {
  let previousFallbackMetadata: AssistantMetadataData | undefined;
  let previousSettings: StampSettings | undefined;
  let previousEnvironment: Readonly<StampFormatEnvironment> | undefined;
  let lines: readonly RightAlignedLine[] = [];
  return () => {
    const settings = getSettings();
    const fallbackMetadata = hasAssistantMetadata(settings) ? getFallbackMetadata?.() : undefined;
    const environment = resolveStampFormatEnvironment(settings);
    if (
      !previousSettings ||
      previousFallbackMetadata !== fallbackMetadata ||
      !haveSameStampSettings(previousSettings, settings) ||
      !previousEnvironment ||
      !haveSameStampFormatEnvironment(settings, previousEnvironment, environment)
    ) {
      previousSettings = { ...settings };
      previousEnvironment = environment;
      previousFallbackMetadata = fallbackMetadata;
      lines = createLines(settings, fallbackMetadata);
    }
    return lines;
  };
}

function haveSameStampFormatEnvironment(
  settings: Readonly<StampSettings>,
  left: Readonly<StampFormatEnvironment>,
  right: Readonly<StampFormatEnvironment>,
): boolean {
  return (
    (settings.locale !== "system" || left.systemLocale === right.systemLocale) &&
    (settings.timeZone !== "local" || left.localTimeZone === right.localTimeZone)
  );
}

function haveSameStampSettings(left: Readonly<StampSettings>, right: Readonly<StampSettings>): boolean {
  return (Object.keys(DEFAULT_STAMP_SETTINGS) as Array<keyof StampSettings>).every(
    (field) => left[field] === right[field],
  );
}

function regularLine(text: string): RightAlignedLine {
  return { text, exact: false };
}

function exactTimelineLines(observations: ReadonlyArray<readonly [StampTimelineBoundary, number]>): RightAlignedLine[] {
  return observations.flatMap(([boundary, timestamp]) => {
    const text = formatExactTimelineLine(boundary, timestamp);
    return text ? [{ text, exact: true }] : [];
  });
}

function dynamicRightAlignedText(
  getLines: () => readonly RightAlignedLine[],
  style: (text: string) => string,
): Component {
  let cachedWidth: number | undefined;
  let cachedLines: readonly RightAlignedLine[] | undefined;
  let cachedOutput: string[] | undefined;
  return {
    render(width) {
      if (width < 1) return [];
      const lines = getLines();
      if (cachedOutput && cachedWidth === width && cachedLines === lines) return cachedOutput;
      cachedWidth = width;
      cachedLines = lines;
      cachedOutput = lines.flatMap((source) => {
        const wrapped = source.exact
          ? hardWrapExactText(source.text, width).map(style)
          : wrapTextWithAnsi(style(source.text), width);
        return wrapped.map((line) => {
          const leftPadding = " ".repeat(Math.max(0, width - visibleWidth(line)));
          return `${leftPadding}${line}`;
        });
      });
      return cachedOutput;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
      cachedOutput = undefined;
    },
  };
}

function hardWrapExactText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const character of text) {
    const characterWidth = visibleWidth(character);
    if (line && lineWidth + characterWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    if (characterWidth > width) continue;
    line += character;
    lineWidth += characterWidth;
  }
  if (line) lines.push(line);
  return lines;
}

export default function stampExtension(pi: ExtensionAPI, options: StampExtensionOptions = {}): void {
  const settingsRuntime = options.settingsRuntime ?? createStampSettingsRuntime();
  const displaySettings = createStampDisplaySettings(() => settingsRuntime.get().settings);
  const messageMetadata = createMessageMetadataReader();
  const now = options.now ?? Date.now;
  pi.registerEntryRenderer(STAMP_ENTRY_TYPE, createStampEntryRenderer(displaySettings.get, messageMetadata.get));

  let generation = 0;
  let sessionController = new AbortController();
  let tuiSessionActive = false;
  let lastStampTimestamp: number | undefined;
  let activeAssistantTiming: AssistantTimingObservation | undefined;
  let finalizedAssistantTiming: FinalizedAssistantTiming | undefined;
  let activeThinkingLevel: StampThinkingLevel | undefined;
  let costSinceUser = emptyCostSinceUserAccumulator();
  let nextUsageEntryIndex = 0;
  const activeToolTimings = new Map<string, ToolTimingObservation>();
  const pendingUserStamps: Array<{ role: "user"; timestamp: number }> = [];

  pi.registerCommand("stamp", {
    description: "Configure transcript timestamp and metadata stamps",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("/stamp does not accept arguments.");
      if (ctx.mode === "print" || ctx.mode === "json") {
        throw new Error(`/stamp is unavailable in ${ctx.mode} mode; use TUI or RPC mode.`);
      }
      const commandGeneration = generation;
      const commandController = sessionController;
      const { showStampMenu } = await import("./menu.js");
      if (
        commandGeneration !== generation ||
        commandController !== sessionController ||
        commandController.signal.aborted
      ) {
        return;
      }
      await showStampMenu(ctx, settingsRuntime, {
        signal: commandController.signal,
        beginPreview: displaySettings.begin,
        isCurrent: () =>
          commandGeneration === generation &&
          commandController === sessionController &&
          !commandController.signal.aborted,
      });
    },
  });

  const appendVersion2Stamp = (role: "user" | "assistant", timestamp: number): void => {
    const stamp: MessageStampDataV2 = {
      version: 2,
      role,
      timestamp,
      ...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
    };
    if (!isMessageStampData(stamp)) return;
    pi.appendEntry<MessageStampDataV2>(STAMP_ENTRY_TYPE, stamp);
    lastStampTimestamp = timestamp;
  };

  const appendAssistantStamp = (
    timestamp: number,
    timing: FinalizedAssistantTiming | undefined,
    message: unknown,
    thinkingLevel: StampThinkingLevel | undefined,
    costSinceUserData: AssistantCostSinceUserData | undefined,
    timeSinceUserMs: number | undefined,
  ): void => {
    const matchingTiming = timing?.timestamp === timestamp ? timing : undefined;
    const settings = settingsRuntime.get().settings;
    const metadata = captureAssistantMetadata(message, settings);
    const outputTokens = settings.showOutputThroughput ? captureCompletedOutputTokens(message) : undefined;
    const common = {
      role: "assistant" as const,
      timestamp,
      ...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
      ...(matchingTiming
        ? {
            completedAt: matchingTiming.completedAt,
            ...(matchingTiming.firstContentAt === undefined ? {} : { firstContentAt: matchingTiming.firstContentAt }),
          }
        : {}),
      ...(metadata === undefined ? {} : { metadata }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    };
    let richStamp: MessageStampData | undefined;
    if (outputTokens !== undefined && matchingTiming && matchingTiming.completedAt > timestamp) {
      richStamp = {
        ...common,
        version: 8,
        completedAt: matchingTiming.completedAt,
        outputTokens,
        ...(timeSinceUserMs === undefined ? {} : { timeSinceUserMs }),
        ...costSinceUserData,
      };
    } else if (timeSinceUserMs !== undefined && matchingTiming) {
      richStamp = {
        ...common,
        version: 7,
        completedAt: matchingTiming.completedAt,
        timeSinceUserMs,
        ...costSinceUserData,
      };
    } else if (costSinceUserData) {
      richStamp = { ...common, version: 6, ...costSinceUserData };
    } else if (metadata && thinkingLevel !== undefined) {
      richStamp = { ...common, version: 5, metadata, thinkingLevel };
    } else if (metadata) {
      richStamp = { ...common, version: 4, metadata };
    }
    if (isMessageStampData(richStamp)) {
      pi.appendEntry<MessageStampData>(STAMP_ENTRY_TYPE, richStamp);
      lastStampTimestamp = timestamp;
      return;
    }
    if (!matchingTiming) {
      appendVersion2Stamp("assistant", timestamp);
      return;
    }
    const stamp: AssistantMessageStampDataV3 = {
      version: 3,
      role: "assistant",
      timestamp,
      ...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
      completedAt: matchingTiming.completedAt,
      ...(matchingTiming.firstContentAt === undefined ? {} : { firstContentAt: matchingTiming.firstContentAt }),
    };
    if (!isMessageStampData(stamp)) {
      appendVersion2Stamp("assistant", timestamp);
      return;
    }
    pi.appendEntry<AssistantMessageStampDataV3>(STAMP_ENTRY_TYPE, stamp);
    lastStampTimestamp = timestamp;
  };

  const flushPendingUsers = (): void => {
    if (!tuiSessionActive) {
      pendingUserStamps.length = 0;
      return;
    }
    while (pendingUserStamps.length > 0) {
      const stamp = pendingUserStamps[0];
      if (!stamp) break;
      appendVersion2Stamp(stamp.role, stamp.timestamp);
      pendingUserStamps.shift();
    }
  };

  const flushToolStamps = (toolResults: readonly unknown[]): void => {
    try {
      if (!tuiSessionActive || !settingsRuntime.get().settings.toolStamps) return;
      for (const result of toolResults) {
        if (!isRecord(result) || typeof result.toolCallId !== "string") continue;
        const timing = activeToolTimings.get(result.toolCallId);
        if (!timing || timing.completedAt === undefined || timing.outcome === undefined) {
          continue;
        }
        activeToolTimings.delete(result.toolCallId);
        const stamp: ToolStampDataV1 = {
          version: 1,
          kind: "tool",
          toolCallId: timing.toolCallId,
          toolName: timing.toolName,
          startedAt: timing.startedAt,
          completedAt: timing.completedAt,
          outcome: timing.outcome,
        };
        if (isToolStampData(stamp)) pi.appendEntry<ToolStampDataV1>(STAMP_ENTRY_TYPE, stamp);
      }
    } finally {
      activeToolTimings.clear();
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    messageMetadata.bind(ctx.sessionManager);
    displaySettings.clear();
    sessionController.abort(new Error("pi-stamp session replaced"));
    sessionController = new AbortController();
    const controller = sessionController;
    const currentGeneration = ++generation;
    pendingUserStamps.length = 0;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeThinkingLevel = undefined;
    activeToolTimings.clear();
    tuiSessionActive = ctx.mode === "tui";
    const branch = ctx.sessionManager.getBranch();
    lastStampTimestamp = lastStampTimestampFromBranch(branch);
    costSinceUser = costSinceUserFromBranch(branch);
    nextUsageEntryIndex = branch.length;
    try {
      const state = await settingsRuntime.reload(controller.signal);
      if (controller.signal.aborted || currentGeneration !== generation || controller !== sessionController) {
        return;
      }
      if (state.issue && ctx.hasUI) {
        ctx.ui.notify(safeTerminalText(state.issue.message), "warning");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (ctx.hasUI) {
        ctx.ui.notify(`Could not load pi-stamp settings: ${safeTerminalText(formatError(error))}`, "warning");
      }
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    const settings = settingsRuntime.get().settings;
    activeThinkingLevel =
      tuiSessionActive && settings.showPiThinkingLevel && isStampThinkingLevel(ctx.thinkingLevel)
        ? ctx.thinkingLevel
        : undefined;
    activeToolTimings.clear();
  });

  pi.on("tool_execution_start", (event) => {
    if (
      !tuiSessionActive ||
      !settingsRuntime.get().settings.toolStamps ||
      activeToolTimings.size >= MAX_TOOL_STAMP_OBSERVATIONS ||
      activeToolTimings.has(event.toolCallId) ||
      !isSafePersistedText(event.toolCallId)
    ) {
      return;
    }
    const toolName = sanitizeMetadataText(event.toolName);
    if (!toolName) return;
    const startedAt = now();
    if (!isValidTimestamp(startedAt)) return;
    activeToolTimings.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName,
      startedAt,
    });
  });

  pi.on("tool_execution_end", (event) => {
    const timing = activeToolTimings.get(event.toolCallId);
    if (!tuiSessionActive || !timing || timing.completedAt !== undefined) return;
    const completedAt = now();
    if (!isValidTimestamp(completedAt) || completedAt < timing.startedAt) {
      activeToolTimings.delete(event.toolCallId);
      return;
    }
    timing.completedAt = completedAt;
    timing.outcome = event.isError ? "error" : "success";
  });

  pi.on("message_start", (event) => {
    flushPendingUsers();
    if (!tuiSessionActive || event.message.role !== "assistant" || !isValidTimestamp(event.message.timestamp)) {
      return;
    }
    activeAssistantTiming = { timestamp: event.message.timestamp };
    finalizedAssistantTiming = undefined;
  });

  pi.on("message_update", (event) => {
    if (
      !tuiSessionActive ||
      event.message.role !== "assistant" ||
      !activeAssistantTiming ||
      activeAssistantTiming.timestamp !== event.message.timestamp ||
      activeAssistantTiming.firstContentAt !== undefined ||
      !isMeaningfulAssistantUpdate(event.assistantMessageEvent)
    ) {
      return;
    }
    const firstContentAt = now();
    if (isValidTimestamp(firstContentAt)) activeAssistantTiming.firstContentAt = firstContentAt;
  });

  pi.on("message_end", (event, ctx) => {
    if (!tuiSessionActive) return;
    if (event.message.role === "user") {
      costSinceUser = emptyCostSinceUserAccumulator();
      // Pi appends the user entry after this hook, so start at the current branch tail.
      nextUsageEntryIndex = ctx.sessionManager.getBranch().length;
      if (isValidTimestamp(event.message.timestamp)) {
        pendingUserStamps.push({ role: "user", timestamp: event.message.timestamp });
      }
      return;
    }
    if (event.message.role !== "assistant" || !isValidTimestamp(event.message.timestamp)) return;
    const completedAt = now();
    if (!isValidTimestamp(completedAt) || completedAt < event.message.timestamp) {
      activeAssistantTiming = undefined;
      finalizedAssistantTiming = undefined;
      return;
    }
    const firstContentAt =
      activeAssistantTiming?.timestamp === event.message.timestamp &&
      isValidTimestamp(activeAssistantTiming.firstContentAt) &&
      activeAssistantTiming.firstContentAt >= event.message.timestamp &&
      activeAssistantTiming.firstContentAt <= completedAt
        ? activeAssistantTiming.firstContentAt
        : undefined;
    // Read the raw active branch, not compacted model context or an abandoned tree path.
    // Pi has already persisted prior user messages by this assistant completion boundary.
    const timeSinceUserMs = settingsRuntime.get().settings.showTimeSinceUser
      ? elapsedSinceUser(ctx.sessionManager.getBranch(), completedAt)
      : undefined;
    finalizedAssistantTiming = {
      timestamp: event.message.timestamp,
      completedAt,
      ...(firstContentAt === undefined ? {} : { firstContentAt }),
      ...(timeSinceUserMs === undefined ? {} : { timeSinceUserMs }),
    };
    activeAssistantTiming = undefined;
  });

  pi.on("turn_end", (event, ctx) => {
    const timing = finalizedAssistantTiming;
    const thinkingLevel = activeThinkingLevel;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeThinkingLevel = undefined;
    if (tuiSessionActive && event.message.role === "assistant") {
      const branch = ctx.sessionManager.getBranch();
      nextUsageEntryIndex = addNewUsageCosts(branch, nextUsageEntryIndex, costSinceUser);
      const estimatedCost = captureReportedCost(event.message);
      addReportedCostSinceUser(costSinceUser, estimatedCost);
      for (const toolResult of event.toolResults) {
        addReportedCostSinceUser(costSinceUser, captureReportedCost(toolResult));
      }
      const settings = settingsRuntime.get().settings;
      const isNonToolUseResponse = event.message.stopReason !== "toolUse";
      const costSinceUserData =
        settings.showCostSinceUser && isNonToolUseResponse && costSinceUser.valid && costSinceUser.hasReportedCost
          ? {
              ...(estimatedCost === undefined ? {} : { estimatedCost }),
              costSinceUser: costSinceUser.total,
            }
          : undefined;
      const timeSinceUserMs =
        isNonToolUseResponse && timing?.timestamp === event.message.timestamp ? timing.timeSinceUserMs : undefined;
      appendAssistantStamp(
        event.message.timestamp,
        timing,
        event.message,
        thinkingLevel,
        costSinceUserData,
        timeSinceUserMs,
      );
    }
    flushToolStamps(event.toolResults);
  });

  pi.on("agent_end", () => {
    flushPendingUsers();
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeThinkingLevel = undefined;
    activeToolTimings.clear();
  });

  pi.on("session_shutdown", async () => {
    messageMetadata.clear();
    displaySettings.clear();
    sessionController.abort(new Error("pi-stamp session shut down"));
    generation += 1;
    flushPendingUsers();
    pendingUserStamps.length = 0;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeThinkingLevel = undefined;
    activeToolTimings.clear();
    tuiSessionActive = false;
    lastStampTimestamp = undefined;
    costSinceUser = emptyCostSinceUserAccumulator();
    nextUsageEntryIndex = 0;
    await settingsRuntime.flush();
  });
}

function emptyCostSinceUserAccumulator(): CostSinceUserAccumulator {
  return { total: 0, hasReportedCost: false, valid: true };
}

function addReportedCostSinceUser(accumulator: CostSinceUserAccumulator, estimatedCost: number | undefined): void {
  if (estimatedCost === undefined || !accumulator.valid) return;
  const total = accumulator.total + estimatedCost;
  if (!isAssistantEstimatedCost(total)) {
    accumulator.valid = false;
    return;
  }
  accumulator.total = total;
  accumulator.hasReportedCost = true;
}

function costSinceUserFromBranch(entries: readonly unknown[]): CostSinceUserAccumulator {
  let costSinceUserStart = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") {
      costSinceUserStart = index + 1;
      break;
    }
  }

  const accumulator = emptyCostSinceUserAccumulator();
  for (let index = costSinceUserStart; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    if (entry.type === "usage") {
      addReportedCostSinceUser(accumulator, captureReportedCost(entry));
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
      addReportedCostSinceUser(accumulator, captureReportedCost(entry.message));
    }
  }
  return accumulator;
}

function addNewUsageCosts(
  entries: readonly unknown[],
  nextIndex: number,
  accumulator: CostSinceUserAccumulator,
): number {
  const start = Math.min(nextIndex, entries.length);
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (isRecord(entry) && entry.type === "usage") {
      addReportedCostSinceUser(accumulator, captureReportedCost(entry));
    }
  }
  return entries.length;
}

function elapsedSinceUser(entries: readonly unknown[], completedAt: number): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user")
      continue;
    const timestamp = entry.message.timestamp;
    // An invalid latest user is still a reset boundary; never fall back to an older user.
    return isValidTimestamp(timestamp) && timestamp <= completedAt ? completedAt - timestamp : undefined;
  }
  return undefined;
}

function lastStampTimestampFromBranch(entries: readonly unknown[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === STAMP_ENTRY_TYPE &&
      isMessageStampData(entry.data)
    ) {
      return entry.data.timestamp;
    }
  }
  return undefined;
}

function isMeaningfulAssistantUpdate(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta") {
    return typeof value.delta === "string" && value.delta.length > 0;
  }
  if (value.type === "text_end" || value.type === "thinking_end") {
    return typeof value.content === "string" && value.content.length > 0;
  }
  return value.type === "toolcall_end" && isRecord(value.toolCall);
}

function safeTerminalText(value: string): string {
  return sanitizeTerminalText(value).trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
